import { all, get, int, text, type Ctx } from './context';
import { fileBytes } from './profile';
import type { SizeReport, TableSize } from './types';

/** The hard size budget: at most 1 GB (decimal, the stricter reading of "GB") per 100,000 files, without full text. */
export const BUDGET_BYTES_PER_100K_FILES = 1_000_000_000;
export const BUDGET_FILE_COUNT = 100_000;

/** Tables whose rows are the opt-in page text: counted apart from the metadata budget. */
const FULL_TEXT_TABLES = new Set(['text_fts']);

interface Master { type: string; name: string; tbl_name: string }

/** Maps a b-tree name (table, index, FTS shadow table) of the main schema to the logical table it belongs to. */
function logicalOwner(entry: Master, virtualTables: string[]): string {
  if (entry.type === 'index') return entry.tbl_name;
  const virtual = virtualTables.find(v => entry.name.startsWith(`${v}_`));
  return virtual ?? entry.name;
}

/**
 * Bytes of the database file, its write-ahead log and shared-memory file, and where they go. The file counts are `files` (loose files,
 * the number the budget is stated in) and `entries` (archive members, whose cost is part of their archive's share). Per-table figures
 * need the `dbstat` virtual table. Page text (`text_fts` and its shadow tables) is reported separately and left out of `bytesPerFile`.
 */
export function sizeReport(ctx: Ctx, dbPath: string): SizeReport {
  const memory = dbPath === ':memory:' || dbPath === '';
  const databaseBytes = memory ? 0 : fileBytes(dbPath), walBytes = memory ? 0 : fileBytes(`${dbPath}-wal`), shmBytes = memory ? 0 : fileBytes(`${dbPath}-shm`);
  const pageSize = int(get<{ page_size: number }>(ctx, 'PRAGMA page_size')?.page_size);
  const pageCount = int(get<{ page_count: number }>(ctx, 'PRAGMA page_count')?.page_count);
  const freelistPages = int(get<{ freelist_count: number }>(ctx, 'PRAGMA freelist_count')?.freelist_count);
  const files = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM file WHERE container_id IS NULL')?.n);
  const entries = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM file WHERE container_id IS NOT NULL')?.n);
  const contents = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM content')?.n);

  const tables = new Map<string, TableSize>();
  let perTable = true;
  try {
    const master = all<Master>(ctx, "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_stat%' AND name <> 'sqlite_sequence'");
    const virtualTables = master.filter(m => m.type === 'table' && /CREATE VIRTUAL TABLE/i.test(text(get<{ sql: string }>(ctx, 'SELECT sql FROM sqlite_master WHERE name = ?', m.name)?.sql))).map(m => m.name);
    const owner = new Map<string, string>();
    for (const entry of master) owner.set(entry.name, logicalOwner(entry, virtualTables));
    owner.set('sqlite_schema', 'sqlite_schema');
    for (const row of all<{ name: string; bytes: number }>(ctx, 'SELECT name, sum(pgsize) AS bytes FROM dbstat WHERE aggregate = TRUE GROUP BY name')) {
      const table = owner.get(row.name) ?? row.name;
      const entry = tables.get(table) ?? { name: table, rows: 0, bytes: 0 };
      entry.bytes += int(row.bytes);
      tables.set(table, entry);
    }
    for (const entry of tables.values()) {
      if (entry.name === 'sqlite_schema') continue;
      const virtual = virtualTables.includes(entry.name);
      try { entry.rows = int(get<{ n: number }>(ctx, virtual ? `SELECT count(*) AS n FROM ${entry.name}_docsize` : `SELECT count(*) AS n FROM ${entry.name}`)?.n); } catch { entry.rows = 0; }
    }
  } catch { perTable = false; tables.clear(); }

  const fullTextBytes = int(get<{ n: number }>(ctx, 'SELECT count(*) AS n FROM text_fts_docsize')?.n) === 0 ? 0 :
    [...tables.values()].filter(t => FULL_TEXT_TABLES.has(t.name)).reduce((sum, t) => sum + t.bytes, 0);
  const totalBytes = databaseBytes + walBytes + shmBytes;
  const metadataBytes = Math.max(0, totalBytes - fullTextBytes);
  const bytesPerFile = files > 0 ? metadataBytes / files : 0;
  const projectedPer100kFiles = Math.round(bytesPerFile * BUDGET_FILE_COUNT);
  return {
    databaseBytes, walBytes, shmBytes, totalBytes, pageSize, pageCount, freelistPages, freeBytes: freelistPages * pageSize,
    files, entries, contents, bytesPerFile, projectedPer100kFiles, budgetPer100kFiles: BUDGET_BYTES_PER_100K_FILES, withinBudget: projectedPer100kFiles <= BUDGET_BYTES_PER_100K_FILES,
    tables: [...tables.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)), fullTextBytes, perTable,
  };
}
