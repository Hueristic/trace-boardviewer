import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryDb, libraryDbPath } from './index';
import { buildChild, type BuiltChild } from './child-build';

let built: BuiltChild;
const dirs: string[] = [];
const live: LibraryDb[] = [];
beforeAll(() => { built = buildChild('src/library-service/db/crash-child.ts'); });
afterAll(() => built?.dispose());
afterEach(() => { for (const db of live.splice(0)) if (db.isOpen) db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Running { child: ChildProcess; lines: string[]; waitFor(match: (line: string) => boolean): Promise<string>; exited: Promise<void> }

function start(path: string, env: Record<string, string>): Running {
  const child = spawn(process.execPath, ['--no-warnings', built.entry], { env: { ...process.env, LIB_PATH: path, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting: { match: (line: string) => boolean; resolve: (line: string) => void }[] = [];
  let buffer = '', stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      lines.push(line);
      for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].match(line)) waiting.splice(i, 1)[0].resolve(line);
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  const waitFor = (match: (line: string) => boolean): Promise<string> => new Promise((resolve, reject) => {
    const existing = lines.find(match);
    if (existing !== undefined) { resolve(existing); return; }
    waiting.push({ match, resolve });
    void exited.then(() => reject(new Error(`the child process ended before the awaited line appeared\nstdout: ${lines.slice(-5).join(' | ')}\nstderr: ${stderr.slice(0, 600)}`)));
  });
  return { child, lines, waitFor, exited };
}

async function kill(run: Running): Promise<void> {
  run.child.kill('SIGKILL');
  await run.exited;
}

const profile = (): string => { const userData = mkdtempSync(join(tmpdir(), 'trace-lib-crash-')); dirs.push(userData); return libraryDbPath(userData); };
const n = (db: LibraryDb, sql: string): number => Number((db.connection.prepare(sql).get() as { n: number }).n);

/** What must hold after any interruption: every stage's outputs are there together with its state, and the search indexes match their tables. */
function expectConsistent(db: LibraryDb): void {
  const integrity = db.checkIntegrity('full');
  expect(integrity.problems).toEqual([]);
  expect(integrity.ok).toBe(true);
  expect(n(db, `SELECT count(*) AS n FROM stage s WHERE s.stage = 'summary' AND s.state = 'done'
    AND NOT EXISTS (SELECT 1 FROM board b WHERE b.content_id = s.content_id) AND NOT EXISTS (SELECT 1 FROM document d WHERE d.content_id = s.content_id) AND NOT EXISTS (SELECT 1 FROM image i WHERE i.content_id = s.content_id)`)).toBe(0);
  expect(n(db, `SELECT count(*) AS n FROM (SELECT content_id FROM board UNION ALL SELECT content_id FROM document UNION ALL SELECT content_id FROM image) x
    WHERE NOT EXISTS (SELECT 1 FROM stage s WHERE s.content_id = x.content_id AND s.stage = 'summary' AND s.state = 'done')`)).toBe(0);
  expect(n(db, `SELECT count(*) AS n FROM posting p WHERE NOT EXISTS (SELECT 1 FROM board b WHERE b.content_id = p.content_id) AND NOT EXISTS (SELECT 1 FROM document d WHERE d.content_id = p.content_id)`)).toBe(0);
  expect(n(db, 'SELECT count(*) AS n FROM name_fts_docsize')).toBe(n(db, 'SELECT count(*) AS n FROM file'));
  expect(n(db, 'SELECT count(*) AS n FROM dir d WHERE d.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dir p WHERE p.id = d.parent_id)')).toBe(0);
}

async function interrupted(path: string, scenario: string, killAt: number, runId = 1): Promise<LibraryDb> {
  const run = start(path, { SCENARIO: scenario, KILL_AT: String(killAt), RUN_ID: String(runId) });
  await run.waitFor(line => line === 'PARKED');
  await kill(run);
  const db = LibraryDb.open({ path });
  live.push(db);
  return db;
}

describe('killing the process during a batch', () => {
  it.each([1, 2, 4])('leaves exactly the batches that were committed when the process stops before commit %i of a bulk insert', async killAt => {
    const path = profile();
    const db = await interrupted(path, 'files', killAt);
    expect(db.report).toMatchObject({ uncleanShutdown: true, checked: true, created: false });
    expect(db.report.recovery).toBeUndefined();
    expectConsistent(db);
    // The open transaction never reached the database; each earlier batch of 500 files is whole.
    expect(db.counts().files).toBe(120 + 500 * (killAt - 1));
    expect(n(db, "SELECT count(*) AS n FROM file WHERE name LIKE 'bulk%'")).toBe(500 * (killAt - 1));
    // The database is fully usable afterwards: it takes the same work again.
    const scan = db.beginScan();
    db.upsertFiles('r1', scan, Array.from({ length: 700 }, (_, i) => ({ dir: 'after', name: `after${i}.brd`, size: 10 + i })));
    expect(db.counts().files).toBe(120 + 500 * (killAt - 1) + 700);
    expectConsistent(db);
    db.close();
    const again = LibraryDb.open({ path });
    live.push(again);
    expect(again.report).toMatchObject({ uncleanShutdown: false, checked: false });
  });

  it.each([3, 8, 30, 77])('keeps a summary together with its stage state when the process stops before commit %i of a series of summaries', async killAt => {
    const path = profile();
    const db = await interrupted(path, 'summaries', killAt);
    expect(db.report).toMatchObject({ uncleanShutdown: true, checked: true });
    expect(db.report.recovery).toBeUndefined();
    expectConsistent(db);
    const summarised = n(db, "SELECT count(*) AS n FROM stage WHERE stage = 'summary' AND state = 'done' AND content_id IN (SELECT content_id FROM document)");
    expect(summarised).toBe(n(db, 'SELECT count(*) AS n FROM document'));
    // Contents that were identified but not yet summarised are offered to the queue again.
    const pending = db.listPending('summary', 1, 1000).filter(p => p.kind === 'pdf');
    expect(pending.length).toBeLessThanOrEqual(1);
    db.close();
  });

  it('finishes a root removal that was cut off half way', async () => {
    const path = profile();
    const db = await interrupted(path, 'remove-root', 3);
    expect(db.report.uncleanShutdown).toBe(true);
    expect(db.report.pendingRemovals).toEqual(['r2']);
    expect(db.listRoots().map(r => r.id)).toEqual(['r1']);
    const left = n(db, "SELECT count(*) AS n FROM file f JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id WHERE r.public_id = 'r2'");
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(2600);
    expectConsistent(db);
    expect(db.finishPendingRemovals()).toEqual(['r2']);
    expect(db.report.pendingRemovals).toEqual([]);
    expect(db.counts()).toMatchObject({ roots: 1, files: 120 });
    expectConsistent(db);
    expect(n(db, 'SELECT count(*) AS n FROM dir')).toBe(1 + 5);
  });

  it('purges an interrupted full-text opt-out on the next unclean open', async () => {
    const db = await interrupted(profile(), 'full-text-off', 2);
    expect(db.report).toMatchObject({ uncleanShutdown: true, checked: true });
    expect(db.report.recovery).toBeUndefined();
    expect(n(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(0);
    expect(db.listRoots().find(r => r.id === 'r2')!.options.fullText).toBe(false);
    expectConsistent(db);
  });

  it('survives being killed at arbitrary points, again and again, against the same database', async () => {
    const path = profile();
    let previous = 0;
    for (const [round, commitsBeforeKill] of [4, 9, 15, 6].entries()) {
      const run = start(path, { SCENARIO: 'churn', KILL_AT: '0', RUN_ID: String(round + 1) });
      let seen = 0;
      await run.waitFor(line => line.startsWith('COMMIT') && ++seen >= commitsBeforeKill);
      await kill(run);
      const db = LibraryDb.open({ path });
      live.push(db);
      expect(db.report).toMatchObject({ uncleanShutdown: true, checked: true });
      expect(db.report.recovery).toBeUndefined();
      expectConsistent(db);
      const files = db.counts().files;
      expect(files).toBeGreaterThanOrEqual(Math.max(previous, 120));
      previous = files;
      db.abandon();
    }
  });

  it('does not report a clean shutdown for a process that was killed, and does for one that closed', async () => {
    const path = profile();
    const run = start(path, { SCENARIO: 'summaries', KILL_AT: '0', RUN_ID: '1' });
    await run.waitFor(line => line === 'DONE');
    await run.exited;
    const db = LibraryDb.open({ path });
    live.push(db);
    expect(db.report).toMatchObject({ uncleanShutdown: false, checked: false });
    expect(db.counts().files).toBeGreaterThan(120);
    expectConsistent(db);
  });
});
