import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DuplicateSet, FileState, Identifier, LibraryDecision, LibraryGroup, LibraryId, LibraryRevision, LibraryStage, RegisteredRoot, RootOptions, RootSummary, StoredDecision } from '../../lib/library/model';
import { LIBRARY_SCHEMA_VERSION } from '../../lib/library/model';
import type { GroupDetail, SimilarGroup } from '../../lib/library/protocol';
import type { LibraryFile } from '../../lib/library/model';
import type { QueryRequest } from '../../lib/library/query';
import { DEFAULT_POLICY, all, atomic, get, int, type Ctx } from './context';
import { applyDecisions, readDecisionFile, resolveDecisionTargets, type ApplyReport } from './decisions';
import { getGroup, getFile, similarGroups } from './details';
import { beginAttempt, confirmHash, contentByPublicId, endAttempt, linkContent, listPending, setNameIdentifiers, setSniff, setStages, unconfirmedDuplicates } from './content';
import { collectGarbage, deleteFileRows, markMissing, moveFile, purgeMissing, removeMissingNow, removeRoot, resolveMoves, upsertFiles } from './files';
import { putDuplicateSet, putGroup, putRevisions, putSuggestions, removeDuplicateSets, removeGroup, removeSuggestionsFor } from './groups';
import { checkIntegrity, repairSearchIndexes, type RepairReport } from './integrity';
import { randomIds } from './ids';
import { currentScan, epoch, getMeta, nextScan, setMeta } from './meta';
import { ForeignDatabaseError, MigrationError, NewerSchemaError, migrate, readSchemaVersion } from './migrations';
import { DB_FILE_NAME, backupBeforeMigration, moveAsideDamaged, ownedFiles, removeIndexFiles } from './profile';
import { pendingRemovals, rootByPublicId, listRoots, setRootOptions, setRootState, syncRoots } from './roots';
import { runQuery } from './search';
import { sizeReport } from './size';
import { bumpStageVersion, stageVersion, type StageBump } from './stages';
import { commitSummary, loadBoardSummary, loadDocumentSummary, loadImageSummary, loadRefs, setDocumentMinhash } from './summary';
import { createTempTables } from './temp';
import { BatchWriter } from './writer';
import type {
  AttemptDecision, BoardSummary, ContentLink, ContentLinkResult, DocumentSummary, FileObservation, FileUpsertResult, FullTextChange, ImageSummary, IntegrityReport, LibraryDbOptions,
  MoveReport, OpenReport, PendingContent, QueryResult, Recovery, RootRemoval, RootSyncReport, SizeReport, SniffOutcome, StageUpdate, SuggestionWrite, SummaryCommit, SummaryCommitResult,
} from './types';

export { NewerSchemaError, ForeignDatabaseError, MigrationError } from './migrations';
export { InvalidCursorError } from './search';
export { MAX_ATTEMPTS } from './content';
export { MISSING_RETENTION_MS } from './files';
export { DB_FILE_NAME } from './profile';
export { BUDGET_BYTES_PER_100K_FILES } from './size';
export { parseDecisionFile, readDecisionFile, retargetDecisions, isStoredDecision, type ApplyReport, type GroupingConstraint } from './decisions';
export { sequentialIds, randomIds, type IdSource } from './ids';
export type * from './types';

/** `<userData>/library/library.db`: the service owns this directory and nothing in it is a user file. */
export const libraryDbPath = (userDataDirectory: string): string => join(userDataDirectory, 'library', DB_FILE_NAME);

const PRAGMAS = `PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -65536;
PRAGMA temp_store = MEMORY;
PRAGMA busy_timeout = 2000;
PRAGMA journal_size_limit = 16777216;
PRAGMA trusted_schema = OFF;`;

const isMemory = (path: string): boolean => path === ':memory:' || path === '';

/** SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), with their extended variants: the file cannot be trusted. */
function isCorruption(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; errcode?: unknown };
  return e.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number' && ((e.errcode & 0xff) === 11 || (e.errcode & 0xff) === 26);
}

type Probe = { kind: 'ok' } | { kind: 'newer'; found: number } | { kind: 'unreadable'; detail: string };

/** Reads the schema version of an existing file through a read-only connection, so a refused or damaged file is never written to. */
function probeFile(path: string, target: number): Probe {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const found = readSchemaVersion(db);
    return found > target ? { kind: 'newer', found } : { kind: 'ok' };
  } catch (error) {
    if (error instanceof ForeignDatabaseError) return { kind: 'unreadable', detail: error.message };
    if (isCorruption(error)) return { kind: 'unreadable', detail: (error as Error).message };
    throw error;
  } finally { try { db?.close(); } catch { /* already closed */ } }
}

export interface HealthReport { integrity: IntegrityReport; repaired?: RepairReport; recovery?: Recovery }

export interface LibraryCounts { roots: number; files: number; entries: number; contents: number; groups: number; boards: number; documents: number; problems: number }

/**
 * The Library database: `node:sqlite` in WAL mode with bounded write transactions, built to run inside one utility process that owns the
 * single connection. All methods are synchronous. A database from a newer application is refused (`NewerSchemaError`) and never written; a
 * damaged one is moved aside and replaced by an empty one (the report says so; scanning and replaying the decisions file restore the rest).
 */
export class LibraryDb {
  readonly path: string;
  /** What happened at open. After `rebuild` or `deleteIndex` it describes that operation. */
  report: OpenReport;
  private readonly options: LibraryDbOptions;
  private ctx: Ctx;
  private conn: DatabaseSync;
  private open = true;

  private constructor(options: LibraryDbOptions, conn: DatabaseSync, report: OpenReport) {
    this.options = options;
    this.path = options.path;
    this.conn = conn;
    this.report = report;
    this.ctx = this.makeContext(conn);
  }

  /**
   * Opens (creating it when needed) the database at `options.path`, or `:memory:`. Order: probe the file read-only (refuse a newer schema,
   * set a damaged file aside), apply pragmas, migrate (copying the old database to `library.db.v<N>.bak` first), clear `clean_shutdown`
   * and, after an unclean shutdown, run the quick check (a failure sets the file aside and starts an empty one).
   */
  static open(options: LibraryDbOptions): LibraryDb {
    const path = options.path, now = options.now ?? Date.now, target = options.schemaTarget ?? LIBRARY_SCHEMA_VERSION;
    const memory = isMemory(path);
    const report: OpenReport = { created: false, uncleanShutdown: false, checked: false, pendingRemovals: [] };
    if (!memory) mkdirSync(dirname(path), { recursive: true });
    let recovery: Recovery | undefined;
    if (!memory && existsSync(path) && statSync(path).size > 0) {
      const probe = probeFile(path, target);
      if (probe.kind === 'newer') throw new NewerSchemaError(probe.found, target);
      if (probe.kind === 'unreadable') recovery = { reason: 'unreadable', damagedFile: basenameOf(moveAsideDamaged(path, now())), detail: probe.detail };
    }
    let conn = LibraryDb.connect(path);
    const step = (c: DatabaseSync): void => {
      const migration = migrate(c, {
        ...(options.migrations ? { migrations: options.migrations } : {}), target, now,
        backup: from => {
          if (memory) return;
          c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          const copy = backupBeforeMigration(path, from, options.backupDirectory);
          options.onBackup?.(copy);
        },
      });
      if (migration.steps > 0 && migration.from > 0) report.migratedFrom = migration.from;
      if (migration.created) report.created = true;
    };
    try { step(conn); } catch (error) {
      try { conn.close(); } catch { /* closing a broken handle */ }
      if (error instanceof NewerSchemaError) throw error;
      const broken = error instanceof MigrationError ? 'migration-failed' : error instanceof ForeignDatabaseError || isCorruption(error) ? 'unreadable' : undefined;
      if (!broken || memory) throw error;
      recovery = { reason: broken, damagedFile: basenameOf(moveAsideDamaged(path, now())), detail: (error as Error).message.slice(0, 300) };
      conn = LibraryDb.connect(path);
      step(conn);
      delete report.migratedFrom;
    }
    if (recovery) report.created = true;
    const db = new LibraryDb(options, conn, report);
    if (recovery) db.report.recovery = recovery;
    db.startSession();
    if (options.decisionsPath) { const r = db.replayDecisions(options.decisionsPath); db.report.decisions = { applied: r.applied, unresolved: r.unresolved, dropped: r.dropped }; }
    db.report.pendingRemovals = pendingRemovals(db.ctx);
    return db;
  }

  private static connect(path: string): DatabaseSync {
    const conn = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    try {
      conn.exec(PRAGMAS);
      conn.function('library_fold', { deterministic: true }, value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : '');
    } catch (error) { conn.close(); throw error; }
    return conn;
  }

  private makeContext(conn: DatabaseSync): Ctx {
    return {
      db: conn, ids: this.options.ids ?? randomIds(), now: this.options.now ?? Date.now, policy: DEFAULT_POLICY, statements: new Map(),
      writer: new BatchWriter(conn, this.options.maxUnitsPerTransaction, this.options.hooks),
    };
  }

  /** Clears `clean_shutdown`, runs the quick check after an unclean close, and creates the connection-local scratch tables. */
  private startSession(): void {
    const ctx = this.ctx;
    createTempTables(ctx);
    const previous = getMeta(ctx, 'clean_shutdown');
    const fresh = this.report.created;
    this.report.uncleanShutdown = !fresh && previous !== '1';
    if (this.report.uncleanShutdown || (this.options.verify === true && !fresh)) {
      this.report.checked = true;
      const health = this.ensureHealthy('quick');
      if (health.recovery) { this.report.recovery = health.recovery; this.report.created = true; }
    }
    atomic(this.ctx, () => setMeta(this.ctx, 'clean_shutdown', '0'));
  }

  private assertOpen(): void { if (!this.open) throw new Error('The Library database is closed'); }

  get isOpen(): boolean { return this.open; }
  /** Scratch access for tests that inspect the database directly. Not part of the service interface. */
  get connection(): DatabaseSync { this.assertOpen(); return this.conn; }

  /** Commits the open batch, writes `clean_shutdown`, truncates the log and closes. Safe to call twice. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    try {
      this.ctx.writer.commit();
      this.ctx.writer.atomic(1, () => setMeta(this.ctx, 'clean_shutdown', '1'));
      if (!isMemory(this.path)) this.conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch { this.ctx.writer.rollback(); }
    this.ctx.statements.clear();
    try { this.conn.close(); } catch { /* already closed */ }
  }

  /** Closes without writing `clean_shutdown` (the next open runs the quick check). Used by tests and by an orderly-but-abrupt exit. */
  abandon(): void {
    if (!this.open) return;
    this.open = false;
    this.ctx.writer.rollback();
    this.ctx.statements.clear();
    try { this.conn.close(); } catch { /* already closed */ }
  }

  /** Commits what is pending and moves the log into the database file (the bounded work of an orderly shutdown). */
  checkpoint(): void {
    this.assertOpen();
    this.ctx.writer.commit();
    if (!isMemory(this.path)) this.conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Checkpoints and rebuilds the file without free pages. Needs room for a second copy of the database. */
  compact(): void {
    this.checkpoint();
    this.conn.exec('VACUUM');
    if (!isMemory(this.path)) this.conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  // ---- integrity, recovery, deletion, size ---------------------------------------------------------------------------------------

  checkIntegrity(level: 'quick' | 'full' = 'quick'): IntegrityReport { this.assertOpen(); this.ctx.writer.commit(); return checkIntegrity(this.ctx, level); }

  repairSearchIndexes(): RepairReport { this.assertOpen(); return repairSearchIndexes(this.ctx); }

  /**
   * Checks the database and brings it back: drift between a search index and its table is repaired in place; anything SQLite itself
   * reports (or an unreadable file) sets the database aside and starts an empty one. The decisions file is not touched.
   */
  ensureHealthy(level: 'quick' | 'full' = 'quick'): HealthReport {
    this.assertOpen();
    let integrity: IntegrityReport;
    try { integrity = checkIntegrity(this.ctx, level); } catch (error) { integrity = { ok: false, level, problems: [(error as Error).message.slice(0, 300)], fts: { nameOrphans: 0, nameMissing: 0, textOrphans: 0 } }; }
    if (integrity.ok) return { integrity };
    const driftOnly = integrity.problems.every(p => /name index|page text|without a full-text root/.test(p));
    if (driftOnly) {
      const repaired = repairSearchIndexes(this.ctx);
      const again = checkIntegrity(this.ctx, level);
      if (again.ok) return { integrity: again, repaired };
      return { integrity: again, repaired, recovery: this.rebuild('integrity', again.problems[0]) };
    }
    return { integrity, recovery: this.rebuild('integrity', integrity.problems[0]) };
  }

  /**
   * Replaces the database by an empty one. The old file stays next to it as `library.db.damaged-<time>` (one such copy at most). Roots
   * must be registered again (`syncRoots`), the folders scanned, and `replayDecisions` called: the corrections are in their own file.
   */
  rebuild(reason: Recovery['reason'] = 'integrity', detail?: string): Recovery {
    this.assertOpen();
    let previousEpoch = 0;
    try { previousEpoch = epoch(this.ctx); } catch { /* a damaged file may not answer */ }
    this.ctx.writer.rollback();
    this.ctx.statements.clear();
    try { this.conn.close(); } catch { /* a damaged handle */ }
    const damaged = isMemory(this.path) ? undefined : moveAsideDamaged(this.path, (this.options.now ?? Date.now)());
    this.conn = LibraryDb.connect(this.path);
    migrate(this.conn, { ...(this.options.migrations ? { migrations: this.options.migrations } : {}), target: this.options.schemaTarget ?? LIBRARY_SCHEMA_VERSION, now: this.options.now ?? Date.now });
    this.ctx = this.makeContext(this.conn);
    createTempTables(this.ctx);
    // Cursors issued for the replaced database must not validate against the new one.
    atomic(this.ctx, () => { setMeta(this.ctx, 'epoch', String(previousEpoch + 1)); setMeta(this.ctx, 'clean_shutdown', '0'); });
    const recovery: Recovery = { reason, ...(damaged ? { damagedFile: basename(damaged) } : {}), ...(detail ? { detail } : {}) };
    this.report = { ...this.report, created: true, recovery };
    return recovery;
  }

  /** Reads the decisions file (never writes it) and applies it to the current index. Safe to call again after every scan. */
  replayDecisions(path: string | undefined = this.options.decisionsPath): ApplyReport & { dropped: number; found: boolean } {
    this.assertOpen();
    if (!path) return { applied: 0, unresolved: 0, grouping: [], dropped: 0, found: false };
    const file = readDecisionFile(path);
    return { ...applyDecisions(this.ctx, file.decisions), dropped: file.dropped, found: file.found };
  }

  /** Applies decisions held in memory (the caller read them from `library-decisions.json`). */
  applyDecisions(decisions: readonly StoredDecision[]): ApplyReport { this.assertOpen(); return applyDecisions(this.ctx, decisions); }

  /** The durable targets of a decision that names current group or content ids, or undefined when an id is unknown. */
  resolveDecisionTargets(decision: LibraryDecision): ReturnType<typeof resolveDecisionTargets> { this.assertOpen(); return resolveDecisionTargets(this.ctx, decision); }

  /**
   * Deletes the index: closes the connection and removes the database, its log, the migration backup and the damaged copy from the
   * service's own directory. The root list and the corrections live in the profile's JSON files, which this never touches.
   */
  deleteIndex(): string[] {
    this.assertOpen();
    this.open = false;
    this.ctx.writer.rollback();
    this.ctx.statements.clear();
    try { this.conn.close(); } catch { /* already closed */ }
    return isMemory(this.path) ? [] : removeIndexFiles(this.path);
  }

  size(): SizeReport { this.assertOpen(); this.ctx.writer.commit(); return sizeReport(this.ctx, this.path); }

  counts(): LibraryCounts {
    this.assertOpen();
    const n = (sql: string): number => int(get<{ n: number }>(this.ctx, sql)?.n);
    return {
      roots: n("SELECT count(*) AS n FROM root WHERE state <> 'removing'"), files: n('SELECT count(*) AS n FROM file WHERE container_id IS NULL'), entries: n('SELECT count(*) AS n FROM file WHERE container_id IS NOT NULL'),
      contents: n('SELECT count(*) AS n FROM content'), groups: n('SELECT count(*) AS n FROM grp'), boards: n('SELECT count(*) AS n FROM board'), documents: n('SELECT count(*) AS n FROM document'),
      problems: n("SELECT count(*) AS n FROM file WHERE state IN ('unknown', 'unsupported', 'encrypted', 'damaged', 'skipped', 'link', 'no-access', 'locked', 'missing')"),
    };
  }

  // ---- meta ----------------------------------------------------------------------------------------------------------------------

  get schemaVersion(): number { this.assertOpen(); return Number(getMeta(this.ctx, 'schema_version') ?? 0); }
  /** Changes whenever row ids may be reused or change meaning; cursors and caches are bound to it. */
  get epoch(): number { this.assertOpen(); return epoch(this.ctx); }
  getMeta(key: string): string | undefined { this.assertOpen(); return getMeta(this.ctx, key); }
  setMeta(key: string, value: string): void { this.assertOpen(); atomic(this.ctx, () => setMeta(this.ctx, key, value)); }
  stageVersion(stage: LibraryStage): number { this.assertOpen(); return stageVersion(this.ctx, stage); }
  bumpStageVersion(stage: LibraryStage, version: number): StageBump | undefined { this.assertOpen(); return bumpStageVersion(this.ctx, stage, version); }
  /** Starts a scan: the number is stored on every row the scan sees, and only grows. */
  beginScan(): number { this.assertOpen(); return atomic(this.ctx, () => nextScan(this.ctx)); }
  get scanCounter(): number { this.assertOpen(); return currentScan(this.ctx); }
  /** Runs `fn` as one transaction (a nested call joins it). For callers that group several operations. */
  transaction<T>(fn: () => T): T { this.assertOpen(); return atomic(this.ctx, fn); }

  // ---- roots ---------------------------------------------------------------------------------------------------------------------

  syncRoots(roots: readonly RegisteredRoot[]): RootSyncReport { this.assertOpen(); return syncRoots(this.ctx, roots); }
  listRoots(): RootSummary[] { this.assertOpen(); return listRoots(this.ctx); }
  setRootState(rootId: LibraryId, state: 'online' | 'offline' | 'no-access'): boolean { this.assertOpen(); return setRootState(this.ctx, rootId, state); }
  setRootOptions(rootId: LibraryId, options: RootOptions): FullTextChange | undefined { this.assertOpen(); return setRootOptions(this.ctx, rootId, options); }
  removeRoot(rootId: LibraryId): RootRemoval | undefined { this.assertOpen(); return removeRoot(this.ctx, rootId); }
  /** Completes the removals a crash interrupted. Returns the roots finished. */
  finishPendingRemovals(): string[] {
    this.assertOpen();
    const done: string[] = [];
    for (const id of pendingRemovals(this.ctx)) { if (removeRoot(this.ctx, id)) done.push(id); }
    this.report.pendingRemovals = pendingRemovals(this.ctx);
    return done;
  }
  rootExists(rootId: LibraryId): boolean { this.assertOpen(); return rootByPublicId(this.ctx, rootId) !== undefined; }

  // ---- files and identity --------------------------------------------------------------------------------------------------------

  upsertFiles(rootId: LibraryId, scan: number, entries: readonly FileObservation[]): FileUpsertResult[] { this.assertOpen(); return upsertFiles(this.ctx, rootId, scan, entries); }
  markMissing(rootId: LibraryId, scan: number, nowMs: number = this.ctx.now()): number { this.assertOpen(); return markMissing(this.ctx, rootId, scan, nowMs); }
  purgeMissing(nowMs: number = this.ctx.now(), retentionMs?: number): number { this.assertOpen(); return purgeMissing(this.ctx, nowMs, retentionMs); }
  removeMissingNow(rootId?: LibraryId): number { this.assertOpen(); return removeMissingNow(this.ctx, rootId); }
  resolveMoves(rootId: LibraryId, scan: number): MoveReport[] { this.assertOpen(); return resolveMoves(this.ctx, rootId, scan); }
  moveFile(fileId: LibraryId, to: { dir: string; name: string }): boolean { this.assertOpen(); return moveFile(this.ctx, fileId, to); }
  deleteFiles(fileIds: readonly number[]): number { this.assertOpen(); return atomic(this.ctx, () => deleteFileRows(this.ctx, fileIds)); }
  collectGarbage(): ReturnType<typeof collectGarbage> { this.assertOpen(); return collectGarbage(this.ctx); }
  linkContent(links: readonly ContentLink[]): ContentLinkResult[] { this.assertOpen(); return linkContent(this.ctx, links); }
  confirmHash(contentId: LibraryId, sha256: string): ReturnType<typeof confirmHash> { this.assertOpen(); return confirmHash(this.ctx, contentId, sha256); }
  unconfirmedDuplicates(limit?: number): ReturnType<typeof unconfirmedDuplicates> { this.assertOpen(); return unconfirmedDuplicates(this.ctx, limit); }
  setSniff(contentId: LibraryId, outcome: SniffOutcome, version?: number): boolean { this.assertOpen(); return setSniff(this.ctx, contentId, outcome, version); }
  setStages(contentId: LibraryId, updates: readonly StageUpdate[]): boolean { this.assertOpen(); return setStages(this.ctx, contentId, updates); }
  setNameIdentifiers(fileId: LibraryId, identifiers: readonly Identifier[]): boolean { this.assertOpen(); return setNameIdentifiers(this.ctx, fileId, identifiers); }
  listPending(stage: LibraryStage, version: number, limit?: number, afterContentRowId?: number): PendingContent[] { this.assertOpen(); return listPending(this.ctx, stage, version, limit, afterContentRowId); }
  /** Poison-file guard: call before a job leaves for a reader. */
  beginAttempt(contentId: LibraryId): AttemptDecision { this.assertOpen(); return beginAttempt(this.ctx, contentId); }
  endAttempt(contentId: LibraryId): void { this.assertOpen(); endAttempt(this.ctx, contentId); }

  // ---- summaries -----------------------------------------------------------------------------------------------------------------

  commitSummary(commit: SummaryCommit): SummaryCommitResult { this.assertOpen(); return commitSummary(this.ctx, commit); }
  boardSummary(contentId: LibraryId): BoardSummary | undefined { this.assertOpen(); const c = contentByPublicId(this.ctx, contentId); return c ? loadBoardSummary(this.ctx, c.id) : undefined; }
  documentSummary(contentId: LibraryId): DocumentSummary | undefined { this.assertOpen(); const c = contentByPublicId(this.ctx, contentId); return c ? loadDocumentSummary(this.ctx, c.id) : undefined; }
  imageSummary(contentId: LibraryId): ImageSummary | undefined { this.assertOpen(); const c = contentByPublicId(this.ctx, contentId); return c ? loadImageSummary(this.ctx, c.id) : undefined; }
  refsOf(contentId: LibraryId): string[] { this.assertOpen(); const c = contentByPublicId(this.ctx, contentId); return c ? loadRefs(this.ctx, c.id) : []; }
  setDocumentMinhash(contentId: LibraryId, minhash: readonly number[]): boolean { this.assertOpen(); return setDocumentMinhash(this.ctx, contentId, minhash); }

  // ---- groups and relations ------------------------------------------------------------------------------------------------------

  putGroup(group: LibraryGroup): number { this.assertOpen(); return putGroup(this.ctx, group); }
  removeGroup(groupId: LibraryId): boolean { this.assertOpen(); return removeGroup(this.ctx, groupId); }
  putRevisions(groupId: LibraryId, revisions: readonly LibraryRevision[]): number { this.assertOpen(); return putRevisions(this.ctx, groupId, revisions); }
  putDuplicateSet(set: DuplicateSet): void { this.assertOpen(); putDuplicateSet(this.ctx, set); }
  removeDuplicateSets(ids: readonly string[]): number { this.assertOpen(); return removeDuplicateSets(this.ctx, ids); }
  putSuggestions(suggestions: readonly SuggestionWrite[]): number { this.assertOpen(); return putSuggestions(this.ctx, suggestions); }
  removeSuggestionsFor(contentId: LibraryId): number { this.assertOpen(); return removeSuggestionsFor(this.ctx, contentId); }

  // ---- queries -------------------------------------------------------------------------------------------------------------------

  query(request: QueryRequest): QueryResult { this.assertOpen(); return runQuery(this.ctx, request); }
  getFile(fileId: LibraryId): LibraryFile | undefined { this.assertOpen(); return getFile(this.ctx, fileId); }
  getGroup(groupId: LibraryId): GroupDetail | undefined { this.assertOpen(); return getGroup(this.ctx, groupId); }
  similar(groupId: LibraryId, basis: 'layout' | 'parts'): SimilarGroup[] { this.assertOpen(); return similarGroups(this.ctx, groupId, basis); }
  /** File states shown on the problems view, for diagnostics counts. */
  countByState(): { state: FileState; count: number }[] {
    this.assertOpen();
    return all<{ state: string; n: number }>(this.ctx, 'SELECT state, count(*) AS n FROM file GROUP BY state ORDER BY state').map(r => ({ state: r.state as FileState, count: int(r.n) }));
  }
  /** Files on disk owned by this database (for tests and the settings page): database, log, shared memory, backup, damaged copy. */
  ownedFileNames(): string[] {
    if (isMemory(this.path)) return [];
    const f = ownedFiles(this.path);
    return [f.main, f.wal, f.shm, f.journal, ...f.backups, ...f.damaged].filter(p => existsSync(p)).map(p => basename(p));
  }
}

function basenameOf(path: string | undefined): string | undefined { return path === undefined ? undefined : basename(path); }
