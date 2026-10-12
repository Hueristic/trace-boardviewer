import { DEFAULT_ROOT_OPTIONS, type RegisteredRoot, type RootOptions, type RootSummary } from '../../lib/library/model';
import { all, atomic, get, int, run, type Ctx } from './context';
import type { FullTextChange, RootSyncReport } from './types';

export interface RootRow { id: number; public_id: string; path: string; label: string; state: string; network: number; options: string }

export function parseOptions(raw: string | null | undefined): RootOptions {
  try {
    const value = JSON.parse(raw ?? '{}') as Partial<RootOptions>;
    return {
      fullText: value.fullText === true,
      watch: value.watch === true,
      exclusions: Array.isArray(value.exclusions) ? value.exclusions.filter((e): e is string => typeof e === 'string').slice(0, 128) : [],
      rescanMinutes: Number.isSafeInteger(value.rescanMinutes) && (value.rescanMinutes as number) >= 0 ? (value.rescanMinutes as number) : 0,
    };
  } catch { return { ...DEFAULT_ROOT_OPTIONS, exclusions: [] }; }
}

const serializeOptions = (o: RootOptions): string => JSON.stringify({ fullText: o.fullText === true, watch: o.watch === true, exclusions: o.exclusions.slice(0, 128), rescanMinutes: o.rescanMinutes });

export const rootByPublicId = (ctx: Ctx, publicId: string): RootRow | undefined => get<RootRow>(ctx, 'SELECT * FROM root WHERE public_id = ?', publicId);

function clipLabel(label: string): string {
  const clipped = label.normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 64);
  return clipped;
}

const stateOf = (state: string): 'online' | 'offline' | 'no-access' => (state === 'offline' || state === 'no-access' ? state : 'online');

export function summarize(ctx: Ctx, row: RootRow): RootSummary {
  const count = get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM file f JOIN dir d ON d.id = f.dir_id WHERE d.root_id = ?', row.id);
  return { id: row.public_id, label: row.label, state: stateOf(row.state), network: row.network === 1, options: parseOptions(row.options), fileCount: int(count?.n) };
}

export function listRoots(ctx: Ctx): RootSummary[] {
  return all<RootRow>(ctx, "SELECT * FROM root WHERE state <> 'removing' ORDER BY id").map(row => summarize(ctx, row));
}

/** Contents of this root that would lose their only full-text-enabled root when the option is turned off. */
function contentsLosingFullText(ctx: Ctx, rootId: number): number[] {
  return all<{ content_id: number }>(ctx, `SELECT DISTINCT f.content_id FROM file f JOIN dir d ON d.id = f.dir_id
    WHERE d.root_id = ? AND f.content_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM stage s WHERE s.content_id = f.content_id AND s.stage = 'full-text')
      AND NOT EXISTS (SELECT 1 FROM file f2 JOIN dir d2 ON d2.id = f2.dir_id JOIN root r2 ON r2.id = d2.root_id
        WHERE f2.content_id = f.content_id AND r2.id <> ? AND r2.state <> 'removing' AND json_extract(r2.options, '$.fullText') = 1)`, rootId, rootId).map(r => r.content_id);
}

/**
 * Deletes the page text rows of the contents (no cascade reaches a contentless table) and their `full-text` stage rows. The rows of one
 * content are found through the table's own `docsize` shadow table: a rowid range on the virtual table itself is a full scan.
 */
export function purgeFullTextRows(ctx: Ctx, contentIds: readonly number[]): void {
  for (const id of contentIds) {
    run(ctx, 'DELETE FROM text_fts WHERE rowid IN (SELECT id FROM text_fts_docsize WHERE id BETWEEN ? * 4096 + 1 AND ? * 4096 + 2000)', id, id);
    run(ctx, "DELETE FROM stage WHERE content_id = ? AND stage = 'full-text'", id);
  }
}

/** Purges page text when removing or changing a file takes away its last enabled root. Called inside the file transaction. */
export function purgeUnconsentedFullText(ctx: Ctx, contentIds: readonly number[]): void {
  for (const id of new Set(contentIds)) {
    if (get(ctx, `SELECT 1 FROM file f JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id
      WHERE f.content_id = ? AND r.state <> 'removing' AND json_extract(r.options, '$.fullText') = 1 LIMIT 1`, id) === undefined) purgeFullTextRows(ctx, [id]);
  }
}

function applyFullTextChange(ctx: Ctx, rootId: number, before: RootOptions, after: RootOptions): FullTextChange {
  const change: FullTextChange = { purgedContents: 0, pendingContents: 0 };
  if (before.fullText && !after.fullText) {
    const ids = contentsLosingFullText(ctx, rootId);
    for (let i = 0; i < ids.length; i += 100) ctx.writer.run(100, () => purgeFullTextRows(ctx, ids.slice(i, i + 100)));
    change.purgedContents = ids.length;
  } else if (!before.fullText && after.fullText) {
    // The documents of this root need their text read again: mark the stage pending so that the queue picks them up.
    const now = ctx.now();
    change.pendingContents = ctx.writer.run(1, () => run(ctx, `INSERT INTO stage(content_id, stage, version, state, at)
      SELECT DISTINCT f.content_id, 'full-text', 0, 'pending', ? FROM file f JOIN dir d ON d.id = f.dir_id JOIN content c ON c.id = f.content_id
      WHERE d.root_id = ? AND c.kind IN ('pdf', 'schematic') AND f.content_id IS NOT NULL
      ON CONFLICT(content_id, stage) DO UPDATE SET state = CASE WHEN stage.state = 'done' THEN stage.state ELSE 'pending' END`, now, rootId).changes);
  }
  ctx.writer.commit();
  return change;
}

/**
 * Applies the registered roots main sends. A root is identified by its public id; its realpath, label, state, network flag and options are
 * updated in place and its rows stay. Roots in the database that main no longer lists are reported, never deleted: removal is explicit.
 */
export function syncRoots(ctx: Ctx, roots: readonly RegisteredRoot[]): RootSyncReport {
  const report: RootSyncReport = { added: [], updated: [], unchanged: [], unregistered: [] };
  const seen = new Set<string>();
  for (const root of roots) {
    seen.add(root.id);
    const row = rootByPublicId(ctx, root.id);
    const options = serializeOptions(root.options);
    const label = clipLabel(root.label) || root.id, network = root.network ? 1 : 0;
    if (!row) {
      atomic(ctx, () => run(ctx, 'INSERT INTO root(public_id, path, label, state, network, options) VALUES(?, ?, ?, ?, ?, ?)', root.id, root.realpath, label, root.state, network, options));
      report.added.push(root.id);
      continue;
    }
    const before = parseOptions(row.options);
    const same = row.path === root.realpath && row.label === label && row.state === root.state && row.network === network && row.options === options;
    if (same) { report.unchanged.push(root.id); continue; }
    atomic(ctx, () => run(ctx, 'UPDATE root SET path = ?, label = ?, state = ?, network = ?, options = ? WHERE id = ?', root.realpath, label, root.state, network, options, row.id));
    applyFullTextChange(ctx, row.id, before, parseOptions(options));
    report.updated.push(root.id);
  }
  report.unregistered = all<{ public_id: string }>(ctx, "SELECT public_id FROM root WHERE state <> 'removing'").map(r => r.public_id).filter(id => !seen.has(id));
  return report;
}

export function setRootState(ctx: Ctx, publicId: string, state: 'online' | 'offline' | 'no-access'): boolean {
  return atomic(ctx, () => run(ctx, "UPDATE root SET state = ? WHERE public_id = ? AND state <> 'removing'", state, publicId).changes) > 0;
}

export function setRootOptions(ctx: Ctx, publicId: string, options: RootOptions): FullTextChange | undefined {
  const row = rootByPublicId(ctx, publicId);
  if (!row || row.state === 'removing') return undefined;
  const next = serializeOptions(options);
  atomic(ctx, () => run(ctx, 'UPDATE root SET options = ? WHERE id = ?', next, row.id));
  return applyFullTextChange(ctx, row.id, parseOptions(row.options), parseOptions(next));
}

/** Roots left half-removed by a crash (state `removing`): the caller finishes them at start-up. */
export function pendingRemovals(ctx: Ctx): string[] {
  return all<{ public_id: string }>(ctx, "SELECT public_id FROM root WHERE state = 'removing'").map(r => r.public_id);
}
