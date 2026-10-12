/**
 * Program run by the crash tests in a separate Node process (compiled by child-build.ts). It writes to the database in bounded batches and
 * announces its progress on stdout, one line per event; the parent kills it at a chosen point. Nothing here is part of the service.
 */
import { writeSync } from 'node:fs';
import { LibraryDb } from './index';
import { ingest, makeBoardSummary, makeDocumentSummary, syntheticRoot } from './synthetic';

const say = (line: string): void => { writeSync(1, `${line}\n`); };
const path = process.env.LIB_PATH ?? '', scenario = process.env.SCENARIO ?? '', killAt = Number(process.env.KILL_AT ?? 0);
const park = (): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); };

let armed = false, commits = 0;
const db = LibraryDb.open({
  path,
  hooks: {
    beforeCommit: info => {
      if (!armed) return;
      commits++;
      say(`COMMIT ${commits} ${info.units}`);
      // Stop inside the open transaction, right before COMMIT: the parent kills the process while this batch is uncommitted.
      if (killAt > 0 && commits === killAt) { say('PARKED'); park(); }
    },
  },
});

db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
if (db.counts().files === 0) {
  const scan = db.beginScan();
  for (let i = 0; i < 120; i++) ingest(db, 'r1', scan, { dir: `base${i % 5}`, name: `base${i}.brd`, seed: 100 + i, kind: 'board', summary: makeBoardSummary({ seed: 100 + i, refs: 120, parts: 12, components: 6 }), stages: true });
  db.checkpoint();
}
say(`BASELINE ${db.counts().files}`);

/** Distinguishes the files of one run from those of an earlier run against the same database. */
const epoch = Number(process.env.RUN_ID ?? 0);
if (scenario === 'files') {
  // One call, many bounded transactions of 500 files each.
  const scan = db.beginScan();
  armed = true;
  db.upsertFiles('r1', scan, Array.from({ length: 3000 }, (_, i) => ({ dir: `bulk${i % 40}`, name: `bulk${epoch}_${i}.brd`, size: 4000 + i, mtimeMs: 1_700_000_000_000 + i })));
} else if (scenario === 'summaries') {
  // Each summary is one transaction: the outputs of a stage and its state row commit together.
  const scan = db.beginScan();
  armed = true;
  for (let i = 0; i < 80; i++) ingest(db, 'r1', scan, { dir: 'sum', name: `s${epoch}_${i}.pdf`, seed: 5000 + epoch + i, kind: 'pdf', summary: makeDocumentSummary({ seed: 5000 + i, pages: 20, parts: 30, rails: 3 }), stages: true });
} else if (scenario === 'remove-root') {
  db.syncRoots([syntheticRoot('r2', '/synthetic/two')]);
  const scan = db.beginScan();
  db.upsertFiles('r2', scan, Array.from({ length: 2600 }, (_, i) => ({ dir: `x${i % 30}`, name: `x${i}.brd`, size: 100 + i })));
  say('LOADED');
  commits = 0;
  armed = true;
  db.removeRoot('r2');
} else if (scenario === 'full-text-off') {
  const on = { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 };
  db.syncRoots([syntheticRoot('r2', '/synthetic/two', { options: on })]);
  const scan = db.beginScan();
  ingest(db, 'r2', scan, { dir: '', name: 'text.pdf', seed: 8500, kind: 'pdf', sha256: true,
    summary: makeDocumentSummary({ seed: 8500, pages: 1, parts: 1, fullText: [{ page: 1, body: 'consentedtext' }] }) });
  ingest(db, 'r1', scan, { dir: '', name: 'copy.pdf', seed: 8500, kind: 'pdf', sha256: true });
  armed = true;
  db.setRootOptions('r2', { ...on, fullText: false });
} else if (scenario === 'churn') {
  // Runs until killed: batches of files followed by a summary, forever.
  armed = true;
  for (let round = 0; ; round++) {
    const scan = db.beginScan();
    db.upsertFiles('r1', scan, Array.from({ length: 700 }, (_, i) => ({ dir: `churn${round % 7}`, name: `c${epoch}_${round}_${i}.brd`, size: 900 + i })));
    ingest(db, 'r1', scan, { dir: 'churn', name: `s${epoch}_${round}.pdf`, seed: 9000 + epoch + round, kind: 'pdf', summary: makeDocumentSummary({ seed: 9000 + round, pages: 8, parts: 10, rails: 2 }), stages: true });
  }
}
say('DONE');
db.close();
