'use strict';

// Main-process bridge of the device catalogue (Library). It is the only place where the renderer's device requests meet the file
// system. Operations:
//   pickRoot() / listRoots() / removeRoot({rootId})   the persisted list of Library roots (userData, see below).
//   scan({rootIds, steps?, skipFolders?})            runs the catalogue pipeline read-only; returns counts only.
//   cancelScan()                                     aborts the running scan (the pipeline checks the signal at every folder).
//   listFolders({rootId, parentId?, cursor?, limit?}) the folder tree of the last scan, one level at a time, paged.
//   listBoards({rootId, cursor?, limit?})            the boards that have files under the root, paged; each row carries the board code and
//                                                    revision of its anchor (the board anchor source, see below).
//   boardDetail({boardId})                           one board: its boardview and BIOS presence, and its files (ids and roles).
//   loadCorrections() / saveCorrections(doc)         the durable corrections (userData, through corrections-store.cjs).
//
// Board anchors come from a BoardAnchorSource port (see src/lib/library/devices/anchor-source.ts): anchorsFor(scan) for matching and
// describe(anchorId) for the board code and revision. The default source derives anchors from the scanned boardview file names; the
// Library database implements the same port later and is injected through the `anchorSource` option. Presence is always file evidence.
//
// What the renderer can and cannot do
//  - It never names a path. A root is referred to by the opaque id pickRoot returned; folders, boards and files by the opaque ids of
//    the last scan. Those ids are fresh for every scan; a stale cursor or id is refused with a fixed code.
//  - Requests use a closed schema: unknown keys, wrong types and out-of-range values are refused before any work starts.
//  - Results contain counts, opaque ids and file-derived board identifiers (board code and revision) only. No absolute path, no file
//    or folder name and no file system error text crosses the bridge; failures carry a fixed LIBRARY_* code and a fixed message.
//  - A value the scan did not measure is reported as 'unknown', never as false. The `network` flag is not measured by this bridge, so it
//    is always 'unknown'; `online` is measured (the recorded realpath can be resolved now).
//  - No file is written in a Library root. The writes are under userData: the corrections, the root key, the root list.
//  - No network is used. One scan runs at a time.
//
// Root ids and the root list (stable across sessions)
//  - The id is an HMAC-SHA256 of the canonical realpath (lower-cased on win32 only), keyed with a random per-install key stored as
//    userData/library/devices/root-key.bin. The same folder therefore gets the same id after a restart, so corrections (which name
//    their files by root id) keep their target. The id reveals nothing about the path, and the key never leaves the main process.
//  - A darwin volume may be case-sensitive, so two folders whose names differ only by case are two roots. Only the same spelling, or
//    on darwin the same file-system object (device and inode), names one root. Ids that earlier releases recorded on darwin from the
//    lower-cased path stay valid for the entries that hold them (legacyDarwinRootId); a new darwin root gets the id of its exact path.
//  - The root list (id, realpath, label) is kept in userData/library/devices/roots.json, written atomically. An entry whose id does
//    not match the key is dropped. A damaged list is moved aside with its bytes kept, and nothing is overwritten.
//  - A key file that cannot be read or has the wrong length is never replaced silently (that would orphan every correction).
//
// Anchors: the board anchors of matching are derived from the scanned boardview files (board code and revision; see catalogue.ts
// deriveBoardAnchors). The source of the application is the Library board store (electron/library/board-store.cjs): it records the
// boards of every scan under userData, answers the scan's own anchors, and gives the board code and revision of a board. Without an
// injected source the file-name default is used (tests).
//
// Corrections status: a damaged corrections file is moved aside by the store (its bytes are kept) and the load returns an empty
// document. The bridge reports status 'quarantined' for the rest of the session (until a save succeeds), without the file name.
//
// Error codes start the message as "[CODE] text" (the preload strips the wrapper and the code survives the context bridge).

const path = require('node:path');
const fsSync = require('node:fs');
const fsPromises = require('node:fs/promises');
const { promisify } = require('node:util');
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const { createDirectoryPort } = require('./directory-adapter.cjs');
const { createCorrectionsStore, MAX_CORRECTIONS, DIRECTORY_SEGMENTS } = require('./corrections-store.cjs');
const { renameWithRetry } = require('../store.cjs');

const BRIDGE_CODES = Object.freeze({
  INVALID_REQUEST: 'LIBRARY_INVALID_REQUEST',
  UNKNOWN_ROOT: 'LIBRARY_UNKNOWN_ROOT',
  UNKNOWN_FOLDER: 'LIBRARY_UNKNOWN_FOLDER',
  UNKNOWN_BOARD: 'LIBRARY_UNKNOWN_BOARD',
  RESERVED_ROOT: 'LIBRARY_RESERVED_ROOT',
  TOO_MANY_ROOTS: 'LIBRARY_TOO_MANY_ROOTS',
  ROOT_UNAVAILABLE: 'LIBRARY_ROOT_UNAVAILABLE',
  ROOTS_UNAVAILABLE: 'LIBRARY_ROOTS_UNAVAILABLE',
  NOT_SCANNED: 'LIBRARY_NOT_SCANNED',
  STALE_CURSOR: 'LIBRARY_STALE_CURSOR',
  BUSY: 'LIBRARY_BUSY',
  CANCELLED: 'LIBRARY_CANCELLED',
  SCAN_FAILED: 'LIBRARY_SCAN_FAILED',
  KEY_UNAVAILABLE: 'LIBRARY_KEY_UNAVAILABLE',
  CORRECTIONS_BLOCKED: 'LIBRARY_CORRECTIONS_BLOCKED',
  CORRECTIONS_FAILED: 'LIBRARY_CORRECTIONS_FAILED',
  UNKNOWN_FILE: 'LIBRARY_UNKNOWN_FILE',
  NO_SCAN: 'LIBRARY_NO_SCAN',
  UNSUPPORTED_PLATFORM: 'LIBRARY_UNSUPPORTED_PLATFORM',
});

const CORRECTIONS_VERSION = 1; // Mirrors devices/corrections.ts and corrections-store.cjs.
// The codec's closed list of refusal reasons (devices/corrections.ts RejectReason). Only these codes reach the renderer.
const REJECT_REASONS = Object.freeze(['invalid-entry', 'unknown-role', 'path-too-long', 'invalid-relative-path', 'too-many']);
const ROOTS_VERSION = 1;
const MAX_RECORDED_ROOTS = 32;
const MAX_SCAN_ROOTS = 16;
const MAX_SKIP_FOLDERS = 256;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 100;
const KEY_FILE = 'root-key.bin';
const ROOTS_FILE = 'roots.json';
// The darwin roots recorded under the exact-path id (see stableRootId). The earlier release reads only the lower-cased darwin id from
// roots.json and rewrites that file without any other entry, so these roots live here, which that release never touches: a downgrade
// cannot drop them. Same format and validation as roots.json (TB-030).
const ROOTS_EXACT_FILE = 'roots-exact.json';
const KEY_BYTES = 32;
const ROOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_ID = ROOT_ID; // Folder, board and file ids are UUIDs generated per scan. They live in memory: the last scan's ids stay valid until the next scan replaces them or the process ends; a restart invalidates them, and the renderer must start a new scan (TB-065).
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const STEP_KEYS = Object.freeze(['folderMap', 'nameIdentity', 'biosCandidates', 'matching', 'corrections']);
const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
// The closed rejection reasons of devices/corrections.ts. Each one maps to a localisation key; the renderer owns the text.
const REJECTION_KEYS = Object.freeze({
  'invalid-entry': 'library.corrections.rejected.invalidEntry',
  'unknown-role': 'library.corrections.rejected.unknownRole',
  'path-too-long': 'library.corrections.rejected.pathTooLong',
  'too-many': 'library.corrections.rejected.tooMany',
});
const realpath = promisify(fsSync.realpath.native);

function bridgeError(code, message) {
  return Object.assign(new Error(`[${code}] ${message}`), { code });
}

function invalid(message) {
  return bridgeError(BRIDGE_CODES.INVALID_REQUEST, message);
}

// Waits for `work`, unless the scan is cancelled first: then the wait ends with CANCELLED at once. A disk read cannot be stopped, so the late
// result or failure of `work` is ignored; this is what releases a scan that is stuck on a slow or hung read (TB-037).
function untilCancelled(work, signal) {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(bridgeError(BRIDGE_CODES.CANCELLED, 'the scan was cancelled'));
  }
  let onAbort = null;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(bridgeError(BRIDGE_CODES.CANCELLED, 'the scan was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Every key must be one of `allowed`, and only own keys count (no inherited or symbol keys).
function hasOnlyKeys(value, allowed) {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key));
}

function closed(value, allowed, message) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, allowed)) throw invalid(message);
  return value;
}

function opaqueId(value, message) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw invalid(message);
  return value;
}

function limitOf(value) {
  if (value === undefined) return DEFAULT_PAGE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) throw invalid('the page size is out of range');
  return value;
}

function cursorOf(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CURSOR.test(value)) throw invalid('the cursor is malformed');
  return value;
}

function scanRequest(value) {
  closed(value, ['rootIds', 'steps', 'skipFolders', 'scanId'], 'the scan request has an unknown shape');
  if (!Array.isArray(value.rootIds) || value.rootIds.length < 1 || value.rootIds.length > MAX_SCAN_ROOTS) {
    throw invalid('the scan needs between one and sixteen roots');
  }
  for (const id of value.rootIds) opaqueId(id, 'a root id is malformed');
  if (new Set(value.rootIds).size !== value.rootIds.length) throw invalid('a root id is repeated');
  const steps = {};
  if (value.steps !== undefined) {
    closed(value.steps, STEP_KEYS, 'the scan steps have an unknown shape');
    for (const key of Object.keys(value.steps)) {
      if (typeof value.steps[key] !== 'boolean') throw invalid('a scan step switch is not a boolean');
      steps[key] = value.steps[key];
    }
  }
  let skipFolders = [];
  if (value.skipFolders !== undefined) {
    if (!Array.isArray(value.skipFolders) || value.skipFolders.length > MAX_SKIP_FOLDERS) throw invalid('the skipped folders are malformed or too many');
    for (const id of value.skipFolders) opaqueId(id, 'a skipped folder id is malformed');
    if (new Set(value.skipFolders).size !== value.skipFolders.length) throw invalid('a skipped folder id is repeated');
    skipFolders = [...value.skipFolders];
  }
  const scanId = value.scanId === undefined ? randomUUID() : opaqueId(value.scanId, 'the scan id is malformed');
  return { rootIds: [...value.rootIds], steps, skipFolders, scanId };
}

function skipStepRequest(value) {
  closed(value, ['scanId', 'step'], 'the request has an unknown shape');
  if (!STEP_KEYS.includes(value.step)) throw invalid('the step is not known');
  return { scanId: opaqueId(value.scanId, 'the scan id is malformed'), step: value.step };
}

function folderListRequest(value) {
  closed(value, ['rootId', 'parentId', 'cursor', 'limit'], 'the request has an unknown shape');
  return {
    rootId: opaqueId(value.rootId, 'a root id is malformed'),
    parentId: value.parentId === undefined ? undefined : opaqueId(value.parentId, 'a folder id is malformed'),
    cursor: cursorOf(value.cursor),
    limit: limitOf(value.limit),
  };
}

function boardListRequest(value) {
  closed(value, ['rootId', 'cursor', 'limit'], 'the request has an unknown shape');
  return { rootId: opaqueId(value.rootId, 'a root id is malformed'), cursor: cursorOf(value.cursor), limit: limitOf(value.limit) };
}

function idRequest(value, key, message) {
  closed(value, [key], 'the request has an unknown shape');
  return opaqueId(value[key], message);
}

function correctionDocument(value, platform) {
  closed(value, ['version', 'platform', 'corrections'], 'the correction document has an unknown shape');
  if (value.version !== CORRECTIONS_VERSION) throw invalid('the correction document has an unsupported version');
  if (value.platform !== platform) throw invalid('the correction document belongs to another platform');
  if (!Array.isArray(value.corrections) || value.corrections.length > MAX_CORRECTIONS) throw invalid('the correction list is malformed or too long');
  return { version: CORRECTIONS_VERSION, platform: value.platform, corrections: value.corrections };
}

// Rejections as the renderer sees them: index, a closed reason and the localisation key of its text.
function rejectionRows(rejections) {
  return (rejections ?? []).map(({ index, reason }) => {
    const closedReason = Object.hasOwn(REJECTION_KEYS, reason) ? reason : 'invalid-entry';
    return { index, reason: closedReason, messageKey: REJECTION_KEYS[closedReason] };
  });
}

// Maps a store or codec failure to a fixed code. The original message can contain a path, so it is never forwarded.
function correctionsFailure(error) {
  const code = error && error.code;
  if (code === 'STORE_BLOCKED') return bridgeError(BRIDGE_CODES.CORRECTIONS_BLOCKED, 'saving the corrections is blocked');
  if (code === 'STORE_INVALID_DOCUMENT' || code === 'STORE_TOO_LARGE') return invalid('the correction document is not valid');
  return bridgeError(BRIDGE_CODES.CORRECTIONS_FAILED, 'the corrections could not be saved');
}

// Exact spellings only, except on win32 (NTFS keeps no two names that differ by case alone). Darwin needs the file system (see sameFolder).
function sameLocation(left, right, platform) {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// True when child is parent or lies inside it. path.relative gives an absolute path across drives, which counts as outside.
function within(parent, child) {
  const relation = path.relative(parent, child);
  return relation === '' || !(relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation));
}

// The root id: HMAC of the canonical realpath under the per-install key. Case is folded only on win32, where the file system folds it.
// darwin is hashed under a prefix that no path can contain (a NUL byte), so its ids never equal the lower-cased ids of legacyDarwinRootId.
const DARWIN_ID_PREFIX = 'darwin-exact\u0000';

function stableRootId(key, realPath, platform) {
  if (platform === 'win32') return hashedRootId(key, realPath.toLowerCase());
  if (platform === 'darwin') return hashedRootId(key, `${DARWIN_ID_PREFIX}${realPath}`);
  return hashedRootId(key, realPath);
}

// The id that earlier releases gave a darwin folder (lower-cased path). Read only: it keeps the entries already recorded valid.
function legacyDarwinRootId(key, realPath) {
  return hashedRootId(key, realPath.toLowerCase());
}

// True when rootId is the id the path yields under this key: the current id, or on darwin the id of an earlier release.
function rootIdFollows(key, realPath, rootId, platform) {
  if (stableRootId(key, realPath, platform) === rootId) return true;
  return platform === 'darwin' && legacyDarwinRootId(key, realPath) === rootId;
}

function hashedRootId(key, canonical) {
  const hex = createHmac('sha256', key).update(canonical, 'utf8').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(text) {
  let value;
  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw invalid('the cursor is malformed');
  }
  if (!isPlainObject(value) || !Number.isSafeInteger(value.g) || typeof value.s !== 'string' || !Number.isSafeInteger(value.o) || value.o < 0) {
    throw invalid('the cursor is malformed');
  }
  return value;
}

// One page of `items`. The cursor binds the generation of the scan and the scope (root and parent), so a cursor cannot be replayed on
// another listing or after a rescan.
function pageOf(items, { cursor, limit }, generation, scope) {
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded.g !== generation || decoded.s !== scope) throw bridgeError(BRIDGE_CODES.STALE_CURSOR, 'the cursor is stale');
    offset = decoded.o;
  }
  const rows = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? { nextCursor: encodeCursor({ g: generation, s: scope, o: offset + limit }) } : {};
  return { rows, total: items.length, ...next };
}

function summarize(result, manualRoles) {
  const measuredAll = result.maps.every((entry) => entry.map !== null && entry.map.complete) && result.steps.corrections === 'ran';
  return {
    steps: { ...result.steps },
    complete: result.complete === true,
    skippedByRequest: [...(result.skippedByRequest ?? [])],
    roots: result.maps.map((entry) => ({
      rootId: entry.rootId,
      complete: entry.map !== null && entry.map.complete,
      scanned: entry.map !== null,
      folderCount: entry.map === null ? 0 : entry.map.folderCount,
      fileCount: entry.map === null ? 0 : entry.map.fileCount,
      skippedCount: entry.map === null ? 0 : entry.map.skippedCount,
    })),
    fileCount: result.files.length,
    associationCount: result.associations.length,
    anchorCount: (result.anchors ?? []).length,
    missingTargetCount: measuredAll ? result.missingTargets.length : 'unknown',
    excludedFirmwareCount: result.excludedFirmwareCount,
    collisionCount: result.collisions.length,
    needsManualCount: result.needsManual.length,
    manualClassificationCount: result.files.filter((file) => manualRoles.has(file.identity.role)).length,
    stats: { ...result.stats, match: { ...result.stats.match } },
  };
}

const FIRMWARE_ROLES = new Set(['bios-candidate', 'ec-firmware', 'me-firmware', 'saved-dump']);
// Presence of a board's boardview and BIOS files, from the scanned files that the matching linked to it:
//  boardview: 'confirmed' when a boardview-role file of the board is present in the scanned roots;
//  bios:      'confirmed' or 'candidate' from the firmware-role files (confirmed when one is confirmed by matching);
//  'none' only when the whole scan was complete and nothing matches; 'unknown' otherwise. Unknown is never false.
function presenceOfBoard(files, complete) {
  const absent = complete ? 'none' : 'unknown';
  const firmware = files.filter((file) => FIRMWARE_ROLES.has(file.role));
  return {
    boardview: files.some((file) => file.role === 'boardview') ? 'confirmed' : absent,
    bios: firmware.length === 0 ? absent : (firmware.some((file) => file.state === 'confirmed') ? 'confirmed' : 'candidate'),
  };
}

// Keeps what the list channels need from one scan, in the main process only. Ids are fresh per scan; the paths and nodes they resolve
// to never leave this process.
function fileIdIn(state, rootId, filePath) {
  const key = `${rootId}\u0000${filePath}`;
  let id = state.fileIds.get(key);
  if (id === undefined) {
    id = randomUUID();
    state.fileIds.set(key, id);
    state.fileById.set(id, { rootId, path: filePath });
  }
  return id;
}

function indexScan(result, generation, manualRoles, registry) {
  const complete = result.complete === true;
  const anchors = result.anchors ?? [];
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const roots = new Map();
  const correctionsRan = result.steps.corrections === 'ran';
  for (const entry of result.maps) {
    const map = entry.map;
    const rootComplete = map !== null && map.complete;
    roots.set(entry.rootId, {
      scanned: map !== null,
      complete: rootComplete,
      skippedCount: map === null ? 0 : map.skippedCount,
      root: map === null ? null : map.root,
      indexedFileCount: result.files.filter((file) => file.rootId === entry.rootId).length,
      manualClassificationCount: result.files.filter((file) => file.rootId === entry.rootId && manualRoles.has(file.identity.role)).length,
      missingTargetCount: rootComplete && correctionsRan
        ? result.missingTargets.filter((correction) => correction.file !== undefined && correction.file.rootId === entry.rootId).length
        : 'unknown',
      collisionCount: result.collisions.filter((collision) => collision.rootId === entry.rootId).length,
    });
  }
  // An association names its file by fileRefOf(): "<rootId>\0<identity key>". The root id is the part before the separator.
  const boardsByAnchor = new Map();
  const boardsById = new Map();
  // Opaque file ids: one per file of the scan, resolved to root and path inside this process only (see fileIdIn).
  const fileKeyByRef = new Map();
  const roleByKey = new Map();
  // Online-only files (cloud placeholders) by the same key: their board rows say so, and nothing reads their content.
  const onlineKeys = new Set();
  for (const file of result.files) {
    fileKeyByRef.set(file.fileRef, { rootId: file.rootId, path: file.path });
    roleByKey.set(`${file.rootId}\u0000${file.path}`, file.identity.role);
    if (file.online === true) onlineKeys.add(`${file.rootId}\u0000${file.path}`);
  }
  const state = registry;
  for (const association of result.associations) {
    const separator = association.filePath.indexOf('\u0000');
    const rootId = separator < 0 ? '' : association.filePath.slice(0, separator);
    if (!roots.has(rootId)) continue;
    let board = boardsByAnchor.get(association.anchorId);
    if (board === undefined) {
      const anchor = anchorById.get(association.anchorId);
      board = {
        boardId: randomUUID(),
        anchorId: association.anchorId,
        boardCode: anchor === undefined ? undefined : anchor.boardCode,
        revision: anchor === undefined || anchor.revision === undefined ? undefined : anchor.revision.normalized,
        byRoot: new Map(),
        files: [],
      };
      boardsByAnchor.set(association.anchorId, board);
      boardsById.set(board.boardId, board);
    }
    const located = fileKeyByRef.get(association.filePath);
    const fileId = located === undefined ? randomUUID() : fileIdIn(state, located.rootId, located.path);
    board.files.push({ fileId, rootId, role: association.role, state: association.state });
    const counts = board.byRoot.get(rootId) ?? { fileCount: 0, confirmed: 0, probable: 0, review: 0 };
    counts.fileCount++;
    counts[association.state]++;
    board.byRoot.set(rootId, counts);
  }
  const boards = [...boardsById.values()].map((board) => ({ ...board, ...presenceOfBoard(board.files, complete) }));
  return {
    generation,
    complete,
    roots,
    boards,
    boardsById: new Map(boards.map((board) => [board.boardId, board])),
    roleByKey,
    onlineKeys,
    folderIdOf: new Map(),
    folderNodes: new Map(),
  };
}

/**
 * createDeviceBridge({ core, chooseDirectory, userDataDirectory, platform, fs, adapterFs })
 *   core             { buildDeviceCatalogue, parseCorrections, serializeCorrections, CANONICAL_ROLE_OF } from devices-core.cjs (injected)
 *   chooseDirectory  () => Promise<string | null>   the main process's native folder chooser (null when cancelled)
 *   userDataDirectory absolute path; the corrections, the key and the root list live under it and no root may contain or lie inside it
 *   fs, adapterFs    optional file-system objects (fs/promises shape) for the store, the key, the root list and the directory adapter
 *   realpath         optional async realpath for the root checks (default: the native realpath)
 */
function createDeviceBridge(options = {}) {
  const {
    core,
    chooseDirectory,
    userDataDirectory,
    platform = process.platform,
    fs = fsPromises,
    adapterFs,
    realpath: realpathOf = realpath,
    anchorSource,
  } = options;

  if (core === null || typeof core !== 'object' || typeof core.buildDeviceCatalogue !== 'function') throw bridgeError(BRIDGE_CODES.SCAN_FAILED, 'the catalogue is not available');
  if (typeof chooseDirectory !== 'function') throw bridgeError(BRIDGE_CODES.INVALID_REQUEST, 'a directory chooser is required');
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) throw bridgeError(BRIDGE_CODES.INVALID_REQUEST, 'the user data directory is invalid');
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw bridgeError(BRIDGE_CODES.UNSUPPORTED_PLATFORM, 'this platform is not supported');
  if (typeof realpathOf !== 'function') throw bridgeError(BRIDGE_CODES.INVALID_REQUEST, 'the realpath function is not valid');

  // The board anchor source: the injected port, or the file-name default created for this bridge (its describe() remembers its scan).
  if (anchorSource !== undefined && (anchorSource === null || typeof anchorSource.anchorsFor !== 'function' || typeof anchorSource.describe !== 'function')) {
    throw bridgeError(BRIDGE_CODES.INVALID_REQUEST, 'the board anchor source is not valid');
  }
  const boardSource = anchorSource !== undefined ? anchorSource : (typeof core.createFileNameAnchorSource === 'function' ? core.createFileNameAnchorSource() : null);

  const dataRoot = path.resolve(userDataDirectory);
  const deviceDirectory = path.join(dataRoot, ...DIRECTORY_SEGMENTS);
  const rootsPath = path.join(deviceDirectory, ROOTS_FILE);
  const rootsExactPath = path.join(deviceDirectory, ROOTS_EXACT_FILE);
  // rootId -> { realPath, label }. Loaded from roots.json and roots-exact.json once per process.
  const recorded = new Map();
  // Whether roots-exact.json held entries when it was read: then it is rewritten even when no entry of it is left.
  let exactOnDisk = false;
  let rootsLoad = null;
  let rootsQueue = Promise.resolve();
  let scanning = false;
  let activeScan = null;
  let store = null;
  let rootKey = null;
  let lastScan = null; // indexScan() of the last successful scan
  // File ids of this process: one per (root, path). Kept for the life of the process; the ids of a removed root are dropped with it (see
  // forgetFileIds). A correction of a removed root stays in the corrections file. The next load shows it with a fresh id (see
  // toRendererCorrection), and an edit through that id is stored under the removed root's (root, path), as any correction is. The paths
  // stay in this process.
  const fileRegistry = { fileIds: new Map(), fileById: new Map() };
  let scanGeneration = 0;
  let quarantinedThisRun = false;
  // The file roles whose canonical role is 'unknown' (manual classification), taken from the codec's own table.
  const manualRoles = new Set(Object.keys(core.CANONICAL_ROLE_OF ?? {}).filter((name) => core.CANONICAL_ROLE_OF[name] === 'unknown'));

  function getStore() {
    if (store === null) {
      store = createCorrectionsStore({ userDataDirectory: dataRoot, codec: core, platform, fs });
    }
    return store;
  }

  // The per-install key behind the stable root ids. Created once (exclusively, through a temporary file); never replaced.
  async function readKey(file) {
    const bytes = await fs.readFile(file);
    if (bytes.length !== KEY_BYTES) throw new Error('the root key has the wrong length');
    return bytes;
  }

  async function loadRootKey() {
    if (rootKey !== null) return rootKey;
    const file = path.join(deviceDirectory, KEY_FILE);
    try {
      rootKey = await readKey(file);
      return rootKey;
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw bridgeError(BRIDGE_CODES.KEY_UNAVAILABLE, 'the library key cannot be read');
    }
    const fresh = randomBytes(KEY_BYTES);
    const temporary = `${file}.${process.pid}.${randomUUID().replace(/-/g, '')}.tmp`;
    try {
      await fs.mkdir(deviceDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, fresh, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
      rootKey = fresh;
      return rootKey;
    } catch {
      await fs.unlink(temporary).catch(() => {});
      // Another start may have created the key meanwhile; that key is then the one to use.
      try {
        rootKey = await readKey(file);
        return rootKey;
      } catch {
        throw bridgeError(BRIDGE_CODES.KEY_UNAVAILABLE, 'the library key cannot be created');
      }
    }
  }

  // Whether two spellings name one folder. Exact spellings always do. On darwin, a spelling that differs only by case may name the same
  // folder (a case-insensitive volume) or another one (a case-sensitive volume), so only the file system's identity decides.
  async function sameFolder(left, right) {
    if (sameLocation(left, right, platform)) return true;
    if (platform !== 'darwin' || left.toLowerCase() !== right.toLowerCase()) return false;
    try {
      // bigint: a 64-bit inode number is compared exactly, never rounded into a shared value.
      const [first, second] = await Promise.all([fs.stat(left, { bigint: true }), fs.stat(right, { bigint: true })]);
      return first.dev === second.dev && first.ino === second.ino;
    } catch {
      return false;
    }
  }

  // The id of the recorded root that is this folder, or null when the folder is not recorded.
  async function recordedRootOf(realPath) {
    for (const [rootId, entry] of recorded) {
      if (await sameFolder(entry.realPath, realPath)) return rootId;
    }
    return null;
  }

  // ---- The root list -------------------------------------------------------------------------------------------------------------
  function validRootsDocument(value) {
    if (!isPlainObject(value) || !hasOnlyKeys(value, ['version', 'roots']) || value.version !== ROOTS_VERSION) return false;
    if (!Array.isArray(value.roots) || value.roots.length > MAX_RECORDED_ROOTS) return false;
    return value.roots.every((entry) => isPlainObject(entry)
      && hasOnlyKeys(entry, ['rootId', 'realPath', 'label'])
      && typeof entry.rootId === 'string' && ROOT_ID.test(entry.rootId)
      && typeof entry.realPath === 'string' && path.isAbsolute(entry.realPath) && entry.realPath.length <= 4096
      && typeof entry.label === 'string' && entry.label.length <= 255);
  }

  // The parsed roots document of one file: null when the file is absent or damaged (a damaged file is moved aside, its bytes kept).
  async function readRootsFile(file) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw bridgeError(BRIDGE_CODES.ROOTS_UNAVAILABLE, 'the library roots cannot be read');
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (validRootsDocument(parsed)) return parsed;
    // Moved aside with its bytes kept; if that fails, nothing is started that could overwrite it.
    const aside = path.join(deviceDirectory, `${path.basename(file, '.json')}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
    try {
      await fs.rename(file, aside);
    } catch {
      throw bridgeError(BRIDGE_CODES.ROOTS_UNAVAILABLE, 'the damaged library roots cannot be set aside');
    }
    return null;
  }

  async function readRoots() {
    const main = await readRootsFile(rootsPath);
    const exact = await readRootsFile(rootsExactPath);
    exactOnDisk = platform === 'darwin' && exact !== null && exact.roots.length > 0;
    if (main === null && exact === null) return;
    const key = await loadRootKey();
    for (const parsed of [main, exact]) {
      if (parsed === null) continue;
      for (const entry of parsed.roots) {
        // An entry whose id does not follow from its path under this key is dropped, never trusted.
        if (!rootIdFollows(key, entry.realPath, entry.rootId, platform)) continue;
        recorded.set(entry.rootId, { realPath: entry.realPath, label: entry.label });
      }
    }
  }

  function loadRoots() {
    if (rootsLoad === null) {
      rootsLoad = readRoots().catch((error) => {
        rootsLoad = null;
        throw error;
      });
    }
    return rootsLoad;
  }

  // Writes one roots document atomically: a temporary file, then the rename.
  async function writeRootsFile(file, rows) {
    const body = JSON.stringify({ version: ROOTS_VERSION, roots: rows });
    const temporary = `${file}.${process.pid}.${randomUUID().replace(/-/g, '')}.tmp`;
    try {
      await fs.mkdir(deviceDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(fs, temporary, file);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw bridgeError(BRIDGE_CODES.ROOTS_UNAVAILABLE, 'the library roots cannot be saved');
    }
  }

  // Writes the root list: roots-exact.json first, then roots.json, so a failed write leaves roots.json as it was. Writes are queued so two
  // changes never interleave. On darwin an id the earlier release cannot read goes to roots-exact.json; roots.json keeps the others (TB-030).
  function persistRoots() {
    const run = rootsQueue.then(async () => {
      const key = platform === 'darwin' ? await loadRootKey() : null;
      const forRootsJson = [];
      const forSidecar = [];
      for (const [rootId, entry] of recorded) {
        const row = { rootId, realPath: entry.realPath, label: entry.label };
        if (platform === 'darwin' && rootId !== legacyDarwinRootId(key, entry.realPath)) forSidecar.push(row);
        else forRootsJson.push(row);
      }
      // The sidecar is darwin's: the other platforms never write it, so the darwin roots of a copied profile are left alone there.
      if (platform === 'darwin' && (forSidecar.length > 0 || exactOnDisk)) await writeRootsFile(rootsExactPath, forSidecar);
      exactOnDisk = platform === 'darwin' && forSidecar.length > 0;
      await writeRootsFile(rootsPath, forRootsJson);
    });
    rootsQueue = run.catch(() => {});
    return run;
  }

  async function pickRoot() {
    await loadRoots();
    const chosen = await chooseDirectory();
    if (typeof chosen !== 'string' || chosen === '' || !path.isAbsolute(chosen)) return null;
    let realPath;
    try {
      realPath = await realpathOf(chosen);
      const stat = await fs.lstat(realPath);
      if (!stat.isDirectory()) throw bridgeError(BRIDGE_CODES.ROOT_UNAVAILABLE, 'the chosen item is not a folder');
    } catch (error) {
      if (error && error.code === BRIDGE_CODES.ROOT_UNAVAILABLE) throw error;
      throw bridgeError(BRIDGE_CODES.ROOT_UNAVAILABLE, 'the chosen folder cannot be read');
    }
    // The application's own data must never be scanned as a Library root, nor may a root hold it.
    const dataReal = await realpathOf(dataRoot).catch(() => dataRoot);
    if (within(realPath, dataReal) || within(dataReal, realPath)) {
      throw bridgeError(BRIDGE_CODES.RESERVED_ROOT, 'this folder cannot be used as a library root');
    }
    const key = await loadRootKey();
    const label = (path.basename(realPath) || realPath).slice(0, 255);
    // A folder that is already recorded keeps its id, whatever spelling it was picked with (and so keeps its corrections).
    const known = await recordedRootOf(realPath);
    if (known !== null) return { rootId: known, label };
    const rootId = stableRootId(key, realPath, platform);
    if (!recorded.has(rootId)) {
      if (recorded.size >= MAX_RECORDED_ROOTS) throw bridgeError(BRIDGE_CODES.TOO_MANY_ROOTS, 'too many library roots are recorded');
      recorded.set(rootId, { realPath, label });
      try {
        await persistRoots();
      } catch (error) {
        recorded.delete(rootId);
        throw error;
      }
    }
    return { rootId, label };
  }

  async function listRoots() {
    await loadRoots();
    const rows = [];
    for (const [rootId, entry] of recorded) {
      let online;
      try {
        online = await sameFolder(await realpathOf(entry.realPath), entry.realPath);
      } catch {
        online = false;
      }
      const view = lastScan === null ? undefined : lastScan.roots.get(rootId);
      rows.push({
        rootId,
        label: entry.label,
        online,
        network: 'unknown', // Not measured by this bridge; never reported as true or false.
        scanned: view !== undefined && view.scanned,
        complete: view === undefined ? 'unknown' : view.complete,
      });
    }
    return { roots: rows, total: rows.length };
  }

  // Drops one root from the last scan without a rescan: its view, its folder ids, and its files inside the boards. A board left with no
  // file is dropped, and the presence of the remaining boards is recomputed from the remaining files.
  // Drops the file ids of a removed root. Its corrections stay in the corrections file (see removeRoot); the next load gives them fresh ids.
  function forgetFileIds(rootId) {
    const prefix = `${rootId}\u0000`;
    for (const [key, id] of fileRegistry.fileIds) {
      if (!key.startsWith(prefix)) continue;
      fileRegistry.fileIds.delete(key);
      fileRegistry.fileById.delete(id);
    }
  }

  function forgetRootInScan(rootId) {
    lastScan.roots.delete(rootId);
    const prefix = `${rootId}\u0000`;
    for (const key of [...lastScan.roleByKey.keys()]) if (key.startsWith(prefix)) lastScan.roleByKey.delete(key);
    for (const key of [...lastScan.onlineKeys]) if (key.startsWith(prefix)) lastScan.onlineKeys.delete(key);
    for (const [id, entry] of lastScan.folderNodes) {
      if (entry.rootId !== rootId) continue;
      lastScan.folderNodes.delete(id);
      lastScan.folderIdOf.delete(entry.node);
    }
    const kept = [];
    for (const board of lastScan.boards) {
      const files = board.files.filter((file) => file.rootId !== rootId);
      if (files.length === 0) continue;
      const byRoot = new Map();
      for (const file of files) {
        const counts = byRoot.get(file.rootId) ?? { fileCount: 0, confirmed: 0, probable: 0, review: 0 };
        counts.fileCount++;
        counts[file.state]++;
        byRoot.set(file.rootId, counts);
      }
      kept.push({ ...board, files, byRoot, ...presenceOfBoard(files, lastScan.complete) });
    }
    lastScan.boards = kept;
    lastScan.boardsById = new Map(kept.map((board) => [board.boardId, board]));
  }

  async function removeRoot(request) {
    const rootId = idRequest(request, 'rootId', 'a root id is malformed');
    await loadRoots();
    if (scanning) throw bridgeError(BRIDGE_CODES.BUSY, 'a scan is already running');
    const entry = recorded.get(rootId);
    if (entry === undefined) throw bridgeError(BRIDGE_CODES.UNKNOWN_ROOT, 'the root is not known');
    recorded.delete(rootId);
    try {
      await persistRoots();
    } catch (error) {
      recorded.set(rootId, entry);
      throw error;
    }
    forgetFileIds(rootId);
    if (lastScan !== null) forgetRootInScan(rootId);
    // The files are never touched, and the corrections that name this root stay in the corrections file. A root's id follows from its
    // path, so picking the folder again gives the same id and the corrections apply again. On darwin the id follows the exact spelling,
    // and an id recorded by an earlier release (lower-cased path) is never issued again: a re-added darwin folder gets a new id and
    // does not inherit those corrections (see legacyDarwinRootId).
    return { removed: true };
  }

  // Resolves one recorded root to a port, after checking that its realpath is still the one recorded.
  async function portFor(rootId) {
    const entry = recorded.get(rootId);
    if (entry === undefined) throw bridgeError(BRIDGE_CODES.UNKNOWN_ROOT, 'the root is not known');
    try {
      const now = await realpathOf(entry.realPath);
      if (!(await sameFolder(now, entry.realPath))) throw new Error('the root moved');
      return await createDirectoryPort({ root: entry.realPath, platform, fs: adapterFs });
    } catch {
      throw bridgeError(BRIDGE_CODES.ROOT_UNAVAILABLE, 'the root cannot be read');
    }
  }

  // ---- Scan --------------------------------------------------------------------------------------------------------------------
  // Reports the store's verdict to the renderer. A quarantine stays visible for the rest of the session, until a save succeeds.
  function correctionsStatus(loaded) {
    if (loaded.status === 'quarantined') quarantinedThisRun = true;
    if (loaded.status === 'empty' && quarantinedThisRun) return 'quarantined';
    return loaded.status;
  }

  // Skipped folders are the ids the last listing issued. Each one names a root that must be part of the scan.
  function skipPathsFor(rootIds, skipFolders) {
    const byRoot = new Map();
    for (const id of skipFolders) {
      const entry = lastScan === null ? undefined : lastScan.folderNodes.get(id);
      if (entry === undefined) throw bridgeError(BRIDGE_CODES.UNKNOWN_FOLDER, 'the folder is not known');
      if (!rootIds.includes(entry.rootId)) throw invalid('a skipped folder belongs to a root that is not part of the scan');
      const paths = byRoot.get(entry.rootId) ?? new Set();
      paths.add(entry.node.path);
      byRoot.set(entry.rootId, paths);
    }
    return byRoot;
  }

  async function scan(request) {
    const { rootIds, steps, skipFolders, scanId } = scanRequest(request);
    if (scanning) throw bridgeError(BRIDGE_CODES.BUSY, 'a scan is already running');
    // The flag is raised before the first await, so a second scan cannot pass the check while this one is still starting.
    scanning = true;
    const controller = new AbortController();
    const skippedSteps = new Set();
    activeScan = { controller, scanId, skippedSteps };
    try {
      // A cancel is honoured at each wait point too: after the root list, after the ports, and after the corrections are read.
      const throwIfCancelled = () => {
        if (controller.signal.aborted) throw bridgeError(BRIDGE_CODES.CANCELLED, 'the scan was cancelled');
      };
      await untilCancelled(loadRoots(), controller.signal);
      throwIfCancelled();
      const skipByRoot = skipPathsFor(rootIds, skipFolders);
      const roots = [];
      for (const rootId of rootIds) roots.push({ rootId, port: await untilCancelled(portFor(rootId), controller.signal), skipPaths: skipByRoot.get(rootId) });
      throwIfCancelled();
      const loaded = await untilCancelled(getStore().load().catch(() => ({ status: 'unreadable', document: null })), controller.signal);
      throwIfCancelled();
      const corrections = loaded.document === null || loaded.document === undefined ? [] : loaded.document.corrections;
      const result = await core.buildDeviceCatalogue({
        platform,
        roots,
        anchors: [],
        deriveAnchors: true,
        anchorSource: boardSource === null ? undefined : boardSource,
        corrections,
        steps,
        signal: controller.signal,
        isStepSkipped: (step) => skippedSteps.has(step),
      });
      scanGeneration++;
      lastScan = indexScan(result, scanGeneration, manualRoles, fileRegistry);
      return { ...summarize(result, manualRoles), scanId, correctionsStatus: correctionsStatus(loaded) };
    } catch (error) {
      if (controller.signal.aborted || (error && error.code === 'CANCELLED')) throw bridgeError(BRIDGE_CODES.CANCELLED, 'the scan was cancelled');
      if (error && typeof error.code === 'string' && error.code.startsWith('LIBRARY_')) throw error;
      throw bridgeError(BRIDGE_CODES.SCAN_FAILED, 'the scan could not be completed');
    } finally {
      scanning = false;
      activeScan = null;
    }
  }

  function cancelScan() {
    if (activeScan === null) return { cancelled: false };
    activeScan.controller.abort();
    return { cancelled: true };
  }

  // A step of the running scan is switched off before it starts. The scan id is the one the scan was started with.
  async function skipScanStep(request) {
    const { scanId, step } = skipStepRequest(request);
    if (activeScan === null || activeScan.scanId !== scanId) throw bridgeError(BRIDGE_CODES.NO_SCAN, 'no scan with that id is running');
    activeScan.skippedSteps.add(step);
    return { scanId, step, accepted: true, complete: false };
  }

  // ---- Listings ----------------------------------------------------------------------------------------------------------------
  // The last scan's view of one recorded root. Unknown roots and roots not covered by the last scan are refused.
  async function scannedRoot(rootId) {
    await loadRoots();
    if (!recorded.has(rootId)) throw bridgeError(BRIDGE_CODES.UNKNOWN_ROOT, 'the root is not known');
    const view = lastScan === null ? undefined : lastScan.roots.get(rootId);
    if (view === undefined) throw bridgeError(BRIDGE_CODES.NOT_SCANNED, 'the root has not been scanned');
    return view;
  }

  // Folder ids are issued lazily, one per folder node, and stay the same for the rest of the scan.
  function folderIdFor(node, rootId) {
    let id = lastScan.folderIdOf.get(node);
    if (id === undefined) {
      id = randomUUID();
      lastScan.folderIdOf.set(node, id);
      lastScan.folderNodes.set(id, { rootId, node });
    }
    return id;
  }

  async function listFolders(request) {
    const { rootId, parentId, cursor, limit } = folderListRequest(request);
    const view = await scannedRoot(rootId);
    if (view.root === null) {
      return { generation: lastScan.generation, scanned: false, complete: false, skippedCount: 0, folders: [], total: 0, files: [], fileTotal: 0, filesTruncated: false };
    }
    let parent = view.root;
    if (parentId !== undefined) {
      const entry = lastScan.folderNodes.get(parentId);
      if (entry === undefined || entry.rootId !== rootId) throw bridgeError(BRIDGE_CODES.UNKNOWN_FOLDER, 'the folder is not known');
      parent = entry.node;
    }
    const items = parent.folders.map((node) => ({
      folderId: folderIdFor(node, rootId),
      // The folder's own name (basename only, never a full path), its read state, and for an unreadable folder its closed code.
      name: node.name,
      readState: node.readState,
      ...(node.code === undefined ? {} : { code: node.code }),
      folderCount: node.folderCount,
      fileCount: node.fileCount,
      bytes: node.bytes,
      childFolderCount: node.folders.length,
    }));
    const paged = pageOf(items, { cursor, limit }, lastScan.generation, `folders|${rootId}|${parentId ?? ''}`);
    const files = parent.files.slice(0, MAX_PAGE).map((file) => ({
      fileId: fileIdIn(fileRegistry, rootId, file.path),
      name: file.name,
      role: lastScan.roleByKey.get(`${rootId}\u0000${file.path}`) ?? null,
    }));
    return {
      generation: lastScan.generation,
      scanned: true,
      complete: view.complete,
      skippedCount: view.skippedCount,
      folders: paged.rows,
      total: paged.total,
      files,
      fileTotal: parent.files.length,
      filesTruncated: parent.files.length > MAX_PAGE,
      ...(paged.nextCursor === undefined ? {} : { nextCursor: paged.nextCursor }),
    };
  }

  async function listBoards(request) {
    const { rootId, cursor, limit } = boardListRequest(request);
    const view = await scannedRoot(rootId);
    const items = lastScan.boards
      .filter((board) => board.byRoot.has(rootId))
      .map((board) => {
        const counts = board.byRoot.get(rootId);
        return { boardId: board.boardId, boardAnchorId: board.anchorId, boardCode: board.boardCode ?? null, revision: board.revision ?? null, fileCount: counts.fileCount, confirmed: counts.confirmed, probable: counts.probable, review: counts.review, boardview: board.boardview, bios: board.bios };
      });
    const paged = pageOf(items, { cursor, limit }, lastScan.generation, `boards|${rootId}`);
    // The board code and revision come from the board anchor source (the Library board store) when it knows the board: only the rows of
    // this page are asked, so a page costs what it shows.
    const rows = await Promise.all(paged.rows.map(async (row) => {
      const meta = boardSource === null ? undefined : await boardSource.describe(row.boardAnchorId);
      return { ...row, boardCode: (meta && meta.boardCode) ?? row.boardCode, revision: (meta && meta.revision) ?? row.revision };
    }));
    return {
      generation: lastScan.generation,
      scanned: view.scanned,
      complete: view.complete,
      indexedFileCount: view.indexedFileCount,
      manualClassificationCount: view.manualClassificationCount,
      missingTargetCount: view.missingTargetCount,
      collisionCount: view.collisionCount,
      boards: rows,
      total: paged.total,
      ...(paged.nextCursor === undefined ? {} : { nextCursor: paged.nextCursor }),
    };
  }

  async function boardDetail(request) {
    const boardId = idRequest(request, 'boardId', 'a board id is malformed');
    const board = lastScan === null ? undefined : lastScan.boardsById.get(boardId);
    if (board === undefined) throw bridgeError(BRIDGE_CODES.UNKNOWN_BOARD, 'the board is not known');
    const meta = boardSource === null ? undefined : await boardSource.describe(board.anchorId);
    return {
      generation: lastScan.generation,
      boardId,
      boardAnchorId: board.anchorId,
      boardCode: (meta && meta.boardCode) ?? board.boardCode ?? null,
      revision: (meta && meta.revision) ?? board.revision ?? null,
      boardview: board.boardview,
      bios: board.bios,
      complete: lastScan.complete,
      files: board.files.slice(0, MAX_PAGE).map((file) => {
        const located = fileRegistry.fileById.get(file.fileId);
        const online = located !== undefined && lastScan.onlineKeys.has(`${file.rootId}\u0000${located.path}`);
        return { fileId: file.fileId, name: located === undefined ? null : located.path.split('/').pop(), rootId: file.rootId, role: file.role, state: file.state, ...(online ? { online: true } : {}) };
      }),
      filesTruncated: board.files.length > MAX_PAGE,
    };
  }

  // ---- Correction translation: the renderer names files and boards by id. The store keeps (root, path) and anchorId, unchanged.
  function registryTarget(fileId) {
    if (typeof fileId !== 'string' || !OPAQUE_ID.test(fileId)) throw invalid('a file id is malformed');
    const target = fileRegistry.fileById.get(fileId);
    if (target === undefined) throw bridgeError(BRIDGE_CODES.UNKNOWN_FILE, 'the file id is not known or its root was removed');
    return { rootId: target.rootId, path: target.path };
  }

  // Inbound: fileId and boardAnchorId become the stored form. Entries that carry a path or an anchorId key are refused: the renderer never names a path.
  function toStoredCorrection(entry) {
    if (!isPlainObject(entry)) throw invalid('a correction entry is not an object');
    if (Object.hasOwn(entry, 'file') || Object.hasOwn(entry, 'anchorId')) throw invalid('a correction names its file and board by id');
    const { fileId, boardAnchorId, ...rest } = entry;
    const stored = { ...rest };
    if (fileId !== undefined) stored.file = registryTarget(fileId);
    if (boardAnchorId !== undefined) {
      if (typeof boardAnchorId !== 'string') throw invalid('a board anchor id is malformed');
      stored.anchorId = boardAnchorId;
    }
    return stored;
  }

  // Outbound: the stored form becomes ids only. No path leaves this process.
  function toRendererCorrection(entry) {
    const { file, anchorId, ...rest } = entry;
    const out = { ...rest };
    if (file !== undefined) out.fileId = fileIdIn(fileRegistry, file.rootId, file.path);
    if (anchorId !== undefined) out.boardAnchorId = anchorId;
    return out;
  }

  // ---- Corrections -------------------------------------------------------------------------------------------------------------
  async function loadCorrections() {
    try {
      const loaded = await getStore().load();
      return {
        status: correctionsStatus(loaded),
        document: loaded.document === null ? null : { ...loaded.document, corrections: loaded.document.corrections.map(toRendererCorrection) },
        dropped: loaded.dropped,
        rejections: rejectionRows(loaded.rejections),
      };
    } catch (error) {
      throw correctionsFailure(error);
    }
  }

  // Refused entries are reported and nothing is written: the save either stores the whole document or none of it. A newer
  // schema, an unreadable file or a file that cannot be moved aside blocks the save in the store, so it is never overwritten.
  async function saveCorrections(document) {
    const checked = correctionDocument(document, platform);
    checked.corrections = checked.corrections.map(toStoredCorrection);
    let probe;
    try {
      probe = core.parseCorrections(JSON.stringify(checked));
    } catch {
      throw bridgeError(BRIDGE_CODES.CORRECTIONS_FAILED, 'the corrections could not be checked');
    }
    if (probe.rejections.length > 0) return { status: 'refused', rejections: rejectionRows(probe.rejections) };
    try {
      const saved = await getStore().save(checked);
      quarantinedThisRun = false;
      return saved;
    } catch (error) {
      throw correctionsFailure(error);
    }
  }

  return Object.freeze({
    pickRoot,
    listRoots,
    removeRoot,
    scan,
    cancelScan,
    skipScanStep,
    listFolders,
    listBoards,
    boardDetail,
    loadCorrections,
    saveCorrections,
    BRIDGE_CODES,
  });
}

module.exports = Object.freeze({
  createDeviceBridge,
  stableRootId,
  legacyDarwinRootId,
  rootIdFollows,
  BRIDGE_CODES,
  MAX_RECORDED_ROOTS,
  MAX_SCAN_ROOTS,
  MAX_SKIP_FOLDERS,
  MAX_PAGE,
});
