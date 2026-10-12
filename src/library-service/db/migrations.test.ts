import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIBRARY_SCHEMA_VERSION } from '../../lib/library/model';
import { ForeignDatabaseError, MIGRATIONS, MigrationError, NewerSchemaError, migrate, readSchemaVersion, type Migration } from './migrations';
import { SCHEMA_V1_SQL } from './schema-v1';

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'trace-lib-mig-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
const version = (db: DatabaseSync): string | undefined => (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;

describe('schema v1', () => {
  it('is the SQL block of docs/LIBRARY_SCHEMA.md, character for character', () => {
    const doc = readFileSync(new URL('../../../docs/LIBRARY_SCHEMA.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(/```sql\n([\s\S]*?)\n```/.exec(doc)![1]).toBe(SCHEMA_V1_SQL);
  });

  it('creates every documented table, index and virtual table', () => {
    const db = new DatabaseSync(':memory:');
    const report = migrate(db);
    expect(report).toEqual({ from: 0, to: LIBRARY_SCHEMA_VERSION, steps: 1, created: true });
    const names = tables(db);
    for (const table of ['meta', 'root', 'dir', 'content', 'file', 'stage', 'board', 'document', 'image', 'term', 'posting', 'identifier', 'grp', 'member', 'suggestion', 'revision', 'duplicate_set', 'duplicate_file', 'duplicate_content', 'name_fts', 'text_fts']) expect(names).toContain(table);
    for (const index of ['dir_child', 'dir_top', 'content_quick', 'file_loose', 'file_entry', 'file_content', 'file_scan', 'file_container', 'board_fingerprint', 'term_base', 'term_family', 'posting_content', 'identifier_norm', 'identifier_content', 'identifier_file', 'member_content', 'suggestion_b']) {
      expect(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)).toBeDefined();
    }
    expect(version(db)).toBe('1');
    expect(db.prepare("SELECT value FROM meta WHERE key = 'created_at'").get()).toBeDefined();
    db.close();
  });

  it('is idempotent: a database at the current version is left alone', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare("INSERT INTO meta(key, value) VALUES('probe', 'kept')").run();
    expect(migrate(db)).toEqual({ from: 1, to: 1, steps: 0, created: false });
    expect((db.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as { value: string }).value).toBe('kept');
    db.close();
  });
});

describe('migrations', () => {
  const v2: Migration = { from: 1, to: 2, up(db) { db.exec('ALTER TABLE root ADD COLUMN note TEXT'); db.exec("INSERT INTO meta(key, value) VALUES('v2_marker', 'yes')"); } };

  it('upgrades a populated version-1 fixture step by step and keeps its rows', () => {
    const dir = temp(), file = join(dir, 'library.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL');
    migrate(db);
    db.exec("INSERT INTO root(public_id, path, label, state, network, options) VALUES('r1', '/synthetic', 'Bench', 'online', 0, '{}')");
    db.close();
    const again = new DatabaseSync(file);
    const backups: number[] = [];
    const report = migrate(again, { migrations: [...MIGRATIONS, v2], target: 2, backup: from => backups.push(from) });
    expect(report).toEqual({ from: 1, to: 2, steps: 1, created: false });
    expect(backups).toEqual([1]);
    expect(version(again)).toBe('2');
    expect((again.prepare("SELECT label, note FROM root WHERE public_id = 'r1'").get() as { label: string; note: null }).label).toBe('Bench');
    expect(again.prepare("SELECT value FROM meta WHERE key = 'v2_marker'").get()).toBeDefined();
    again.close();
  });

  it('does not ask for a backup when it creates the database', () => {
    const db = new DatabaseSync(':memory:');
    const backups: number[] = [];
    migrate(db, { backup: from => backups.push(from) });
    expect(backups).toEqual([]);
    db.close();
  });

  it('refuses a newer schema before writing anything, and leaves the file byte for byte unchanged', () => {
    const dir = temp(), file = join(dir, 'library.db');
    const db = new DatabaseSync(file);
    migrate(db);
    db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const before = readFileSync(file);
    const again = new DatabaseSync(file);
    let caught: unknown;
    try { migrate(again, { backup: () => { throw new Error('no backup for a refused schema'); } }); } catch (error) { caught = error; }
    again.close();
    expect(caught).toBeInstanceOf(NewerSchemaError);
    expect(caught).toMatchObject({ code: 'newer-schema', found: 7, supported: 1 });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('rolls a failing step back completely and reports which step failed', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const broken: Migration = { from: 1, to: 2, up(d) { d.exec('CREATE TABLE half_done(x INTEGER)'); throw new Error('boom'); } };
    let caught: unknown;
    try { migrate(db, { migrations: [...MIGRATIONS, broken], target: 2 }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MigrationError);
    expect(caught).toMatchObject({ code: 'migration-failed', from: 1, to: 2 });
    expect(tables(db)).not.toContain('half_done');
    expect(version(db)).toBe('1');
    db.close();
  });

  it('fails cleanly when no step leads to the target', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(() => migrate(db, { target: 3 })).toThrow(MigrationError);
    expect(version(db)).toBe('1');
    db.close();
  });

  it('recognises a database that is not a Library database', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE other(x INTEGER)');
    expect(() => readSchemaVersion(db)).toThrow(ForeignDatabaseError);
    expect(() => migrate(db)).toThrow(ForeignDatabaseError);
    const named = new DatabaseSync(':memory:');
    named.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version', 'abc')");
    expect(() => readSchemaVersion(named)).toThrow(ForeignDatabaseError);
    named.exec("UPDATE meta SET value = '0'");
    expect(() => readSchemaVersion(named)).toThrow(ForeignDatabaseError);
    db.close(); named.close();
  });

  it('keeps the backup file a plain copy of the application database only', () => {
    const dir = temp(), file = join(dir, 'library.db'), bak = join(dir, 'library.db.v1.bak');
    const db = new DatabaseSync(file);
    migrate(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    migrate(db, { migrations: [...MIGRATIONS, v2], target: 2, backup: from => copyFileSync(file, join(dir, `library.db.v${from}.bak`)) });
    db.close();
    expect(existsSync(bak)).toBe(true);
    const old = new DatabaseSync(bak, { readOnly: true });
    expect(version(old)).toBe('1');
    old.close();
    expect(readdirSync(dir).filter(n => n.endsWith('.bak'))).toEqual(['library.db.v1.bak']);
  });
});
