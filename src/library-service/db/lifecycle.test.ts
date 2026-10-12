import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DecisionTarget, StoredDecision } from '../../lib/library/model';
import { LibraryDb, NewerSchemaError, libraryDbPath, sequentialIds } from './index';
import { MIGRATIONS, type Migration } from './migrations';
import { buildFixture, SHA_REV1 } from './fixture';
import { groupOf, ingest, makeBoardSummary, makeDocumentSummary, syntheticRoot } from './synthetic';

const dirs: string[] = [];
const live: LibraryDb[] = [];
afterEach(() => { for (const db of live.splice(0)) if (db.isOpen) db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const profile = (): { userData: string; path: string; decisions: string } => {
  const userData = mkdtempSync(join(tmpdir(), 'trace-lib-life-')); dirs.push(userData);
  return { userData, path: libraryDbPath(userData), decisions: join(userData, 'library-decisions.json') };
};
const track = (db: LibraryDb): LibraryDb => { live.push(db); return db; };
const open = (path: string, extra: Partial<Parameters<typeof LibraryDb.open>[0]> = {}): LibraryDb => track(LibraryDb.open({ path, ids: sequentialIds(), ...extra }));
const n = (db: LibraryDb, sql: string): number => Number((db.connection.prepare(sql).get() as { n: number }).n);

function populate(db: LibraryDb): void {
  db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
  const scan = db.beginScan();
  for (let i = 0; i < 60; i++) ingest(db, 'r1', scan, { dir: `d${i % 6}`, name: `board${i}.brd`, seed: 1000 + i, kind: 'board', summary: makeBoardSummary({ seed: 1000 + i, refs: 400, parts: 40, components: 20 }) });
}

/** Overwrites whole pages in the middle of the file: the header and schema stay readable, the data does not. */
function damage(path: string): void {
  const bytes = readFileSync(path);
  for (let i = 4096 * 6; i < Math.min(bytes.length, 4096 * 14); i++) bytes[i] = 0xab ^ (i & 0xff);
  writeFileSync(path, bytes);
}

describe('open and close', () => {
  it('creates the profile directory and a WAL database with the documented settings', () => {
    const { path } = profile();
    const db = open(path);
    expect(existsSync(path)).toBe(true);
    expect(db.report).toMatchObject({ created: true, uncleanShutdown: false, checked: false, pendingRemovals: [] });
    expect(db.schemaVersion).toBe(1);
    const pragma = (name: string): unknown => Object.values(db.connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('synchronous')).toBe(1);
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('cache_size')).toBe(-65536);
    expect(pragma('journal_size_limit')).toBe(16777216);
    expect(db.getMeta('clean_shutdown')).toBe('0');
  });

  it('writes clean_shutdown at close, truncates the log and opens again without a check', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.close();
    db.close();
    expect(statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
    const again = open(path);
    expect(again.report).toMatchObject({ created: false, uncleanShutdown: false, checked: false });
    expect(again.counts()).toMatchObject({ roots: 1, files: 60, contents: 60 });
    expect(again.getMeta('clean_shutdown')).toBe('0');
    expect(() => db.counts()).toThrow('closed');
  });

  it('runs the quick check after an unclean close and keeps a healthy database', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.abandon();
    const again = open(path);
    expect(again.report).toMatchObject({ uncleanShutdown: true, checked: true, created: false });
    expect(again.report.recovery).toBeUndefined();
    expect(again.counts().files).toBe(60);
  });

  it('works on an in-memory database', () => {
    const db = track(LibraryDb.open({ path: ':memory:' }));
    expect(db.report.created).toBe(true);
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    expect(db.counts().roots).toBe(1);
    expect(db.size().databaseBytes).toBe(0);
    expect(db.ownedFileNames()).toEqual([]);
    db.close();
  });
});

describe('newer schema', () => {
  it('is refused without touching the file, even its log, and without a backup or a rebuild', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    raw.close();
    const before = readFileSync(path);
    let caught: unknown;
    try { LibraryDb.open({ path }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NewerSchemaError);
    expect(caught).toMatchObject({ code: 'newer-schema', found: 9, supported: 1 });
    expect(readFileSync(path).equals(before)).toBe(true);
    // Probing a WAL database read-only may leave its empty log and shared-memory file; nothing else appears, and the log holds no frames.
    expect(readdirSync(join(path, '..')).filter(f => !/^library.db(-wal|-shm)?$/.test(f))).toEqual([]);
    expect(statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
  });
});

describe('migration on disk', () => {
  const v2: Migration = { from: 1, to: 2, up(db) { db.exec('ALTER TABLE root ADD COLUMN note TEXT'); } };
  const v3: Migration = { from: 2, to: 3, up(db) { db.exec('ALTER TABLE root ADD COLUMN extra TEXT'); } };

  it('copies the old database to library.db.v<N>.bak first and keeps only one backup', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.close();
    const backups: string[] = [];
    const second = open(path, { migrations: [...MIGRATIONS, v2], schemaTarget: 2, onBackup: file => backups.push(file) });
    expect(second.report.migratedFrom).toBe(1);
    expect(second.schemaVersion).toBe(2);
    expect(second.counts().files).toBe(60);
    second.close();
    const dir = join(path, '..');
    expect(readdirSync(dir).filter(f => f.endsWith('.bak'))).toEqual(['library.db.v1.bak']);
    const old = new DatabaseSync(join(dir, 'library.db.v1.bak'), { readOnly: true });
    expect(Number((old.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value)).toBe(1);
    expect(Number((old.prepare('SELECT count(*) AS n FROM file').get() as { n: number }).n)).toBe(60);
    old.close();
    const third = open(path, { migrations: [...MIGRATIONS, v2, v3], schemaTarget: 3 });
    third.close();
    expect(readdirSync(dir).filter(f => f.endsWith('.bak'))).toEqual(['library.db.v2.bak']);
    expect(backups).toHaveLength(1);
  });

  it('starts a new database when a migration cannot run, and keeps the old one as the damaged copy', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.close();
    const breaksWithData: Migration = { from: 1, to: 2, up(raw) { if (Number((raw.prepare('SELECT count(*) AS n FROM file').get() as { n: number }).n) > 0) throw new Error('cannot convert'); } };
    const next = open(path, { migrations: [...MIGRATIONS, breaksWithData], schemaTarget: 2 });
    expect(next.report.recovery).toMatchObject({ reason: 'migration-failed' });
    expect(next.report.recovery!.damagedFile).toMatch(/^library\.db\.damaged-\d+$/);
    expect(next.counts().files).toBe(0);
    expect(next.schemaVersion).toBe(2);
    expect(existsSync(join(path, '..', next.report.recovery!.damagedFile!))).toBe(true);
  });
});

describe('integrity and rebuild', () => {
  it('moves a damaged database aside and starts an empty one', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.close();
    damage(path);
    const again = open(path, { verify: true });
    expect(again.report.checked).toBe(true);
    expect(again.report.recovery).toMatchObject({ reason: 'integrity' });
    expect(again.report.created).toBe(true);
    expect(again.counts()).toMatchObject({ roots: 0, files: 0 });
    expect(again.checkIntegrity('full').ok).toBe(true);
    const names = readdirSync(join(path, '..')).filter(f => f.includes('damaged'));
    expect(names).toEqual([again.report.recovery!.damagedFile]);
    // The next damage replaces the kept copy: at most one damaged database stays.
    populate(again);
    again.close();
    damage(path);
    const third = open(path, { verify: true, now: () => 1_900_000_000_000 });
    expect(third.report.recovery!.damagedFile).toBe('library.db.damaged-1900000000000');
    expect(readdirSync(join(path, '..')).filter(f => f.includes('damaged'))).toEqual(['library.db.damaged-1900000000000']);
  });

  it('recovers from an unreadable file, a file that is not a database and a zeroed header', () => {
    for (const make of [(p: string) => writeFileSync(p, Buffer.from('this is not a database '.repeat(400))), (p: string) => { const b = readFileSync(p); b.fill(0, 0, 100); writeFileSync(p, b); }]) {
      const { path } = profile();
      const db = open(path);
      populate(db);
      db.close();
      make(path);
      const again = open(path);
      expect(again.report.recovery).toMatchObject({ reason: 'unreadable' });
      expect(again.counts().files).toBe(0);
      expect(again.report.recovery!.damagedFile).toBeDefined();
    }
  });

  it('treats a SQLite file that is not the Library database as damaged and does not overwrite it', () => {
    const { path } = profile();
    mkdirSync(join(path, '..'), { recursive: true });
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE other(x INTEGER); INSERT INTO other VALUES(41)");
    foreign.close();
    const db = open(path);
    expect(db.report.recovery).toMatchObject({ reason: 'unreadable' });
    const kept = new DatabaseSync(join(path, '..', db.report.recovery!.damagedFile!), { readOnly: true });
    expect(Number((kept.prepare('SELECT x FROM other').get() as { x: number }).x)).toBe(41);
    kept.close();
  });

  it('checks an unclean database and rebuilds when SQLite reports damage', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.abandon();
    damage(path);
    const again = open(path);
    expect(again.report).toMatchObject({ uncleanShutdown: true, checked: true });
    expect(again.report.recovery).toMatchObject({ reason: 'integrity' });
    expect(again.counts().files).toBe(0);
  });

  it('rebuilds a running database on request and makes older cursors invalid', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    const first = db.query({ text: '', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 5 });
    const epoch = db.epoch;
    const recovery = db.rebuild('integrity', 'test');
    expect(recovery).toMatchObject({ reason: 'integrity', detail: 'test' });
    expect(db.counts().files).toBe(0);
    expect(db.epoch).toBe(epoch + 1);
    populate(db);
    expect(() => db.query({ text: '', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 5, cursor: first.cursor })).toThrow();
    expect(db.query({ text: '', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 5 }).total).toBe(60);
  });

  it('repairs a search index that drifted from its table without a rebuild', () => {
    const fx = buildFixture();
    live.push(fx.db);
    const { db } = fx;
    const raw = db.connection;
    raw.exec('DELETE FROM name_fts WHERE rowid IN (SELECT id FROM file ORDER BY id LIMIT 3)');
    raw.exec("INSERT INTO name_fts(rowid, name, path) VALUES(9999, 'ghost', 'ghost')");
    raw.exec('INSERT INTO text_fts(rowid, body) VALUES(77 * 4096 + 1, \'orphan page\')');
    const bad = db.checkIntegrity('quick');
    expect(bad.ok).toBe(false);
    expect(bad.fts).toEqual({ nameOrphans: 1, nameMissing: 3, textOrphans: 1 });
    const health = db.ensureHealthy('quick');
    expect(health.repaired).toEqual({ nameRemoved: 1, nameAdded: 3, textRemoved: 1 });
    expect(health.recovery).toBeUndefined();
    expect(health.integrity.ok).toBe(true);
    expect(db.checkIntegrity('full').ok).toBe(true);
    // The repaired index answers again, for loose files and for the archive member.
    for (const text of ['lx100_rev1', 'pack.zip', 'spare']) expect(db.query({ text, mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 20 }).rows.length, text).toBeGreaterThan(0);
  });

  it('reports page text kept without a root that allows it, and removes it on repair', () => {
    const fx = buildFixture();
    live.push(fx.db);
    const { db } = fx;
    db.setRootOptions('rootB', { fullText: false, watch: false, exclusions: [], rescanMinutes: 0 });
    const contentRow = Number((db.connection.prepare('SELECT id FROM content WHERE public_id = ?').get(fx.f.datasheet.contentId) as { id: number }).id);
    db.connection.exec(`INSERT INTO text_fts(rowid, body) VALUES(${contentRow} * 4096 + 5, 'leftover words')`);
    expect(db.checkIntegrity('quick').ok).toBe(false);
    const full = db.checkIntegrity('full');
    expect(full.ok).toBe(false);
    expect(full.problems.join(' ')).toContain('full-text root');
    expect(db.repairSearchIndexes().textRemoved).toBe(1);
    expect(db.checkIntegrity('full').ok).toBe(true);
  });
});

describe('user decisions survive a rebuild', () => {
  const photo: DecisionTarget = { kind: 'file', rootId: 'rootB', relativePath: 'photos/lx100_top.jpg' };
  const notes: DecisionTarget = { kind: 'file', rootId: 'rootA', relativePath: 'misc/loose_notes.pdf' };
  const rev1: DecisionTarget = { kind: 'content', sha256: SHA_REV1 };

  function writeDecisions(path: string): string {
    const list: StoredDecision[] = [
      { id: 'x1', at: 1, decision: { kind: 'hide', target: notes, hidden: true }, targets: [notes] },
      { id: 'x2', at: 2, decision: { kind: 'role', target: photo, role: 'thermal' }, targets: [photo] },
      { id: 'x3', at: 3, decision: { kind: 'label', groupId: 'g1', label: 'Bench laptop' }, targets: [rev1] },
      { id: 'x4', at: 4, decision: { kind: 'tag', groupId: 'g1', tag: 'priority', enabled: true }, targets: [rev1] },
      { id: 'x5', at: 5, decision: { kind: 'same', a: rev1, b: photo }, targets: [rev1, photo] },
    ];
    const text = JSON.stringify({ version: 1, decisions: list }, null, 2);
    writeFileSync(path, text);
    return text;
  }

  it('restores hides, roles, labels, tags and pair constraints from the separate file after the database was replaced', () => {
    const { path, decisions } = profile();
    // First life: a fixture library on disk, with the decisions file next to it.
    const first = open(path, { decisionsPath: decisions });
    buildInto(first);
    const raw = writeDecisions(decisions);
    expect(first.replayDecisions()).toMatchObject({ applied: 5, unresolved: 0, found: true, dropped: 0 });
    const hiddenBefore = first.query({ text: '', mode: 'unsorted', filters: {}, sort: 'label', direction: 'asc', limit: 50 }).rows.map(r => r.label);
    expect(hiddenBefore).toEqual(['pack.zip', 'spare.brd']);
    first.close();

    // The database is damaged and replaced; the decisions file is untouched.
    damage(path);
    const second = open(path, { decisionsPath: decisions, verify: true });
    expect(second.report.recovery).toMatchObject({ reason: 'integrity' });
    expect(second.report.decisions).toEqual({ applied: 0, unresolved: 5, dropped: 0 });
    expect(second.query({ text: '', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 50 }).total).toBe(0);
    expect(readFileSync(decisions, 'utf8')).toBe(raw);

    // A scan and the grouping stage recreate the index (with new internal ids); replaying the file brings the decisions back.
    const rebuilt = buildInto(second);
    expect(rebuilt.f.rev1.contentId).not.toBe('');
    const replay = second.replayDecisions();
    expect(replay).toMatchObject({ applied: 5, unresolved: 0, dropped: 0 });
    expect(second.query({ text: '', mode: 'unsorted', filters: {}, sort: 'label', direction: 'asc', limit: 50 }).rows.map(r => r.label)).toEqual(hiddenBefore);
    expect(second.getFile(rebuilt.f.photo.fileId)!.role).toBe('thermal');
    expect(second.getGroup('g1')!.group).toMatchObject({ label: 'Bench laptop', tags: ['bench', 'priority'] });
    expect(replay.grouping).toEqual([{ kind: 'same', a: rebuilt.f.rev1.contentId, b: rebuilt.f.photo.contentId }]);
    expect(readFileSync(decisions, 'utf8')).toBe(raw);
  });

  it('replays the decisions file at every open and ignores entries that fail validation', () => {
    const { path, decisions } = profile();
    const first = open(path, { decisionsPath: decisions });
    buildInto(first);
    const good = JSON.parse(writeDecisions(decisions)) as { version: number; decisions: unknown[] };
    writeFileSync(decisions, JSON.stringify({ version: 1, decisions: [...good.decisions, { id: 'bad', decision: { kind: 'nonsense' } }] }));
    first.close();
    const second = open(path, { decisionsPath: decisions });
    expect(second.report.decisions).toEqual({ applied: 5, unresolved: 0, dropped: 1 });
    expect(second.query({ text: 'loose_notes', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 5 }).rows).toEqual([]);
  });

  it('works without a decisions file', () => {
    const { path, decisions } = profile();
    const db = open(path, { decisionsPath: decisions });
    expect(db.report.decisions).toEqual({ applied: 0, unresolved: 0, dropped: 0 });
    expect(db.replayDecisions()).toMatchObject({ found: false });
    expect(db.replayDecisions(undefined)).toMatchObject({ found: false });
  });
});

describe('deleting the index', () => {
  it('removes the database, its log, the backup and the damaged copy, and nothing else', () => {
    const { userData, path, decisions } = profile();
    const dir = join(path, '..');
    const db = open(path);
    populate(db);
    db.close();
    damage(path);
    const again = open(path, { verify: true });
    populate(again);
    again.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    writeFileSync(join(dir, 'library.db.v0.bak'), 'old');
    writeFileSync(join(dir, 'notes-from-someone-else.txt'), 'keep me');
    writeFileSync(decisions, '{"version":1,"decisions":[]}');
    writeFileSync(join(userData, 'library-settings.json'), '{"roots":[]}');
    expect(again.ownedFileNames().length).toBeGreaterThanOrEqual(3);
    const removed = again.deleteIndex();
    expect(removed).toEqual(expect.arrayContaining(['library.db', 'library.db.v0.bak', again.report.recovery!.damagedFile!]));
    expect(removed).not.toContain('notes-from-someone-else.txt');
    expect(readdirSync(dir)).toEqual(['notes-from-someone-else.txt']);
    expect(readFileSync(decisions, 'utf8')).toBe('{"version":1,"decisions":[]}');
    expect(existsSync(join(userData, 'library-settings.json'))).toBe(true);
    expect(again.isOpen).toBe(false);
    expect(() => again.counts()).toThrow('closed');
    // The next start finds nothing and builds a new index.
    const fresh = open(path);
    expect(fresh.report).toMatchObject({ created: true, uncleanShutdown: false });
    expect(fresh.counts().files).toBe(0);
  });

  it('removes the empty library directory and leaves the profile alone', () => {
    const { userData, path } = profile();
    const db = open(path);
    db.deleteIndex();
    expect(existsSync(join(userData, 'library'))).toBe(false);
    expect(existsSync(userData)).toBe(true);
  });
});

describe('size accounting', () => {
  it('adds up the file, the log and the shared memory, and breaks the file down by table', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    const size = db.size();
    expect(size.databaseBytes).toBeGreaterThan(0);
    expect(size.totalBytes).toBe(size.databaseBytes + size.walBytes + size.shmBytes);
    expect(size.pageSize).toBe(4096);
    expect(size.files).toBe(60);
    expect(size.contents).toBe(60);
    expect(size.perTable).toBe(true);
    const names = size.tables.map(t => t.name);
    for (const expected of ['board', 'posting', 'term', 'file', 'name_fts', 'content']) expect(names).toContain(expected);
    const byName = Object.fromEntries(size.tables.map(t => [t.name, t]));
    expect(byName.file.rows).toBe(60);
    expect(byName.name_fts.rows).toBe(60);
    expect(byName.board.rows).toBe(60);
    expect(size.tables.map(t => t.bytes)).toEqual([...size.tables.map(t => t.bytes)].sort((a, b) => b - a));
    const tableBytes = size.tables.reduce((sum, t) => sum + t.bytes, 0);
    expect(tableBytes + size.freeBytes).toBeLessThanOrEqual(size.pageCount * size.pageSize);
    expect(tableBytes).toBeGreaterThan(size.pageCount * size.pageSize * 0.9 - size.freeBytes);
    expect(size.bytesPerFile).toBeCloseTo((size.totalBytes - size.fullTextBytes) / 60, 6);
    expect(size.projectedPer100kFiles).toBe(Math.round(size.bytesPerFile * 100_000));
    expect(size.budgetPer100kFiles).toBe(1_000_000_000);
    expect(size.withinBudget).toBe(size.projectedPer100kFiles <= 1_000_000_000);
  });

  it('counts the opt-in page text apart from the metadata budget', () => {
    const { path } = profile();
    const db = open(path);
    db.syncRoots([syntheticRoot('r1', '/synthetic/one', { options: { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 } })]);
    const scan = db.beginScan();
    const body = (i: number): string => Array.from({ length: 300 }, (_, k) => `word${(i * 31 + k * 7) % 4000}`).join(' ');
    for (let i = 0; i < 20; i++) ingest(db, 'r1', scan, { dir: 'd', name: `doc${i}.pdf`, seed: 3000 + i, kind: 'pdf', summary: makeDocumentSummary({ seed: 3000 + i, pages: 10, parts: 5, rails: 1, fullText: Array.from({ length: 10 }, (_, p) => ({ page: p + 1, body: body(i * 10 + p) })) }) });
    const size = db.size();
    expect(size.fullTextBytes).toBeGreaterThan(50_000);
    expect(size.bytesPerFile).toBeLessThan(size.totalBytes / 20);
    expect(size.tables.find(t => t.name === 'text_fts')!.rows).toBe(200);
  });

  it('keeps the log small while writing: it is truncated down to the journal size limit after a checkpoint', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.checkpoint();
    expect(db.size().walBytes).toBe(0);
  });

  it('compacts free pages', () => {
    const { path } = profile();
    const db = open(path);
    populate(db);
    db.removeRoot('r1');
    db.checkpoint();
    const before = db.size();
    expect(before.freelistPages).toBeGreaterThan(0);
    db.compact();
    const after = db.size();
    expect(after.freelistPages).toBe(0);
    expect(after.databaseBytes).toBeLessThan(before.databaseBytes);
  });
});

/** Rebuilds the hand-made fixture library inside an existing database (a scan followed by the grouping stage). */
function buildInto(db: LibraryDb): ReturnType<typeof buildFixture> {
  const f = {} as ReturnType<typeof buildFixture>['f'];
  const on = { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 };
  db.syncRoots([syntheticRoot('rootA', '/synthetic/a'), syntheticRoot('rootB', '/synthetic/b', { options: on })]);
  const scan = db.beginScan();
  const board = (seed: number) => makeBoardSummary({ seed, refs: 60, parts: 6, components: 4 });
  f.rev1 = ingest(db, 'rootA', scan, { dir: 'laptops/aurelia', name: 'lx100_rev1.brd', seed: 101, kind: 'board', sha256: true, size: 5000, summary: board(101) });
  f.rev2 = ingest(db, 'rootA', scan, { dir: 'laptops/aurelia', name: 'lx100_rev2.brd', seed: 102, kind: 'board', size: 5100, summary: board(102) });
  f.photo = ingest(db, 'rootB', scan, { dir: 'photos', name: 'lx100_top.jpg', seed: 601, kind: 'image', summary: { kind: 'image', width: 4000, height: 3000 } });
  f.notes = ingest(db, 'rootA', scan, { dir: 'misc', name: 'loose_notes.pdf', seed: 301, kind: 'pdf', summary: makeDocumentSummary({ seed: 301, pages: 2, parts: 2, rails: 0 }) });
  f.zip = ingest(db, 'rootA', scan, { dir: 'zips', name: 'pack.zip', seed: 501, kind: 'archive' });
  f.spare = ingest(db, 'rootA', scan, { dir: '', name: '', seed: 502, kind: 'board', container: { fileId: f.zip.fileId, entryPath: 'inside/spare.brd' }, summary: board(502) });
  db.putGroup(groupOf('g1', 'Aurelia LX100', [{ contentId: f.rev1.contentId, role: 'board' }, { contentId: f.rev2.contentId, role: 'board' }, { contentId: f.photo.contentId, role: 'photo' }], { tags: ['bench'], vendor: 'Aurelia', deviceType: 'laptop' }));
  return { db, scan, f };
}
