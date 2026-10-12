import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Name of the database inside the profile's `library/` directory. */
export const DB_FILE_NAME = 'library.db';

const BACKUP = /^library\.db\.v\d{1,9}\.bak$/;
const DAMAGED = /^library\.db\.damaged-\d{1,16}$/;

/** The files the service owns next to one database file. Anything else in the directory is not ours and is never touched. */
export function ownedFiles(dbPath: string): { main: string; wal: string; shm: string; journal: string; backups: string[]; damaged: string[] } {
  const dir = dirname(dbPath), name = basename(dbPath);
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { /* the directory does not exist yet */ }
  const backups = name === DB_FILE_NAME ? entries.filter(e => BACKUP.test(e)).map(e => join(dir, e)) : [];
  const damaged = name === DB_FILE_NAME ? entries.filter(e => DAMAGED.test(e)).map(e => join(dir, e)) : [];
  return { main: dbPath, wal: `${dbPath}-wal`, shm: `${dbPath}-shm`, journal: `${dbPath}-journal`, backups, damaged };
}

const sizeOf = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };
export const fileBytes = sizeOf;

const removeOwned = (path: string): void => { rmSync(path, { force: true }); };

/**
 * Copies only the application's own database to `library.db.v<N>.bak` before a migration, keeping a single backup. The caller has
 * checkpointed the write-ahead log, so the copy is complete without it. Never copies a user document.
 */
export function backupBeforeMigration(dbPath: string, fromVersion: number, directory: string = dirname(dbPath)): string {
  const target = join(directory, `${basename(dbPath)}.v${fromVersion}.bak`);
  for (const old of ownedFiles(dbPath).backups) if (old !== target) removeOwned(old);
  copyFileSync(dbPath, target);
  return target;
}

/**
 * Moves a database that cannot be trusted aside as `library.db.damaged-<time>` and drops its write-ahead log. At most one damaged
 * database is kept: older ones are deleted. Returns the new name, or undefined when there was nothing to move.
 */
export function moveAsideDamaged(dbPath: string, nowMs: number): string | undefined {
  const files = ownedFiles(dbPath);
  removeOwned(files.wal); removeOwned(files.shm); removeOwned(files.journal);
  if (!existsSync(files.main)) return undefined;
  const target = join(dirname(dbPath), `${basename(dbPath)}.damaged-${Math.max(0, Math.trunc(nowMs))}`);
  for (const old of files.damaged) if (old !== target) removeOwned(old);
  renameSync(files.main, target);
  return target;
}

/**
 * Deletes the index: the database, its log and shared-memory file, the migration backup and the damaged copy. Only these named files
 * of the profile's library directory are removed (the directory itself only when it is empty afterwards). Returns what was removed.
 */
export function removeIndexFiles(dbPath: string): string[] {
  const files = ownedFiles(dbPath);
  const removed: string[] = [];
  for (const path of [files.wal, files.shm, files.journal, files.main, ...files.backups, ...files.damaged]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(basename(path));
  }
  // The directory goes only when it is the service's own `library` folder and nothing else is left in it.
  if (basename(dirname(dbPath)) === 'library') { try { rmdirSync(dirname(dbPath)); } catch { /* not empty (other files stay) or already gone */ } }
  return removed;
}
