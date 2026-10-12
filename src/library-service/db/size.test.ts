import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryDb, libraryDbPath } from './index';
import { PartPool, groupOf, ingest, makeBoardSummary, makeDocumentSummary, makeRng, syntheticRoot, type Ingested } from './synthetic';

let db: LibraryDb | undefined;
let directory: string | undefined;
afterEach(() => { db?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

it('keeps the expanded metadata schema below 1 GB per 100,000 files on a mixed synthetic library', () => {
  directory = mkdtempSync(join(tmpdir(), 'trace-lib-budget-'));
  db = LibraryDb.open({ path: libraryDbPath(directory) });
  db.syncRoots([syntheticRoot('r1', '/synthetic/budget')]);
  const scan = db.beginScan(), pool = new PartPool(makeRng(714));
  const files = 2000;
  let previousBoard: Ingested | undefined;
  for (let batch = 0; batch < files; batch += 20) {
    db.transaction(() => {
      for (let i = batch; i < Math.min(files, batch + 20); i++) {
        const slot = i % 20, seed = 10000 + i;
        if (slot < 6) {
          const duplicate = slot === 5, identity = duplicate ? seed - 1 : seed;
          const f = ingest(db, 'r1', scan, { dir: `boards/project${Math.floor(i / 20)}`, name: `board${i}.brd`, seed: identity, kind: 'board', sha256: true, stages: true,
            summary: duplicate ? undefined : makeBoardSummary({ seed, pool, refs: 1500, parts: 150, components: 150, passives: 70 }) });
          if (!duplicate) {
            db.putGroup(groupOf(`g${i}`, `Synthetic board ${i}`, [{ contentId: f.contentId, role: 'board' }]));
            db.putRevisions(`g${i}`, [{ contentId: f.contentId, label: 'REV 1', scheme: 'rev-number', order: 1, basis: 'token' }]);
            if (previousBoard) db.putSuggestions([{ a: previousBoard.contentId, b: f.contentId, kind: 'layout-related', score: 0.4, evidence: [] }]);
          } else if (previousBoard) {
            db.putDuplicateSet({ id: `d${i}`, kind: 'identical', fileIds: [previousBoard.fileId, f.fileId], contentIds: [f.contentId], evidence: [] });
          }
          previousBoard = f;
        } else if (slot < 14) {
          ingest(db, 'r1', scan, { dir: `documents/project${Math.floor(i / 20)}`, name: `document${i}.pdf`, seed, kind: 'pdf', stages: true,
            summary: makeDocumentSummary({ seed, pool, pages: 70, parts: 100, rails: 10, textLayer: slot % 3 === 0 ? 'no' : 'yes' }) });
        } else if (slot < 17) {
          ingest(db, 'r1', scan, { dir: 'images', name: `image${i}.png`, seed, kind: 'image', summary: { kind: 'image', width: 4000, height: 3000 }, stages: true });
        } else if (slot === 17) {
          const archive = ingest(db, 'r1', scan, { dir: 'archives', name: `archive${i}.zip`, seed, kind: 'archive' });
          for (let entry = 0; entry < 4; entry++) ingest(db, 'r1', scan, { dir: '', name: '', seed: 100000 + i * 4 + entry, kind: 'pdf', container: { fileId: archive.fileId, entryPath: `notes/page${entry}.pdf` },
            summary: makeDocumentSummary({ seed: 100000 + i * 4 + entry, pool, pages: 12, parts: 30, refs: 60 }) });
        } else {
          ingest(db, 'r1', scan, { dir: 'other', name: `item${i}.bin`, seed, kind: slot === 18 ? 'firmware' : 'unknown' });
        }
      }
    });
  }
  db.checkpoint();
  db.compact();
  const size = db.size();
  console.log(JSON.stringify({ files, entries: size.entries, bytesPerFile: size.bytesPerFile, projectedPer100kFiles: size.projectedPer100kFiles, databaseBytes: size.databaseBytes, walBytes: size.walBytes, shmBytes: size.shmBytes, perTable: size.perTable }));
  if (process.env.LIBRARY_SIZE_REPORT) writeFileSync(process.env.LIBRARY_SIZE_REPORT, JSON.stringify(size, null, 2));
  expect(size.files).toBe(files);
  expect(size.entries).toBe(400);
  expect(size.walBytes).toBe(0);
  expect(size.tables.find(t => t.name === 'text_fts')?.rows).toBe(0);
  expect(size.withinBudget).toBe(true);
  expect(size.projectedPer100kFiles).toBeLessThanOrEqual(1_000_000_000);
  expect(db.checkIntegrity('full').ok).toBe(true);
}, 300_000);
