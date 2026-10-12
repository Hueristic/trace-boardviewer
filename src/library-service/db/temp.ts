import { jsonIds, run, type Ctx } from './context';

/**
 * Connection-local scratch tables (TEMP schema, never written to library.db):
 *  - hidden_file / hidden_content / role_override hold the materialised user decisions. They are disposable: the decisions file in the
 *    profile is the only copy of that data, and `applyDecisions` rebuilds these tables from it.
 *  - q_hits / q_nhits / q_pairs hold the intermediate sets of one search request.
 */
export const TEMP_SQL = `
CREATE TEMP TABLE IF NOT EXISTS hidden_file(file_id INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TEMP TABLE IF NOT EXISTS hidden_content(content_id INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TEMP TABLE IF NOT EXISTS role_override(content_id INTEGER PRIMARY KEY, role TEXT NOT NULL) WITHOUT ROWID;
CREATE TEMP TABLE IF NOT EXISTS q_hits(term INTEGER NOT NULL, content_id INTEGER NOT NULL, mrank INTEGER NOT NULL, ptier INTEGER NOT NULL, source TEXT, refs TEXT, extra INTEGER, pages BLOB, page INTEGER);
CREATE INDEX IF NOT EXISTS temp.q_hits_term ON q_hits(term, content_id);
CREATE TEMP TABLE IF NOT EXISTS q_nhits(term INTEGER NOT NULL, file_id INTEGER NOT NULL, content_id INTEGER);
CREATE INDEX IF NOT EXISTS temp.q_nhits_term ON q_nhits(term, file_id);
CREATE INDEX IF NOT EXISTS temp.q_nhits_content ON q_nhits(term, content_id);
CREATE TEMP TABLE IF NOT EXISTS q_pairs(row_id, file_id INTEGER, kind TEXT, role TEXT, format TEXT, root TEXT, state TEXT);
CREATE INDEX IF NOT EXISTS temp.q_pairs_row ON q_pairs(row_id);
`;

export function createTempTables(ctx: Ctx): void { ctx.db.exec(TEMP_SQL); }

/** Drops decision rows that point at files or contents that no longer exist, so reused row ids can never inherit a hidden flag. */
export function forgetFiles(ctx: Ctx, fileIds: readonly number[]): void {
  if (fileIds.length) run(ctx, 'DELETE FROM hidden_file WHERE file_id IN (SELECT value FROM json_each(?))', jsonIds(fileIds));
}
export function forgetContents(ctx: Ctx, contentIds: readonly number[]): void {
  if (!contentIds.length) return;
  const ids = jsonIds(contentIds);
  run(ctx, 'DELETE FROM hidden_content WHERE content_id IN (SELECT value FROM json_each(?))', ids);
  run(ctx, 'DELETE FROM role_override WHERE content_id IN (SELECT value FROM json_each(?))', ids);
}
