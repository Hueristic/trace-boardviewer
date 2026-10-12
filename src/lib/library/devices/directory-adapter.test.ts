import { createRequire } from 'node:module';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpath as realpathCallback, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { DEFAULT_LIMITS, findFolder, mapFolderTree, type DirEntry, type FolderMap, type MapLimits } from './folder-map';
import type { DevicePlatform } from './paths';

// The directory adapter is a native main-process module (CommonJS, outside src). Load it through Node so the test runs the same code.
const require = createRequire(import.meta.url);
interface NativeDirectoryPort { readDir(segments: readonly string[]): Promise<DirEntry[]> }
interface DirectoryAdapterModule {
  createDirectoryPort(options: { root: string; platform: string; fs?: unknown }): Promise<NativeDirectoryPort>;
}
const adapter = require('../../../../electron/library/directory-adapter.cjs') as DirectoryAdapterModule;

const platform: DevicePlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
// The callback form of realpath.native is the asynchronous one; promisify must not wrap the synchronous variant.
const nativeRealpath = promisify(realpathCallback.native);

let root = '';
let outside = '';
let linked = false;

// Everything the map could change: relative names, kinds and sizes of the whole tree (links recorded, never followed).
function listTree(directory: string, relative: string[] = []): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(directory, ...relative)).sort()) {
    const segments = [...relative, name];
    const stat = lstatSync(join(directory, ...segments));
    const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file';
    out.push(`${segments.join('/')}|${kind}|${stat.size}`);
    if (kind === 'dir') out.push(...listTree(directory, segments));
  }
  return out;
}

async function mapWith(limits: Partial<MapLimits> = {}, fs?: unknown): Promise<FolderMap> {
  const port = await adapter.createDirectoryPort({ root, platform: process.platform, fs });
  return mapFolderTree(port, platform, { ...DEFAULT_LIMITS, ...limits });
}

// The adapter resolves paths with the native realpath, which expands an 8.3 short name (C:\Users\RUNNER~1\...) to the long one. The JS
// realpathSync does not, so the fixtures must be built from the native form, or the adapter's path comparisons never match.
const canonicalTemp = () => realpathSync.native(tmpdir());

beforeAll(() => {
  const temp = canonicalTemp();
  root = mkdtempSync(join(temp, 'devices-adapter-root-'));
  outside = mkdtempSync(join(temp, 'devices-adapter-outside-'));
  for (const folder of ['Birchfield/Kestrel-14-R2/board', 'Birchfield/Kestrel-14-R2/docs', 'Birchfield/Alder']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'loose.txt'), 'x'.repeat(10));
  writeFileSync(join(root, 'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd'), Buffer.alloc(2048, 1));
  writeFileSync(join(root, 'Birchfield/Kestrel-14-R2/docs/Kestrel14_R02_schematic.pdf'), Buffer.alloc(4096, 2));
  writeFileSync(join(root, 'Birchfield/Alder/MB-Q731_rev2_BIOS.bin'), Buffer.alloc(1024, 3));
  writeFileSync(join(outside, 'secret.brd'), 'outside the root');
  try {
    // A junction on win32 needs no privilege; a directory symlink elsewhere. Refusal leaves the link checks skipped, not passed.
    symlinkSync(outside, join(root, 'Link'), process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch {
    linked = false;
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('native directory adapter with the folder map', () => {
  it('maps the synthetic library with recursive totals and leaves the tree unchanged', async () => {
    const before = listTree(root);
    const map = await mapWith();
    expect(map.complete).toBe(true);
    expect(map.limitReached).toBe(false);
    expect(map.fileCount).toBe(4);
    expect(map.root.bytes).toBe(10 + 2048 + 4096 + 1024);
    const board = findFolder(map, 'Birchfield/Kestrel-14-R2/board', platform);
    expect(board?.files[0]).toMatchObject({ name: 'MB-Q731_rev2.brd', size: 2048, extension: 'brd' });
    expect(listTree(root)).toEqual(before);
  });

  it('records a junction or link as a skip, never walks into it, and keeps the map complete', async (ctx: TestContext) => {
    if (!linked) ctx.skip();
    const map = await mapWith();
    // The junction points outside the root, so its refusal carries the escape code (TB-038).
    expect(map.skipped).toContainEqual({ path: 'Link', reason: 'link', code: 'ADAPTER_ESCAPES_ROOT' });
    expect(map.complete).toBe(true);
    expect(map.fileCount).toBe(4);
    expect(JSON.stringify(map)).not.toContain('secret.brd');
  });

  it('marks the map incomplete when the depth limit stops the walk', async () => {
    const map = await mapWith({ maxDepth: 1 });
    expect(map.complete).toBe(false);
    expect(map.skipped).toContainEqual({ path: 'Birchfield', reason: 'too-deep' });
    expect(map.fileCount).toBe(1);
  });

  it('marks the map incomplete and reports limitReached when the entry limit stops the walk', async () => {
    const map = await mapWith({ maxEntries: 2 });
    expect(map.limitReached).toBe(true);
    expect(map.complete).toBe(false);
    expect(map.skippedCount).toBeGreaterThan(0);
  });

  it('records an unreadable folder as unreadable and keeps walking the readable ones', async () => {
    const denied = join('Birchfield', 'Alder');
    const fs = {
      readdir: (directory: string, options?: object) => (directory.endsWith(denied)
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : readdir(directory, options)),
      lstat,
      realpath: nativeRealpath,
    };
    const map = await mapWith({}, fs);
    expect(map.complete).toBe(false);
    expect(map.skipped).toContainEqual({ path: 'Birchfield/Alder', reason: 'unreadable', code: 'EACCES' });
    // loose.txt, the board file and the schematic are counted; the unreadable folder's BIOS file is not.
    expect(map.fileCount).toBe(3);
  });

  it('keeps an entry whose metadata cannot be read as unknown, keeps its siblings, and marks the map incomplete', async () => {
    const denied = join(root, 'loose.txt');
    const fs = {
      readdir,
      lstat: (target: string) => (target === denied
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }))
        : lstat(target)),
      realpath: nativeRealpath,
    };
    const map = await mapWith({}, fs);
    expect(map.complete).toBe(false);
    expect(map.skipped).toContainEqual({ path: 'loose.txt', reason: 'unknown', code: 'EPERM' });
    // The folder itself was readable: its sibling entries are still mapped, and the unknown file is not counted.
    expect(map.root.folders.map(folder => folder.name)).toContain('Birchfield');
    expect(findFolder(map, 'Birchfield/Alder', platform)?.files.map(file => file.name)).toEqual(['MB-Q731_rev2_BIOS.bin']);
    expect(map.root.files).toHaveLength(0);
    expect(map.fileCount).toBe(3);
  });
});

describe('reparse points through the native adapter (W16-B4)', () => {
  it('a reparse point that is not a link is skipped with reason reparse, is not read, its siblings are mapped and the map is incomplete', async () => {
    const tree = mkdtempSync(join(canonicalTemp(), 'devices-reparse-'));
    mkdirSync(join(tree, 'Cloud', 'hidden'), { recursive: true });
    mkdirSync(join(tree, 'Plain'));
    writeFileSync(join(tree, 'Plain', 'board.brd'), 'x');
    const listed: string[] = [];
    // The listing's type says link for the cloud placeholder (readdir on Windows); its lstat is a plain directory, as Node reports it.
    const fake = {
      readdir: async (target: string, options?: object) => {
        listed.push(target);
        const items = await readdir(target, options as never) as unknown as Array<{ name: string }>;
        return items.map(item => (item.name === 'Cloud' ? { name: 'Cloud', isSymbolicLink: () => true } : item));
      },
      lstat,
      realpath: nativeRealpath,
    };
    try {
      const port = await adapter.createDirectoryPort({ root: tree, platform: process.platform, fs: fake });
      const map = await mapFolderTree(port, platform, DEFAULT_LIMITS);
      expect(map.skipped).toContainEqual({ path: 'Cloud', reason: 'reparse' });
      expect(listed.some(target => target.endsWith('Cloud'))).toBe(false);
      expect(findFolder(map, 'Plain', platform)?.fileCount).toBe(1);
      expect(map.complete).toBe(false);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('online-only files through the native adapter (W16-B4)', () => {
  it('a cloud placeholder file is mapped by name and size with online true, and its content is never opened', async () => {
    const tree = mkdtempSync(join(canonicalTemp(), 'devices-online-'));
    const placeholder = join(tree, 'Cloud.brd');
    writeFileSync(placeholder, Buffer.alloc(8192, 5));
    const opened: string[] = [];
    // The listing says link for the placeholder (readdir on Windows); its metadata says a file of two clusters with no allocated blocks.
    const fake = {
      readdir: async (target: string, options?: object) => {
        const items = await readdir(target, options as never) as unknown as Array<{ name: string }>;
        return items.map(item => (item.name === 'Cloud.brd' ? { name: 'Cloud.brd', isSymbolicLink: () => true } : item));
      },
      lstat: async (target: string, ...rest: unknown[]) => {
        if (target !== placeholder) return (lstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
        const real = await lstat(target);
        return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: real.size, blocks: 0 };
      },
      realpath: async (target: string) => { opened.push(target); return nativeRealpath(target); },
    };
    try {
      const port = await adapter.createDirectoryPort({ root: tree, platform: process.platform, fs: fake });
      const map = await mapFolderTree(port, platform, DEFAULT_LIMITS);
      expect(map.root.files).toEqual([expect.objectContaining({ name: 'Cloud.brd', size: 8192, online: true })]);
      expect(opened.some(target => target.endsWith('Cloud.brd'))).toBe(false);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
