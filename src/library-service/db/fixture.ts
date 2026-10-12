/**
 * A small hand-made library used by the query tests: two roots, two board groups (a laptop and a tablet), duplicate files, problem files
 * and an archive. All names, part numbers and identifiers are invented.
 */
import type { PartTerm } from '../../lib/library/model';
import { LibraryDb, sequentialIds } from './index';
import { groupOf, ingest, makeBoardSummary, makeDocumentSummary, sha256Of, syntheticRoot, type Ingested } from './synthetic';

const t = (norm: string, extra: Partial<PartTerm> = {}): PartTerm => ({ norm, tier: 'known', source: 'header', refs: [], additionalRefs: 0, pages: [], ...extra });
const idf = (kind: 'board-number' | 'vendor' | 'device-type' | 'model', raw: string, source: 'header' | 'title-block' | 'folder' | 'name' = 'header') => ({ kind, raw, norm: raw.toUpperCase(), source, confidence: 90 });

export interface Fixture {
  db: LibraryDb;
  scan: number;
  f: Record<'rev1' | 'copy' | 'rev2' | 'schematic' | 'datasheet' | 'photo' | 'tb200' | 'service' | 'notes' | 'damaged' | 'unknown' | 'locked' | 'encrypted' | 'zip' | 'spare' | 'linked', Ingested>;
}

export function buildFixture(options: { now?: () => number } = {}): Fixture {
  const db = LibraryDb.open({ path: ':memory:', ids: sequentialIds(), ...(options.now ? { now: options.now } : {}) });
  const on = { fullText: true, watch: false, exclusions: [], rescanMinutes: 0 };
  db.syncRoots([syntheticRoot('rootA', '/synthetic/a'), syntheticRoot('rootB', '/synthetic/b', { options: on })]);
  const scan = db.beginScan();
  const lx = (seed: number, extraTerms: PartTerm[] = []) => makeBoardSummary({
    seed, refList: ['C1', 'C2', 'R1', 'U7000', 'U7001'], railNames: ['+3V3_S5', '+5V_S0'],
    terms: [t('TPS51225RUKR', { base: 'TPS51225', family: 'buck-ctl', refs: ['U7000', 'U7001'] }), t('BQ24715RGRR', { base: 'BQ24715', family: 'charger' }), t('MAX98357', { tier: 'text' }), ...extraTerms],
    identifiers: [idf('board-number', 'LX-Z123'), idf('vendor', 'Aurelia'), idf('device-type', 'laptop')],
  });
  const f = {} as Fixture['f'];
  f.rev1 = ingest(db, 'rootA', scan, { dir: 'laptops/aurelia', name: 'lx100_rev1.brd', seed: 101, kind: 'board', sha256: true, size: 5000, summary: lx(101) });
  f.copy = ingest(db, 'rootA', scan, { dir: 'copies', name: 'lx100_rev1_copy.brd', seed: 101, kind: 'board', sha256: true, size: 5000 });
  f.rev2 = ingest(db, 'rootA', scan, { dir: 'laptops/aurelia', name: 'lx100_rev2.brd', seed: 102, kind: 'board', size: 5100, summary: lx(102, [t('NEWPART77')]) });
  f.schematic = ingest(db, 'rootA', scan, { dir: 'laptops/aurelia', name: 'lx100_schematic.pdf', seed: 103, kind: 'schematic', summary: makeDocumentSummary({
    seed: 103, pages: 40, role: 'schematic', refList: ['U7000', 'U7001', 'U7002'], railNames: ['+3V3_S5'],
    terms: [t('TPS51225RUKR', { base: 'TPS51225', family: 'buck-ctl', pages: [3, 4], source: 'schematic', refs: ['U7000'] }), t('TPS62130', { tier: 'near-ref', source: 'schematic', pages: [9] })],
    identifiers: [idf('board-number', 'LX-Z123', 'title-block')],
  }) });
  f.datasheet = ingest(db, 'rootB', scan, { dir: 'datasheets', name: 'tps51225.pdf', seed: 104, kind: 'pdf', summary: makeDocumentSummary({
    seed: 104, pages: 30, role: 'datasheet', refList: [], railNames: [], terms: [t('TPS51225', { source: 'schematic', pages: [1] })], identifiers: [],
    fullText: [{ page: 1, body: 'Synchronous step down controller with 3.3 V and 5 V LDOs' }, { page: 2, body: 'Typical application circuit and layout guidelines' }],
  }) });
  f.photo = ingest(db, 'rootB', scan, { dir: 'photos', name: 'lx100_top.jpg', seed: 601, kind: 'image', summary: { kind: 'image', width: 4000, height: 3000 } });
  f.tb200 = ingest(db, 'rootA', scan, { dir: 'tablets', name: 'tb200.brd', seed: 201, kind: 'board', summary: makeBoardSummary({
    seed: 201, refList: ['U100', 'C5'], railNames: ['+5V_S0'], terms: [t('BQ24715RGRR', { tier: 'near-ref', base: 'BQ24715' }), t('TPS65982', { family: 'usb-pd' })],
    identifiers: [idf('board-number', 'TB-200'), idf('vendor', 'Bexley'), idf('device-type', 'tablet')],
  }) });
  f.service = ingest(db, 'rootB', scan, { dir: 'tablets', name: 'tb200_service.pdf', seed: 202, kind: 'pdf', summary: makeDocumentSummary({
    seed: 202, pages: 80, role: 'service-manual', refList: [], railNames: [], terms: [t('TPS65982', { family: 'usb-pd', source: 'schematic', pages: [12, 13] })], identifiers: [],
  }) });
  f.notes = ingest(db, 'rootA', scan, { dir: 'misc', name: 'loose_notes.pdf', seed: 301, kind: 'pdf', summary: makeDocumentSummary({
    seed: 301, pages: 2, role: 'other', refList: [], railNames: [], terms: [t('MAX98357', { tier: 'text', source: 'schematic', pages: [1] })], identifiers: [],
  }) });
  f.damaged = ingest(db, 'rootA', scan, { dir: 'broken', name: 'damaged.brd', seed: 401, kind: 'board', sniff: { problem: 'damaged' } });
  f.unknown = ingest(db, 'rootA', scan, { dir: 'broken', name: 'unknown.bin', seed: 402, kind: 'unknown' });
  f.locked = ingest(db, 'rootA', scan, { dir: 'broken', name: 'locked.zip', seed: 403, kind: 'archive', walkerState: 'locked' });
  f.encrypted = ingest(db, 'rootA', scan, { dir: 'broken', name: 'secret.fz', seed: 404, kind: 'board', sniff: { needsKey: 'fz' } });
  f.linked = ingest(db, 'rootA', scan, { dir: 'broken', name: 'shortcut.brd', seed: 405, kind: 'board', walkerState: 'link' });
  f.zip = ingest(db, 'rootA', scan, { dir: 'zips', name: 'pack.zip', seed: 501, kind: 'archive' });
  f.spare = ingest(db, 'rootA', scan, { dir: '', name: '', seed: 502, kind: 'board', container: { fileId: f.zip.fileId, entryPath: 'inside/spare.brd' }, summary: makeBoardSummary({
    seed: 502, refList: ['U1'], railNames: [], terms: [t('SPARE0001')], identifiers: [],
  }) });

  db.putGroup(groupOf('g1', 'Aurelia LX100', [
    { contentId: f.rev1.contentId, role: 'board' }, { contentId: f.rev2.contentId, role: 'board' }, { contentId: f.schematic.contentId, role: 'schematic' },
    { contentId: f.datasheet.contentId, role: 'datasheet' }, { contentId: f.photo.contentId, role: 'photo' },
  ], { boardNumber: 'LX-Z123', vendor: 'Aurelia', model: 'LX100', deviceType: 'laptop', updated: 3000, tags: ['bench'] }));
  db.putGroup(groupOf('g2', 'Bexley TB200', [{ contentId: f.tb200.contentId, role: 'board' }, { contentId: f.service.contentId, role: 'service-manual' }],
    { boardNumber: 'TB-200', vendor: 'Bexley', model: 'TB200', deviceType: 'tablet', updated: 1000 }));
  db.putRevisions('g1', [
    { contentId: f.rev1.contentId, label: 'REV 1', scheme: 'rev-number', order: 1, basis: 'token' },
    { contentId: f.rev2.contentId, label: 'REV 2', scheme: 'rev-number', order: 2, basis: 'token', addedParts: 1, removedParts: 0, changedValues: 0 },
  ]);
  db.putDuplicateSet({ id: 'd1', kind: 'identical', fileIds: [f.rev1.fileId, f.copy.fileId], contentIds: [f.rev1.contentId], evidence: [{ kind: 'fingerprint', a: f.rev1.contentId, b: f.copy.contentId, strength: 'strong', score: 1 }] });
  db.putSuggestions([{ a: f.rev1.contentId, b: f.tb200.contentId, kind: 'layout-related', score: 0.4, evidence: [] }]);
  return { db, scan, f };
}

export const SHA_REV1 = sha256Of(101);
