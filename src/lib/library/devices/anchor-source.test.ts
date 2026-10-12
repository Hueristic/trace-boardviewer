import { describe, expect, it } from 'vitest';
import { buildDeviceCatalogue } from './catalogue';
import { createFileNameAnchorSource, deriveBoardAnchors, type BoardAnchorSource } from './anchor-source';
import type { DirEntry, DirectoryPort } from './folder-map';

function memoryPort(tree: Record<string, DirEntry[]>): DirectoryPort {
  return {
    async readDir(segments) {
      const listing = tree[segments.join('/')];
      if (listing === undefined) throw new Error('ENOENT synthetic');
      return listing;
    },
  };
}

const tree: Record<string, DirEntry[]> = {
  '': [{ name: 'Board', kind: 'dir' }],
  Board: [{ name: 'MB-Q731_rev2.brd', kind: 'file', size: 10 }],
};

describe('default board anchor source (file names)', () => {
  it('anchorsFor returns the derived anchors, and describe answers the board code and revision of the last scan', async () => {
    const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [], deriveAnchors: true });
    const source = createFileNameAnchorSource();
    const anchors = await source.anchorsFor({ files: result.files, derived: deriveBoardAnchors(result.files) });
    expect(anchors.map(anchor => anchor.id)).toEqual(result.anchors.map(anchor => anchor.id));
    const meta = await source.describe(anchors[0].id);
    expect(meta?.boardCode).toBe('MB-Q731');
    expect(await source.describe('board:UNKNOWN|')).toBeUndefined();
  });
});

describe('injected board anchor source (the port)', () => {
  it('the catalogue matches against the anchors the source returns, not the derived ones', async () => {
    const dbSource: BoardAnchorSource = {
      async anchorsFor() {
        return [{ id: 'db-board-1', boardCode: 'MB-Q731', aliases: [] }];
      },
      async describe(anchorId) {
        return anchorId === 'db-board-1' ? { boardCode: 'MB-Q731', revision: 'REV 2' } : undefined;
      },
    };
    const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [], anchorSource: dbSource });
    expect(result.anchors.map(anchor => anchor.id)).toEqual(['db-board-1']);
    expect(result.associations.some(item => item.anchorId === 'db-board-1' && item.role === 'boardview')).toBe(true);
  });

  it('input anchors are kept, and a source anchor with an input id is not added twice', async () => {
    const source: BoardAnchorSource = {
      async anchorsFor() {
        return [{ id: 'given', boardCode: 'OTHER', aliases: [] }, { id: 'extra', aliases: [] }];
      },
      async describe() {
        return undefined;
      },
    };
    const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: memoryPort(tree) }], anchors: [{ id: 'given', aliases: [] }], anchorSource: source });
    expect(result.anchors.map(anchor => anchor.id)).toEqual(['given', 'extra']);
  });
});
