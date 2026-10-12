import { all, atomic, get, int, run, text, type Ctx } from './context';
import { dirPather, ftsPutName, joinPath } from './files';
import { purgeFullTextRows } from './roots';
import { fullTextAllowed } from './summary';
import type { IntegrityReport } from './types';

const MAX_PROBLEMS = 20;

/**
 * The name and page-text indexes are contentless FTS5 tables: they have no foreign key to the rows they index. Their `docsize` shadow
 * tables list the row ids that exist, which is the cheap way to compare them with `file` and `content` (a scan of the virtual table
 * itself reads every row).
 */
function ftsDrift(ctx: Ctx): IntegrityReport['fts'] {
  const nameOrphans = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM name_fts_docsize WHERE id NOT IN (SELECT id FROM file)')?.n);
  const nameMissing = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM file WHERE id NOT IN (SELECT id FROM name_fts_docsize)')?.n);
  const textOrphans = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM text_fts_docsize WHERE (id / 4096) NOT IN (SELECT id FROM content)')?.n);
  return { nameOrphans, nameMissing, textOrphans };
}

/** Contents that hold page text although no root they belong to has full text on. */
function textWithoutConsent(ctx: Ctx): number[] {
  const contents = all<{ c: number }>(ctx, 'SELECT DISTINCT id / 4096 AS c FROM text_fts_docsize WHERE id / 4096 IN (SELECT id FROM content)').map(r => int(r.c));
  return contents.filter(c => !fullTextAllowed(ctx, c));
}

/**
 * `quick` runs SQLite's quick check and compares the search indexes with their tables. `full` adds the complete integrity check, the foreign
 * key check and the FTS5 self check, and also reports page text kept without a root that allows it.
 */
export function checkIntegrity(ctx: Ctx, level: 'quick' | 'full' = 'quick'): IntegrityReport {
  const problems: string[] = [];
  const add = (message: string): void => { if (problems.length < MAX_PROBLEMS) problems.push(message.slice(0, 300)); };
  try {
    const rows = ctx.db.prepare(level === 'full' ? 'PRAGMA integrity_check' : 'PRAGMA quick_check').all() as Record<string, unknown>[];
    for (const row of rows) { const message = text(Object.values(row)[0]); if (message !== 'ok') add(message); }
  } catch (error) { add(`check failed: ${(error as Error).message}`); }
  let fts: IntegrityReport['fts'] = { nameOrphans: 0, nameMissing: 0, textOrphans: 0 };
  if (problems.length === 0) {
    try {
      fts = ftsDrift(ctx);
      if (fts.nameOrphans) add(`${fts.nameOrphans} name index rows without a file`);
      if (fts.nameMissing) add(`${fts.nameMissing} files without a name index row`);
      if (fts.textOrphans) add(`${fts.textOrphans} page text rows without a content`);
      const consent = textWithoutConsent(ctx);
      if (consent.length) { add(`${consent.length} contents keep page text without a full-text root`); fts.textOrphans += consent.length; }
      if (level === 'full') {
        for (const row of ctx.db.prepare('PRAGMA foreign_key_check').all().slice(0, MAX_PROBLEMS) as Record<string, unknown>[]) add(`foreign key violation in ${text(row.table)}`);
        for (const table of ['name_fts', 'text_fts']) {
          try { ctx.db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`); } catch (error) { add(`${table}: ${(error as Error).message}`); }
        }
      }
    } catch (error) { add(`index check failed: ${(error as Error).message}`); }
  }
  return { ok: problems.length === 0, level, problems, fts };
}

/** The label stored in the name index for a file: the folder part, relative to its root (archive members include the archive's name). */
function nameLabel(ctx: Ctx, row: { dir_id: number; name: string; container_id: number | null; entry_path: string | null }, pather: (id: number) => string): { name: string; dir: string } {
  if (row.container_id === null || row.entry_path === null) return { name: row.name, dir: pather(row.dir_id) };
  const container = get<{ dir_id: number; name: string }>(ctx, 'SELECT dir_id, name FROM file WHERE id = ?', row.container_id);
  const slash = row.entry_path.lastIndexOf('/');
  const base = container ? joinPath(pather(container.dir_id), container.name) : '';
  return { name: row.entry_path.slice(slash + 1), dir: joinPath(base, slash < 0 ? '' : row.entry_path.slice(0, slash)) };
}

export interface RepairReport { nameRemoved: number; nameAdded: number; textRemoved: number }

/**
 * Brings the two search indexes back in line with their tables: removes rows that point nowhere and adds the name rows files are missing.
 * Page text that is gone cannot be rebuilt here (the text lives only in the documents); a root that opted into full text rescans it.
 */
export function repairSearchIndexes(ctx: Ctx): RepairReport {
  const report: RepairReport = { nameRemoved: 0, nameAdded: 0, textRemoved: 0 };
  report.nameRemoved = atomic(ctx, () => run(ctx, 'DELETE FROM name_fts WHERE rowid IN (SELECT id FROM name_fts_docsize WHERE id NOT IN (SELECT id FROM file))').changes);
  const pather = dirPather(ctx);
  for (;;) {
    const missing = all<{ id: number; dir_id: number; name: string; container_id: number | null; entry_path: string | null }>(ctx,
      'SELECT id, dir_id, name, container_id, entry_path FROM file WHERE id NOT IN (SELECT id FROM name_fts_docsize) LIMIT 500');
    if (missing.length === 0) break;
    atomic(ctx, () => { for (const row of missing) { const label = nameLabel(ctx, row, pather); ftsPutName(ctx, row.id, label.name, label.dir); } }, 500);
    report.nameAdded += missing.length;
  }
  report.textRemoved = atomic(ctx, () => run(ctx, 'DELETE FROM text_fts WHERE rowid IN (SELECT id FROM text_fts_docsize WHERE (id / 4096) NOT IN (SELECT id FROM content))').changes);
  for (const c of textWithoutConsent(ctx)) {
    report.textRemoved += atomic(ctx, () => {
      const rows = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM text_fts_docsize WHERE id BETWEEN ? * 4096 + 1 AND ? * 4096 + 2000', c, c)?.n);
      purgeFullTextRows(ctx, [c]);
      return rows;
    });
  }
  return report;
}
