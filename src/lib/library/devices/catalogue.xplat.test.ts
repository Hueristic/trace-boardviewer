/**
 * The device catalogue over the synthetic fixture plan, for win32, darwin and linux, on any host. The file system is an in-memory
 * port built from the plan with the same collision rule the platform uses (generator survivingEntries), so the results do not
 * depend on the machine that runs the tests. Real host behaviour is in folder-map.xplat.test.ts.
 *
 * KNOWN DEFECT / KNOWN GAP tests are `it.fails`: green while the behaviour differs from the expectation, red once it is fixed.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildDeviceCatalogue, type CatalogueInput, type CatalogueResult } from './catalogue';
import { confirmCaseCollision, fileRefOf, parseCorrections, serializeCorrections, type Correction, type CorrectionDocument } from './corrections';
import type { DirectoryPort } from './folder-map';
import type { BoardAnchor } from './match';
import type { DevicePlatform } from './paths';

interface Truth {
  kind: string;
  boardCode: string | null;
  codes: string[];
  revision: string | null;
  aliasesMustInclude: string[];
  sidecar: boolean;
  hidden: boolean;
}
interface PlanEntry { scenario: string; path: string; content: string; index: number; truth: Truth }
interface FixtureGenerator {
  planFixtures(seed: string): { seed: string; entries: PlanEntry[] };
  survivingEntries(plan: { entries: PlanEntry[] }, platform: DevicePlatform): PlanEntry[];
  memoryTree(entries: PlanEntry[]): DirectoryPort;
}

const require = createRequire(import.meta.url);
const generator = require('../../../../scripts/gen-device-fixtures.cjs') as FixtureGenerator;
const PLATFORMS: readonly DevicePlatform[] = ['win32', 'darwin', 'linux'];
const ROOT = 'lib';

const anchors: BoardAnchor[] = [
  { id: 'anchor-mb-q731', boardCode: 'MB-Q731', revision: { normalized: '2', scheme: 'number', rank: [2] }, aliases: [] },
  { id: 'anchor-bd-k1402', boardCode: 'BD-K1402', aliases: [] },
  { id: 'anchor-lb-n77', boardCode: 'LB-N77', aliases: ['agnes'] },
  { id: 'anchor-quarrel', aliases: ['quarrel'] },
];

const plan = generator.planFixtures('1');
const truthByPath = new Map(plan.entries.map(entry => [entry.path, entry.truth] as const));

function survivorsOf(platform: DevicePlatform): PlanEntry[] {
  return generator.survivingEntries(plan, platform);
}

async function run(platform: DevicePlatform, extra: Partial<CatalogueInput> = {}): Promise<{ survivors: PlanEntry[]; result: CatalogueResult }> {
  const survivors = survivorsOf(platform);
  const port = generator.memoryTree(survivors);
  const result = await buildDeviceCatalogue({ platform, roots: [{ rootId: ROOT, port }], anchors, ...extra });
  return { survivors, result };
}

function associationsOf(result: CatalogueResult, path: string, platform: DevicePlatform) {
  const ref = fileRefOf({ rootId: ROOT, path }, platform);
  return result.associations.filter(association => association.filePath === ref);
}

describe.each(PLATFORMS)('catalogue on %s (in-memory tree from the fixture plan)', platform => {
  it('OS and AppleDouble sidecar files (._*, .DS_Store, Thumbs.db, desktop.ini) are not indexed as board files', async () => {
    const { result } = await run(platform);
    expect(result.files.filter(file => truthByPath.get(file.path)?.sidecar === true).map(file => file.path)).toEqual([]);
  });

  it('lists every surviving non-sidecar entry; the sidecars are skipped in the walk with reason "sidecar" and counted', async () => {
    const { survivors, result } = await run(platform);
    expect(result.steps).toEqual({ folderMap: 'ran', nameIdentity: 'ran', biosCandidates: 'ran', matching: 'ran', corrections: 'ran' });
    expect(result.files.map(file => file.path).sort()).toEqual(survivors.filter(entry => !entry.truth.sidecar).map(entry => entry.path).sort());
    const map = result.maps[0].map;
    expect(map?.skipped.filter(item => item.reason === 'sidecar').map(item => item.path).sort()).toEqual(survivors.filter(entry => entry.truth.sidecar).map(entry => entry.path).sort());
    expect(map?.complete).toBe(true);
  });

  it('gives each non-sidecar entry the role and board code its truth says (ambiguous names are checked separately)', async () => {
    const { survivors, result } = await run(platform);
    const byRef = new Map(result.files.map(file => [file.fileRef, file] as const));
    for (const entry of survivors) {
      if (entry.truth.sidecar || entry.truth.codes.length > 1) continue;
      const indexed = byRef.get(fileRefOf({ rootId: ROOT, path: entry.path }, platform));
      expect(indexed, entry.path).toBeDefined();
      expect(indexed?.identity.role, entry.path).toBe(entry.truth.kind);
      expect(indexed?.identity.boardCode, entry.path).toBe(entry.truth.boardCode ?? undefined);
      if (entry.truth.revision !== null) expect(indexed?.identity.revision?.normalized, entry.path).toBe(entry.truth.revision);
    }
  });

  it('the identity of a file is the same on every platform (files present on all three hosts)', async () => {
    const perPlatform = await Promise.all(PLATFORMS.map(async p => ({ p, result: (await run(p)).result })));
    const byPath = new Map<string, Map<DevicePlatform, unknown>>();
    for (const { p, result } of perPlatform) {
      for (const file of result.files) {
        const entry = byPath.get(file.path) ?? new Map<DevicePlatform, unknown>();
        entry.set(p, file.identity);
        byPath.set(file.path, entry);
      }
    }
    let compared = 0;
    for (const [path, identities] of byPath) {
      if (identities.size !== PLATFORMS.length) continue;
      compared++;
      const [first, ...rest] = PLATFORMS.map(p => identities.get(p));
      for (const other of rest) expect(other, path).toEqual(first);
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('aliases of the entries contain the search keys the truth expects (Latin and accented names)', async () => {
    const { survivors, result } = await run(platform);
    const byRef = new Map(result.files.map(file => [file.fileRef, file] as const));
    for (const entry of survivors) {
      if (entry.truth.sidecar || entry.truth.aliasesMustInclude.length === 0) continue;
      const indexed = byRef.get(fileRefOf({ rootId: ROOT, path: entry.path }, platform));
      for (const alias of entry.truth.aliasesMustInclude) expect(indexed?.identity.aliases, `${entry.path} alias ${alias}`).toContain(alias);
    }
  });

  it('a board file of MB-Q731 rev 2 is probably linked to the MB-Q731 anchor, by name (multiple matches stay probable)', async () => {
    const { survivors, result } = await run(platform);
    const boards = survivors.filter(entry => !entry.truth.sidecar && entry.truth.kind === 'boardview' && entry.truth.boardCode === 'MB-Q731');
    expect(boards.length).toBeGreaterThanOrEqual(4);
    for (const entry of boards) {
      const links = associationsOf(result, entry.path, platform).filter(association => association.anchorId === 'anchor-mb-q731');
      expect(links, entry.path).toHaveLength(1);
      expect(links[0].state, entry.path).toBe('probable');
      expect(links[0].basis).toBe('names');
    }
  });

  it('firmware candidates of MB-Q731 are linked by name as candidates, and never confirmed', async () => {
    const { result, survivors } = await run(platform);
    for (const entry of survivors.filter(item => ['bios-candidate', 'ec-firmware', 'saved-dump'].includes(item.truth.kind) && item.truth.boardCode === 'MB-Q731')) {
      const links = associationsOf(result, entry.path, platform).filter(association => association.anchorId === 'anchor-mb-q731');
      expect(links[0]?.state, entry.path).toBe('probable');
    }
  });

  it('two revisions of one board in one folder are both probable links (no confirmation, no conflict with an anchor without revision)', async () => {
    const { result } = await run(platform);
    for (const path of ['Tessaly/Mirror/BD-K1402_rev1.brd', 'Tessaly/Mirror/BD-K1402_rev3.brd']) {
      const links = associationsOf(result, path, platform).filter(association => association.anchorId === 'anchor-bd-k1402');
      expect(links, path).toHaveLength(1);
      expect(links[0].state).toBe('probable');
    }
  });

  it('a Cyrillic folder and file name keeps its alias (the Ukrainian locale uses Cyrillic names)', async () => {
    const { result } = await run(platform);
    const file = result.files.find(item => item.path === 'Плата/Кестрел-14/Кестрел-14_rev2.brd');
    expect(file?.identity.aliases).toContain('кестрел');
  });

  it('a board whose name is only a folder alias is a review candidate, never confirmed', async () => {
    const { result } = await run(platform);
    for (const path of ['Quarrel/uncertain/board.brd', 'Quarrel/uncertain/Quarrel-untitled.brd']) {
      const links = associationsOf(result, path, platform).filter(association => association.anchorId === 'anchor-quarrel');
      expect(links, path).toHaveLength(1);
      expect(links[0].state).toBe('review');
      expect(links[0].basis).toBe('alias');
    }
  });

  it('a schematic with no matching anchor, a firmware file with no board and a Cyrillic or Polish name get no association (missing match)', async () => {
    const { result } = await run(platform);
    for (const path of ['Birchfield/Kestrel-14-R2/docs/Kestrel14_R02_schematic.pdf', 'Orphan/MB-Z999_BIOS.bin', 'Плата/Кестрел-14/Кестрел-14_rev2.brd', 'Łódź/Łącznik-7/Łącznik-7.brd']) {
      expect(associationsOf(result, path, platform), path).toEqual([]);
    }
  });

  it('the accented Ágnes name (composed and decomposed spellings, where the host keeps both) is linked to the LB-N77 anchor by name', async () => {
    const { survivors, result } = await run(platform);
    const agnes = survivors.filter(entry => entry.path.startsWith('Ágnes Böngésző/'));
    expect(agnes.length).toBeGreaterThanOrEqual(1);
    for (const entry of agnes) {
      const links = associationsOf(result, entry.path, platform).filter(association => association.anchorId === 'anchor-lb-n77');
      expect(links[0]?.state, entry.path).toBe('probable');
    }
  });

  it('"MB-Q731 vs MB-Q732" names two codes: ambiguous, a review candidate for the anchor of each code, never confirmed or probable (decided D5)', async () => {
    const { result } = await run(platform);
    const path = 'Quarrel/uncertain/MB-Q731 vs MB-Q732.brd';
    expect(result.files.find(item => item.path === path)?.identity.ambiguousCodes).toEqual(['MB-Q731', 'MB-Q732']);
    const links = associationsOf(result, path, platform).filter(association => association.anchorId === 'anchor-mb-q731');
    expect(links).toHaveLength(1);
    expect(links[0].state).toBe('review');
    expect(links[0].basis).toBe('ambiguous');
    expect(associationsOf(result, path, platform).filter(association => association.state !== 'review')).toEqual([]);
  });

  it('a user link settles the ambiguous name (a durable manual correction): it is confirmed by the user, and only that anchor', async () => {
    const path = 'Quarrel/uncertain/MB-Q731 vs MB-Q732.brd';
    const { result } = await run(platform, { corrections: [{ op: 'link', file: { rootId: ROOT, path }, anchorId: 'anchor-mb-q731' }] });
    const links = associationsOf(result, path, platform);
    expect(links.find(association => association.anchorId === 'anchor-mb-q731')?.state).toBe('confirmed');
    expect(links.find(association => association.anchorId === 'anchor-mb-q731')?.basis).toBe('user');
  });

  it('the steps can be switched off one by one; a skipped step does not run and its output stays empty', async () => {
    const noMap = await run(platform, { steps: { folderMap: false } });
    expect(noMap.result.steps.folderMap).toBe('skipped');
    expect(noMap.result.files).toEqual([]);
    expect(noMap.result.associations).toEqual([]);
    const noBios = await run(platform, { steps: { biosCandidates: false } });
    expect(noBios.result.excludedFirmwareCount).toBe(4);
    expect(noBios.result.files.some(file => ['bios-candidate', 'ec-firmware', 'saved-dump'].includes(file.identity.role))).toBe(false);
    const noMatch = await run(platform, { steps: { matching: false } });
    expect(noMatch.result.steps.matching).toBe('skipped');
    expect(noMatch.result.associations).toEqual([]);
  });

  it('a user link confirms a board with no code in its name, when no code conflict exists', async () => {
    const { result } = await run(platform, { corrections: [{ op: 'link', file: { rootId: ROOT, path: 'Quarrel/uncertain/board.brd' }, anchorId: 'anchor-mb-q731' }] });
    const links = associationsOf(result, 'Quarrel/uncertain/board.brd', platform).filter(association => association.anchorId === 'anchor-mb-q731');
    expect(links).toHaveLength(1);
    expect(links[0].state).toBe('confirmed');
    expect(links[0].basis).toBe('user');
  });

  it('an unlink removes the name link of that one file only', async () => {
    const { result } = await run(platform, { corrections: [{ op: 'unlink', file: { rootId: ROOT, path: 'Birchfield/Kestrel-14-R2/MB-Q731_rev2.brd' }, anchorId: 'anchor-mb-q731' }] });
    expect(associationsOf(result, 'Birchfield/Kestrel-14-R2/MB-Q731_rev2.brd', platform).filter(association => association.anchorId === 'anchor-mb-q731')).toEqual([]);
    expect(associationsOf(result, 'Birchfield/Kestrel-14-R2/MB Q731 rev 2 copy.brd', platform).filter(association => association.anchorId === 'anchor-mb-q731')).toHaveLength(1);
  });

  it('a role correction changes the role of the file it names', async () => {
    const { result } = await run(platform, { corrections: [{ op: 'role', file: { rootId: ROOT, path: 'Alder/Orion-5/MB-Q731_rev2_BIOS.bin' }, role: 'other' }] });
    const file = result.files.find(item => item.path === 'Alder/Orion-5/MB-Q731_rev2_BIOS.bin');
    expect(file?.identity.role).toBe('other');
    expect(file?.identity.roleBasis).toBe('correction');
  });

  it('a link to a path that is not in the scan is reported as a missing target, never moved to another file', async () => {
    const { result } = await run(platform, { corrections: [{ op: 'link', file: { rootId: ROOT, path: 'Nowhere/absent.brd' }, anchorId: 'anchor-mb-q731' }] });
    expect(result.missingTargets).toHaveLength(1);
    expect(result.associations.filter(association => association.filePath.includes('absent'))).toEqual([]);
  });
});

describe('case of a user link path (depends on the platform rule, by design)', () => {
  const link: Correction = { op: 'link', file: { rootId: ROOT, path: 'quarrel/uncertain/BOARD.brd' }, anchorId: 'anchor-mb-q731' };

  it('win32 folds case, so the link finds board.brd', async () => {
    const { result } = await run('win32', { corrections: [link] });
    expect(result.missingTargets).toEqual([]);
  });

  // Decided D8: darwin keys stay exact. The link is not redirected to board.brd, and it is not a plain missing target either:
  // it is a case-collision that needs a manual confirmation of the candidate path.
  it('darwin keys are exact: the BOARD.brd link is not applied; board.brd is listed as a case-collision needing a manual confirmation (decided D8)', async () => {
    const { result } = await run('darwin', { corrections: [link] });
    expect(result.missingTargets).toEqual([]);
    expect(result.needsManual).toEqual([{ state: 'case-collision', correction: link, candidatePaths: ['Quarrel/uncertain/board.brd'] }]);
    expect(associationsOf(result, 'Quarrel/uncertain/board.brd', 'darwin').filter(association => association.anchorId === 'anchor-mb-q731')).toEqual([]);
  });

  it('darwin: a correction spelled in the other Unicode normalisation of a present file is a case-collision too (decided D7 handling)', async () => {
    const folderNfc = 'Ágnes Böngésző'.normalize('NFC');
    const fileNfc = 'LB-N77 Ágnes.brd'.normalize('NFC');
    const port: DirectoryPort = {
      async readDir(segments) {
        if (segments.length === 0) return [{ name: folderNfc, kind: 'dir' as const }];
        if (segments.length === 1 && segments[0] === folderNfc) return [{ name: fileNfc, kind: 'file' as const, size: 1 }];
        return [];
      },
    };
    const decomposed = `${folderNfc.normalize('NFD')}/${fileNfc.normalize('NFD')}`;
    const result = await buildDeviceCatalogue({ platform: 'darwin', roots: [{ rootId: ROOT, port }], anchors, corrections: [{ op: 'link', file: { rootId: ROOT, path: decomposed }, anchorId: 'anchor-lb-n77' }] });
    expect(result.missingTargets).toEqual([]);
    expect(result.needsManual.map(item => item.candidatePaths)).toEqual([[`${folderNfc}/${fileNfc}`]]);
  });

  it('darwin: confirming the candidate replaces the stored link (one entry, exact path) and the rerun confirms it by the user', async () => {
    const stored: CorrectionDocument = { version: 1, platform: 'darwin', corrections: [link] };
    const first = await run('darwin', { corrections: stored.corrections });
    const item = first.result.needsManual[0];
    const next = confirmCaseCollision(stored, item, item.candidatePaths[0]);
    expect(next.corrections).toEqual([{ op: 'link', file: { rootId: ROOT, path: 'Quarrel/uncertain/board.brd' }, anchorId: 'anchor-mb-q731' }]);
    expect(confirmCaseCollision(stored, item, 'Quarrel/uncertain/Not-a-candidate.brd')).toBe(stored);
    const second = await run('darwin', { corrections: next.corrections });
    expect(second.result.needsManual).toEqual([]);
    expect(second.result.missingTargets).toEqual([]);
    const links = associationsOf(second.result, 'Quarrel/uncertain/board.brd', 'darwin').filter(association => association.anchorId === 'anchor-mb-q731');
    expect(links).toHaveLength(1);
    expect(links[0].state).toBe('confirmed');
    expect(links[0].basis).toBe('user');
  });

  it('linux compares exactly, so the same link is a missing target and is not a case-collision', async () => {
    const { result } = await run('linux', { corrections: [link] });
    expect(result.missingTargets).toHaveLength(1);
    expect(result.needsManual).toEqual([]);
  });

  it('win32 folds case, so the same link is found and is neither missing nor a collision', async () => {
    const { result } = await run('win32', { corrections: [link] });
    expect(result.needsManual).toEqual([]);
  });
});

describe('scale and stored corrections (platform independent)', () => {
  it('a folder with 130,000 subfolders is catalogued without a RangeError (walkFiles and findFolder use a loop, not a spread)', async () => {
    const entries = Array.from({ length: 130_000 }, (_value, index) => ({ name: `d${index}`, kind: 'dir' as const }));
    const port: DirectoryPort = { async readDir(segments) { return segments.length === 0 ? entries : []; } };
    await expect(buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: ROOT, port }], anchors: [] })).resolves.toBeDefined();
  }, 120_000);

  it('a stored correction for a relative path longer than 512 characters is kept (valid on Windows with long paths)', () => {
    const segments = Array.from({ length: 10 }, (_value, index) => `level-${String(index).padStart(2, '0')}-${'x'.repeat(50)}`);
    const longPath = [...segments, 'BD-K1402_rev3.brd'].join('/');
    expect(longPath.length).toBeGreaterThan(512);
    const stored = serializeCorrections({ version: 1, platform: 'win32', corrections: [{ op: 'link', file: { rootId: ROOT, path: longPath }, anchorId: 'anchor-bd-k1402' }] } satisfies CorrectionDocument);
    const parsed = parseCorrections(stored);
    expect(parsed.dropped).toBe(0);
    expect(parsed.document.corrections).toHaveLength(1);
  });

  it('a stored correction document round-trips on each platform and keeps its platform field', () => {
    for (const platform of PLATFORMS) {
      const stored = serializeCorrections({ version: 1, platform, corrections: [{ op: 'link', file: { rootId: ROOT, path: 'Quarrel/uncertain/board.brd' }, anchorId: 'anchor-mb-q731' }] } satisfies CorrectionDocument);
      const parsed = parseCorrections(stored);
      expect(parsed.error).toBeUndefined();
      expect(parsed.document.platform).toBe(platform);
      expect(parsed.document.corrections).toHaveLength(1);
    }
  });
});
