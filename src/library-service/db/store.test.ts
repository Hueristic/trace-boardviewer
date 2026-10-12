import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryDb, sequentialIds } from './index';
import { groupOf, ingest, makeBoardSummary, makeDocumentSummary, quickKey, sha256Of, syntheticRoot } from './synthetic';

const dirs: string[] = [];
const open: LibraryDb[] = [];
afterEach(() => { for (const db of open.splice(0)) if (db.isOpen) db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const memoryDb = (now = () => 1_800_000_000_000): LibraryDb => { const db = LibraryDb.open({ path: ':memory:', ids: sequentialIds(), now }); open.push(db); return db; };
const fileDb = (): { db: LibraryDb; dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-lib-store-')); dirs.push(dir);
  const path = join(dir, 'library', 'library.db');
  const db = LibraryDb.open({ path, ids: sequentialIds() }); open.push(db);
  return { db, dir, path };
};
const count = (db: LibraryDb, table: string): number => Number((db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);

describe('roots', () => {
  it('registers, updates and lists roots without exposing their paths', () => {
    const db = memoryDb();
    const report = db.syncRoots([syntheticRoot('rootA', '/synthetic/a'), syntheticRoot('rootB', '/synthetic/b', { network: true })]);
    expect(report.added).toEqual(['rootA', 'rootB']);
    expect(db.syncRoots([syntheticRoot('rootA', '/synthetic/a'), syntheticRoot('rootB', '/synthetic/b', { network: true })]).unchanged).toEqual(['rootA', 'rootB']);
    const renamed = db.syncRoots([syntheticRoot('rootA', '/synthetic/a2', { label: 'Renamed' })]);
    expect(renamed.updated).toEqual(['rootA']);
    expect(renamed.unregistered).toEqual(['rootB']);
    const roots = db.listRoots();
    expect(roots.map(r => [r.id, r.label, r.network, r.fileCount])).toEqual([['rootA', 'Renamed', false, 0], ['rootB', 'Synthetic rootB', true, 0]]);
    expect(JSON.stringify(roots)).not.toContain('/synthetic');
  });

  it('state changes never delete rows, and an offline root is not marked missing', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const scan1 = db.beginScan();
    ingest(db, 'r1', scan1, { dir: 'a', name: 'one.brd', seed: 1, kind: 'board' });
    ingest(db, 'r1', scan1, { dir: 'a', name: 'two.brd', seed: 2, kind: 'board' });
    db.setRootState('r1', 'offline');
    const scan2 = db.beginScan();
    expect(db.markMissing('r1', scan2, 5)).toBe(0);
    expect(db.counts().files).toBe(2);
    db.setRootState('r1', 'online');
    expect(db.markMissing('r1', scan2, 5)).toBe(2);
  });
});

describe('files and identity', () => {
  it('records new, unchanged and changed files and keeps public ids stable', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const [n] = db.upsertFiles('r1', s1, [{ dir: 'boards/laptops', name: 'main.brd', size: 4000, mtimeMs: 10 }]);
    expect(n).toMatchObject({ status: 'new', needsIdentity: true });
    const [u] = db.upsertFiles('r1', db.beginScan(), [{ dir: 'boards/laptops', name: 'main.brd', size: 4000, mtimeMs: 10 }]);
    expect(u).toMatchObject({ status: 'unchanged', id: n.id, needsIdentity: true });
    const [c] = db.upsertFiles('r1', db.beginScan(), [{ dir: 'boards/laptops', name: 'main.brd', size: 4100, mtimeMs: 11 }]);
    expect(c).toMatchObject({ status: 'changed', id: n.id });
    expect(db.getFile(n.id!)).toMatchObject({ relativePath: 'boards/laptops/main.brd', size: 4100, state: 'pending', rootId: 'r1' });
  });

  it('rejects unsafe or malformed locations and never stores them', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const bad = db.upsertFiles('r1', 1, [
      { dir: '..', name: 'x.brd', size: 1 }, { dir: '/abs', name: 'x.brd', size: 1 }, { dir: 'a', name: 'b/c.brd', size: 1 }, { dir: 'C:\\x', name: 'x.brd', size: 1 },
      { dir: 'a', name: 'x.brd', size: -1 }, { dir: 'a', name: 'x.brd', size: 1.5 }, { dir: 'a', name: 'x.brd:stream', size: 1 }, { dir: 'a', name: '', size: 1 },
    ]);
    expect(bad.every(r => r.status === 'rejected')).toBe(true);
    expect(db.counts().files).toBe(0);
    expect(db.upsertFiles('nope', 1, [{ dir: '', name: 'x.brd', size: 1 }])[0]).toMatchObject({ status: 'rejected', reason: 'unknown-root' });
  });

  it('shares a content row only after the full hash confirmed it', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s = db.beginScan();
    const a = ingest(db, 'r1', s, { dir: 'x', name: 'a.brd', seed: 5, kind: 'board', size: 777 });
    const b = ingest(db, 'r1', s, { dir: 'y', name: 'b.brd', seed: 5, kind: 'board', size: 777 });
    expect(a.contentId).not.toBe(b.contentId);
    expect(db.unconfirmedDuplicates()).toEqual([{ size: 777, contentIds: expect.arrayContaining([a.contentId, b.contentId]) }]);
    expect(db.confirmHash(a.contentId, sha256Of(5))).toEqual({ contentId: a.contentId, merged: false });
    const merged = db.confirmHash(b.contentId, sha256Of(5))!;
    expect(merged.merged).toBe(true);
    expect(db.getFile(a.fileId)!.contentId).toBe(db.getFile(b.fileId)!.contentId);
    expect(count(db, 'content')).toBe(1);
    expect(db.unconfirmedDuplicates()).toEqual([]);
  });

  it('keeps the content with the summary when two contents merge', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s = db.beginScan();
    const a = ingest(db, 'r1', s, { dir: 'x', name: 'a.brd', seed: 6, kind: 'board', size: 800 });
    const b = ingest(db, 'r1', s, { dir: 'y', name: 'b.brd', seed: 6, kind: 'board', size: 800, summary: makeBoardSummary({ seed: 6, refs: 40, parts: 8, components: 4 }) });
    db.confirmHash(a.contentId, sha256Of(6));
    const merged = db.confirmHash(b.contentId, sha256Of(6))!;
    expect(merged).toEqual({ contentId: b.contentId, merged: true });
    expect(db.boardSummary(b.contentId)).toBeDefined();
    expect(db.getFile(a.fileId)).toMatchObject({ contentId: b.contentId, state: 'indexed' });
  });

  it('marks unseen files missing after a complete walk and keeps them thirty days', () => {
    let now = 1_800_000_000_000;
    const db = memoryDb(() => now);
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    ingest(db, 'r1', s1, { dir: 'd', name: 'keep.brd', seed: 1, kind: 'board' });
    ingest(db, 'r1', s1, { dir: 'd', name: 'gone.brd', seed: 2, kind: 'board' });
    const s2 = db.beginScan();
    db.upsertFiles('r1', s2, [{ dir: 'd', name: 'keep.brd', size: 1001, mtimeMs: 1_700_000_000_001 }]);
    expect(db.markMissing('r1', s2, now)).toBe(1);
    expect(db.counts().problems).toBe(1);
    now += 29 * 24 * 3600 * 1000;
    expect(db.purgeMissing(now)).toBe(0);
    now += 2 * 24 * 3600 * 1000;
    expect(db.purgeMissing(now)).toBe(1);
    expect(db.counts()).toMatchObject({ files: 1, contents: 1 });
  });

  it('returns a missing file to its content state when it reappears', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const a = ingest(db, 'r1', s1, { dir: 'd', name: 'back.brd', seed: 3, kind: 'board', summary: makeBoardSummary({ seed: 3, refs: 30, parts: 5, components: 3 }) });
    expect(db.getFile(a.fileId)!.state).toBe('indexed');
    const s2 = db.beginScan();
    db.markMissing('r1', s2, 10);
    expect(db.getFile(a.fileId)!.state).toBe('missing');
    const s3 = db.beginScan();
    db.upsertFiles('r1', s3, [{ dir: 'd', name: 'back.brd', size: 1003, mtimeMs: 1_700_000_000_003 }]);
    expect(db.getFile(a.fileId)).toMatchObject({ state: 'indexed' });
    expect(db.getFile(a.fileId)!.missingSince).toBeUndefined();
  });

  it('detects a moved file by size and quick key and keeps its content, group and summary', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const old = ingest(db, 'r1', s1, { dir: 'old', name: 'm.brd', seed: 9, kind: 'board', summary: makeBoardSummary({ seed: 9, refs: 30, parts: 5, components: 3 }) });
    db.putGroup(groupOf('g1', 'Moved board', [{ contentId: old.contentId, role: 'board' }]));
    const s2 = db.beginScan();
    const moved = ingest(db, 'r1', s2, { dir: 'new/place', name: 'renamed.brd', seed: 9, kind: 'board' });
    expect(moved.contentId).not.toBe(old.contentId);
    const reports = db.resolveMoves('r1', s2);
    expect(reports).toEqual([{ removedFileId: old.fileId, keptFileId: moved.fileId, contentId: old.contentId }]);
    expect(db.getFile(old.fileId)).toBeUndefined();
    expect(db.getFile(moved.fileId)).toMatchObject({ contentId: old.contentId, relativePath: 'new/place/renamed.brd', state: 'indexed' });
    expect(db.getGroup('g1')!.files.map(f => f.id)).toEqual([moved.fileId]);
    expect(count(db, 'content')).toBe(1);
  });

  it('does not treat two candidates for one file as a move', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    ingest(db, 'r1', s1, { dir: 'a', name: 'one.brd', seed: 11, kind: 'board', size: 500 });
    const s2 = db.beginScan();
    ingest(db, 'r1', s2, { dir: 'b', name: 'copy1.brd', seed: 11, kind: 'board', size: 500 });
    ingest(db, 'r1', s2, { dir: 'c', name: 'copy2.brd', seed: 11, kind: 'board', size: 500 });
    expect(db.resolveMoves('r1', s2)).toEqual([]);
  });

  it('refuses to treat contents with different confirmed hashes as a move', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const a = ingest(db, 'r1', s1, { dir: 'a', name: 'x.brd', seed: 12, kind: 'board', size: 500 });
    db.confirmHash(a.contentId, sha256Of(1200));
    const s2 = db.beginScan();
    const b = ingest(db, 'r1', s2, { dir: 'b', name: 'y.brd', seed: 12, kind: 'board', size: 500 });
    db.confirmHash(b.contentId, sha256Of(1201));
    expect(db.resolveMoves('r1', s2)).toEqual([]);
  });

  it('moves a file row in place and keeps archive members under it', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s = db.beginScan();
    const zip = ingest(db, 'r1', s, { dir: 'zips', name: 'pack.zip', seed: 20, kind: 'archive' });
    const member = ingest(db, 'r1', s, { dir: '', name: '', seed: 21, kind: 'board', container: { fileId: zip.fileId, entryPath: 'inner/board.brd' } });
    expect(db.moveFile(zip.fileId, { dir: 'archive/2024', name: 'pack2.zip' })).toBe(true);
    expect(db.getFile(zip.fileId)!.relativePath).toBe('archive/2024/pack2.zip');
    expect(db.getFile(member.fileId)).toMatchObject({ relativePath: 'archive/2024/pack2.zip', entryPath: 'inner/board.brd', containerId: zip.fileId });
    const hit = db.query({ text: 'file:board.brd', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 10 });
    expect(hit.rows.map(r => r.relativePath)).toEqual(['archive/2024/pack2.zip']);
  });
});

describe('archive members', () => {
  it('stores members under their container and follows them in the scan', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const zip = ingest(db, 'r1', s1, { dir: 'z', name: 'bundle.zip', seed: 30, kind: 'archive', size: 9000 });
    const m1 = ingest(db, 'r1', s1, { dir: '', name: '', seed: 31, kind: 'board', container: { fileId: zip.fileId, entryPath: 'a/b.brd' } });
    const m2 = ingest(db, 'r1', s1, { dir: '', name: '', seed: 32, kind: 'pdf', container: { fileId: zip.fileId, entryPath: 'doc.pdf' } });
    expect(db.getFile(m1.fileId)).toMatchObject({ containerId: zip.fileId, entryPath: 'a/b.brd', relativePath: 'z/bundle.zip' });
    expect(db.counts()).toMatchObject({ files: 1, entries: 2 });
    const bad = db.upsertFiles('r1', s1, [{ containerId: zip.fileId, entryPath: '../evil', size: 1 }, { containerId: 'nope', entryPath: 'a', size: 1 }, { containerId: m1.fileId, entryPath: 'nested.zip', size: 1 }]);
    expect(bad.map(r => r.reason)).toEqual(['invalid-entry', 'unknown-container', 'unknown-container']);
    expect(m2.fileId).toBeTruthy();
  });

  it('carries the members of an unchanged archive through the next scan', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const zip = ingest(db, 'r1', s1, { dir: 'z', name: 'bundle.zip', seed: 40, kind: 'archive', size: 9000, mtimeMs: 5 });
    const member = ingest(db, 'r1', s1, { dir: '', name: '', seed: 41, kind: 'board', container: { fileId: zip.fileId, entryPath: 'a.brd' } });
    const s2 = db.beginScan();
    db.upsertFiles('r1', s2, [{ dir: 'z', name: 'bundle.zip', size: 9000, mtimeMs: 5 }]);
    expect(db.markMissing('r1', s2, 99)).toBe(0);
    expect(db.getFile(member.fileId)!.state).not.toBe('missing');
    // The archive vanishes, then returns unchanged: its members return with it.
    const s3 = db.beginScan();
    expect(db.markMissing('r1', s3, 100)).toBe(2);
    const s4 = db.beginScan();
    db.upsertFiles('r1', s4, [{ dir: 'z', name: 'bundle.zip', size: 9000, mtimeMs: 5 }]);
    expect(db.getFile(zip.fileId)!.state).not.toBe('missing');
    expect(db.getFile(member.fileId)!.state).not.toBe('missing');
    expect(db.markMissing('r1', s4, 101)).toBe(0);
  });

  it('marks members missing when a changed archive no longer lists them', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const zip = ingest(db, 'r1', s1, { dir: 'z', name: 'bundle.zip', seed: 50, kind: 'archive', size: 9000, mtimeMs: 5 });
    const keep = ingest(db, 'r1', s1, { dir: '', name: '', seed: 51, kind: 'board', container: { fileId: zip.fileId, entryPath: 'keep.brd' } });
    const drop = ingest(db, 'r1', s1, { dir: '', name: '', seed: 52, kind: 'board', container: { fileId: zip.fileId, entryPath: 'drop.brd' } });
    const s2 = db.beginScan();
    db.upsertFiles('r1', s2, [{ dir: 'z', name: 'bundle.zip', size: 9500, mtimeMs: 6 }]);
    db.upsertFiles('r1', s2, [{ containerId: zip.fileId, entryPath: 'keep.brd', size: 1051 }]);
    expect(db.markMissing('r1', s2, 99)).toBe(1);
    expect(db.getFile(drop.fileId)!.state).toBe('missing');
    expect(db.getFile(keep.fileId)!.state).not.toBe('missing');
  });

  it('deletes members with their archive and their name index rows', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s1 = db.beginScan();
    const zip = ingest(db, 'r1', s1, { dir: 'z', name: 'bundle.zip', seed: 60, kind: 'archive' });
    ingest(db, 'r1', s1, { dir: '', name: '', seed: 61, kind: 'board', container: { fileId: zip.fileId, entryPath: 'in/side.brd' } });
    expect(count(db, 'name_fts_docsize')).toBe(2);
    db.removeRoot('r1');
    expect(count(db, 'file')).toBe(0);
    expect(count(db, 'name_fts_docsize')).toBe(0);
    expect(count(db, 'content')).toBe(0);
  });
});

describe('content stages and the poison-file guard', () => {
  it('increments the attempt before dispatch and stops after two reader crashes', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'p', name: 'poison.pdf', seed: 70, kind: 'pdf' });
    expect(db.beginAttempt(f.contentId)).toEqual({ allowed: true, attempts: 1 });
    expect(db.beginAttempt(f.contentId)).toEqual({ allowed: true, attempts: 2 });
    expect(db.beginAttempt(f.contentId)).toEqual({ allowed: false, attempts: 2 });
    expect(db.getFile(f.fileId)).toMatchObject({ problem: 'reader-crash', state: 'skipped' });
    expect(db.listPending('summary', 1).map(p => p.contentId)).not.toContain(f.contentId);
    expect(db.beginAttempt('no-such-content')).toEqual({ allowed: false, attempts: 0 });
  });

  it('resets the counter when the reader succeeds', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'p', name: 'ok.pdf', seed: 71, kind: 'pdf' });
    db.beginAttempt(f.contentId);
    db.commitSummary({ contentId: f.contentId, summary: makeDocumentSummary({ seed: 71, pages: 3, parts: 4, rails: 1 }), extractorVersion: 1 });
    expect(db.beginAttempt(f.contentId)).toEqual({ allowed: true, attempts: 1 });
    db.endAttempt(f.contentId);
    expect(db.beginAttempt(f.contentId)).toEqual({ allowed: true, attempts: 1 });
  });

  it('offers a content again only when its stage is older, missing or pending', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s = db.beginScan();
    const a = ingest(db, 'r1', s, { dir: 'p', name: 'a.brd', seed: 80, kind: 'board' });
    const b = ingest(db, 'r1', s, { dir: 'p', name: 'b.brd', seed: 81, kind: 'board', summary: makeBoardSummary({ seed: 81, refs: 20, parts: 4, components: 2 }) });
    const c = ingest(db, 'r1', s, { dir: 'p', name: 'c.txt', seed: 82, kind: 'text' });
    expect(db.listPending('summary', 1).map(p => p.contentId)).toEqual([a.contentId]);
    expect(db.listPending('summary', 2).map(p => p.contentId).sort()).toEqual([a.contentId, b.contentId].sort());
    expect(db.getFile(c.fileId)!.state).toBe('indexed');
    db.setStages(b.contentId, [{ stage: 'summary', version: 1, state: 'pending' }]);
    expect(db.listPending('summary', 1).map(p => p.contentId).sort()).toEqual([a.contentId, b.contentId].sort());
    expect(db.listPending('summary', 1, 1)).toHaveLength(1);
  });

  it('reruns only the changed stage and its dependants after a version bump', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const a = ingest(db, 'r1', db.beginScan(), { dir: 'p', name: 'a.brd', seed: 90, kind: 'board', summary: makeBoardSummary({ seed: 90, refs: 20, parts: 4, components: 2 }), stages: true });
    const stages = (): Record<string, string> => Object.fromEntries((db.connection.prepare('SELECT stage, state FROM stage').all() as { stage: string; state: string }[]).map(r => [r.stage, r.state]));
    expect(stages()).toMatchObject({ sniff: 'done', summary: 'done', knowledge: 'done', group: 'done' });
    expect(db.bumpStageVersion('knowledge', 2)).toMatchObject({ from: 0, to: 2, invalidated: 1 });
    expect(stages()).toMatchObject({ sniff: 'done', summary: 'done', knowledge: 'done', group: 'pending' });
    expect(db.stageVersion('knowledge')).toBe(2);
    expect(db.bumpStageVersion('knowledge', 1)).toBeUndefined();
    expect(db.listPending('knowledge', 2).map(p => p.contentId)).toEqual([a.contentId]);
  });
});

describe('garbage and removal', () => {
  it('removing a root removes its files, contents, terms, groups and index rows and bumps the epoch', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one'), syntheticRoot('r2', '/synthetic/two')]);
    const s = db.beginScan();
    const a = ingest(db, 'r1', s, { dir: 'a', name: 'a.brd', seed: 100, kind: 'board', summary: makeBoardSummary({ seed: 100, refs: 20, parts: 6, components: 3 }) });
    const b = ingest(db, 'r2', s, { dir: 'b', name: 'b.brd', seed: 101, kind: 'board', summary: makeBoardSummary({ seed: 101, refs: 20, parts: 6, components: 3 }) });
    db.putGroup(groupOf('gA', 'A', [{ contentId: a.contentId, role: 'board' }]));
    db.putGroup(groupOf('gB', 'B', [{ contentId: b.contentId, role: 'board' }]));
    const epoch = db.epoch;
    const removal = db.removeRoot('r1')!;
    expect(removal).toMatchObject({ files: 1, contents: 1, groups: 1 });
    expect(db.listRoots().map(r => r.id)).toEqual(['r2']);
    expect(db.getGroup('gA')).toBeUndefined();
    expect(db.getGroup('gB')).toBeDefined();
    expect(count(db, 'board')).toBe(1);
    expect(count(db, 'name_fts_docsize')).toBe(1);
    expect(count(db, 'dir')).toBe(2);
    expect(Number((db.connection.prepare('SELECT count(*) AS n FROM term t WHERE NOT EXISTS (SELECT 1 FROM posting p WHERE p.term_id = t.id)').get() as { n: number }).n)).toBe(0);
    expect(db.epoch).toBe(epoch + 1);
    expect(db.removeRoot('r1')).toBeUndefined();
  });

  it('finishes a removal a crash left half done', () => {
    const { db, path } = fileDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    ingest(db, 'r1', db.beginScan(), { dir: 'a', name: 'a.brd', seed: 110, kind: 'board' });
    db.connection.exec("UPDATE root SET state = 'removing'");
    db.abandon();
    const again = LibraryDb.open({ path, ids: sequentialIds() });
    open.push(again);
    expect(again.report.pendingRemovals).toEqual(['r1']);
    expect(again.listRoots()).toEqual([]);
    expect(again.finishPendingRemovals()).toEqual(['r1']);
    expect(again.counts()).toMatchObject({ roots: 0, files: 0, contents: 0 });
  });

  it('removes a file with the content nothing else references', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s = db.beginScan();
    const a = ingest(db, 'r1', s, { dir: 'a', name: 'x.pdf', seed: 120, kind: 'pdf', summary: makeDocumentSummary({ seed: 120, pages: 4, parts: 5, rails: 2 }) });
    ingest(db, 'r1', s, { dir: 'a', name: 'y.brd', seed: 121, kind: 'board' });
    const s2 = db.beginScan();
    db.upsertFiles('r1', s2, [{ dir: 'a', name: 'y.brd', size: 1121, mtimeMs: 1_700_000_000_121 }]);
    db.markMissing('r1', s2, 1);
    expect(db.removeMissingNow('r1')).toBe(1);
    expect(db.getFile(a.fileId)).toBeUndefined();
    expect(count(db, 'document')).toBe(0);
    expect(count(db, 'posting')).toBe(0);
    expect(count(db, 'term')).toBe(0);
  });

  it('keeps the quick-key lookup for a link made with the same bytes', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const [n] = db.upsertFiles('r1', db.beginScan(), [{ dir: 'a', name: 'x.brd', size: 10, mtimeMs: 1 }]);
    const first = db.linkContent([{ fileId: n.id!, quick: quickKey(1), size: 10 }])[0];
    const again = db.linkContent([{ fileId: n.id!, quick: quickKey(1), size: 10 }])[0];
    expect(again).toEqual({ contentId: first.contentId, created: false });
    expect(db.linkContent([{ fileId: n.id!, quick: new Uint8Array(15), size: 10 }, { fileId: 'nope', quick: quickKey(1), size: 10 }, { fileId: n.id!, quick: quickKey(1), size: 10, sha256: 'zz' }]).map(r => r.contentId)).toEqual([null, null, null]);
  });
});
