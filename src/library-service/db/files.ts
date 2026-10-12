import { FILE_STATES, type FileState, type LibraryId } from '../../lib/library/model';
import { isRelativeLibraryPath } from '../../lib/library/validate';
import { all, atomic, get, jsonIds, run, type Ctx } from './context';
import { bumpEpoch } from './meta';
import { deriveStateForContent } from './content';
import { purgeFullTextRows, purgeUnconsentedFullText, rootByPublicId } from './roots';
import { forgetContents, forgetFiles } from './temp';
import type { FileObservation, FileUpsertResult, MoveReport, RootRemoval } from './types';

const MAX_DEPTH = 64;
export const MISSING_RETENTION_MS = 30 * 24 * 3600 * 1000;
/** States only the walker sets; everything else is derived from the content (see content.ts). */
const WALKER_STATES = new Set<FileState>(['link', 'no-access', 'locked', 'skipped']);
const validState = (s: unknown): s is FileState => typeof s === 'string' && (FILE_STATES as readonly string[]).includes(s);

/** Directory path (relative to its root, `/` separated, empty for the root folder) with a memo local to one operation. */
export function dirPather(ctx: Ctx): (dirId: number) => string {
  const memo = new Map<number, string>();
  const walk = (id: number, depth: number): string => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (depth > MAX_DEPTH) return '';
    const row = get<{ parent_id: number | null; name: string }>(ctx, 'SELECT parent_id, name FROM dir WHERE id = ?', id);
    if (!row) return '';
    let path = '';
    if (row.parent_id !== null) { const parent = walk(row.parent_id, depth + 1); path = parent ? `${parent}/${row.name}` : row.name; }
    memo.set(id, path);
    return path;
  };
  return id => walk(id, 0);
}

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

interface DirContext { rootId: number; cache: Map<string, number> }

function ensureDir(ctx: Ctx, d: DirContext, dir: string): number {
  const cached = d.cache.get(dir);
  if (cached !== undefined) return cached;
  let id: number;
  if (dir === '') {
    id = get<{ id: number }>(ctx, 'SELECT id FROM dir WHERE root_id = ? AND parent_id IS NULL', d.rootId)?.id
      ?? run(ctx, "INSERT INTO dir(root_id, parent_id, name) VALUES(?, NULL, '')", d.rootId).lastInsertRowid;
  } else {
    const slash = dir.lastIndexOf('/');
    const parent = ensureDir(ctx, d, slash < 0 ? '' : dir.slice(0, slash));
    const name = dir.slice(slash + 1);
    id = get<{ id: number }>(ctx, 'SELECT id FROM dir WHERE root_id = ? AND parent_id = ? AND name = ?', d.rootId, parent, name)?.id
      ?? run(ctx, 'INSERT INTO dir(root_id, parent_id, name) VALUES(?, ?, ?)', d.rootId, parent, name).lastInsertRowid;
  }
  d.cache.set(dir, id);
  return id;
}

/** Name index rows hold normalised relative labels only: never an absolute path. */
const searchText = (value: string): string => value.normalize('NFKC');
export function ftsPutName(ctx: Ctx, fileId: number, name: string, dir: string): void {
  run(ctx, 'INSERT INTO name_fts(rowid, name, path) VALUES(?, ?, ?)', fileId, searchText(name), searchText(dir));
}

interface FileRow { id: number; public_id: string; dir_id: number; name: string; container_id: number | null; entry_path: string | null; size: number; mtime_ms: number | null; file_key: string | null; content_id: number | null; state: string; seen_scan: number; missing_since: number | null }

interface Prepared { dirId: number; name: string; containerId: number | null; entryPath: string | null; ftsDir: string; lookupSql: string; lookup: (number | string)[] }

const validNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function prepare(ctx: Ctx, d: DirContext, obs: FileObservation, pather: (id: number) => string): Prepared | FileUpsertResult {
  if ('containerId' in obs) {
    const container = get<{ id: number; dir_id: number; name: string }>(ctx, 'SELECT f.id, f.dir_id, f.name FROM file f JOIN dir d ON d.id = f.dir_id WHERE f.public_id = ? AND f.container_id IS NULL AND d.root_id = ?', obs.containerId, d.rootId);
    if (!container) return { status: 'rejected', reason: 'unknown-container' };
    if (typeof obs.entryPath !== 'string' || !isRelativeLibraryPath(obs.entryPath)) return { status: 'rejected', reason: 'invalid-entry' };
    const slash = obs.entryPath.lastIndexOf('/');
    const entryDir = slash < 0 ? '' : obs.entryPath.slice(0, slash);
    const containerDir = pather(container.dir_id);
    return {
      dirId: container.dir_id, name: obs.entryPath.slice(slash + 1), containerId: container.id, entryPath: obs.entryPath,
      ftsDir: joinPath(joinPath(containerDir, container.name), entryDir),
      lookupSql: 'SELECT * FROM file WHERE container_id = ? AND entry_path = ?', lookup: [container.id, obs.entryPath],
    };
  }
  if (typeof obs.dir !== 'string' || typeof obs.name !== 'string' || obs.name.includes('/')) return { status: 'rejected', reason: 'invalid-path' };
  const path = joinPath(obs.dir, obs.name);
  if (!isRelativeLibraryPath(path) || (obs.dir !== '' && !isRelativeLibraryPath(obs.dir)) || path.split('/').length > MAX_DEPTH) return { status: 'rejected', reason: 'invalid-path' };
  const dirId = ensureDir(ctx, d, obs.dir);
  return { dirId, name: obs.name, containerId: null, entryPath: null, ftsDir: obs.dir, lookupSql: 'SELECT * FROM file WHERE dir_id = ? AND name = ? AND container_id IS NULL', lookup: [dirId, obs.name] };
}

/**
 * An unchanged archive is not listed again, so its members are carried into the new scan with it (otherwise the end of the walk would mark
 * them missing). Members that went missing together with the archive come back with it; members missing on their own stay missing.
 */
function carryMembers(ctx: Ctx, container: FileRow, scan: number): void {
  if (container.missing_since !== null) {
    const revived = all<{ id: number; content_id: number | null }>(ctx, 'SELECT id, content_id FROM file WHERE container_id = ? AND missing_since = ?', container.id, container.missing_since);
    for (const member of revived) {
      run(ctx, 'UPDATE file SET missing_since = NULL, state = ? WHERE id = ?', member.content_id === null ? 'pending' : deriveStateForContent(ctx, member.content_id), member.id);
    }
  }
  run(ctx, 'UPDATE file SET seen_scan = ? WHERE container_id = ? AND missing_since IS NULL', scan, container.id);
}

function upsertOne(ctx: Ctx, d: DirContext, scan: number, obs: FileObservation, pather: (id: number) => string): FileUpsertResult {
  if (!validNumber(obs.size) || (obs.mtimeMs !== undefined && !Number.isFinite(obs.mtimeMs)) || (obs.fileKey !== undefined && (typeof obs.fileKey !== 'string' || obs.fileKey.length > 256)) || (obs.state !== undefined && !validState(obs.state))) {
    return { status: 'rejected', reason: 'invalid-value' };
  }
  const prepared = prepare(ctx, d, obs, pather);
  if (!('dirId' in prepared)) return prepared;
  const mtime = obs.mtimeMs === undefined ? null : Math.trunc(obs.mtimeMs);
  const key = obs.fileKey ?? null;
  const existing = get<FileRow>(ctx, prepared.lookupSql, ...prepared.lookup);
  if (!existing) {
    const id = ctx.ids.next('f');
    const rowid = run(ctx, `INSERT INTO file(public_id, dir_id, name, container_id, entry_path, size, mtime_ms, file_key, content_id, state, seen_scan, missing_since)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`, id, prepared.dirId, prepared.name, prepared.containerId, prepared.entryPath, obs.size, mtime, key, obs.state ?? 'pending', scan).lastInsertRowid;
    ftsPutName(ctx, rowid, prepared.name, prepared.ftsDir);
    return { status: 'new', id, needsIdentity: true };
  }
  const changed = existing.size !== obs.size || (mtime !== null && existing.mtime_ms !== null && existing.mtime_ms !== mtime) || (key !== null && existing.file_key !== null && existing.file_key !== key);
  const contentId = existing.content_id === null ? undefined : get<{ public_id: string }>(ctx, 'SELECT public_id FROM content WHERE id = ?', existing.content_id)?.public_id;
  if (changed) {
    run(ctx, 'UPDATE file SET size = ?, mtime_ms = ?, file_key = ?, content_id = NULL, state = ?, seen_scan = ?, missing_since = NULL WHERE id = ?', obs.size, mtime, key, obs.state ?? 'pending', scan, existing.id);
    if (existing.content_id !== null) purgeUnconsentedFullText(ctx, [existing.content_id]);
    return { status: 'changed', id: existing.public_id, needsIdentity: true };
  }
  run(ctx, 'UPDATE file SET seen_scan = ?, missing_since = NULL, mtime_ms = COALESCE(mtime_ms, ?), file_key = COALESCE(file_key, ?) WHERE id = ?', scan, mtime, key, existing.id);
  if (!('containerId' in obs)) carryMembers(ctx, existing, scan);
  // A state the walker reports wins; when the walker reports none, a walker-only state or `missing` is resolved from the content again.
  if (obs.state && obs.state !== existing.state && (WALKER_STATES.has(obs.state) || existing.state === 'missing' || WALKER_STATES.has(existing.state as FileState))) run(ctx, 'UPDATE file SET state = ? WHERE id = ?', obs.state, existing.id);
  else if (!obs.state && (existing.state === 'missing' || WALKER_STATES.has(existing.state as FileState))) {
    if (existing.content_id === null) run(ctx, "UPDATE file SET state = 'pending' WHERE id = ?", existing.id);
    else run(ctx, 'UPDATE file SET state = ? WHERE id = ?', deriveStateForContent(ctx, existing.content_id), existing.id);
  }
  return { status: 'unchanged', id: existing.public_id, ...(contentId ? { contentId } : {}), needsIdentity: existing.content_id === null };
}

/**
 * Records the files a walk saw in one root, in transactions of at most 500 files. A new row starts `pending`; a row whose size, mtime or file
 * key changed loses its content link and is `pending` again; an unchanged row only gets the scan number (and comes back from `missing`).
 * Paths that are not normalised relative locations are rejected, never stored.
 */
export function upsertFiles(ctx: Ctx, rootPublicId: string, scan: number, entries: readonly FileObservation[]): FileUpsertResult[] {
  const root = rootByPublicId(ctx, rootPublicId);
  if (!root || root.state === 'removing') return entries.map(() => ({ status: 'rejected' as const, reason: 'unknown-root' as const }));
  const d: DirContext = { rootId: root.id, cache: new Map() };
  const pather = dirPather(ctx);
  const results: FileUpsertResult[] = [];
  try {
    for (const entry of entries) results.push(ctx.writer.run(1, () => upsertOne(ctx, d, scan, entry, pather)));
    ctx.writer.commit();
  } catch (error) { ctx.writer.rollback(); throw error; }
  return results;
}

/** Deletes files and the archive members of those files, together with their name index rows. Foreign keys cascade the rest. */
export function deleteFileRows(ctx: Ctx, fileIds: readonly number[]): number {
  if (fileIds.length === 0) return 0;
  const list = jsonIds(fileIds);
  const members = all<{ id: number }>(ctx, 'SELECT id FROM file WHERE container_id IN (SELECT value FROM json_each(?))', list).map(r => r.id);
  const everything = [...fileIds, ...members];
  const ids = jsonIds(everything);
  const contents = all<{ content_id: number }>(ctx, 'SELECT DISTINCT content_id FROM file WHERE id IN (SELECT value FROM json_each(?)) AND content_id IS NOT NULL', ids).map(r => r.content_id);
  run(ctx, 'DELETE FROM name_fts WHERE rowid IN (SELECT value FROM json_each(?))', ids);
  forgetFiles(ctx, everything);
  const deleted = run(ctx, 'DELETE FROM file WHERE id IN (SELECT value FROM json_each(?))', ids).changes;
  purgeUnconsentedFullText(ctx, contents);
  return deleted;
}

/**
 * Called after a COMPLETE walk of an online root: rows the walk did not see are marked `missing` and keep their data for 30 days. An
 * offline or unreadable root is never touched, so an unplugged drive cannot empty the index.
 */
export function markMissing(ctx: Ctx, rootPublicId: string, scan: number, nowMs: number): number {
  const root = rootByPublicId(ctx, rootPublicId);
  if (!root || root.state !== 'online') return 0;
  let total = 0;
  for (;;) {
    const changed = atomic(ctx, () => {
      const ids = all<{ id: number }>(ctx, `SELECT f.id FROM file f JOIN dir d ON d.id = f.dir_id WHERE d.root_id = ? AND f.seen_scan < ? AND f.missing_since IS NULL LIMIT 500`, root.id, scan).map(r => r.id);
      if (ids.length === 0) return 0;
      return run(ctx, "UPDATE file SET missing_since = ?, state = 'missing' WHERE id IN (SELECT value FROM json_each(?))", nowMs, jsonIds(ids)).changes;
    }, 500);
    if (changed === 0) break;
    total += changed;
  }
  return total;
}

/** Deletes rows missing for longer than the retention (default 30 days), then removes what only they referenced. */
export function purgeMissing(ctx: Ctx, nowMs: number, retentionMs: number = MISSING_RETENTION_MS): number {
  let total = 0;
  for (;;) {
    const removed = atomic(ctx, () => {
      const ids = all<{ id: number }>(ctx, "SELECT id FROM file WHERE state = 'missing' AND missing_since IS NOT NULL AND missing_since <= ? AND container_id IS NULL LIMIT 500", nowMs - retentionMs).map(r => r.id);
      const entries = all<{ id: number }>(ctx, "SELECT id FROM file WHERE state = 'missing' AND missing_since IS NOT NULL AND missing_since <= ? AND container_id IS NOT NULL LIMIT 500", nowMs - retentionMs).map(r => r.id);
      return deleteFileRows(ctx, [...ids, ...entries]);
    }, 500);
    if (removed === 0) break;
    total += removed;
  }
  if (total > 0) { collectGarbage(ctx); atomic(ctx, () => bumpEpoch(ctx)); }
  return total;
}

/** Removes the file `fileId` and returns whether it was a member of an archive. Used when a user explicitly removes missing rows. */
export function removeMissingNow(ctx: Ctx, rootPublicId?: string): number {
  const where = rootPublicId ? 'AND d.root_id = (SELECT id FROM root WHERE public_id = ?)' : '';
  const params = rootPublicId ? [rootPublicId] : [];
  let total = 0;
  for (;;) {
    const removed = atomic(ctx, () => {
      const ids = all<{ id: number }>(ctx, `SELECT f.id FROM file f JOIN dir d ON d.id = f.dir_id WHERE f.state = 'missing' ${where} LIMIT 500`, ...params).map(r => r.id);
      return deleteFileRows(ctx, ids);
    }, 500);
    if (removed === 0) break;
    total += removed;
  }
  if (total > 0) { collectGarbage(ctx); atomic(ctx, () => bumpEpoch(ctx)); }
  return total;
}

/** Moves a loose file row to a new location, keeping its content, group membership and decisions. */
export function moveFile(ctx: Ctx, filePublicId: string, to: { dir: string; name: string }): boolean {
  const file = get<{ id: number; dir_id: number; container_id: number | null }>(ctx, 'SELECT id, dir_id, container_id FROM file WHERE public_id = ?', filePublicId);
  if (!file || file.container_id !== null) return false;
  const root = get<{ root_id: number }>(ctx, 'SELECT root_id FROM dir WHERE id = ?', file.dir_id);
  if (!root || to.name.includes('/') || !isRelativeLibraryPath(joinPath(to.dir, to.name)) || (to.dir !== '' && !isRelativeLibraryPath(to.dir))) return false;
  const d: DirContext = { rootId: root.root_id, cache: new Map() };
  try {
    ctx.writer.run(1, () => {
      const dirId = ensureDir(ctx, d, to.dir);
      run(ctx, 'UPDATE file SET dir_id = ?, name = ? WHERE id = ?', dirId, to.name, file.id);
      run(ctx, 'DELETE FROM name_fts WHERE rowid = ?', file.id);
      ftsPutName(ctx, file.id, to.name, to.dir);
      const members = all<{ id: number; entry_path: string }>(ctx, 'SELECT id, entry_path FROM file WHERE container_id = ?', file.id);
      for (const member of members) {
        run(ctx, 'UPDATE file SET dir_id = ? WHERE id = ?', dirId, member.id);
        const slash = member.entry_path.lastIndexOf('/');
        run(ctx, 'DELETE FROM name_fts WHERE rowid = ?', member.id);
        ftsPutName(ctx, member.id, member.entry_path.slice(slash + 1), joinPath(joinPath(to.dir, to.name), slash < 0 ? '' : member.entry_path.slice(0, slash)));
      }
    });
    ctx.writer.commit();
  } catch (error) { ctx.writer.rollback(); return false; }
  return true;
}

/**
 * Pairs a file the walk did not see with a file it newly saw whose content has the same size and quick key: a move. The new row takes over
 * the old row's content (so groups and hash-keyed decisions follow) and the old row is deleted. The new row's content must belong to no other file. Only one-to-one pairs are resolved.
 */
export function resolveMoves(ctx: Ctx, rootPublicId: string, scan: number): MoveReport[] {
  const root = rootByPublicId(ctx, rootPublicId);
  if (!root) return [];
  const pairs = all<{ uid: number; nid: number; ucontent: number; ncontent: number }>(ctx, `
    SELECT u.id AS uid, n.id AS nid, u.content_id AS ucontent, n.content_id AS ncontent
    FROM file u JOIN dir du ON du.id = u.dir_id JOIN content cu ON cu.id = u.content_id
      JOIN content cn ON cn.quick = cu.quick AND cn.size = cu.size AND cn.id <> cu.id AND (cu.sha256 IS NULL OR cn.sha256 IS NULL)
      JOIN file n ON n.content_id = cn.id JOIN dir dn ON dn.id = n.dir_id
    WHERE du.root_id = ? AND dn.root_id = ? AND u.seen_scan < ? AND u.missing_since IS NULL AND u.container_id IS NULL
      AND n.seen_scan = ? AND n.container_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM file o WHERE o.content_id = n.content_id AND o.id <> n.id)`, root.id, root.id, scan, scan);
  const olds = new Map<number, number>(), news = new Map<number, number>();
  for (const p of pairs) { olds.set(p.uid, (olds.get(p.uid) ?? 0) + 1); news.set(p.nid, (news.get(p.nid) ?? 0) + 1); }
  const reports: MoveReport[] = [];
  for (const p of pairs) {
    if (olds.get(p.uid) !== 1 || news.get(p.nid) !== 1) continue;
    const report = atomic(ctx, () => {
      const oldFile = get<{ public_id: string }>(ctx, 'SELECT public_id FROM file WHERE id = ?', p.uid);
      const newFile = get<{ public_id: string }>(ctx, 'SELECT public_id FROM file WHERE id = ?', p.nid);
      const content = get<{ public_id: string }>(ctx, 'SELECT public_id FROM content WHERE id = ?', p.ucontent);
      if (!oldFile || !newFile || !content) return undefined;
      run(ctx, 'UPDATE file SET content_id = ?, state = (SELECT state FROM file WHERE id = ?) WHERE id = ?', p.ucontent, p.uid, p.nid);
      // The old row only had the identity and the position; the new row now carries the content.
      const entries = all<{ id: number }>(ctx, 'SELECT id FROM file WHERE container_id = ?', p.uid);
      deleteFileRows(ctx, [p.uid, ...entries.map(e => e.id)]);
      if (get(ctx, 'SELECT 1 AS x FROM file WHERE content_id = ? LIMIT 1', p.ncontent) === undefined) {
        purgeFullTextRows(ctx, [p.ncontent]);
        forgetContents(ctx, [p.ncontent]);
        run(ctx, 'DELETE FROM content WHERE id = ?', p.ncontent);
      }
      return { removedFileId: oldFile.public_id, keptFileId: newFile.public_id, contentId: content.public_id };
    });
    if (report) reports.push(report);
  }
  return reports;
}

/**
 * Removes a root and everything that belongs to it, in bounded steps. The root is marked `removing` first so a crash leaves a state
 * that start-up finishes (see pendingRemovals). Contents, terms and groups nothing references any more go with it.
 */
export function removeRoot(ctx: Ctx, rootPublicId: string): RootRemoval | undefined {
  const root = rootByPublicId(ctx, rootPublicId);
  if (!root) return undefined;
  atomic(ctx, () => run(ctx, "UPDATE root SET state = 'removing' WHERE id = ?", root.id));
  let files = 0;
  for (;;) {
    const removed = atomic(ctx, () => {
      const ids = all<{ id: number }>(ctx, 'SELECT f.id FROM file f JOIN dir d ON d.id = f.dir_id WHERE d.root_id = ? AND f.container_id IS NULL LIMIT 500', root.id).map(r => r.id);
      return deleteFileRows(ctx, ids);
    }, 500);
    if (removed === 0) break;
    files += removed;
  }
  atomic(ctx, () => run(ctx, 'DELETE FROM root WHERE id = ?', root.id));
  const garbage = collectGarbage(ctx);
  atomic(ctx, () => bumpEpoch(ctx));
  return { files, contents: garbage.contents, groups: garbage.groups };
}

/**
 * Deletes what nothing references: empty directories, contents without a file (with their page text rows), groups without members, duplicate
 * sets without files or contents, and terms without postings. Bounded transactions.
 */
export function collectGarbage(ctx: Ctx): { contents: number; groups: number; terms: number; dirs: number } {
  const result = { contents: 0, groups: 0, terms: 0, dirs: 0 };
  for (;;) {
    const removed = atomic(ctx, () => run(ctx, `DELETE FROM dir WHERE parent_id IS NOT NULL AND id IN (
      SELECT d.id FROM dir d WHERE d.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM file f WHERE f.dir_id = d.id) AND NOT EXISTS (SELECT 1 FROM dir c WHERE c.parent_id = d.id) LIMIT 500)`).changes);
    if (removed === 0) break;
    result.dirs += removed;
  }
  for (;;) {
    const removed = atomic(ctx, () => {
      const ids = all<{ id: number }>(ctx, 'SELECT c.id FROM content c WHERE NOT EXISTS (SELECT 1 FROM file f WHERE f.content_id = c.id) LIMIT 100').map(r => r.id);
      if (ids.length === 0) return 0;
      purgeFullTextRows(ctx, ids);
      forgetContents(ctx, ids);
      return run(ctx, 'DELETE FROM content WHERE id IN (SELECT value FROM json_each(?))', jsonIds(ids)).changes;
    }, 100);
    if (removed === 0) break;
    result.contents += removed;
  }
  result.groups = atomic(ctx, () => {
    const empty = run(ctx, 'DELETE FROM grp WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m.group_id = grp.id)').changes;
    run(ctx, 'DELETE FROM duplicate_set WHERE NOT EXISTS (SELECT 1 FROM duplicate_file x WHERE x.set_id = duplicate_set.id) AND NOT EXISTS (SELECT 1 FROM duplicate_content y WHERE y.set_id = duplicate_set.id)');
    return empty;
  });
  for (;;) {
    const removed = atomic(ctx, () => run(ctx, 'DELETE FROM term WHERE id IN (SELECT t.id FROM term t WHERE NOT EXISTS (SELECT 1 FROM posting p WHERE p.term_id = t.id) LIMIT 5000)').changes, 100);
    if (removed === 0) break;
    result.terms += removed;
  }
  return result;
}
