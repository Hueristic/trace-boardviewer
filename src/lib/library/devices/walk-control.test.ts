import { describe, expect, it } from 'vitest';
import { buildDeviceCatalogue, deriveBoardAnchors } from './catalogue';
import { CANCELLED_CODE, DEFAULT_LIMITS, mapFolderTree, type DirEntry, type DirectoryPort } from './folder-map';

/** Synthetic in-memory tree; keys are folder paths ("" is the root). Every read is recorded. */
function memoryPort(tree: Record<string, DirEntry[]>, reads: string[][] = [], onRead?: (segments: string[]) => void): DirectoryPort {
  return {
    async readDir(segments) {
      reads.push([...segments]);
      onRead?.([...segments]);
      const listing = tree[segments.join('/')];
      if (listing === undefined) throw new Error('ENOENT synthetic');
      return listing;
    },
  };
}

const tree: Record<string, DirEntry[]> = {
  '': [{ name: 'Birchfield', kind: 'dir' }, { name: 'Loose.txt', kind: 'file', size: 4 }],
  Birchfield: [{ name: 'Kestrel-14-R2', kind: 'dir' }, { name: 'Alder', kind: 'dir' }],
  'Birchfield/Kestrel-14-R2': [{ name: 'MB-Q731_rev2.brd', kind: 'file', size: 100 }],
  'Birchfield/Alder': [{ name: 'MB-Q731_bios.bin', kind: 'file', size: 200 }],
};

describe('user folder skip', () => {
  it('does not read a skipped subtree, records the skip, and marks the map incomplete', async () => {
    const reads: string[][] = [];
    const map = await mapFolderTree(memoryPort(tree, reads), 'linux', DEFAULT_LIMITS, { skipPaths: new Set(['Birchfield/Alder']) });
    expect(reads.map(segments => segments.join('/'))).not.toContain('Birchfield/Alder');
    expect(map.skipped).toEqual([{ path: 'Birchfield/Alder', reason: 'user-skipped' }]);
    expect(map.complete).toBe(false);
    expect(map.root.folders[0].folders.map(folder => folder.name)).toEqual(['Kestrel-14-R2']);
  });

  it('without skips the walk is complete', async () => {
    const map = await mapFolderTree(memoryPort(tree), 'linux');
    expect(map.complete).toBe(true);
    expect(map.fileCount).toBe(3);
  });
});

describe('cancel', () => {
  it('a signal that is already aborted stops the walk before the first read', async () => {
    const reads: string[][] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(mapFolderTree(memoryPort(tree, reads), 'linux', DEFAULT_LIMITS, { signal: controller.signal })).rejects.toMatchObject({ code: CANCELLED_CODE });
    expect(reads).toEqual([]);
  });

  it('a cancel during the walk stops it at the next folder and returns no partial map', async () => {
    const reads: string[][] = [];
    const controller = new AbortController();
    const port = memoryPort(tree, reads, segments => {
      if (segments.length === 1) controller.abort();
    });
    await expect(mapFolderTree(port, 'linux', DEFAULT_LIMITS, { signal: controller.signal })).rejects.toMatchObject({ code: CANCELLED_CODE });
    expect(reads.some(segments => segments.length === 2)).toBe(false);
  });

  it('a cancel raised during the last read stops the run before the identity step, not after it', async () => {
    const controller = new AbortController();
    const port = memoryPort(tree, [], segments => {
      if (segments.length === 1) controller.abort();
    });
    await expect(buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port }], anchors: [], signal: controller.signal })).rejects.toMatchObject({ code: CANCELLED_CODE });
  });

  it('the catalogue propagates the cancel and returns nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [], signal: controller.signal })).rejects.toMatchObject({ code: CANCELLED_CODE });
  });
});

describe('derived board anchors', () => {
  it('a boardview file yields an anchor whose id depends only on the board code and revision', async () => {
    const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [], deriveAnchors: true });
    expect(result.anchors.length).toBeGreaterThanOrEqual(1);
    const derived = deriveBoardAnchors(result.files);
    expect(derived.map(anchor => anchor.id)).toEqual(result.anchors.map(anchor => anchor.id));
    expect(result.associations.some(item => item.role === 'boardview' && result.anchors.some(anchor => anchor.id === item.anchorId))).toBe(true);
  });

  it('without deriveAnchors the anchors stay the input anchors', async () => {
    const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [{ id: 'given', aliases: [] }] });
    expect(result.anchors.map(anchor => anchor.id)).toEqual(['given']);
  });
});

describe('step skip requested during a run', () => {
  it('a step asked to skip before it starts is reported skipped, produces nothing, and makes the result incomplete', async () => {
    const result = await buildDeviceCatalogue({
      platform: 'linux',
      roots: [{ rootId: 'r1', port: memoryPort(tree) }],
      anchors: [],
      deriveAnchors: true,
      isStepSkipped: step => step === 'matching',
    });
    expect(result.steps.matching).toBe('skipped');
    expect(result.skippedByRequest).toEqual(['matching']);
    expect(result.associations).toEqual([]);
    expect(result.steps.nameIdentity).toBe('ran');
    expect(result.complete).toBe(false);
  });

  it('a step that is not asked to skip runs as usual and nothing is reported skipped by request', async () => {
    const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [], isStepSkipped: () => false });
    expect(result.skippedByRequest).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

describe('complete flag', () => {
  it('is true only when every step ran and every map is complete', async () => {
    const full = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [] });
    expect(full.complete).toBe(true);
    const partial = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [], steps: { biosCandidates: false } });
    expect(partial.complete).toBe(false);
    const skipped = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree), skipPaths: new Set(['Birchfield/Alder']) }], anchors: [] });
    expect(skipped.complete).toBe(false);
  });
});
