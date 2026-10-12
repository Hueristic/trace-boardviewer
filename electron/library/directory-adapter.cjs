'use strict';

// Read-only directory port for the device catalogue (Library), used by the native main process only.
//
// It implements the DirectoryPort contract of src/lib/library/devices/folder-map.ts:
//   readDir(segments) -> [{ name, kind: 'file' | 'dir' | 'link' | 'other' | 'unknown', size?, code? }]
// where `segments` is the path relative to the selected root (`[]` is the root itself).
//
// Guarantees
//  - Read-only. Only readdir, lstat and realpath are used (the injected fs object offers nothing else). File contents are
//    never opened. Nothing is written, renamed, moved or deleted.
//  - Root resolved once. The root is resolved with realpath when the port is created; that canonical path is the boundary
//    for the whole scan. The root itself is re-checked on every listing, so a root replaced by a link later is refused.
//  - Links are not followed. An entry that lstat reports as a symbolic link (a POSIX symlink, or a Windows junction, which
//    Node reports the same way) is returned as kind 'link' and its contents are never listed. Any other Windows reparse point
//    (cloud placeholder, dedup, app execution link, volume mount) is returned as kind 'reparse': readdir reports it as a link,
//    lstat may report a plain directory or fail, and it is neither followed nor read. A path whose ancestor is a
//    link is refused with ADAPTER_LINK, even when the link points back inside the root. Every component of the path (the root
//    included) is lstat-ed on every listing; no ancestor is trusted from an earlier listing, so a verified folder replaced by a
//    junction is refused by the chain check even where realpath would not catch it (an injected fs, or a platform whose realpath
//    does not expose the swap). On NTFS a real junction swap is also refused by the realpath check; the chain check makes that
//    refusal explicit (ADAPTER_LINK) and does not depend on it.
//  - Root-bound, before and after. Segments are single names (no '.', '..', separators, drive or alternate-stream markers on
//    win32). The realpath of a folder must equal the canonical root joined with the segments both before its listing and
//    after it. A folder replaced by a link (or moved outside the root) while the listing runs is refused with
//    ADAPTER_ESCAPES_ROOT, and no entries are returned.
//  - Folder failures throw. A failed readdir, or a failed ancestor check, rejects that folder. The walker records the folder as
//    unreadable and the map as incomplete.
//  - Entry failures are local. A failed lstat for one entry (denied, or vanished between readdir and lstat) yields kind
//    'unknown' for that entry only, with `code` set to the system error code (EPERM, EACCES, ENOENT ...; 'UNKNOWN' when the error
//    has none). The other entries of the folder are still returned. The walker records the entry as unknown, with the code, and
//    the map as incomplete, so absence is never claimed for it.
//
// Limits: the walker owns depth and entry limits. This adapter does not truncate listings.
//
// Platform notes (what this module assumes, and what was verified where; see the report for the evidence):
//  - win32: junction and symbolic-link entries are reported as links by lstat (verified on NTFS with a junction). Names are
//    compared case-insensitively in the root-bound check. Creating file symbolic links needs a privilege that the verifying
//    machine did not grant, so that case is not verified there.
//  - darwin: names are compared exactly in the root-bound check. A darwin volume may be case-sensitive, where two names that
//    differ only by case are two folders, so folding case here could accept a folder that resolves to its case-only sibling.
//    The expected path and the realpath are both built from the same realpath output and the on-disk names, so an exact
//    comparison holds on a case-insensitive volume too. Finder aliases are regular files
//    and are listed as files; they are not followed. Not run natively in the verifying environment.
//    Unicode normalisation (NFC against NFD names) is not handled: on darwin the root-bound comparison is byte-exact, and on
//    win32 it is byte-exact apart from case.
//    The adapter only receives names that readdir returned, so the on-disk form is always used; a caller that passes a
//    different normalisation of the same name would be refused (ESCAPES_ROOT). Not reachable from the current caller, not
//    tested on macOS.
//  - linux: names are compared exactly. Symbolic links are detected by lstat. Not run natively in the verifying environment.
//  - Cloud placeholder files (for example OneDrive or iCloud evicted files) are returned as kind 'file' with online: true: their
//    name and size come from the metadata, and their content is never read (electron/placeholder.cjs says which files they are).
//    Other reparse points, and placeholder folders, are returned as kind 'reparse' and not listed; the walker records them as
//    skipped and the map as incomplete.
//  - Paths longer than the Windows legacy limit depend on the process long-path setting; this module does not add a prefix.
//
// Concurrency: one adapter instance is meant for one scan. Nothing is cached between listings. A swap that happens between the
// checks and the readdir is caught by the realpath check after the listing, and the listing is then discarded.
// Each entry is checked again after the listing (TB-038): a link or a reparse point is resolved, and one whose real place is outside
// the root is returned as a link with the code ADAPTER_ESCAPES_ROOT, so the walker records it as skipped. A cloud placeholder that is
// online only is never resolved: its name and size come from the metadata. RESIDUAL WINDOW (accepted, TB-038): a swap that is made
// and undone between the ancestor check and the listing, or between the listing and the entry check, is not seen; names from outside
// the root could then be returned in that window. Node offers no handle-based listing, so closing it fully needs a native helper (a
// later item). The walk is limited to what the user chose: the root is picked by the user, only names, kinds and sizes are returned,
// and no file content is ever read or written. See docs/LIBRARY-LIMITS.md.
//
// Decided (root, W16): ADAPTER_LINK is the refusal for a link at any path component, including the root. Every listing lstat-s
// the whole path; no ancestor is cached.

const nodeFs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { isOnlineOnly } = require('../placeholder.cjs');

const MAX_SEGMENTS = 64;
const MAX_NAME_LENGTH = 255;
const LSTAT_BATCH = 32;

const ADAPTER_CODES = Object.freeze({
  ROOT: 'ADAPTER_ROOT',
  ROOT_NOT_DIRECTORY: 'ADAPTER_ROOT_NOT_DIRECTORY',
  INVALID_SEGMENT: 'ADAPTER_INVALID_SEGMENT',
  LINK: 'ADAPTER_LINK',
  NOT_DIRECTORY: 'ADAPTER_NOT_DIRECTORY',
  ESCAPES_ROOT: 'ADAPTER_ESCAPES_ROOT',
});

const defaultFs = Object.freeze({
  readdir: fsPromises.readdir,
  lstat: fsPromises.lstat,
  realpath: promisify(nodeFs.realpath.native),
});

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Closed set of diagnostic codes. A system error code outside this set, a message or a path is reported as 'UNKNOWN'.
// The same set is mirrored in src/lib/library/devices/folder-map.ts (diagnosticCodeOf); change both together.
const DIAGNOSTIC_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ENAMETOOLONG', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EINVAL',
  'ADAPTER_ROOT', 'ADAPTER_ROOT_NOT_DIRECTORY', 'ADAPTER_INVALID_SEGMENT', 'ADAPTER_LINK', 'ADAPTER_NOT_DIRECTORY', 'ADAPTER_ESCAPES_ROOT',
  'UNKNOWN',
]);
function diagnosticCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return DIAGNOSTIC_CODES.has(code) ? code : 'UNKNOWN';
}

// Validates a relative path given as names. Rejects anything that is not one plain name per segment.
function checkSegments(segments, platform) {
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
    throw adapterError(ADAPTER_CODES.INVALID_SEGMENT, 'segments must be an array of at most 64 names');
  }
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '' || segment === '.' || segment === '..' || segment.length > MAX_NAME_LENGTH) {
      throw adapterError(ADAPTER_CODES.INVALID_SEGMENT, 'a segment must be a plain name');
    }
    if (segment.includes('/') || segment.includes('\0')) {
      throw adapterError(ADAPTER_CODES.INVALID_SEGMENT, 'a segment must not contain a separator');
    }
    // Windows: "\" separates segments, ":" starts a drive or an alternate data stream.
    if (platform === 'win32' && /[\\:]/.test(segment)) {
      throw adapterError(ADAPTER_CODES.INVALID_SEGMENT, 'a segment must not contain a backslash or colon on win32');
    }
  }
}

/**
 * Opens a read-only port rooted at `root`. The root is resolved once with realpath, because the user chose it explicitly;
 * every folder below it is checked and never followed through a link.
 *
 * @param {{ root: string, platform?: string, fs?: { readdir: Function, lstat: Function, realpath: Function } }} options
 */
async function createDirectoryPort({ root, platform = process.platform, fs = defaultFs } = {}) {
  if (typeof root !== 'string' || root === '' || !path.isAbsolute(root)) {
    throw adapterError(ADAPTER_CODES.ROOT, 'root must be an absolute path');
  }
  const rootPath = await fs.realpath(root);
  const rootStat = await fs.lstat(rootPath);
  if (!rootStat.isDirectory()) {
    throw adapterError(ADAPTER_CODES.ROOT_NOT_DIRECTORY, 'root is not a directory');
  }

  // Only win32 folds case (NTFS). Exact on darwin and linux, whose volumes may be case-sensitive (see the platform notes above).
  const foldCase = platform === 'win32';
  const sameLocation = (left, right) => (foldCase ? left.toLowerCase() === right.toLowerCase() : left === right);

  // Walks the path from the root down, lstat-ing every component (the root included) on every listing. Nothing is cached:
  // a folder that was a real directory when it was verified can later be replaced by a link. The realpath check would refuse
  // most of these, but it compares only resolved names, so the link itself must be seen by lstat.
  // Cost per listing: depth + 1 lstat calls for the chain (measured on NTFS in the report).
  // The components are lstat-ed concurrently (same count, lower latency). The outcomes are read in path order, so the first
  // component that is a link (or not a directory) decides, even when a deeper lstat failed because it runs through that link.
  async function assertRealChain(segments) {
    const chain = [rootPath];
    for (let depth = 1; depth <= segments.length; depth++) chain.push(path.join(chain[depth - 1], segments[depth - 1]));
    const outcomes = await Promise.allSettled(chain.map(component => fs.lstat(component)));
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason;
      if (outcome.value.isSymbolicLink()) throw adapterError(ADAPTER_CODES.LINK, 'a link is not followed');
      if (!outcome.value.isDirectory()) throw adapterError(ADAPTER_CODES.NOT_DIRECTORY, 'a path segment is not a directory');
    }
    return chain[chain.length - 1];
  }

  // Classifies one entry of a listing without opening it. lstat, so a link is never followed to its target. A reparse point of
  // another kind is 'reparse' when the listing's file type says it is a link and lstat does not: lstat reports a cloud placeholder
  // as a plain directory and fails for some others, so lstat alone cannot tell them apart. A failed lstat makes this one entry
  // 'unknown' with a diagnostic code (a reparse point that cannot be inspected is 'reparse' without one); the rest of the folder
  // is still listed.
  // True when a resolved path names a place inside the root (the root itself included); case is folded where the platform folds it.
  function insideRoot(resolved) {
    const fold = (value) => (foldCase ? value.toLowerCase() : value);
    const base = fold(rootPath);
    const target = fold(resolved);
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  }

  // A link or a reparse point whose real place is outside the root. A failed resolution proves nothing, so it is not an escape: the
  // entry stays a link (never followed) or a reparse point.
  async function resolvesOutsideRoot(directory, name) {
    try {
      return !insideRoot(await fs.realpath(path.join(directory, name)));
    } catch {
      return false;
    }
  }

  async function describe(directory, item) {
    const name = typeof item === 'string' ? item : item.name;
    const reparse = typeof item !== 'string' && item.isSymbolicLink();
    let stat;
    try {
      stat = await fs.lstat(path.join(directory, name));
    } catch (error) {
      if (reparse) {
        if (await resolvesOutsideRoot(directory, name)) return { name, kind: 'link', code: ADAPTER_CODES.ESCAPES_ROOT };
        return { name, kind: 'reparse' };
      }
      return { name, kind: 'unknown', code: diagnosticCode(error) };
    }
    if (stat.isSymbolicLink()) {
      // Never followed. One that resolves outside the root is returned with its code, so the walker records the refusal.
      if (await resolvesOutsideRoot(directory, name)) return { name, kind: 'link', code: ADAPTER_CODES.ESCAPES_ROOT };
      return { name, kind: 'link' };
    }
    if (reparse) {
      // An online-only file (electron/placeholder.cjs) keeps its name and size and is not resolved; any other reparse point is resolved
      // like a link, and stays 'reparse' unless it resolves outside the root.
      if (isOnlineOnly(stat)) return { name, kind: 'file', size: stat.size, online: true };
      if (await resolvesOutsideRoot(directory, name)) return { name, kind: 'link', code: ADAPTER_CODES.ESCAPES_ROOT };
      return { name, kind: 'reparse' };
    }
    if (stat.isDirectory()) return { name, kind: 'dir' };
    if (stat.isFile()) return { name, kind: 'file', size: stat.size };
    return { name, kind: 'other' };
  }

  // The folder must still resolve to the expected place inside the root. Used before and after the listing.
  async function assertInsideRoot(directory, segments) {
    const resolved = await fs.realpath(directory);
    const expected = path.join(rootPath, ...segments);
    if (!sameLocation(resolved, expected)) {
      throw adapterError(ADAPTER_CODES.ESCAPES_ROOT, 'a folder resolves outside the root and is not listed');
    }
  }

  async function readDir(segments) {
    checkSegments(segments, platform);
    const directory = await assertRealChain(segments);
    // The folder's realpath is checked as the last call before readdir (no other fs call in between). The window that
    // remains is the asynchronous gap between this check and the readdir system call; closing it needs a directory handle
    // (open security item, see the header).
    await assertInsideRoot(directory, segments);
    // Listed with file types: the type of a reparse point is 'link' here, at no extra call (see describe).
    const items = await fs.readdir(directory, { withFileTypes: true });
    const entries = [];
    for (let start = 0; start < items.length; start += LSTAT_BATCH) {
      const batch = items.slice(start, start + LSTAT_BATCH);
      const described = await Promise.all(batch.map(item => describe(directory, item)));
      for (const entry of described) entries.push(entry);
    }
    // The listing is returned only if the folder still resolves to the expected place inside the root after it was read.
    await assertInsideRoot(directory, segments);
    return entries;
  }

  return Object.freeze({ root: rootPath, readDir });
}

module.exports = Object.freeze({ createDirectoryPort, ADAPTER_CODES, MAX_SEGMENTS, MAX_NAME_LENGTH });
