import type { DatabaseSync } from 'node:sqlite';
import { LIBRARY_SCHEMA_VERSION } from '../../lib/library/model';
import { SCHEMA_V1_SQL } from './schema-v1';

/** Forward-only numbered migration: runs in one transaction, then `meta.schema_version` becomes `to`. */
export interface Migration { from: number; to: number; up(db: DatabaseSync): void }

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { from: 0, to: 1, up(db) { db.exec(SCHEMA_V1_SQL); } },
]);

/** The database was written by a newer application: it is refused and never modified. */
export class NewerSchemaError extends Error {
  readonly code = 'newer-schema' as const;
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number) {
    super(`Library schema ${found} is newer than the supported ${supported}`);
    this.found = found;
    this.supported = supported;
  }
}

/** The file is a SQLite database but not a Library database (or its meta table is unreadable). */
export class ForeignDatabaseError extends Error {
  readonly code = 'foreign-database' as const;
  constructor(detail: string) { super(`Not a Library database: ${detail}`); }
}

export class MigrationError extends Error {
  readonly code = 'migration-failed' as const;
  readonly from: number;
  readonly to: number;
  constructor(from: number, to: number, cause: unknown) {
    super(`Library migration ${from} -> ${to} failed`, { cause });
    this.from = from;
    this.to = to;
  }
}

/** 0 for an empty database. Throws ForeignDatabaseError for a database that holds other tables or an unreadable version. */
export function readSchemaVersion(db: DatabaseSync): number {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  if (tables.length === 0) return 0;
  if (!tables.some(t => t.name === 'meta')) throw new ForeignDatabaseError('no meta table');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (!row) throw new ForeignDatabaseError('no schema_version');
  const version = Number(row.value);
  if (!/^\d{1,9}$/.test(row.value) || !Number.isSafeInteger(version) || version < 1) throw new ForeignDatabaseError('bad schema_version');
  return version;
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  target?: number;
  /** Called once, before the first step that changes an existing (non-empty) database, with the version it has now. */
  backup?: (fromVersion: number) => void;
  now?: () => number;
}
export interface MigrationReport { from: number; to: number; steps: number; created: boolean }

/**
 * Brings the database to `target` (default: the version this application writes). A newer schema is refused before anything is written.
 * Each step is one transaction; a failing step is rolled back and the database stays at the last completed version.
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): MigrationReport {
  const migrations = options.migrations ?? MIGRATIONS;
  const target = options.target ?? LIBRARY_SCHEMA_VERSION;
  const now = options.now ?? Date.now;
  const start = readSchemaVersion(db);
  if (start > target) throw new NewerSchemaError(start, target);
  let version = start, steps = 0;
  while (version < target) {
    const step = migrations.find(m => m.from === version);
    if (!step || step.to <= version || step.to > target) throw new MigrationError(version, target, new Error('no migration path'));
    if (steps === 0 && start > 0) options.backup?.(start);
    db.exec('BEGIN IMMEDIATE');
    try {
      step.up(db);
      db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(step.to));
      if (version === 0) db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('created_at', ?)").run(String(now()));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw new MigrationError(version, step.to, error);
    }
    version = step.to;
    steps++;
  }
  return { from: start, to: version, steps, created: start === 0 && steps > 0 };
}
