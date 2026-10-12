'use strict';

// Native document reading for the technician workspace: PDF datasheets, reference images and
// structured schematics attached to a board. Every read follows the main.cjs board contract:
// absolute local path only, realpath, extension allow-list per kind, content sniffing (the
// extension alone is never trusted), size bound, growth-safe bounded read, SHA-256 of the
// original bytes. Companion files (ASC-style multi-file boards) are gathered only from the
// directory of the selected file and may not escape it through links.
//
// On top of single reads this module also provides the multi-document selection (bounded count and
// bytes, bounded schematic companions), re-finding remembered documents (locateDocuments: absolute
// path, then path relative to the board directory, verified by SHA-256) and the workspace export bundle
// (a zip with ONLY what the user selected, atomic write, zip-slip-safe names).
//
// User-visible texts go through the injected translator t(key, params) where a catalog key fits;
// the remaining English texts are marked `// i18n: pending`. Errors carry a stable `code`.

const defaultFs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { localAbsolutePath, readBounded, renameWithRetry } = require('./store.cjs');
const { isOnlineOnly } = require('./placeholder.cjs');
const ids = require('./identity.cjs');
const formats = require('./formats.cjs');
const { xmlRoot } = require('./xml-prolog.mjs');
const { isSchDoc } = require('./altium-sniff.mjs');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 200;
const MAX_SELECTION_FILES = 16;
const MAX_SELECTION_BYTES = 256 * 1024 * 1024;
const COMPANION_FILES = 32;
const MAX_LOCATE_REQUESTS = 200;
const LOCATE_CONCURRENCY = 4;
const HASH_CHUNK_BYTES = 1024 * 1024;
const DEFLATE_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_SKIPPED = 64;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EXTENSIONS = 32;
const SNIFF_WINDOW = 4096;
const PDF_HEADER_WINDOW = 1024; // The PDF specification allows the header within the first 1024 bytes.
const identity = (key) => key;

const KINDS = Object.freeze({
  pdf: Object.freeze({ extensions: Object.freeze(['.pdf']) }),
  image: Object.freeze({ extensions: Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.svg']) }),
  schematic: Object.freeze({ extensions: Object.freeze(['.kicad_sch', '.sch', '.lib', '.schdoc']) }),
});
const KIND_NAMES = Object.freeze(Object.keys(KINDS));
// Content formats each extension may carry; the first entry's kind is the extension's kind.
const EXTENSION_CONTENT = Object.freeze({
  '.pdf': ['pdf'], '.png': ['png'], '.jpg': ['jpeg'], '.jpeg': ['jpeg'], '.webp': ['webp'], '.svg': ['svg'],
  '.kicad_sch': ['kicad_sch'], '.sch': ['eeschema', 'eagle', 'kicad_sch'], '.lib': ['eeschema-lib'], '.schdoc': ['altium-sch'],
});
const CONTENT = Object.freeze({
  pdf: { kind: 'pdf' }, png: { kind: 'image' }, jpeg: { kind: 'image' },
  webp: { kind: 'image' }, svg: { kind: 'image' },
  kicad_sch: { kind: 'schematic' }, eeschema: { kind: 'schematic' },
  'altium-sch': { kind: 'schematic' },
  eagle: { kind: 'schematic' }, 'eeschema-lib': { kind: 'schematic' },
});
// The content names of the mismatch message come from the catalogue (the literal keys keep them visible to the catalogue checks).
function contentLabel(format, t) {
  switch (format) {
    case 'pdf': return t('native.content.pdf');
    case 'png': return t('native.content.png');
    case 'jpeg': return t('native.content.jpeg');
    case 'webp': return t('native.content.webp');
    case 'svg': return t('native.content.svg');
    case 'kicad_sch': return t('native.content.kicadSch');
    case 'eeschema': return t('native.content.eeschema');
    case 'altium-sch': return t('native.content.altiumSch');
    case 'eagle': return t('native.content.eagle');
    case 'eeschema-lib': return t('native.content.eeschemaLib');
    default: return format;
  }
}
// The status word of a document that cannot be exported (the statuses of locateOne).
function statusLabel(status, t) {
  switch (status) {
    case 'changed': return t('native.error.exportStatusChanged');
    case 'unreadable': return t('native.error.exportStatusUnreadable');
    case 'missing': return t('native.error.exportStatusMissing');
    default: return status;
  }
}

function documentError(message, code, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

// A network (UNC) location is refused, as the store refuses it (electron/store.cjs); the refusal names the reason (MLX-03-04).
// Device namespace prefixes (\\?\, \\.\) are not network locations and keep the store's invalid-path text.
const networkPath = (value) => typeof value === 'string' && /^[\\/]{2}/.test(value) && !/^[\\/]{2}[?.][\\/]/.test(value);
function localDocumentPath(value, t = identity) {
  if (networkPath(value)) throw documentError(t('native.error.networkPathUnsupported'), 'DOCUMENT_INVALID_PATH');
  return localAbsolutePath(value, t);
}

// Maps file-system and store errors to document errors; document errors pass through.
function mapError(error, t = identity) {
  const code = error && error.code;
  if (typeof code === 'string' && code.startsWith('DOCUMENT_')) return error;
  if (code === 'STORE_INVALID_PATH') return documentError(error.message, 'DOCUMENT_INVALID_PATH');
  if (code === 'STORE_TOO_LARGE') return documentError(error.message, 'DOCUMENT_TOO_LARGE');
  if (code === 'STORE_CHANGED') return documentError(error.message, 'DOCUMENT_CHANGED');
  if (code === 'ENOENT') return documentError(t('native.error.documentNotFound'), 'DOCUMENT_NOT_FOUND', error);
  // A file another program holds open exclusively reports EBUSY on Windows (O-07).
  if (code === 'EBUSY') return documentError(t('native.error.fileInUse'), 'DOCUMENT_IN_USE', error);
  if (code === 'EACCES' || code === 'EPERM') return documentError(t('native.error.documentNotReadable'), 'DOCUMENT_NOT_READABLE', error);
  if (code) return documentError(t('native.error.documentReadFailed'), 'DOCUMENT_READ_FAILED', error);
  return error;
}

function normalizeKinds(value) {
  const list = value === undefined ? KIND_NAMES : typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.some((kind) => !Object.hasOwn(KINDS, kind))) {
    throw documentError('Unknown document kind.', 'DOCUMENT_INVALID_KIND'); // i18n: pending
  }
  return KIND_NAMES.filter((kind) => list.includes(kind));
}

function normalizeExtensions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXTENSIONS) {
    throw documentError('Companion extensions must be a non-empty list.', 'DOCUMENT_INVALID_EXTENSION'); // i18n: pending
  }
  const wanted = new Set();
  for (const item of value) {
    const extension = typeof item === 'string' ? `.${item.replace(/^\./, '').toLowerCase()}` : '';
    if (!/^\.[a-z0-9_]{1,32}$/.test(extension)) throw documentError('Invalid companion extension.', 'DOCUMENT_INVALID_EXTENSION'); // i18n: pending
    wanted.add(extension);
  }
  return wanted;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw documentError(`${name} must be a positive integer.`, 'DOCUMENT_INVALID_OPTIONS'); // i18n: pending
  return value;
}

// Platform aware (M01): case-insensitive only where the platform's volumes are (see identity.cjs).
const samePath = (a, b, platform) => ids.samePath(a, b, { platform });
// The same file under another spelling (case or Unicode normalisation on a volume that folds or normalises names): the same device
// and inode. Spelling alone cannot tell this, because a case-sensitive volume keeps two such names as two files with two inodes.
async function sameFile(left, right, fs) {
  try {
    const [a, b] = [await fs.stat(left), await fs.stat(right)];
    return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
// A plain Uint8Array over the read buffer's own ArrayBuffer (never the Buffer pool), safe to clone to the renderer.
const plainBytes = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

// The TextDecoder label of a byte-order-marked UTF-16 head (FF FE little endian, FE FF big endian), or null.
function utf16Label(head) {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return null;
}

// { format, unsafe }: the detected content format (or null), and whether an XML file was refused for
// declaring entities (B34; the root element comes from the prolog scanner the renderer sniffers share,
// electron/xml-prolog.mjs, so both sides reach the same verdict). Binary signatures first, then the text
// formats within the first 4 KiB. Byte-order-marked UTF-16 is sniffed as text too (O-27): its ASCII characters
// carry NUL bytes, which would refuse every such schematic here, while the schematic dispatcher re-encodes it as
// UTF-8 before parsing. Only the schematic formats are accepted from UTF-16: SVG stays UTF-8 only, because the
// image viewer reads ASCII-compatible markup alone (sniffImage in src/lib/images.ts).
function inspectContent(data) {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, SNIFF_WINDOW));
  const found = (format) => ({ format, unsafe: false });
  if (head.byteLength >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return found('png');
  if (head.byteLength >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return found('jpeg');
  if (head.byteLength >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return found('webp');
  const pdfAt = head.indexOf('%PDF-', 0, 'latin1');
  if (pdfAt >= 0 && pdfAt < PDF_HEADER_WINDOW) return found('pdf');
  if (isSchDoc(data)) return found('altium-sch');
  const utf16 = utf16Label(head);
  if (utf16 === null && head.includes(0)) return found(null);
  const text = (utf16 === null ? head.toString('utf8') : new TextDecoder(utf16).decode(head)).replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('(kicad_sch')) return found('kicad_sch');
  if (text.startsWith('EESchema Schematic File')) return found('eeschema');
  if (text.startsWith('EESchema-LIBRARY')) return found('eeschema-lib');
  if (text.startsWith('<')) {
    const xml = xmlRoot(text);
    if (xml && xml.unsafe) return { format: null, unsafe: true };
    if (xml && xml.root === 'svg' && utf16 === null) return found('svg');
    if (xml && xml.root === 'eagle') return found('eagle');
  }
  return found(null);
}

// Returns the detected content format or null.
function sniffContent(data) { return inspectContent(data).format; }

// Reads one document: { name, path, kind, format, data: Uint8Array, key: sha256 hex, size }.
async function readDocument(filename, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  const allowed = normalizeKinds(options.kinds);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  let handle;
  let release = null;
  try {
    const requested = localDocumentPath(filename, t);
    const canonical = localAbsolutePath(await fs.realpath(requested), t);
    const extension = path.extname(canonical).toLowerCase();
    const accepted = EXTENSION_CONTENT[extension];
    const kind = accepted ? CONTENT[accepted[0]].kind : null;
    if (!kind || !allowed.includes(kind)) {
      const list = allowed.flatMap((name) => KINDS[name].extensions).join(', ');
      throw documentError(t('native.error.documentUnsupportedType', { extension: extension || path.basename(canonical), allowed: list }), 'DOCUMENT_UNSUPPORTED_EXTENSION');
    }
    handle = await fs.open(canonical, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw documentError(t('native.error.notAFile'), 'DOCUMENT_NOT_A_FILE');
    if (stat.size > maxBytes) throw documentError(t('native.error.fileLimitExceeded'), 'DOCUMENT_TOO_LARGE');
    if (stat.size === 0) throw documentError(t('native.error.documentEmpty'), 'DOCUMENT_EMPTY');
    if (options.budget) release = await options.budget.acquire(stat.size); // Aggregate bound on concurrent reads.
    const buffer = await readBounded(handle, stat.size, maxBytes, t);
    const { format, unsafe } = inspectContent(buffer);
    if (unsafe) throw documentError(t('native.error.documentUnsafeXml'), 'DOCUMENT_UNSAFE_XML');
    if (!format || !accepted.includes(format)) {
      const detected = format ? contentLabel(format, t) : t('native.content.unrecognized');
      throw documentError(t('native.error.documentContentMismatch', { extension, detected }), 'DOCUMENT_CONTENT_MISMATCH');
    }
    return { name: path.basename(canonical), path: canonical, kind, format, data: plainBytes(buffer), key: sha256(buffer), size: buffer.byteLength };
  } catch (error) {
    throw mapError(error, t);
  } finally {
    if (handle) await handle.close();
    if (release) release();
  }
}

// Gathers sibling files of the selected file by extension, bounded by count and total bytes, each required to
// resolve inside the selected file's directory. Names: an exact lower-case name wins, a unique case variant is
// accepted, and several case variants with no exact name are all reported as duplicate names (see the loop).
// Returns { directory, files: Record<lowercase basename, Uint8Array>, skipped: { name, reason }[] }.
async function gatherCompanions(filename, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  const wanted = normalizeExtensions(options.extensions);
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES, 'maxFiles');
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_BYTES, 'maxTotalBytes');
  const maxBytes = positiveInteger(options.maxBytes, maxTotalBytes, 'maxBytes');
  const { platform } = options;
  let canonical, entries;
  try {
    canonical = localAbsolutePath(await fs.realpath(localDocumentPath(filename, t)), t);
    entries = await fs.readdir(path.dirname(canonical), { withFileTypes: true });
  } catch (error) {
    throw mapError(error, t);
  }
  const directory = path.dirname(canonical);
  const files = {};
  const skipped = [];
  let total = 0;
  let count = 0;
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Name policy, the same as for board sidecars (planCompanions): the entries of one lower-case name are decided together, so the outcome
  // never depends on the listing order. An entry spelled exactly in lower case is the companion; without one, a single case variant is the
  // companion; two or more variants with no exact spelling are ambiguous, so none is chosen and each is reported as a duplicate name.
  // Bytes are never attributed to a name that no entry spells exactly or uniquely.
  const groups = new Map();
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (!wanted.has(path.extname(lower))) continue;
    if (!groups.has(lower)) groups.set(lower, []);
    groups.get(lower).push(entry);
  }
  const chosen = new Set();
  for (const [lower, variants] of groups) {
    const exact = variants.find((entry) => entry.name === lower);
    if (exact !== undefined) chosen.add(exact);
    else if (variants.length === 1) chosen.add(variants[0]);
  }
  const selectedName = path.basename(canonical);
  // The skipped reasons are bounded (MAX_SKIPPED, then one overflow marker), but that bound limits only what is reported. The choice above
  // and the reading below do not depend on it: every chosen companion is read, up to maxFiles, however many rejected variants precede it.
  let overflowed = false;
  const reject = (name, reason) => {
    if (skipped.length < MAX_SKIPPED) skipped.push({ name, reason });
    else overflowed = true;
  };
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (!wanted.has(path.extname(lower))) continue;
    if (entry.name === selectedName) continue; // The selected file is not its own companion, and it is never reported.
    if (!chosen.has(entry)) { reject(entry.name, t('native.skipped.duplicateName')); continue; }
    if (entry.isDirectory()) { reject(entry.name, t('native.skipped.notAFile')); continue; }
    if (samePath(entry.name, selectedName, platform)) continue; // The selected file under its alias: the same identity rule as the realpath check below, and no file-system call.
    // The companion limit comes before any file-system call, so a crowded directory costs no more than its listing.
    if (count >= maxFiles) { reject(entry.name, t('native.skipped.fileLimit')); continue; }
    let handle;
    let release = null;
    try {
      // A Windows reparse point that is not a link is never opened: reading it can download it (a cloud placeholder) or fail (a dedup
      // file, an app execution link). A placeholder is recorded as 'online-only' so the user is told to open or attach it; anything else
      // as 'reparse point'. A link is resolved below, as before.
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
        const meta = await fs.lstat(path.join(directory, entry.name));
        if (!meta.isSymbolicLink()) {
          skipped.push({ name: entry.name, reason: isOnlineOnly(meta) ? 'online-only' : 'reparse point' });
          continue;
        }
      }
      const real = localAbsolutePath(await fs.realpath(path.join(directory, entry.name)), t);
      if (samePath(real, canonical, platform)) continue; // The selected file is not its own companion.
      // The same inode under another spelling (APFS folds case and normalises names), or a hard link to the selected file: the same file.
      // It is skipped without a notice, by decision (U-18), so that one file is not counted twice.
      if (await sameFile(real, canonical, fs)) continue;
      if (!samePath(path.dirname(real), directory, platform)) { reject(entry.name, 'outside the selected directory'); continue; }
      handle = await fs.open(real, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) { reject(entry.name, t('native.skipped.notAFile')); continue; }
      const budget = Math.min(maxBytes, maxTotalBytes - total);
      if (stat.size > budget) { reject(entry.name, 'size limit reached'); continue; }
      if (options.budget) release = await options.budget.acquire(stat.size);
      const buffer = await readBounded(handle, stat.size, budget, t);
      total += buffer.byteLength;
      count++;
      files[lower] = plainBytes(buffer);
    } catch (error) {
      reject(entry.name, error && error.code === 'STORE_CHANGED' ? 'changed while reading' : 'not readable');
    } finally {
      if (handle) await handle.close();
      if (release) release();
    }
  }
  if (overflowed) skipped.push({ name: '…', reason: t('native.skipped.moreFiles') });
  return { directory, files, skipped };
}

// ---------------------------------------------------------------------------------------------
// Selection: several documents in one call
// ---------------------------------------------------------------------------------------------

// Reads the chosen files one after the other: at most 16 files and 256 MiB in total (companions
// included), each file at most 64 MiB. A schematic carries the schematic files of its own directory
// (bounded in count and bytes, never through a link that leaves the directory) as companions.
async function readSelection(filenames, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  if (!Array.isArray(filenames)) throw documentError('The document selection must be a list.', 'DOCUMENT_INVALID_OPTIONS'); // i18n: pending
  if (filenames.length > MAX_SELECTION_FILES) {
    throw documentError(t('native.error.selectionTooMany', { max: MAX_SELECTION_FILES }), 'DOCUMENT_TOO_MANY');
  }
  const perFile = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  let remaining = positiveInteger(options.maxTotalBytes, MAX_SELECTION_BYTES, 'maxTotalBytes');
  const batchTooLarge = () => documentError(t('native.error.selectionTooLarge', { mib: Math.round(MAX_SELECTION_BYTES / 1048576) }), 'DOCUMENT_BATCH_TOO_LARGE');
  const payloads = [];
  for (const filename of filenames) {
    if (remaining <= 0) throw batchTooLarge();
    let payload;
    try {
      payload = await readDocument(filename, { ...options, maxBytes: Math.min(perFile, remaining) });
    } catch (error) {
      if (error && error.code === 'DOCUMENT_TOO_LARGE' && remaining < perFile) throw batchTooLarge();
      throw error;
    }
    remaining -= payload.size;
    if (payload.kind === 'schematic') {
      if (remaining > 0) {
        const gathered = await gatherCompanions(payload.path, {
          ...options, extensions: [...KINDS.schematic.extensions, '.prjpcb'], maxFiles: COMPANION_FILES, maxBytes: undefined,
          maxTotalBytes: Math.min(perFile, remaining),
        });
        const names = Object.keys(gathered.files);
        if (names.length) payload.companions = gathered.files;
        if (gathered.skipped.length) payload.skipped = gathered.skipped;
        for (const name of names) remaining -= gathered.files[name].byteLength;
      } else {
        payload.skipped = [{ name: '…', reason: t('native.error.skippedSizeLimit') }];
      }
    }
    payloads.push(payload);
  }
  return payloads;
}

// ---------------------------------------------------------------------------------------------
// Locating remembered documents
// ---------------------------------------------------------------------------------------------

// SHA-256 and size of a file read in fixed chunks (never the whole file in memory). A file that
// shrinks or grows while it is read is reported as changed instead of hashed.
async function hashFile(filename, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw documentError(t('native.error.notAFile'), 'DOCUMENT_NOT_A_FILE');
    if (stat.size > maxBytes) throw documentError(t('native.error.fileLimitExceeded'), 'DOCUMENT_TOO_LARGE');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.max(1, Math.min(HASH_CHUNK_BYTES, stat.size)));
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, stat.size - offset), offset);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const probe = offset === stat.size ? (await handle.read(Buffer.alloc(1), 0, 1, stat.size)).bytesRead : 0;
    if (offset !== stat.size || probe > 0) throw documentError(t('native.error.fileChangedWhileReading'), 'DOCUMENT_CHANGED');
    return { key: hash.digest('hex'), size: stat.size };
  } catch (error) {
    throw mapError(error, t);
  } finally {
    if (handle) await handle.close();
  }
}

// A stored relative path: '/'-separated segments below the board directory, never absolute, never
// '..', no empty or dot segments, no drive or stream separators. Returns the segments or null.
// On POSIX a backslash is an ordinary character of a name (a file name may hold one); on Windows it is a separator as well.
function relativeSegments(value, platform = process.platform) {
  const windows = platform === 'win32';
  return splitRelative(value, windows ? /[\\/]/ : '/', windows);
}

// The same path read with the backslash as a separator too, for a path written on Windows (docs\ref.pdf) that is read on POSIX. It is
// tried only when the literal name is not there (see locateOne). Null on Windows, where relativeSegments already splits on it.
function separatedRelativeSegments(value, platform = process.platform) {
  if (platform === 'win32' || typeof value !== 'string' || !value.includes('\\')) return null;
  return splitRelative(value, /[\\/]/, false);
}

// The refusals every reading shares, whatever the separator: absolute, drive-relative and stream forms, and any empty, dot or '..' segment.
function splitRelative(value, separator, windows) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32767 || value.includes('\0')) return null;
  if (/^[A-Za-z]:/.test(value) || value.startsWith('/') || (windows && value.startsWith('\\'))) return null;
  const segments = value.split(separator);
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes(':')) ? null : segments;
}

// Path of `filename` below `root` with '/' separators, or undefined when it is not inside the tree.
function relativeInside(root, filename) {
  if (!root) return undefined;
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const index = next++; results[index] = await work(items[index], index); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.id !== 'string' || request.id.length === 0 || request.id.length > 128 ||
      !Object.hasOwn(KINDS, request.kind) || typeof request.path !== 'string' || request.path.length > 32767 ||
      (request.relativePath !== undefined && (typeof request.relativePath !== 'string' || request.relativePath.length > 32767)) ||
      typeof request.key !== 'string' || !KEY_PATTERN.test(request.key)) {
    throw documentError('Invalid document locate request.', 'DOCUMENT_INVALID_REQUEST'); // i18n: pending
  }
  return request;
}

// Resolves the board directory the relative paths are anchored to; null when it is not available
// (only the absolute candidates are tried then).
async function boardRoot(boardPath, options) {
  const { t = identity, fs = defaultFs } = options;
  let board;
  try { board = localDocumentPath(boardPath, t); } catch (error) { throw mapError(error, t); }
  if (!formats.isSupportedExtension(board)) throw documentError(t('native.error.unsupportedFile'), 'DOCUMENT_INVALID_PATH');
  try { return localAbsolutePath(await fs.realpath(path.dirname(board)), t); } catch { return null; }
}

// One remembered document: tries the absolute path, then the path relative to the board directory
// (never leaving that tree), and verifies the SHA-256 of what it finds. A file with the remembered
// bytes wins ('ok' at the absolute path, 'moved' through the relative one); otherwise the first file
// found is reported as 'changed'. Only files of the request's kind (by extension) are considered.
async function locateOne(request, root, options) {
  const { t = identity, fs = defaultFs, platform } = options;
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const candidates = [];
  let problem = null;
  try { candidates.push({ via: 'path', filename: localAbsolutePath(request.path, t) }); } catch { /* No usable absolute path. */ }
  if (request.relativePath !== undefined && root) {
    const segments = relativeSegments(request.relativePath, platform);
    if (segments) candidates.push({ via: 'relative', filename: path.join(root, ...segments) });
    else problem = t('native.error.locateInvalidPath');
    const separated = separatedRelativeSegments(request.relativePath, platform);
    if (separated) candidates.push({ via: 'relative', separated: true, filename: path.join(root, ...separated) });
  }
  const kindExtensions = KINDS[request.kind].extensions;
  const seen = [];
  let changed = null;
  let literalFound = false;
  for (const candidate of candidates) {
    // The separated reading is a fallback: it is tried only when the literal name is not in the board folder.
    if (candidate.separated && literalFound) continue;
    let canonical;
    try {
      canonical = localAbsolutePath(await fs.realpath(candidate.filename), t);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      problem ??= mapError(error, t).message;
      continue;
    }
    if (candidate.via === 'relative' && !candidate.separated) literalFound = true;
    if (candidate.via === 'relative' && relativeInside(root, canonical) === undefined) {
      problem ??= t('native.error.locateOutsideBoard');
      continue;
    }
    if (seen.some((other) => samePath(other, canonical, platform))) continue;
    seen.push(canonical);
    if (!kindExtensions.includes(path.extname(canonical).toLowerCase())) {
      problem ??= t('native.error.locateWrongKind');
      continue;
    }
    let found;
    try {
      found = await hashFile(canonical, { t, fs, maxBytes });
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      problem ??= error.message;
      continue;
    }
    const relativePath = relativeInside(root, canonical);
    const where = { path: canonical, ...(relativePath === undefined ? {} : { relativePath }) };
    if (found.key === request.key) return { id: request.id, status: candidate.via === 'relative' ? 'moved' : 'ok', ...where, key: found.key, size: found.size };
    changed ??= { id: request.id, status: 'changed', ...where, key: found.key, size: found.size, message: t('native.error.locateContentChanged') };
  }
  if (changed) return changed;
  if (problem) return { id: request.id, status: 'unreadable', message: problem };
  return { id: request.id, status: 'missing' };
}

// Re-finds remembered documents (see locateOne) with bounded concurrency; results keep request order.
async function locateDocuments(boardPath, requests, options = {}) {
  if (!Array.isArray(requests) || requests.length > MAX_LOCATE_REQUESTS) {
    throw documentError(`At most ${MAX_LOCATE_REQUESTS} documents can be located at once.`, 'DOCUMENT_INVALID_REQUEST'); // i18n: pending
  }
  const checked = requests.map(validateRequest);
  const root = await boardRoot(boardPath, options);
  return mapLimit(checked, positiveInteger(options.concurrency, LOCATE_CONCURRENCY, 'concurrency'), (request) => locateOne(request, root, options));
}

// ---------------------------------------------------------------------------------------------
// Workspace export bundle
// ---------------------------------------------------------------------------------------------

// One zip segment that can neither climb out of its folder nor name a device or hidden file.
function safeFileName(name, fallback = 'file') {
  let base = String(name).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base) base = fallback;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(base)) base = `_${base}`;
  if (base.length > 120) {
    const extension = path.extname(base).slice(0, 16);
    base = base.slice(0, 120 - extension.length) + extension;
  }
  return base;
}

function uniqueName(name, taken) {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  for (let index = 2; taken.has(candidate.toLowerCase()); index++) candidate = `${stem} (${index})${extension}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function assertSafeZipName(name) {
  const segments = name.split('/');
  if (!name || name.startsWith('/') || /[\\\0]/.test(name) || segments.some((segment) => !segment || segment === '.' || segment === '..' || /^[A-Za-z]:/.test(segment))) {
    throw documentError('Unsafe name in the export bundle.', 'EXPORT_UNSAFE_NAME'); // i18n: pending
  }
  return name;
}

const defineValue = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
const COMPRESSED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.zip', '.tgz', '.gz', '.fz']);

// The manifest stored in the bundle: only the selected documents, paths relative to the bundle root
// (never an absolute local path), cameras/split restricted to what is included.
function bundleManifest(manifest, selected, entryNames, boardEntry) {
  const kept = new Set(selected.map((record) => record.id));
  const documents = selected.map((record) => {
    const { missing: _missing, ...rest } = record;
    return { ...rest, path: entryNames.get(record.id), relativePath: entryNames.get(record.id) };
  });
  const cameras = {};
  for (const key of Object.keys(manifest.cameras)) if (key === 'board' || kept.has(key)) defineValue(cameras, key, manifest.cameras[key]);
  const right = manifest.split.right && kept.has(manifest.split.right.id) ? manifest.split.right : null;
  return {
    ...manifest,
    board: { key: manifest.board.key, name: manifest.board.name, path: boardEntry ?? manifest.board.name, format: manifest.board.format },
    documents,
    split: { enabled: manifest.split.enabled && right !== null, ratio: manifest.split.ratio, right },
    cameras,
    ...(manifest.aliases ? { aliases: manifest.aliases } : {}),
  };
}

// The record of the temporaries a writer creates (electron/export-temporaries.cjs). The default records nothing, for callers that keep none.
const UNRECORDED = Object.freeze({ record: async () => {}, forget: async () => {} });

// Writes the zip next to its destination under a temporary name and renames it into place, so a
// failed export never leaves a partial file at the chosen path. Entries load lazily, one at a time.
// The final rename is retried a bounded number of times on EPERM/EACCES/EBUSY (W-win-lifecycle-01: on
// Windows a scanner or indexer holding the destination makes rename-over-existing fail for a moment);
// after the last attempt the temporary file is removed and the error is reported as before.
async function writeZipAtomically(fs, target, entries, fflate, renameDelaysMs, t = identity, temporaries = UNRECORDED) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  // Recorded before the file exists, so a crash from here on leaves a record for the next start. A record that cannot be written does not stop
  // the export (electron/export-temporaries.cjs logs it): the export is the user's action, the sweep is housekeeping.
  await temporaries.record(temporary);
  let handle;
  let bytes = 0;
  const pending = [];
  const zip = new fflate.Zip((error, chunk) => {
    if (error) pending.push(error);
    else pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  // FileHandle#write may legally accept fewer bytes than offered; the rest of the chunk is offered again. A count that
  // is not a positive integer within what was offered means the handle is not progressing: fail instead of guessing.
  const writeFully = async (chunk) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const offered = chunk.byteLength - offset;
      const { bytesWritten } = await handle.write(chunk, offset, offered);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > offered) {
        throw documentError(t('native.error.exportIncomplete'), 'EXPORT_WRITE_FAILED');
      }
      offset += bytesWritten;
      bytes += bytesWritten;
    }
  };
  const flush = async () => {
    for (const chunk of pending.splice(0)) {
      if (chunk instanceof Error) throw chunk;
      await writeFully(chunk);
    }
  };
  try {
    handle = await fs.open(temporary, 'wx');
    for (const entry of entries) {
      const data = await entry.load();
      const file = entry.deflate && data.byteLength <= DEFLATE_LIMIT_BYTES ? new fflate.ZipDeflate(entry.name, { level: 6 }) : new fflate.ZipPassThrough(entry.name);
      zip.add(file);
      file.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength), true);
      await flush();
    }
    zip.end();
    await flush();
    await handle.close();
    handle = undefined;
    try {
      await renameWithRetry(fs, temporary, target, renameDelaysMs);
    } catch (error) {
      // Only this step tells a held destination apart: the rename over it fails with EPERM on Windows (see mapExportError).
      if (error && typeof error === 'object') error.renameTarget = true;
      throw error;
    }
    await temporaries.forget(temporary); // renamed into place: nothing is left to sweep (forget never rejects)
    return bytes;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    // Forgotten only when the temporary is gone: one that could not be removed stays recorded for the next start.
    const gone = await fs.unlink(temporary).then(() => true, (unlinkError) => unlinkError?.code === 'ENOENT');
    if (gone) await temporaries.forget(temporary);
    throw error;
  }
}

// Bundles ONLY what was asked for: the documents named in `documentIds` (each re-read and verified
// against its remembered SHA-256), the board files when `includeBoard`, the notes when `notes` is given.
// `boardFiles` is the board payload of main.cjs readBoard (already verified against the manifest key).
// Layout: workspace.json, notes.json?, board/<file>..., documents/<file>... Originals are only read.
async function exportBundle(options) {
  const { manifest, notes = null, documentIds, includeBoard = false, boardFiles = null, t = identity, fs = defaultFs, platform } = options;
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, MAX_SELECTION_BYTES, 'maxTotalBytes');
  if (!Array.isArray(documentIds) || documentIds.length > MAX_LOCATE_REQUESTS || new Set(documentIds).size !== documentIds.length) {
    throw documentError('Invalid export document list.', 'EXPORT_INVALID_REQUEST'); // i18n: pending
  }
  if (includeBoard && (!Array.isArray(boardFiles) || boardFiles.length === 0)) throw documentError('The board files are required to include the board.', 'EXPORT_INVALID_REQUEST'); // i18n: pending
  const records = new Map(manifest.documents.map((record) => [record.id, record]));
  const selected = documentIds.map((id) => {
    const record = typeof id === 'string' ? records.get(id) : undefined;
    if (!record) throw documentError('The export names a document that is not in the workspace.', 'EXPORT_UNKNOWN_DOCUMENT'); // i18n: pending
    return record;
  });
  let target;
  try { target = localDocumentPath(options.target, t); } catch (error) { throw mapError(error, t); }
  const fflate = require('fflate');

  // Verify every selected document before anything is written.
  const root = await boardRoot(manifest.board.path, options);
  const located = await mapLimit(selected, LOCATE_CONCURRENCY, async (record) => {
    const result = await locateOne({ id: record.id, kind: record.kind, path: record.path, relativePath: record.relativePath, key: record.key }, root, { t, fs, platform });
    if (result.status !== 'ok' && result.status !== 'moved') {
      throw documentError(t('native.error.exportUnavailable', { name: safeFileName(record.name, 'document'), status: statusLabel(result.status, t), detail: result.message ? `: ${result.message}` : '' }), 'EXPORT_DOCUMENT_UNAVAILABLE');
    }
    return result;
  });

  const taken = new Set();
  const entryNames = new Map();
  const entries = [];
  const sources = [];
  let total = 0;
  const account = (bytes) => {
    total += bytes;
    if (total > maxTotalBytes) throw documentError(t('native.error.exportTooLarge', { mib: Math.round(maxTotalBytes / 1048576) }), 'EXPORT_TOO_LARGE');
  };
  const boardEntries = [];
  if (includeBoard) {
    const boardTaken = new Set();
    for (const file of boardFiles) {
      const name = assertSafeZipName(`board/${uniqueName(safeFileName(file.name), boardTaken)}`);
      if (file.primary) boardEntries.unshift(name); else boardEntries.push(name);
      account(file.data.byteLength);
      entries.push({ name, deflate: !COMPRESSED_EXTENSIONS.has(path.extname(name).toLowerCase()), load: () => file.data });
      if (file.path) sources.push(file.path);
    }
  }
  selected.forEach((record, index) => {
    const found = located[index];
    const name = assertSafeZipName(`documents/${uniqueName(safeFileName(path.basename(found.path)), taken)}`);
    entryNames.set(record.id, name);
    account(found.size);
    sources.push(found.path);
    entries.push({
      name, deflate: !COMPRESSED_EXTENSIONS.has(path.extname(name).toLowerCase()),
      load: async () => {
        const changedWhileExporting = (detail) => documentError(detail
          ? t('native.error.documentChangedExportingDetail', { name: safeFileName(record.name, 'document'), detail })
          : t('native.error.documentChangedExporting', { name: safeFileName(record.name, 'document') }), 'EXPORT_DOCUMENT_UNAVAILABLE');
        let document;
        try { document = await readDocument(found.path, { kinds: [record.kind], t, fs, maxBytes: found.size }); }
        catch (error) { throw changedWhileExporting(error && error.message); }
        if (document.key !== record.key) throw changedWhileExporting();
        return document.data;
      },
    });
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(bundleManifest(manifest, selected, entryNames, boardEntries[0]), null, 2)}\n`, 'utf8');
  const notesBytes = notes === null ? null : Buffer.from(`${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  account(manifestBytes.byteLength + (notesBytes ? notesBytes.byteLength : 0));
  const ordered = [
    { name: 'workspace.json', deflate: true, load: () => manifestBytes },
    ...(notesBytes ? [{ name: 'notes.json', deflate: true, load: () => notesBytes }] : []),
    ...entries,
  ];

  // The bundle may never replace one of the files it was built from.
  const existing = await fs.stat(target).catch((error) => {
    if (error && error.code === 'ENOENT') return null;
    throw mapExportError(error, t);
  });
  if (existing) {
    for (const source of sources) {
      const stat = await fs.stat(source).catch(() => null);
      if (samePath(source, target, platform) || (stat && stat.ino !== 0 && stat.dev === existing.dev && stat.ino === existing.ino)) {
        throw documentError(t('native.error.exportOverwritesSource'), 'EXPORT_OVERWRITES_SOURCE');
      }
    }
  }
  try {
    const bytes = await writeZipAtomically(fs, target, ordered, fflate, options.renameRetryDelaysMs, t, options.temporaries ?? UNRECORDED);
    return { path: target, files: ordered.length, bytes };
  } catch (error) {
    throw mapExportError(error, t);
  }
}

function mapExportError(error, t = identity) {
  const code = error && error.code;
  if (typeof code === 'string' && (code.startsWith('DOCUMENT_') || code.startsWith('EXPORT_'))) return error;
  if (typeof code === 'string' && code.startsWith('STORE_')) return mapError(error, t);
  // The destination is held by another program (O-07, W-win-lifecycle-03): the code stays EXPORT_WRITE_FAILED, the text says why.
  // A held destination fails the final rename with EPERM on Windows, so EPERM counts only from that step; any other EPERM stays generic.
  if (code === 'EBUSY' || (code === 'EPERM' && error.renameTarget)) return documentError(t('native.error.fileInUse'), 'EXPORT_WRITE_FAILED', error);
  return documentError(t('native.error.exportWriteFailed'), 'EXPORT_WRITE_FAILED', error);
}

// Filter definitions for dialog.showOpenDialog. One kind → its filter; several → a combined
// all-documents entry first, then one per kind. The names come from the translator (options.t).
function dialogFilters(kinds, options = {}) {
  const { t = identity } = options;
  const list = normalizeKinds(kinds);
  const filters = list.map((kind) => ({ name: kindLabel(kind, t), extensions: KINDS[kind].extensions.map((extension) => extension.slice(1)) }));
  if (list.length > 1) filters.unshift({ name: t('native.dialog.allDocuments'), extensions: filters.flatMap((filter) => filter.extensions) });
  return filters;
}
// The kind names of the dialog filters. The literal keys let the catalogue checks see them.
function kindLabel(kind, t) {
  switch (kind) {
    case 'pdf': return t('native.dialog.kindPdf');
    case 'image': return t('native.dialog.kindImage');
    case 'schematic': return t('native.dialog.kindSchematic');
    default: return kind;
  }
}

module.exports = Object.freeze({
  DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, MAX_SELECTION_FILES, MAX_SELECTION_BYTES, KINDS,
  readDocument, readSelection, gatherCompanions, locateDocuments, hashFile, exportBundle, relativeSegments,
  dialogFilters, sniffContent, safeFileName,
});
