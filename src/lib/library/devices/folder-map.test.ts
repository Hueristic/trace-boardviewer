import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MAX_SKIP_RECORDS, findFolder, mapFolderTree, type DirEntry, type DirectoryPort } from './folder-map';

/** A synthetic in-memory tree: keys are folder paths ("" is the root); values are the entries of that folder. */
function memoryPort(tree: Record<string, DirEntry[]>, calls: string[][] = [], failing: string[] = []): DirectoryPort {
  return {
    async readDir(segments) {
      const key = segments.join('/');
      calls.push([...segments]);
      if (failing.includes(key)) throw new Error('EACCES synthetic');
      const listing = tree[key];
      if (listing === undefined) throw new Error('ENOENT synthetic');
      return listing;
    },
  };
}

const sampleTree: Record<string, DirEntry[]> = {
  '': [
    { name: 'Birchfield', kind: 'dir' },
    { name: 'loose.txt', kind: 'file', size: 10 },
  ],
  Birchfield: [
    { name: 'Kestrel-14-R2', kind: 'dir' },
    { name: 'Alder', kind: 'dir' },
  ],
  'Birchfield/Kestrel-14-R2': [
    { name: 'board', kind: 'dir' },
    { name: 'docs', kind: 'dir' },
  ],
  'Birchfield/Kestrel-14-R2/board': [{ name: 'MB-Q731_rev2.brd', kind: 'file', size: 2048 }],
  'Birchfield/Kestrel-14-R2/docs': [{ name: 'Kestrel14_R02_schematic.pdf', kind: 'file', size: 4096 }],
  'Birchfield/Alder': [
    { name: 'MB-Q731_rev2_BIOS.bin', kind: 'file', size: 1024 },
    { name: 'shortcut', kind: 'link' },
    { name: 'device', kind: 'other' },
  ],
};

describe('folder map', () => {
  it('keeps the relative hierarchy with recursive totals', async () => {
    const map = await mapFolderTree(memoryPort(sampleTree), 'linux');
    expect(map.complete).toBe(true);
    expect(map.limitReached).toBe(false);
    expect(map.fileCount).toBe(4);
    expect(map.folderCount).toBe(5);
    expect(map.root.files.map(file => file.name)).toEqual(['loose.txt']);
    expect(map.root.bytes).toBe(10 + 2048 + 4096 + 1024);

    const kestrel = findFolder(map, 'Birchfield/Kestrel-14-R2', 'linux');
    expect(kestrel?.fileCount).toBe(2);
    expect(kestrel?.folderCount).toBe(2);
    expect(kestrel?.files).toHaveLength(0);
    const board = findFolder(map, 'Birchfield/Kestrel-14-R2/board', 'linux');
    expect(board?.files[0]).toMatchObject({ name: 'MB-Q731_rev2.brd', path: 'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', size: 2048, extension: 'brd' });
  });

  it('records links and special entries as skips without making the map incomplete', async () => {
    const map = await mapFolderTree(memoryPort(sampleTree), 'linux');
    expect(map.skippedCount).toBe(2);
    // Entries of a folder are visited in name order: "device" before "shortcut".
    expect(map.skipped).toEqual([
      { path: 'Birchfield/Alder/device', reason: 'other-kind' },
      { path: 'Birchfield/Alder/shortcut', reason: 'link' },
    ]);
  });

  it('skips OS sidecar files with reason "sidecar" and counts them; a hidden board file is kept', async () => {
    const tree: Record<string, DirEntry[]> = {
      '': [
        { name: '._MB-Q731_rev2.brd', kind: 'file', size: 1 },
        { name: '.DS_Store', kind: 'file', size: 1 },
        { name: 'Thumbs.db', kind: 'file', size: 1 },
        { name: 'thumbs.DB', kind: 'file', size: 1 },
        { name: 'desktop.ini', kind: 'file', size: 1 },
        { name: '.LB-N77_hidden.brd', kind: 'file', size: 1 },
        { name: 'MB-Q731_rev2.brd', kind: 'file', size: 1 },
      ],
    };
    const map = await mapFolderTree(memoryPort(tree), 'win32');
    expect(map.complete).toBe(true);
    expect(map.root.files.map(file => file.name)).toEqual(['.LB-N77_hidden.brd', 'MB-Q731_rev2.brd']);
    expect(map.skippedCount).toBe(5);
    expect(map.skipped.every(item => item.reason === 'sidecar')).toBe(true);
    expect(map.fileCount).toBe(2);
  });

  it('lists entries in a deterministic order (code unit order)', async () => {
    const tree: Record<string, DirEntry[]> = { '': [{ name: 'b.brd', kind: 'file' }, { name: 'B.brd', kind: 'file' }, { name: 'a.brd', kind: 'file' }] };
    const map = await mapFolderTree(memoryPort(tree), 'linux');
    expect(map.root.files.map(file => file.name)).toEqual(['B.brd', 'a.brd', 'b.brd']);
  });

  it('stops at the depth limit and marks the map incomplete', async () => {
    const map = await mapFolderTree(memoryPort(sampleTree), 'linux', { maxDepth: 2, maxEntries: 1000 });
    expect(map.complete).toBe(false);
    expect(map.skipped.filter(item => item.reason === 'too-deep').map(item => item.path).sort()).toEqual(['Birchfield/Alder', 'Birchfield/Kestrel-14-R2']);
    // Only the root file is inside the limit; the folders at depth 2 are listed as skipped, not walked.
    expect(map.fileCount).toBe(1);
  });

  it('stops at the entry limit: partial and counted, never silently complete', async () => {
    const map = await mapFolderTree(memoryPort(sampleTree), 'linux', { maxDepth: 48, maxEntries: 3 });
    expect(map.limitReached).toBe(true);
    expect(map.complete).toBe(false);
    expect(map.skippedCount).toBeGreaterThan(0);
    expect(map.fileCount).toBeLessThan(4);
  });

  it('records an entry that could not be classified as unknown, never walks it, and marks the map incomplete', async () => {
    const tree: Record<string, DirEntry[]> = {
      '': [{ name: 'Birchfield', kind: 'dir' }, { name: 'loose.txt', kind: 'unknown' }],
      Birchfield: [{ name: 'MB-Q731_rev2.brd', kind: 'file', size: 2048 }],
    };
    const calls: string[][] = [];
    const map = await mapFolderTree(memoryPort(tree, calls), 'linux');
    expect(map.complete).toBe(false);
    expect(map.skipped).toEqual([{ path: 'loose.txt', reason: 'unknown' }]);
    // The unknown entry is not a file, and it is not listed as a folder either: nothing is read under it.
    expect(map.root.files).toHaveLength(0);
    expect(calls.map(segments => segments.join('/'))).toEqual(['', 'Birchfield']);
    // The sibling folder is still walked and counted.
    expect(map.fileCount).toBe(1);
  });

  it('keeps the diagnostic code of an unknown entry and of an unreadable folder, without any path or message', async () => {
    const tree: Record<string, DirEntry[]> = {
      '': [{ name: 'Birchfield', kind: 'dir' }, { name: 'loose.txt', kind: 'unknown', code: 'EPERM' }, { name: 'odd.brd', kind: 'unknown', code: 'not a code' }],
      Birchfield: [{ name: 'MB-Q731_rev2.brd', kind: 'file', size: 2048 }],
    };
    const port: DirectoryPort = {
      async readDir(segments) {
        if (segments.join('/') === 'Birchfield') throw Object.assign(new Error('C:\private\path denied'), { code: 'EACCES' });
        return tree[segments.join('/')] ?? [];
      },
    };
    const map = await mapFolderTree(port, 'linux');
    expect(map.complete).toBe(false);
    expect(map.skipped).toEqual([
      { path: 'loose.txt', reason: 'unknown', code: 'EPERM' },
      { path: 'odd.brd', reason: 'unknown' },
      { path: 'Birchfield', reason: 'unreadable', code: 'EACCES' },
    ]);
    // Neither the message nor the path of the failure is stored in the record.
    expect(JSON.stringify(map.skipped)).not.toContain('private');
  });

  it('drops a code outside the closed set from an unknown entry, and keeps the entry as unknown', async () => {
    const tree: Record<string, DirEntry[]> = { '': [{ name: 'loose.txt', kind: 'unknown', code: 'XYZ_CUSTOM' }] };
    const map = await mapFolderTree(memoryPort(tree), 'linux');
    expect(map.complete).toBe(false);
    expect(map.skipped).toEqual([{ path: 'loose.txt', reason: 'unknown' }]);
  });

  it('stops reading folders once the entry limit is reached (bounded work, not only bounded output)', async () => {
    const calls: string[][] = [];
    const tree: Record<string, DirEntry[]> = {
      '': [{ name: 'A', kind: 'dir' }, { name: 'B', kind: 'dir' }, { name: 'C', kind: 'dir' }, { name: 'D', kind: 'dir' }],
      A: [{ name: 'a.brd', kind: 'file', size: 1 }],
      B: [{ name: 'b.brd', kind: 'file', size: 1 }],
      C: [{ name: 'c.brd', kind: 'file', size: 1 }],
      D: [{ name: 'd.brd', kind: 'file', size: 1 }],
    };
    const map = await mapFolderTree(memoryPort(tree, calls), 'linux', { maxDepth: 48, maxEntries: 4 });
    // The root's four entries use the whole budget; no other folder is read, and each one is recorded as a limit skip.
    expect(calls.map(segments => segments.join('/'))).toEqual(['']);
    expect(map.limitReached).toBe(true);
    expect(map.complete).toBe(false);
    expect(map.skipped.map(item => item.path).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(map.fileCount).toBe(0);
  });

  it('keeps an unreadable folder in the map as unreadable, with its name and code, and walks its siblings', async () => {
    const tree: Record<string, DirEntry[]> = {
      '': [{ name: 'Birchfield', kind: 'dir' }, { name: 'Empty', kind: 'dir' }],
      Birchfield: [{ name: 'Alder', kind: 'dir' }, { name: 'Kestrel', kind: 'dir' }],
      'Birchfield/Alder': [{ name: 'hidden.brd', kind: 'file', size: 5 }],
      'Birchfield/Kestrel': [{ name: 'MB-Q731_rev2.brd', kind: 'file', size: 7 }],
    };
    const port: DirectoryPort = {
      async readDir(segments) {
        const key = segments.join('/');
        if (key === 'Birchfield/Alder') throw Object.assign(new Error('C:\private\denied'), { code: 'EACCES' });
        return tree[key] ?? [];
      },
    };
    const map = await mapFolderTree(port, 'linux');
    expect(map.complete).toBe(false);
    const alder = findFolder(map, 'Birchfield/Alder', 'linux');
    expect(alder).toMatchObject({ name: 'Alder', path: 'Birchfield/Alder', readState: 'unreadable', code: 'EACCES', fileCount: 0 });
    // The unreadable folder is visible in the tree; its siblings are walked and counted.
    expect(findFolder(map, 'Birchfield', 'linux')?.folders.map(folder => [folder.name, folder.readState])).toEqual([['Alder', 'unreadable'], ['Kestrel', 'listed']]);
    expect(findFolder(map, 'Birchfield/Kestrel', 'linux')?.files.map(file => file.name)).toEqual(['MB-Q731_rev2.brd']);
    expect(findFolder(map, 'Empty', 'linux')?.readState).toBe('listed');
    expect(map.fileCount).toBe(1);
    expect(map.skipped).toEqual([{ path: 'Birchfield/Alder', reason: 'unreadable', code: 'EACCES' }]);
    expect(JSON.stringify(map)).not.toContain('private');
  });

  it('marks a folder that was not read because it is too deep as skipped, not listed', async () => {
    const map = await mapFolderTree(memoryPort(sampleTree), 'linux', { maxDepth: 2, maxEntries: 1000 });
    expect(findFolder(map, 'Birchfield/Alder', 'linux')?.readState).toBe('skipped');
    expect(findFolder(map, 'Birchfield', 'linux')?.readState).toBe('listed');
  });

  it('records an unreadable folder and walks the rest', async () => {
    const calls: string[][] = [];
    const map = await mapFolderTree(memoryPort(sampleTree, calls, ['Birchfield/Alder']), 'linux');
    expect(map.complete).toBe(false);
    expect(map.skipped).toContainEqual({ path: 'Birchfield/Alder', reason: 'unreadable' });
    // loose.txt, the board file and the schematic are counted; the unreadable folder's BIOS file is not.
    expect(map.fileCount).toBe(3);
    expect(calls.map(segments => segments.join('/'))).toContain('Birchfield/Kestrel-14-R2/docs');
  });

  it('refuses entry names that could smuggle a second segment or leave the root', async () => {
    const tree: Record<string, DirEntry[]> = {
      '': [
        { name: '..', kind: 'dir' },
        { name: '.', kind: 'file' },
        { name: 'a/b.brd', kind: 'file' },
        { name: 'c\\d.brd', kind: 'file' },
        { name: 'ok.brd', kind: 'file' },
      ],
    };
    const win = await mapFolderTree(memoryPort(tree), 'win32');
    expect(win.root.files.map(file => file.name)).toEqual(['ok.brd']);
    expect(win.skippedCount).toBe(4);
    // On linux a backslash is an ordinary file-name character, so the same name is kept.
    const linux = await mapFolderTree(memoryPort(tree), 'linux');
    expect(linux.root.files.map(file => file.name)).toEqual(['c\\d.brd', 'ok.brd']);
  });

  it('keeps the skip list bounded while counting every skip', async () => {
    const many: DirEntry[] = Array.from({ length: MAX_SKIP_RECORDS + 25 }, (_value, index) => ({ name: `l${index}`, kind: 'link' as const }));
    const map = await mapFolderTree(memoryPort({ '': many }), 'linux');
    expect(map.skipped).toHaveLength(MAX_SKIP_RECORDS);
    expect(map.skippedCount).toBe(MAX_SKIP_RECORDS + 25);
  });

  it('uses the default limits when none are given', async () => {
    expect(DEFAULT_LIMITS).toEqual({ maxDepth: 48, maxEntries: 250_000 });
    const map = await mapFolderTree(memoryPort(sampleTree), 'linux');
    expect(map.complete).toBe(true);
  });

  it('treats a missing size as zero and a negative size as zero', async () => {
    const tree: Record<string, DirEntry[]> = { '': [{ name: 'x.brd', kind: 'file' }, { name: 'y.brd', kind: 'file', size: -5 }] };
    const map = await mapFolderTree(memoryPort(tree), 'linux');
    expect(map.root.bytes).toBe(0);
  });
});

describe('real directory port (read-only, synthetic temp tree)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('maps a temporary synthetic tree and never changes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'trace-devices-'));
    mkdirSync(join(dir, 'Birchfield', 'Kestrel-14-R2', 'board'), { recursive: true });
    mkdirSync(join(dir, 'Alder', 'Orion-5'), { recursive: true });
    writeFileSync(join(dir, 'Birchfield', 'Kestrel-14-R2', 'board', 'MB-Q731_rev2.brd'), Buffer.from('SYNTH-A'));
    writeFileSync(join(dir, 'Alder', 'Orion-5', 'MB-Q731_rev2_BIOS.bin'), Buffer.from('SYNTH-BIOS'));
    const before = readdirSync(dir, { recursive: true }).map(String).sort();

    const port: DirectoryPort = {
      async readDir(segments) {
        const target = join(dir!, ...segments);
        const entries = readdirSync(target, { withFileTypes: true });
        return entries.map(entry => {
          const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
          return { name: entry.name, kind, size: kind === 'file' ? statSync(join(target, entry.name)).size : undefined } as DirEntry;
        });
      },
    };
    const map = await mapFolderTree(port, 'win32');
    expect(map.complete).toBe(true);
    expect(map.fileCount).toBe(2);
    expect(map.folderCount).toBe(5);
    expect(findFolder(map, 'Alder/Orion-5', 'win32')?.files[0]).toMatchObject({ name: 'MB-Q731_rev2_BIOS.bin', size: 10, extension: 'bin' });
    expect(findFolder(map, 'ALDER/orion-5', 'win32')?.name).toBe('Orion-5');
    expect(findFolder(map, 'Alder/Orion-5', 'linux')).toBeUndefined();

    // The walk is read-only: the same names and sizes exist afterwards.
    expect(readdirSync(dir, { recursive: true }).map(String).sort()).toEqual(before);
    expect(statSync(join(dir, 'Alder', 'Orion-5', 'MB-Q731_rev2_BIOS.bin')).size).toBe(10);
  });
});

describe('Windows reparse points that are not links (W16-B4)', () => {
  it('a reparse point is skipped with reason reparse, never walked, and makes the map incomplete; a link keeps its own reason', async () => {
    const calls: string[][] = [];
    const tree: Record<string, DirEntry[]> = {
      '': [
        { name: 'Birchfield', kind: 'dir' },
        { name: 'Cloud', kind: 'reparse' },
        { name: 'Shortcut', kind: 'link' },
        { name: 'loose.txt', kind: 'file', size: 10 },
      ],
      Birchfield: [{ name: 'Alder', kind: 'file', size: 4 }],
      Cloud: [{ name: 'hidden.brd', kind: 'file', size: 99 }],
    };
    const map = await mapFolderTree(memoryPort(tree, calls), 'win32');
    expect(map.skipped).toEqual(expect.arrayContaining([{ path: 'Cloud', reason: 'reparse' }, { path: 'Shortcut', reason: 'link' }]));
    expect(calls.map(segments => segments.join('/'))).not.toContain('Cloud');
    expect(map.root.fileCount).toBe(2);
    expect(map.complete).toBe(false);
  });

  it('a map with links only stays complete', async () => {
    const tree: Record<string, DirEntry[]> = { '': [{ name: 'Shortcut', kind: 'link' }, { name: 'loose.txt', kind: 'file', size: 1 }] };
    const map = await mapFolderTree(memoryPort(tree), 'linux');
    expect(map.skipped).toEqual([{ path: 'Shortcut', reason: 'link' }]);
    expect(map.complete).toBe(true);
  });
});

describe('online-only files (W16-B4)', () => {
  it('an online file is a file node with online true; an ordinary file node has no online key', async () => {
    const tree: Record<string, DirEntry[]> = {
      '': [
        { name: 'Cloud.brd', kind: 'file', size: 8192, online: true },
        { name: 'local.brd', kind: 'file', size: 10 },
      ],
    };
    const map = await mapFolderTree(memoryPort(tree), 'win32');
    const byName = Object.fromEntries(map.root.files.map(file => [file.name, file]));
    expect(byName['Cloud.brd']).toMatchObject({ name: 'Cloud.brd', size: 8192, online: true });
    expect(byName['local.brd']).not.toHaveProperty('online');
    expect(map.complete).toBe(true);
  });
});

describe('TB-038: the skip record of a refused link carries its code', () => {
  it('a link refused for escaping the root is recorded with ADAPTER_ESCAPES_ROOT; a plain link is recorded without one', async () => {
    const tree: Record<string, DirEntry[]> = { '': [{ name: 'Escape', kind: 'link', code: 'ADAPTER_ESCAPES_ROOT' }, { name: 'Shortcut', kind: 'link' }] };
    const map = await mapFolderTree(memoryPort(tree), 'linux');
    expect(map.skipped).toEqual([{ path: 'Escape', reason: 'link', code: 'ADAPTER_ESCAPES_ROOT' }, { path: 'Shortcut', reason: 'link' }]);
    expect(map.complete).toBe(true);
  });
});
