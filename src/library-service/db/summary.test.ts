import { afterEach, describe, expect, it } from 'vitest';
import type { PartTerm } from '../../lib/library/model';
import { LibraryDb, sequentialIds } from './index';
import { ingest, makeBoardSummary, makeDocumentSummary, syntheticRoot } from './synthetic';

const open: LibraryDb[] = [];
afterEach(() => { for (const db of open.splice(0)) if (db.isOpen) db.close(); });
const memoryDb = (): LibraryDb => { const db = LibraryDb.open({ path: ':memory:', ids: sequentialIds() }); open.push(db); return db; };
const count = (db: LibraryDb, sql: string): number => Number((db.connection.prepare(sql).get() as { n: number }).n);

const term = (norm: string, extra: Partial<PartTerm> = {}): PartTerm => ({ norm, tier: 'known', source: 'header', refs: [], additionalRefs: 0, pages: [], ...extra });

describe('board summaries', () => {
  it('stores a summary and reads back the same facts', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const summary = makeBoardSummary({ seed: 5, refs: 300, parts: 20, components: 12, rails: 6, passives: 9, title: 'Synthetic main board' });
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'b', name: 'main.brd', seed: 5, kind: 'board', summary });
    const back = db.boardSummary(f.contentId)!;
    expect(back.kind).toBe('board');
    expect(back.refs).toEqual(summary.refs);
    expect(back.minhash).toEqual(summary.minhash);
    expect(back.fingerprint).toBe(summary.fingerprint);
    expect(back.fingerprintVersion).toBe(1);
    expect(back.components).toEqual(summary.components);
    expect(back.passives).toEqual(summary.passives);
    expect(back.rails).toEqual([...summary.rails].map(r => r.toUpperCase()).sort());
    expect(back.identity.title).toBe('Synthetic main board');
    expect(back.identity.identifiers.map(i => i.norm)).toEqual(summary.identity.identifiers.map(i => i.norm));
    const byNorm = new Map(back.terms.map(t => [t.norm, t]));
    for (const t of summary.terms) {
      const got = byNorm.get(t.norm)!;
      expect(got.tier).toBe(t.tier);
      expect(got.refs).toEqual(t.refs);
      expect(got.additionalRefs).toBe(t.additionalRefs);
      expect(got.base).toBe(t.base);
    }
    expect(db.refsOf(f.contentId)).toEqual(summary.refs);
    expect(db.getFile(f.fileId)).toMatchObject({ state: 'indexed' });
  });

  it('replaces the previous outputs of a content when it is summarised again', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'b', name: 'main.brd', seed: 6, kind: 'board', summary: makeBoardSummary({ seed: 6, refs: 50, parts: 10, components: 5 }) });
    const before = count(db, 'SELECT count(*) AS n FROM posting');
    const next = makeBoardSummary({ seed: 6, refs: 50, parts: 3, components: 2, rails: 1 });
    expect(db.commitSummary({ contentId: f.contentId, summary: next, extractorVersion: 2 })).toMatchObject({ ok: true, postings: 4 });
    expect(count(db, 'SELECT count(*) AS n FROM posting')).toBeLessThan(before);
    expect(count(db, 'SELECT count(*) AS n FROM board')).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM stage WHERE stage = 'summary' AND version = 2")).toBe(1);
    // Terms nothing references any more are collected.
    db.collectGarbage();
    expect(count(db, 'SELECT count(*) AS n FROM term')).toBe(4);
  });

  it('rejects a summary with a malformed fingerprint or minhash and stores nothing', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'b', name: 'main.brd', seed: 7, kind: 'board' });
    const good = makeBoardSummary({ seed: 7, refs: 20, parts: 3, components: 2 });
    expect(db.commitSummary({ contentId: f.contentId, summary: { ...good, fingerprint: 'nothex' }, extractorVersion: 1 })).toMatchObject({ ok: false, reason: 'invalid-summary' });
    expect(db.commitSummary({ contentId: f.contentId, summary: { ...good, minhash: good.minhash.slice(1) }, extractorVersion: 1 })).toMatchObject({ ok: false, reason: 'invalid-summary' });
    expect(db.commitSummary({ contentId: 'missing', summary: good, extractorVersion: 1 })).toMatchObject({ ok: false, reason: 'unknown-content' });
    expect(count(db, 'SELECT count(*) AS n FROM board')).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM stage WHERE stage = 'summary'")).toBe(0);
  });

  it('keeps at most eight reference labels per posting and counts the rest', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const refs = Array.from({ length: 20 }, (_, i) => `U${i + 1}`);
    const summary = makeBoardSummary({ seed: 8, refList: refs, terms: [term('ABC1234', { refs, additionalRefs: 3 })], railNames: [] });
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'b', name: 'x.brd', seed: 8, kind: 'board', summary });
    const back = db.boardSummary(f.contentId)!;
    expect(back.terms).toHaveLength(1);
    expect(back.terms[0].refs).toEqual(refs.slice(0, 8));
    expect(back.terms[0].additionalRefs).toBe(3 + 12);
  });

  it('merges repeated terms and keeps the most reliable tier', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const summary = makeBoardSummary({ seed: 9, refList: ['U1', 'U2'], railNames: [], terms: [term('XYZ99', { tier: 'text', refs: ['U1'] }), term('XYZ99', { tier: 'known', refs: ['U2'] })] });
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'b', name: 'x.brd', seed: 9, kind: 'board', summary });
    const back = db.boardSummary(f.contentId)!;
    expect(back.terms).toHaveLength(1);
    expect(back.terms[0]).toMatchObject({ tier: 'known', refs: ['U1', 'U2'] });
  });

  it('applies the posting policy: the most reliable tiers survive and the summary says it was truncated', () => {
    const db = LibraryDb.open({ path: ':memory:', ids: sequentialIds() });
    open.push(db);
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    // The policy limit is large; shrink it for this content through the test seam on the connection's context.
    const terms: PartTerm[] = [
      ...Array.from({ length: 30 }, (_, i) => term(`TXT${i}`, { tier: 'text' })),
      ...Array.from({ length: 5 }, (_, i) => term(`KNOWN${i}`, { tier: 'known' })),
    ];
    const summary = makeBoardSummary({ seed: 10, refList: ['U1'], railNames: [], terms });
    (db as unknown as { ctx: { policy: { maxPostingsPerContent: number } } }).ctx.policy = { maxPostingsPerContent: 12 };
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'b', name: 'x.brd', seed: 10, kind: 'board', summary });
    const back = db.boardSummary(f.contentId)!;
    expect(back.terms).toHaveLength(12);
    expect(back.terms.filter(t => t.tier === 'known')).toHaveLength(5);
    expect(back.truncated).toContain('terms');
  });
});

describe('document summaries', () => {
  it('stores page hashes, roles and per-term pages', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const summary = makeDocumentSummary({ seed: 20, pages: 60, role: 'schematic', parts: 15, rails: 4, refs: 120 });
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'd', name: 'sch.pdf', seed: 20, kind: 'schematic', summary });
    const back = db.documentSummary(f.contentId)!;
    expect(back).toMatchObject({ kind: 'document', pages: 60, role: 'schematic', textLayer: 'yes', ocr: 'none', producer: 'Synthetic Producer 1.0' });
    expect(back.pageHashes).toEqual(summary.pageHashes);
    expect(back.refs).toEqual(summary.refs);
    const pages = new Map(back.terms.map(t => [t.norm, t.pages]));
    for (const t of summary.terms) expect(pages.get(t.norm)).toEqual([...new Set(t.pages)].sort((a, b) => a - b));
    expect(db.getFile(f.fileId)).toMatchObject({ role: 'schematic' });
  });

  it('stores a scanned document without terms and an image with its size only', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const s = db.beginScan();
    const scan = ingest(db, 'r1', s, { dir: 'd', name: 'scan.pdf', seed: 21, kind: 'pdf', summary: makeDocumentSummary({ seed: 21, pages: 4, textLayer: 'no' }) });
    expect(db.documentSummary(scan.contentId)).toMatchObject({ textLayer: 'no', ocr: 'triage', terms: [], refs: [] });
    const img = ingest(db, 'r1', s, { dir: 'd', name: 'photo.png', seed: 22, kind: 'image', summary: { kind: 'image', width: 800, height: 600 } });
    expect(db.imageSummary(img.contentId)).toEqual({ kind: 'image', width: 800, height: 600 });
    expect(db.getFile(img.fileId)).toMatchObject({ role: 'photo', state: 'indexed' });
  });

  it('keeps the document minhash apart from the summary', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'd', name: 'x.pdf', seed: 23, kind: 'pdf', summary: makeDocumentSummary({ seed: 23, pages: 3, parts: 3, rails: 0 }) });
    expect(db.setDocumentMinhash(f.contentId, Array.from({ length: 128 }, (_, i) => i))).toBe(true);
    expect(db.setDocumentMinhash(f.contentId, [1, 2, 3])).toBe(false);
    expect(Number((db.connection.prepare('SELECT length(refs_minhash) AS n FROM document').get() as { n: number }).n)).toBe(512);
  });
});

describe('full text', () => {
  const page = (n: number, body: string): { page: number; body: string } => ({ page: n, body });

  it('does not return a disabled-root copy for a shared full-text-only hit', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('on', '/synthetic/on', { options: { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 } }), syntheticRoot('off', '/synthetic/off')]);
    const scan = db.beginScan();
    const a = ingest(db, 'on', scan, { dir: '', name: 'original.pdf', seed: 620, kind: 'pdf', sha256: true,
      summary: makeDocumentSummary({ seed: 620, pages: 1, parts: 2, fullText: [page(1, 'consentedtext')] }) });
    ingest(db, 'off', scan, { dir: '', name: 'copy.pdf', seed: 620, kind: 'pdf', sha256: true });
    const request = { text: 'consentedtext', mode: 'files' as const, filters: { roots: ['on', 'off'] }, sort: 'label' as const, direction: 'asc' as const, limit: 10 };
    expect(db.query(request).rows.map(r => r.id)).toEqual([a.fileId]);
    expect(db.query({ ...request, filters: { roots: ['off'] } }).rows).toEqual([]);
  });

  it.each(['remove', 'change'] as const)('purges shared text when the last opted-in file is removed by %s', operation => {
    const db = memoryDb();
    const on = { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 };
    db.syncRoots([syntheticRoot('on', '/synthetic/on', { options: on }), syntheticRoot('off', '/synthetic/off')]);
    const scan = db.beginScan();
    const a = ingest(db, 'on', scan, { dir: '', name: 'shared.pdf', seed: 630, kind: 'pdf', sha256: true,
      summary: makeDocumentSummary({ seed: 630, pages: 1, parts: 2, fullText: [page(1, 'consentedtext')] }) });
    const b = ingest(db, 'off', scan, { dir: '', name: 'copy.pdf', seed: 630, kind: 'pdf', sha256: true });
    expect(a.contentId).toBe(b.contentId);
    if (operation === 'remove') db.removeRoot('on');
    else db.upsertFiles('on', db.beginScan(), [{ dir: '', name: 'shared.pdf', size: 9999, mtimeMs: 1 }]);
    expect(db.getFile(b.fileId)!.contentId).toBe(b.contentId);
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(0);
    expect(db.checkIntegrity('full').ok).toBe(true);
  });

  it('is off by default: page text is refused and the content stays out of the index', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one')]);
    const summary = makeDocumentSummary({ seed: 30, pages: 3, parts: 2, rails: 0, fullText: [page(1, 'zorbulator calibration'), page(2, 'more text')] });
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'd', name: 'doc.pdf', seed: 30, kind: 'pdf', summary });
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM stage WHERE stage = 'full-text' AND state = 'skipped'")).toBe(1);
    expect(db.query({ text: 'zorbulator', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 10 }).rows).toEqual([]);
    expect(f.contentId).toBeTruthy();
  });

  it('stores page text only for a content reachable from a root that turned it on, and filters hits by root', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('on', '/synthetic/on', { options: { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 } }), syntheticRoot('off', '/synthetic/off')]);
    const s = db.beginScan();
    const a = ingest(db, 'on', s, { dir: 'd', name: 'a.pdf', seed: 31, kind: 'pdf', summary: makeDocumentSummary({ seed: 31, pages: 3, parts: 2, rails: 0, fullText: [page(1, 'zorbulator calibration'), page(3, 'zorbulator appendix')] }) });
    ingest(db, 'off', s, { dir: 'd', name: 'b.pdf', seed: 32, kind: 'pdf', summary: makeDocumentSummary({ seed: 32, pages: 3, parts: 2, rails: 0, fullText: [page(1, 'zorbulator elsewhere')] }) });
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(2);
    const all = db.query({ text: 'zorbulator', mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 10 });
    expect(all.rows.map(r => r.label)).toEqual(['a.pdf']);
    expect(all.rows[0].matches[0]).toMatchObject({ tier: 'text', pages: [1, 3], contentId: a.contentId });
    expect(db.query({ text: 'zorbulator', mode: 'files', filters: { roots: ['off'] }, sort: 'label', direction: 'asc', limit: 10 }).rows).toEqual([]);
    expect(db.query({ text: 'zorbulator', mode: 'files', filters: { roots: ['on'] }, sort: 'label', direction: 'asc', limit: 10 }).rows).toHaveLength(1);
  });

  it('purges the text when the last opted-in root turns it off, and not before', () => {
    const db = memoryDb();
    const on = { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 }, off = { ...on, fullText: false };
    db.syncRoots([syntheticRoot('r1', '/synthetic/one', { options: on }), syntheticRoot('r2', '/synthetic/two', { options: on })]);
    const s = db.beginScan();
    // The same bytes reachable from both roots (hash confirmed) share one content.
    const a = ingest(db, 'r1', s, { dir: 'd', name: 'shared.pdf', seed: 33, kind: 'pdf', sha256: true, summary: makeDocumentSummary({ seed: 33, pages: 3, parts: 2, rails: 0, fullText: [page(1, 'quasar index')] }) });
    const b = ingest(db, 'r2', s, { dir: 'e', name: 'shared-copy.pdf', seed: 33, kind: 'pdf', sha256: true });
    expect(b.contentId).toBe(a.contentId);
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(1);
    expect(db.setRootOptions('r1', off)).toEqual({ purgedContents: 0, pendingContents: 0 });
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(1);
    expect(db.setRootOptions('r2', off)).toEqual({ purgedContents: 1, pendingContents: 0 });
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM stage WHERE stage = 'full-text'")).toBe(0);
    // Turning it on again asks for the documents to be read again; nothing is stored until a result arrives.
    expect(db.setRootOptions('r1', on)).toEqual({ purgedContents: 0, pendingContents: 1 });
    expect(db.listPending('full-text', 1).map(p => p.contentId)).toEqual([a.contentId]);
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(0);
  });

  it('removes a root and its page text in one go', () => {
    const db = memoryDb();
    const on = { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 };
    db.syncRoots([syntheticRoot('r1', '/synthetic/one', { options: on })]);
    ingest(db, 'r1', db.beginScan(), { dir: 'd', name: 'a.pdf', seed: 34, kind: 'pdf', summary: makeDocumentSummary({ seed: 34, pages: 5, parts: 2, rails: 0, fullText: [page(1, 'one'), page(2, 'two'), page(5, 'five')] }) });
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(3);
    db.removeRoot('r1');
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(0);
  });

  it('keeps pages 1 to 2000 only and addresses rows as content id times 4096 plus the page', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one', { options: { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 } })]);
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'd', name: 'a.pdf', seed: 35, kind: 'pdf', summary: makeDocumentSummary({ seed: 35, pages: 2000, parts: 1, rails: 0, fullText: [page(0, 'zero'), page(1, 'first'), page(2000, 'last'), page(2001, 'beyond'), page(1.5, 'fraction')] }) });
    const rows = (db.connection.prepare('SELECT id FROM text_fts_docsize ORDER BY id').all() as { id: number }[]).map(r => r.id);
    const content = Number((db.connection.prepare('SELECT id FROM content WHERE public_id = ?').get(f.contentId) as { id: number }).id);
    expect(rows).toEqual([content * 4096 + 1, content * 4096 + 2000]);
  });

  it('replaces the text of a content that is read again', () => {
    const db = memoryDb();
    db.syncRoots([syntheticRoot('r1', '/synthetic/one', { options: { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 } })]);
    const f = ingest(db, 'r1', db.beginScan(), { dir: 'd', name: 'a.pdf', seed: 36, kind: 'pdf', summary: makeDocumentSummary({ seed: 36, pages: 5, parts: 1, rails: 0, fullText: [page(1, 'alpha'), page(2, 'beta'), page(3, 'gamma')] }) });
    db.commitSummary({ contentId: f.contentId, summary: makeDocumentSummary({ seed: 36, pages: 5, parts: 1, rails: 0, fullText: [page(2, 'delta')] }), extractorVersion: 2 });
    expect(count(db, 'SELECT count(*) AS n FROM text_fts_docsize')).toBe(1);
    const q = (text: string): number => db.query({ text, mode: 'files', filters: {}, sort: 'label', direction: 'asc', limit: 10 }).rows.length;
    expect([q('alpha'), q('beta'), q('delta')]).toEqual([0, 0, 1]);
  });
});
