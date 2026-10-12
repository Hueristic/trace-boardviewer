import { describe, expect, it } from 'vitest';
import { buildDeviceCatalogue, type CatalogueInput } from './catalogue';
import type { DirEntry, DirectoryPort } from './folder-map';
import { fileRefOf, type Correction } from './corrections';
import { extractIdentity } from './identity';
import type { BoardAnchor } from './match';
import { WEIGHT } from './match';

/** Synthetic tree of one root. The port records every call; it has no other method, so nothing can be written through it. */
function treePort(tree: Record<string, DirEntry[]>, calls: string[][] = []): DirectoryPort {
  return {
    async readDir(segments) {
      calls.push([...segments]);
      const listing = tree[segments.join('/')];
      if (listing === undefined) throw new Error('ENOENT synthetic');
      return listing;
    },
  };
}

const primaryTree: Record<string, DirEntry[]> = {
  '': [{ name: 'Alder', kind: 'dir' }, { name: 'Birchfield', kind: 'dir' }],
  Alder: [{ name: 'Orion-5', kind: 'dir' }],
  'Alder/Orion-5': [
    { name: 'MB-Q731_rev2_BIOS.bin', kind: 'file', size: 1024 },
    { name: 'EC-Q731.bin', kind: 'file', size: 512 },
  ],
  Birchfield: [{ name: 'Kestrel-14-R2', kind: 'dir' }],
  'Birchfield/Kestrel-14-R2': [{ name: 'board', kind: 'dir' }, { name: 'docs', kind: 'dir' }],
  'Birchfield/Kestrel-14-R2/board': [{ name: 'MB-Q731_rev2.brd', kind: 'file', size: 2048 }],
  'Birchfield/Kestrel-14-R2/docs': [{ name: 'Kestrel14_R02_schematic.pdf', kind: 'file', size: 4096 }],
};

const revision = extractIdentity('x/MB-Q731_rev2.brd', { platform: 'linux' }).revision;
const group: BoardAnchor = { id: 'g-q731', boardCode: 'MB-Q731', revision, aliases: ['kestrel'] };

function input(overrides: Partial<CatalogueInput> = {}, tree: Record<string, DirEntry[]> = primaryTree, calls?: string[][]): CatalogueInput {
  return { platform: 'linux', roots: [{ rootId: 'r1', port: treePort(tree, calls) }], anchors: [group], ...overrides };
}

describe('device catalogue pipeline', () => {
  it('maps, reads identities and matches a synthetic root with every step on', async () => {
    const result = await buildDeviceCatalogue(input());
    expect(result.steps).toEqual({ folderMap: 'ran', nameIdentity: 'ran', biosCandidates: 'ran', matching: 'ran', corrections: 'ran' });
    expect(result.maps[0].map?.fileCount).toBe(4);
    expect(result.files).toHaveLength(4);
    const byPath = (suffix: string) => result.associations.find(item => item.filePath.endsWith(suffix));
    // The board file shares the code and revision in its name: probable, 40 + 15.
    expect(byPath('Kestrel-14-R2/board/MB-Q731_rev2.brd')).toMatchObject({ state: 'probable', score: WEIGHT.codeName + WEIGHT.revisionAgree + WEIGHT.aliasEach, role: 'boardview' });
    // The BIOS candidate shares the code and revision: probable, and it is still only a candidate.
    expect(byPath('Orion-5/MB-Q731_rev2_BIOS.bin')).toMatchObject({ state: 'probable', role: 'bios-candidate' });
    // The schematic shares only the folder alias and the revision: review, never probable.
    expect(byPath('docs/Kestrel14_R02_schematic.pdf')).toMatchObject({ state: 'review', basis: 'alias', score: WEIGHT.aliasEach + WEIGHT.revisionAgree });
    // The EC file has no shared name evidence and produces no association.
    expect(byPath('EC-Q731.bin')).toBeUndefined();
    expect(result.associations).toHaveLength(3);
  });

  it('keeps a file that is in two selected roots as two file references', async () => {
    const second: Record<string, DirEntry[]> = { '': [{ name: 'MB-Q731_rev2.brd', kind: 'file' }] };
    const result = await buildDeviceCatalogue(input({ roots: [{ rootId: 'r1', port: treePort(primaryTree) }, { rootId: 'r2', port: treePort(second) }] }));
    const refs = result.associations.filter(item => item.anchorId === group.id && item.role === 'boardview');
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map(item => item.filePath)).size).toBe(2);
  });

  it('is read-only: the only port call is readDir, and only inside the tree', async () => {
    const calls: string[][] = [];
    const port = treePort(primaryTree, calls);
    expect(Object.keys(port)).toEqual(['readDir']);
    await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port }], anchors: [group] });
    expect(calls.length).toBeGreaterThan(0);
    for (const segments of calls) expect(segments.join('/') in primaryTree).toBe(true);
  });

  it('skips the folder map and everything that depends on it', async () => {
    const result = await buildDeviceCatalogue(input({ steps: { folderMap: false } }));
    expect(result.steps).toEqual({ folderMap: 'skipped', nameIdentity: 'skipped', biosCandidates: 'skipped', matching: 'skipped', corrections: 'ran' });
    expect(result.maps[0].map).toBeNull();
    expect(result.files).toEqual([]);
    expect(result.associations).toEqual([]);
  });

  it('skips name identity and matching while keeping the tree', async () => {
    const result = await buildDeviceCatalogue(input({ steps: { nameIdentity: false } }));
    expect(result.steps.folderMap).toBe('ran');
    expect(result.steps.nameIdentity).toBe('skipped');
    expect(result.steps.matching).toBe('skipped');
    expect(result.maps[0].map?.fileCount).toBe(4);
    expect(result.associations).toEqual([]);
  });

  it('skips matching only, keeping the identities', async () => {
    const result = await buildDeviceCatalogue(input({ steps: { matching: false } }));
    expect(result.steps.matching).toBe('skipped');
    expect(result.files).toHaveLength(4);
    expect(result.associations).toEqual([]);
  });

  it('leaves firmware candidates out when the BIOS step is off, and counts them', async () => {
    const result = await buildDeviceCatalogue(input({ steps: { biosCandidates: false } }));
    expect(result.steps.biosCandidates).toBe('skipped');
    expect(result.excludedFirmwareCount).toBe(2);
    expect(result.files.map(file => file.identity.role).sort()).toEqual(['boardview', 'schematic']);
    expect(result.associations.some(item => item.role === 'bios-candidate')).toBe(false);
  });

  it('applies a durable user link and a detach, and reports a missing target without redirecting it', async () => {
    const corrections: Correction[] = [
      { op: 'link', file: { rootId: 'r1', path: 'Alder/Orion-5/EC-Q731.bin' }, anchorId: group.id },
      { op: 'unlink', file: { rootId: 'r1', path: 'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd' }, anchorId: group.id },
      { op: 'link', file: { rootId: 'r1', path: 'moved/gone.brd' }, anchorId: group.id },
    ];
    const result = await buildDeviceCatalogue(input({ corrections }));
    expect(result.steps.corrections).toBe('ran');
    expect(result.missingTargets).toEqual([corrections[2]]);
    const ecRef = fileRefOf({ rootId: 'r1', path: 'Alder/Orion-5/EC-Q731.bin' }, 'linux');
    const boardRef = fileRefOf({ rootId: 'r1', path: 'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd' }, 'linux');
    expect(result.associations.find(item => item.filePath === ecRef)).toMatchObject({ state: 'confirmed', basis: 'user', score: 0, role: 'ec-firmware' });
    expect(result.associations.find(item => item.filePath === boardRef)).toBeUndefined();
  });

  it('ignores corrections entirely when the corrections step is off', async () => {
    const corrections: Correction[] = [
      { op: 'link', file: { rootId: 'r1', path: 'Alder/Orion-5/EC-Q731.bin' }, anchorId: group.id },
      { op: 'link', file: { rootId: 'r1', path: 'moved/gone.brd' }, anchorId: group.id },
    ];
    const result = await buildDeviceCatalogue(input({ corrections, steps: { corrections: false } }));
    expect(result.steps.corrections).toBe('skipped');
    expect(result.missingTargets).toEqual([]);
    expect(result.associations.some(item => item.basis === 'user')).toBe(false);
  });

  it('applies a role correction and an anchor alias correction', async () => {
    const corrections: Correction[] = [
      { op: 'role', file: { rootId: 'r1', path: 'Alder/Orion-5/MB-Q731_rev2_BIOS.bin' }, role: 'saved-dump' },
      { op: 'alias', anchorId: group.id, alias: 'orion', remove: false },
    ];
    const result = await buildDeviceCatalogue(input({ corrections }));
    const dump = result.files.find(file => file.path.endsWith('MB-Q731_rev2_BIOS.bin'));
    expect(dump?.identity).toMatchObject({ role: 'saved-dump', roleBasis: 'correction' });
    // The added alias makes the BIOS file share a name alias with the group, so it is also reviewable by alias.
    expect(result.associations.some(item => item.role === 'saved-dump' && item.state === 'probable')).toBe(true);
  });

  it('reads a backslash in a linux file name as an ordinary character, and refuses it on win32', async () => {
    const tree: Record<string, DirEntry[]> = { '': [{ name: 'MB-Q731\\rev2.brd', kind: 'file' }] };
    const linux = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: treePort(tree) }], anchors: [] });
    expect(linux.files).toHaveLength(1);
    const win = await buildDeviceCatalogue({ platform: 'win32', roots: [{ rootId: 'r1', port: treePort(tree) }], anchors: [] });
    expect(win.files).toHaveLength(0);
    expect(win.maps[0].map?.skipped).toEqual([{ path: 'MB-Q731\\rev2.brd', reason: 'other-kind' }]);
  });

  it('uses a content code only when it is unique, and matches it to the group', async () => {
    const contentCodes = new Map([[fileRefOf({ rootId: 'r1', path: 'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd' }, 'linux'), { code: 'MB-Q731', unique: true }]]);
    const result = await buildDeviceCatalogue(input({ contentCodes }));
    const board = result.associations.find(item => item.role === 'boardview');
    expect(board).toMatchObject({ state: 'confirmed', basis: 'content' });
  });

  it('marks a root with an unreadable folder as incomplete, and a clean root as complete', async () => {
    const damaged: Record<string, DirEntry[]> = { ...primaryTree };
    delete damaged['Alder/Orion-5'];
    const result = await buildDeviceCatalogue({
      platform: 'linux',
      roots: [{ rootId: 'r1', port: treePort(damaged) }, { rootId: 'r2', port: treePort(primaryTree) }],
      anchors: [group],
    });
    expect(result.maps[0].map?.complete).toBe(false);
    expect(result.maps[1].map?.complete).toBe(true);
    expect(result.steps.folderMap).toBe('ran');
  });
});

const casePairTree: Record<string, DirEntry[]> = {
  '': [{ name: 'Alder', kind: 'dir' }],
  Alder: [{ name: 'MB-Q731.brd', kind: 'file', size: 1 }, { name: 'mb-q731.brd', kind: 'file', size: 1 }],
};

describe('names that differ only by case', () => {
  it('keeps them as two files on darwin, and a link applies to its own file only', async () => {
    const result = await buildDeviceCatalogue({
      platform: 'darwin',
      roots: [{ rootId: 'r1', port: treePort(casePairTree) }],
      anchors: [group],
      corrections: [{ op: 'link', file: { rootId: 'r1', path: 'Alder/MB-Q731.brd' }, anchorId: group.id }],
    });
    expect(result.files).toHaveLength(2);
    expect(result.files.some(file => file.collision === true)).toBe(false);
    const upper = fileRefOf({ rootId: 'r1', path: 'Alder/MB-Q731.brd' }, 'darwin');
    const lower = fileRefOf({ rootId: 'r1', path: 'Alder/mb-q731.brd' }, 'darwin');
    expect(result.associations.find(item => item.filePath === upper)).toMatchObject({ state: 'confirmed', basis: 'user' });
    expect(result.associations.find(item => item.filePath === lower)).toMatchObject({ state: 'probable', basis: 'names' });
  });

  it('reports a collision on win32: neither file is matched, and a link to them is a missing target', async () => {
    const corrections: Correction[] = [{ op: 'link', file: { rootId: 'r1', path: 'Alder/MB-Q731.brd' }, anchorId: group.id }];
    const result = await buildDeviceCatalogue({
      platform: 'win32',
      roots: [{ rootId: 'r1', port: treePort(casePairTree) }],
      anchors: [group],
      corrections,
    });
    expect(result.files.filter(file => file.collision === true).map(file => file.path)).toEqual(['Alder/MB-Q731.brd', 'Alder/mb-q731.brd']);
    expect(result.collisions).toEqual([{ rootId: 'r1', paths: ['Alder/MB-Q731.brd', 'Alder/mb-q731.brd'] }]);
    expect(result.associations).toEqual([]);
    expect(result.missingTargets).toEqual(corrections);
  });
});

describe('large synthetic roots', () => {
  it('does not overflow the call stack for a folder with many sibling folders', async () => {
    const siblings = 150_000;
    const tree: Record<string, DirEntry[]> = { '': Array.from({ length: siblings }, (_value, index) => ({ name: `b${index}`, kind: 'dir' as const })) };
    for (let index = 0; index < siblings; index++) tree[`b${index}`] = [];
    const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: treePort(tree) }], anchors: [], steps: { folderMap: true } });
    expect(result.maps[0].map?.folderCount).toBe(siblings);
    expect(result.files).toEqual([]);
  });

  it('reports stats that show one pass over the entries', async () => {
    const result = await buildDeviceCatalogue(input());
    expect(result.stats).toMatchObject({ folders: 6, files: 4, entries: 10 });
    expect(result.stats.match.judgments).toBeLessThanOrEqual(result.stats.match.candidates);
  });
});
