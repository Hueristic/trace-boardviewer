/**
 * Recursive folder map of one selected root, with the relative hierarchy kept as the index structure.
 *
 * The walker is read-only: it asks a DirectoryPort for the entries of one folder and never opens, renames, moves or deletes
 * anything. Links, junctions and other Windows reparse points (cloud placeholders, dedup, app execution links) are not followed or
 * listed; each is recorded as skipped and the map is marked incomplete. A folder that cannot be read is recorded and the walk continues. Limits (depth
 * and entry count) make the map partial, and a partial map is reported as incomplete so that the caller can keep availability
 * states unknown instead of claiming absence.
 *
 * OS sidecar files (AppleDouble "._*", ".DS_Store", "Thumbs.db", "desktop.ini") are written by the operating system, not by the
 * user, and never describe a board. The walker skips them here, the only place that filters them: they are recorded with the
 * reason "sidecar" and counted in skippedCount, so they never reach the identity, the matching or the corrections.
 *
 * Iterative (explicit stack), deterministic (entries sorted by code unit) and linear in the number of entries.
 */
import { canonicalPath, extensionOf, identityKey, type DevicePlatform } from './paths';

/** 'reparse': a Windows reparse point that is not a link (never walked or listed); 'unknown': the entry could not be classified (for example its metadata was unreadable); it is never walked or counted. */
export type EntryKind = 'file' | 'dir' | 'link' | 'reparse' | 'other' | 'unknown';
/** `code` is set for an 'unknown' entry: the system error code of the failed metadata read (no path, no message). */
/** `online` is set for a file whose content is not on this computer (a cloud placeholder): it is listed by name and size, never read. */
export interface DirEntry { name: string; kind: EntryKind; size?: number; code?: string; online?: boolean }
/** Read-only port. `segments` is relative to the root; `[]` is the root itself. */
export interface DirectoryPort { readDir(segments: readonly string[]): Promise<readonly DirEntry[]> }

/** `online: true` only for an online-only file (see DirEntry); the key is absent for every other file. */
export interface FileNode { name: string; path: string; key: string; size: number; extension: string; online?: true }
/** 'pending' before the walker reaches the folder; then 'listed', 'unreadable' (its listing or ancestor check failed, `code` is set) or 'skipped' (not read: too deep, or the entry limit was reached). */
export type FolderReadState = 'pending' | 'listed' | 'unreadable' | 'skipped';
export interface FolderNode {
  name: string;
  path: string;
  key: string;
  folders: FolderNode[];
  files: FileNode[];
  readState: FolderReadState;
  /** Set only for 'unreadable' folders: the closed diagnostic code of the failure. */
  code?: string;
  /** Recursive totals below this folder. */
  fileCount: number;
  folderCount: number;
  bytes: number;
}
/** 'sidecar' is an operating-system metadata file (see isSidecarName); it does not make the map incomplete. 'user-skipped' is a folder the user left out. */
/** 'reparse' is a Windows reparse point that is not a link: its content is not read and it is not listed, so the map is incomplete. */
export type SkipReason = 'link' | 'reparse' | 'other-kind' | 'too-deep' | 'limit' | 'unreadable' | 'unknown' | 'sidecar' | 'user-skipped';
/** `code`, when present, is the diagnostic code of the failure ('unknown' and 'unreadable' records only). */
export interface SkipRecord { path: string; reason: SkipReason; code?: string }
export interface FolderMap {
  root: FolderNode;
  /** The first MAX_SKIP_RECORDS skips; `skippedCount` is the full count. */
  skipped: SkipRecord[];
  skippedCount: number;
  /** False when a folder was unreadable, an entry was unknown, too deep, or the entry limit stopped the walk. Links and special files do not make it incomplete. */
  complete: boolean;
  fileCount: number;
  folderCount: number;
  limitReached: boolean;
}
export interface MapLimits { maxDepth: number; maxEntries: number }

export const DEFAULT_LIMITS: MapLimits = { maxDepth: 48, maxEntries: 250_000 };
/** Error code of a walk stopped by its signal. The walk never returns a partial map after a cancel. */
export const CANCELLED_CODE = 'CANCELLED';
/** Options of one walk: a cancel signal, and canonical paths of folders the user excluded (their whole subtree is not read). */
export interface WalkOptions { signal?: AbortSignal; skipPaths?: ReadonlySet<string> }
function cancelledError(): Error {
  return Object.assign(new Error('the walk was cancelled'), { name: 'AbortError', code: CANCELLED_CODE });
}
export const MAX_SKIP_RECORDS = 500;

/**
 * True for an operating-system sidecar file name (compared case-insensitively): an AppleDouble "._" file, ".DS_Store",
 * "Thumbs.db" or "desktop.ini". A user file with the same name would be skipped too; these names are never board files.
 */
export function isSidecarName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('._') || lower === '.ds_store' || lower === 'thumbs.db' || lower === 'desktop.ini';
}

// Closed set of diagnostic codes, mirrored from electron/library/directory-adapter.cjs (change both together). Anything else
// (a message, a path, an unlisted code) yields no code on the skip record.
const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ENAMETOOLONG', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EINVAL',
  'ADAPTER_ROOT', 'ADAPTER_ROOT_NOT_DIRECTORY', 'ADAPTER_INVALID_SEGMENT', 'ADAPTER_LINK', 'ADAPTER_NOT_DIRECTORY', 'ADAPTER_ESCAPES_ROOT',
  'UNKNOWN',
]);
function diagnosticCodeOf(source: unknown): string | undefined {
  const code = typeof source === 'object' && source !== null && 'code' in source ? (source as { code: unknown }).code : undefined;
  return typeof code === 'string' && DIAGNOSTIC_CODES.has(code) ? code : undefined;

}

function makeFolder(name: string, segments: readonly string[], platform: DevicePlatform): FolderNode {
  const path = canonicalPath(segments);
  return { name, path, key: identityKey(segments, platform), folders: [], files: [], readState: 'pending', fileCount: 0, folderCount: 0, bytes: 0 };
}

/** Maps the tree under the root that `port` reads. Never throws for a bad entry; unreadable folders become skip records. */
export async function mapFolderTree(port: DirectoryPort, platform: DevicePlatform, limits: MapLimits = DEFAULT_LIMITS, options: WalkOptions = {}): Promise<FolderMap> {
  const skipPaths = options.skipPaths ?? new Set<string>();
  const root = makeFolder('', [], platform);
  const parentOf = new Map<FolderNode, FolderNode>();
  const order: FolderNode[] = [];
  const skipped: SkipRecord[] = [];
  let skippedCount = 0;
  let complete = true;
  let limitReached = false;
  let entries = 0;
  const skip = (path: string, reason: SkipReason, code?: string): void => {
    skippedCount++;
    if (skipped.length < MAX_SKIP_RECORDS) skipped.push(code === undefined ? { path, reason } : { path, reason, code });
    if (reason === 'unreadable' || reason === 'unknown' || reason === 'reparse' || reason === 'too-deep' || reason === 'limit' || reason === 'user-skipped') complete = false;
    if (reason === 'limit') limitReached = true;
  };

  const stack: Array<{ node: FolderNode; segments: string[]; depth: number }> = [{ node: root, segments: [], depth: 0 }];
  order.push(root);
  while (stack.length > 0) {
    // Checked once per folder: a cancel stops the walk at the next folder, and no partial map is returned.
    if (options.signal?.aborted) throw cancelledError();
    const frame = stack.pop()!;
    // Once the entry limit is reached, a remaining folder is not read at all: its listing could only be discarded.
    if (entries >= limits.maxEntries) {
      frame.node.readState = 'skipped';
      skip(canonicalPath(frame.segments), 'limit');
      continue;
    }
    if (frame.depth >= limits.maxDepth) {
      frame.node.readState = 'skipped';
      skip(canonicalPath(frame.segments), 'too-deep');
      continue;
    }
    let listing: readonly DirEntry[];
    try {
      listing = await port.readDir(frame.segments);
    } catch (error) {
      // The folder stays in the map, marked unreadable with its name and code; its siblings are walked as usual. Its children cannot be
      // listed, so they stay unknown and the map is incomplete (accepted limit, TB-137; see docs/LIBRARY-LIMITS.md).
      frame.node.readState = 'unreadable';
      const code = diagnosticCodeOf(error);
      if (code !== undefined) frame.node.code = code;
      skip(canonicalPath(frame.segments), 'unreadable', code);
      continue;
    }
    frame.node.readState = 'listed';
    const sorted = [...listing].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      if (entries >= limits.maxEntries) {
        skip(canonicalPath([...frame.segments, entry.name]), 'limit');
        continue;
      }
      entries++;
      const childPath = [...frame.segments, entry.name];
      // A name that is empty, "." or ".." or contains a separator cannot be a single segment; refuse it instead of walking it.
      if (entry.name === '' || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || (platform === 'win32' && entry.name.includes('\\'))) {
        skip(entry.name, 'other-kind');
        continue;
      }
      // A link is never followed. A link whose real place is outside the root carries the adapter's code: the record says why it was refused.
      if (entry.kind === 'link') { skip(canonicalPath(childPath), 'link', entry.code); continue; }
      // A reparse point that is not a link is neither listed nor walked, and its content is not read: the map says it is incomplete.
      if (entry.kind === 'reparse') { skip(canonicalPath(childPath), 'reparse'); continue; }
      if (entry.kind === 'other') { skip(canonicalPath(childPath), 'other-kind'); continue; }
      // Unclassified entries are recorded and make the map incomplete; their contents are unknown, so they are not walked.
      if (entry.kind === 'unknown') { skip(canonicalPath(childPath), 'unknown', diagnosticCodeOf(entry)); continue; }
      if (entry.kind === 'file') {
        if (isSidecarName(entry.name)) { skip(canonicalPath(childPath), 'sidecar'); continue; }
        const size = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : 0;
        frame.node.files.push({ name: entry.name, path: canonicalPath(childPath), key: identityKey(childPath, platform), size, extension: extensionOf(entry.name), ...(entry.online === true ? { online: true as const } : {}) });
        continue;
      }
      if (skipPaths.has(canonicalPath(childPath))) { skip(canonicalPath(childPath), 'user-skipped'); continue; }
      const child = makeFolder(entry.name, childPath, platform);
      frame.node.folders.push(child);
      parentOf.set(child, frame.node);
      order.push(child);
      stack.push({ node: child, segments: childPath, depth: frame.depth + 1 });
    }
  }

  // Children are always created after their parent, so walking the creation order backwards sums every folder before its parent.
  for (let index = order.length - 1; index >= 0; index--) {
    const node = order[index];
    let fileCount = node.files.length;
    let folderCount = node.folders.length;
    let bytes = node.files.reduce((sum, file) => sum + file.size, 0);
    for (const child of node.folders) {
      fileCount += child.fileCount;
      folderCount += child.folderCount;
      bytes += child.bytes;
    }
    node.fileCount = fileCount;
    node.folderCount = folderCount;
    node.bytes = bytes;
  }
  return { root, skipped, skippedCount, complete, fileCount: root.fileCount, folderCount: root.folderCount, limitReached };
}

/**
 * Finds a folder by its canonical path, or by identity key when `platform` folds case. Returns undefined when no folder matches,
 * and also when two different folders share the key (a collision): the caller must not pick one of them.
 */
export function findFolder(map: FolderMap, canonical: string, platform: DevicePlatform): FolderNode | undefined {
  const wanted = identityKey(canonical === '' ? [] : canonical.split('/'), platform);
  let found: FolderNode | undefined;
  const stack: FolderNode[] = [map.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.key === wanted) {
      if (found !== undefined && found.path !== node.path) return undefined;
      found = node;
    }
    // A loop, not push(...spread): spreading a very large folder overflows the call stack.
    for (const child of node.folders) stack.push(child);
  }
  return found;
}
