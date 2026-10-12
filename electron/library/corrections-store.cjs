'use strict';

// Durable store of the Library device corrections (src/lib/library/devices/corrections.ts), kept by the main process.
//
// WHERE: <userData>/library/devices/corrections.json. The directory is the application's own data folder, never a Library root and
// never inside one (the constructor refuses it). Nothing is written to a scanned folder, and no scanned file is ever touched.
//
// FILE FORMAT: the text produced by serializeCorrections(): { "version": 1, "platform": ..., "corrections": [...] }. Only relative
// identity paths and opaque root ids are stored (no absolute path is ever written by this module).
//
// GUARANTEES
//  - Atomic write: the body goes to a unique temporary file (flag 'wx', mode 0o600), is fsynced, then renamed over the target.
//    On Windows the rename replaces an existing file (Node uses MoveFileEx with MOVEFILE_REPLACE_EXISTING); a transient EPERM/EACCES/EBUSY
//    (antivirus, indexer, preview pane holding the file) is retried by renameWithRetry. A failed write removes its temporary file and the
//    previous document stays exactly as it was. On POSIX the directory is fsynced after the rename (best effort).
//  - A kill at any instant leaves either the previous document or the new one at the target path, plus at most one stale temporary file.
//    Stale temporary files of this store are removed on the next load; they are never read.
//  - Damaged file (not JSON, wrong version field, bad platform): the file is renamed aside to corrections.quarantine-<time>-<id>.json (its bytes
//    are kept unchanged), the load returns an empty document with status 'quarantined' and the quarantine file name, so the caller can
//    show that a repair happened. A damaged file that cannot be renamed aside blocks saves (status 'unpreserved'), so it is never overwritten.
//  - Versioning: a file whose version is newer than CORRECTIONS_VERSION is left untouched (status 'newer-schema') and blocks saves, so an older
//    application never overwrites data it cannot read. Unreadable or oversized files block saves the same way (status 'unreadable' / 'too-large').
//  - Invalid entries inside an otherwise valid document are dropped by parseCorrections and reported in `dropped`.
//  - Every save is verified before it is written: the serialized text must parse back with no dropped entries, otherwise the save is refused.
//  - All operations run in one FIFO queue, so two saves never interleave.
//
// Errors carry a stable `code` (STORE_*); messages are internal and never shown to the user.

const defaultFs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readBounded, renameWithRetry, storeError } = require('../store.cjs');

const DIRECTORY_SEGMENTS = Object.freeze(['library', 'devices']);
const FILE_NAME = 'corrections.json';
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
// Mirrors corrections.ts (kept here so the main process needs no import of the renderer module tree).
const SUPPORTED_VERSION = 1;
const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
const MAX_CORRECTIONS = 50_000;
const BLOCKING = Object.freeze(new Set(['newer-schema', 'too-large', 'unreadable', 'unpreserved']));

function emptyDocument(platform) {
  return { version: SUPPORTED_VERSION, platform, corrections: [] };
}

/** STORE_INVALID_DOCUMENT with the refusal reason from the codec (a closed code list, see REJECTION_REASONS in corrections.ts). */
function invalidDocument(reason) {
  const error = storeError('the document does not validate', 'STORE_INVALID_DOCUMENT');
  if (reason !== undefined) error.reason = reason;
  return error;
}

/**
 * createCorrectionsStore({ userDataDirectory, platform, fs, libraryRoots, maxBytes, renameDelaysMs, now, random, codec })
 *  load()  -> { status, document, dropped, rejections, quarantine? }   status: empty | ok | quarantined | newer-schema | too-large | unreadable | unpreserved
 *  save(document) -> resolves when the new document is durably in place; rejects with a STORE_* code otherwise.
 */
function createCorrectionsStore(options = {}) {
  const {
    userDataDirectory,
    codec,
    platform = process.platform,
    fs = defaultFs,
    libraryRoots = [],
    maxBytes = DEFAULT_MAX_BYTES,
    renameDelaysMs,
    now = () => new Date(),
    random = () => randomUUID(),
  } = options;

  // `codec` is { parseCorrections, serializeCorrections } from src/lib/library/devices/corrections.ts. It is injected, not imported,
  // because the main process needs a CommonJS form of that module graph (see the open items of the lib-devices store report).
  if (codec === null || typeof codec !== 'object' || typeof codec.parseCorrections !== 'function' || typeof codec.serializeCorrections !== 'function') {
    throw storeError('a correction codec is required', 'STORE_INVALID_OPTIONS');
  }
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory) || userDataDirectory.includes('\0')) {
    throw storeError('invalid user data directory', 'STORE_INVALID_PATH');
  }
  if (!PLATFORMS.includes(platform)) throw storeError('unsupported platform', 'STORE_INVALID_OPTIONS');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw storeError('maxBytes must be a positive integer', 'STORE_INVALID_OPTIONS');

  const directory = path.join(path.resolve(userDataDirectory), ...DIRECTORY_SEGMENTS);
  for (const root of libraryRoots) {
    const relation = path.relative(path.resolve(root), directory);
    // The data directory must not be a Library root, nor inside one.
    if (relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))) {
      throw storeError('the corrections directory must not be inside a Library root', 'STORE_INVALID_PATH');
    }
  }
  const filePath = path.join(directory, FILE_NAME);

  let queue = Promise.resolve();
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  // Reads the target: { kind: 'missing' } | { kind: 'bytes', text } | { kind: 'unreadable' } | { kind: 'too-large' }.
  async function readTarget() {
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unreadable' };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { kind: 'unreadable' };
      if (stat.size > maxBytes) return { kind: 'too-large' };
      const buffer = await readBounded(handle, stat.size, maxBytes);
      return { kind: 'bytes', text: buffer.toString('utf8').replace(/^﻿/, '') };
    } catch {
      return { kind: 'unreadable' };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // Classifies the text of the target: 'valid' with the parsed result, 'damaged', or 'newer-schema'.
  function classify(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return { verdict: 'damaged' };
    }
    if (raw !== null && typeof raw === 'object' && Number.isInteger(raw.version) && raw.version > SUPPORTED_VERSION) return { verdict: 'newer-schema' };
    const parsed = codec.parseCorrections(text);
    if (parsed.error !== undefined) return { verdict: 'damaged' };
    return { verdict: 'valid', parsed };
  }

  async function removeStaleTemporaries() {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(`${FILE_NAME}.`) && name.endsWith('.tmp')) await fs.unlink(path.join(directory, name)).catch(() => {});
    }
  }

  // Moves a damaged target aside. Returns the quarantine name, or undefined when the target could not be moved.
  async function quarantineTarget() {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const name = `corrections.quarantine-${stamp}-${random().replace(/-/g, '').slice(0, 12)}.json`;
    try {
      await renameWithRetry(fs, filePath, path.join(directory, name), renameDelaysMs);
      return name;
    } catch {
      return undefined;
    }
  }

  // Inspects the target and settles what the store may do: returns the load result, performing a quarantine when the file is damaged.
  async function inspect() {
    await removeStaleTemporaries();
    const target = await readTarget();
    if (target.kind === 'missing') return { status: 'empty', document: emptyDocument(platform), dropped: 0 };
    if (target.kind === 'too-large') return { status: 'too-large', document: null, dropped: 0 };
    if (target.kind === 'unreadable') return { status: 'unreadable', document: null, dropped: 0 };
    const { verdict, parsed } = classify(target.text);
    if (verdict === 'newer-schema') return { status: 'newer-schema', document: null, dropped: 0 };
    if (verdict === 'valid') return { status: 'ok', document: parsed.document, dropped: parsed.dropped, rejections: parsed.rejections };
    const quarantine = await quarantineTarget();
    if (quarantine === undefined) return { status: 'unpreserved', document: null, dropped: 0 };
    return { status: 'quarantined', document: emptyDocument(platform), dropped: 0, quarantine };
  }

  async function syncDirectory() {
    if (platform === 'win32') return; // Directories cannot be opened for fsync on Windows.
    let handle;
    try {
      handle = await fs.open(directory, 'r');
      await handle.sync();
    } catch {
      // Best effort: some file systems refuse directory fsync.
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function atomicWrite(body) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `${FILE_NAME}.${process.pid}.${random().replace(/-/g, '')}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await renameWithRetry(fs, temporary, filePath, renameDelaysMs);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw storeError('the corrections could not be saved', 'STORE_WRITE_FAILED', error);
    }
    await syncDirectory();
  }

  function load() {
    return enqueue(async () => {
      const result = await inspect();
      const { document, dropped, status, quarantine } = result;
      const out = { status, document, dropped, rejections: result.rejections ?? [] };
      if (quarantine !== undefined) out.quarantine = quarantine;
      return out;
    });
  }

  function save(document) {
    return enqueue(async () => {
      if (document === null || typeof document !== 'object' || !Array.isArray(document.corrections)) {
        throw storeError('the document is not a correction document', 'STORE_INVALID_DOCUMENT');
      }
      // A document beyond the cap is refused, never truncated: serializeCorrections would otherwise drop the extra entries silently.
      if (document.corrections.length > MAX_CORRECTIONS) {
        throw invalidDocument('too-many');
      }
      const body = codec.serializeCorrections({ version: SUPPORTED_VERSION, platform: document.platform, corrections: document.corrections });
      const check = codec.parseCorrections(body);
      if (check.error !== undefined || check.dropped !== 0 || check.document.corrections.length !== document.corrections.length) {
        // The codec's first refusal reason is passed on unchanged; the codec owns the closed list of reasons.
        throw invalidDocument(check.rejections !== undefined && check.rejections.length > 0 ? check.rejections[0].reason : undefined);
      }
      if (Buffer.byteLength(body, 'utf8') > maxBytes) throw storeError('the document is too large', 'STORE_TOO_LARGE');
      const current = await inspect();
      if (BLOCKING.has(current.status)) throw storeError(`saving is blocked: ${current.status}`, 'STORE_BLOCKED');
      // Entries the codec refused on load are not in the new document. The file that holds them is moved aside first, under its
      // quarantine name (the same mechanism as a damaged file), so they are kept byte-for-byte and never disappear on a save.
      // The codec's reason for each refused entry is recomputed from that file on any load.
      // The result names the quarantine file by its base name only (never a full path) and counts the entries it holds.
      let quarantine;
      let quarantinedEntries = 0;
      if (current.status === 'ok' && Array.isArray(current.rejections) && current.rejections.length > 0) {
        quarantine = await quarantineTarget();
        if (quarantine === undefined) throw storeError('the refused entries could not be preserved; saving is blocked', 'STORE_BLOCKED');
        quarantinedEntries = current.rejections.length;
      }
      await atomicWrite(body);
      return quarantine === undefined
        ? { status: 'saved', bytes: Buffer.byteLength(body, 'utf8') }
        : { status: 'saved', bytes: Buffer.byteLength(body, 'utf8'), quarantine, quarantinedEntries };
    });
  }

  return Object.freeze({ directory, filePath, load, save });
}

module.exports = Object.freeze({
  createCorrectionsStore, DIRECTORY_SEGMENTS, FILE_NAME, DEFAULT_MAX_BYTES, MAX_CORRECTIONS,
});
