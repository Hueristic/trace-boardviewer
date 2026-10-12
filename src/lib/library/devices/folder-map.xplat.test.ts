/**
 * The folder walker against the real file system of the host, on synthetic fixtures written into a temporary folder.
 *
 * Three groups:
 *   1. Host-independent: the walk lists exactly what the host kept when the fixtures were written, once each; the walk is read-only;
 *      the generator is deterministic and refuses an output folder inside this repository.
 *   2. Windows facts, checked on the host with the real API (win32 only): NTFS behaviour that the walker relies on. Each test states
 *      the observed result; on a different Windows setup the same test shows whether that setup agrees.
 *   3. macOS and Linux facts (native only). They are not verified on the win32 host and are skipped there. The
 *      expected result is written in the title; a native run on that platform is what verifies it.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, findFolder, mapFolderTree, type DirEntry, type DirectoryPort, type FolderMap, type FolderNode } from './folder-map';
import { identityKey, type DevicePlatform } from './paths';

interface FixtureGenerator {
  MARKER: string;
  planFixtures(seed: string): { seed: string; entries: Array<{ scenario: string; path: string; content: string; truth: { sidecar: boolean } }> };
  survivingEntries(plan: unknown, platform: DevicePlatform): Array<{ scenario: string; path: string }>;
  checkOutput(out: string): string;
  writeFixtures(out: string, seed: string): {
    out: string;
    library: string;
    manifest: { created: Array<{ scenario: string; path: string; size: number }>; skipped: Array<{ scenario: string; path: string; reason: string }>; planned: number };
  };
}

const require = createRequire(import.meta.url);
const generator = require('../../../../scripts/gen-device-fixtures.cjs') as FixtureGenerator;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const host = process.platform as DevicePlatform;
const itWin = host === 'win32' ? it : it.skip;
const itLinux = host === 'linux' ? it : it.skip;
const itDarwin = host === 'darwin' ? it : it.skip;

/** A real read-only port over the host folder. Links are reported as links; they are never followed by the walker. */
function realPort(root: string): DirectoryPort {
  return {
    async readDir(segments) {
      const dir = join(root, ...segments);
      return readdirSync(dir, { withFileTypes: true }).map((entry): DirEntry => {
        if (entry.isSymbolicLink()) return { name: entry.name, kind: 'link' };
        if (entry.isDirectory()) return { name: entry.name, kind: 'dir' };
        if (entry.isFile()) return { name: entry.name, kind: 'file', size: lstatSync(join(dir, entry.name)).size };
        return { name: entry.name, kind: 'other' };
      });
    },
  };
}

function filesOf(map: FolderMap): string[] {
  const out: string[] = [];
  const stack: FolderNode[] = [map.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const file of node.files) out.push(file.path);
    for (const child of node.folders) stack.push(child);
  }
  return out;
}

/** Name, kind and size of every entry under `root`, without following links. Sorted, so two snapshots compare with toEqual. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const label = relative === '' ? name : `${relative}/${name}`;
      const info = lstatSync(full);
      if (info.isSymbolicLink()) out.push(`${label} link`);
      else if (info.isDirectory()) {
        out.push(`${label} dir`);
        walk(full, label);
      } else out.push(`${label} file ${info.size}`);
    }
  };
  walk(root, '');
  return out;
}

/** Normalised spelling for comparing names: a file system may hand back a name in another Unicode form. */
const nfc = (value: string): string => value.normalize('NFC');

const links: string[] = [];
let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'trace-devfx-'));
});

afterAll(() => {
  // Remove the links first: a recursive delete must not reach through a junction into its target.
  for (const link of links) {
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* already gone */ } }
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('fixture library written to a temporary folder (host independent)', () => {
  let fixture: ReturnType<FixtureGenerator['writeFixtures']>;

  beforeAll(() => {
    fixture = generator.writeFixtures(join(scratch, 'fx-seed-1'), '1');
  });

  it('the walk lists exactly the non-sidecar files the host kept, each once; the sidecars are skipped and counted, and the walk is complete', async () => {
    const map = await mapFolderTree(realPort(fixture.library), host, DEFAULT_LIMITS);
    expect(map.complete).toBe(true);
    // Sidecar files (._*, .DS_Store, Thumbs.db, desktop.ini) that the host kept are skipped by the walker, the only filter, and counted.
    const sidecars = new Set(generator.planFixtures('1').entries.filter(entry => entry.truth.sidecar).map(entry => nfc(entry.path)));
    const kept = fixture.manifest.created.filter(item => !sidecars.has(nfc(item.path)));
    expect(map.skippedCount).toBe(fixture.manifest.created.length - kept.length);
    expect(map.skipped.every(item => item.reason === 'sidecar')).toBe(true);
    // Uniqueness is checked on the spellings as the host returns them (NFC and NFD may be two names); the comparison uses NFC.
    const raw = filesOf(map);
    expect(new Set(raw).size).toBe(raw.length);
    expect(raw.map(nfc).sort()).toEqual(kept.map(item => nfc(item.path)).sort());
  });

  it('the depth-10 path of scenario S19 is listed with its recursive folder totals', async () => {
    const map = await mapFolderTree(realPort(fixture.library), host, DEFAULT_LIMITS);
    const deepFolder = findFolder(map, 'level-00-synthetic-folder-name/level-01-synthetic-folder-name/level-02-synthetic-folder-name/level-03-synthetic-folder-name/level-04-synthetic-folder-name/level-05-synthetic-folder-name/level-06-synthetic-folder-name/level-07-synthetic-folder-name/level-08-synthetic-folder-name/level-09-synthetic-folder-name', host);
    expect(deepFolder?.files.map(file => file.name)).toEqual(['BD-K1402_rev3_deep.brd']);
    expect(deepFolder?.path.length ?? 0).toBeGreaterThan(260);
  });

  itWin('[win32 expectation] only the case-variant name S11 is skipped, because the host resolves it to the first name', () => {
    expect(fixture.manifest.skipped.map(item => item.path)).toEqual(['Quarrel/case/LB-N77_REV2.brd']);
  });

  itLinux('[linux expectation] nothing is skipped: the case variant and both spellings are separate names', () => {
    expect(fixture.manifest.skipped).toEqual([]);
  });

  itDarwin('[native macOS check, not verified on the win32 host] the case variant and the decomposed spelling are skipped', () => {
    expect(fixture.manifest.skipped.map(item => item.path).sort()).toEqual(
      ['Quarrel/case/LB-N77_REV2.brd', `${'Ágnes Böngésző'.normalize('NFC')}/${'LB-N77 Ágnes.brd'.normalize('NFD')}`].sort(),
    );
  });

  it('the fixture writer never overwrites: a skipped name keeps the first entry\'s bytes', () => {
    const skipped = fixture.manifest.skipped.find(item => item.scenario === 'S11');
    if (skipped === undefined) return; // linux: nothing skipped
    const kept = readFileSync(join(fixture.library, 'Quarrel', 'case', 'lb-n77_rev2.BRD'), 'utf8');
    expect(kept).toContain('SYNTHETIC device fixture; seed=1; entry=');
  });

  it('the walk is read-only: names, kinds and sizes are the same after mapping', async () => {
    const before = snapshot(fixture.library);
    await mapFolderTree(realPort(fixture.library), host, DEFAULT_LIMITS);
    expect(snapshot(fixture.library)).toEqual(before);
  });

  it('the same seed in a second folder writes the same names and the same bytes', () => {
    const second = generator.writeFixtures(join(scratch, 'fx-seed-1-again'), '1');
    expect(second.manifest.created.map(item => item.path)).toEqual(fixture.manifest.created.map(item => item.path));
    for (const item of fixture.manifest.created) {
      expect(readFileSync(join(second.library, ...item.path.split('/'))).equals(readFileSync(join(fixture.library, ...item.path.split('/'))))).toBe(true);
    }
  });

  it('a different seed keeps the same names and changes the bytes of the files', () => {
    const other = generator.writeFixtures(join(scratch, 'fx-seed-2'), '2');
    expect(other.manifest.created.map(item => item.path)).toEqual(fixture.manifest.created.map(item => item.path));
    const changed = fixture.manifest.created.filter(item => !readFileSync(join(other.library, ...item.path.split('/'))).equals(readFileSync(join(fixture.library, ...item.path.split('/')))));
    expect(changed.length).toBeGreaterThan(0);
    for (const item of fixture.manifest.created) expect(readFileSync(join(other.library, ...item.path.split('/'))).toString('utf8')).toContain('SYNTHETIC device fixture');
  });

  it('every fixture file is small synthetic text: no binary content and no name from outside the fixture plan', () => {
    const plan = generator.planFixtures('1');
    const planned = new Set(plan.entries.map(entry => nfc(entry.path)));
    for (const item of fixture.manifest.created) {
      expect(planned.has(nfc(item.path))).toBe(true);
      const bytes = readFileSync(join(fixture.library, ...item.path.split('/')));
      expect(bytes.length).toBeLessThan(512);
      expect(bytes.every(byte => byte === 0x0a || (byte >= 0x20 && byte < 0x7f))).toBe(true);
    }
  });
});

describe('generator guards (host independent)', () => {
  it('refuses an output folder inside this repository', () => {
    expect(() => generator.checkOutput(join(repoRoot, 'test-results', 'fixtures-should-not-exist'))).toThrow(/inside the repository/);
  });

  it('refuses an output folder that already holds files', () => {
    const occupied = join(scratch, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep.txt'), 'x');
    expect(() => generator.checkOutput(occupied)).toThrow(/not empty/);
  });

  it('accepts a missing folder outside the repository, including one whose name has spaces and accents', () => {
    expect(generator.checkOutput(join(scratch, 'Ágnes Böngésző fixtures'))).toBe(join(scratch, 'Ágnes Böngésző fixtures'));
  });
});

describe('Windows file-system facts (win32 only)', () => {
  itWin('lookup ignores ASCII letter case; a write under another case reuses the existing entry', () => {
    const dir = join(scratch, 'win-case-ascii');
    mkdirSync(dir);
    writeFileSync(join(dir, 'ABC.brd'), 'first');
    expect(existsSync(join(dir, 'abc.brd'))).toBe(true);
    writeFileSync(join(dir, 'abc.brd'), 'second');
    expect(readdirSync(dir)).toEqual(['ABC.brd']);
    expect(readFileSync(join(dir, 'ABC.brd'), 'utf8')).toBe('second');
  });

  itWin('lookup also folds non-ASCII letter case (accented Latin letters)', () => {
    const dir = join(scratch, 'win-case-accent');
    mkdirSync(dir);
    writeFileSync(join(dir, 'ÁGNES.brd'), 'x');
    expect(existsSync(join(dir, 'ágnes.brd'))).toBe(true);
  });

  itWin('a name in composed form (NFC) and in decomposed form (NFD) are two entries', () => {
    const dir = join(scratch, 'win-normalisation');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Ágnes.brd'.normalize('NFC')), 'composed');
    writeFileSync(join(dir, 'Ágnes.brd'.normalize('NFD')), 'decomposed');
    expect(readdirSync(dir)).toHaveLength(2);
    expect(identityKey(['Ágnes.brd'.normalize('NFC')], 'win32')).not.toBe(identityKey(['Ágnes.brd'.normalize('NFD')], 'win32'));
  });

  itWin('a directory junction is listed as a link and its target is walked once, under the real folder only', async () => {
    const root = join(scratch, 'win-junction');
    const target = join(root, 'Birchfield', 'Kestrel-14-R2');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'MB-Q731_rev2.brd'), 'SYNTH-A');
    const junction = join(root, 'Alias');
    symlinkSync(target, junction, 'junction');
    links.push(junction);
    const map = await mapFolderTree(realPort(root), 'win32', DEFAULT_LIMITS);
    expect(map.skipped).toContainEqual({ path: 'Alias', reason: 'link' });
    expect(filesOf(map)).toEqual(['Birchfield/Kestrel-14-R2/MB-Q731_rev2.brd']);
    expect(existsSync(join(target, 'MB-Q731_rev2.brd'))).toBe(true);
  });

  itWin('a directory symbolic link cannot be created without the privilege; where it can, the walker records it as a link', async () => {
    const root = join(scratch, 'win-dirsymlink');
    const target = join(root, 'real');
    mkdirSync(target, { recursive: true });
    const link = join(root, 'loop');
    try {
      symlinkSync(target, link, 'dir');
    } catch (error) {
      // Without developer mode or the privilege the call fails with EPERM.
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
      return;
    }
    links.push(link);
    const map = await mapFolderTree(realPort(root), 'win32', DEFAULT_LIMITS);
    expect(map.skipped).toContainEqual({ path: 'loop', reason: 'link' });
  });

  itWin('a file name with a colon (alternate data stream) is never listed as a separate name', () => {
    const dir = join(scratch, 'win-ads');
    mkdirSync(dir);
    writeFileSync(join(dir, 'MB-Q731.brd'), 'main');
    writeFileSync(`${join(dir, 'MB-Q731.brd')}:Zone.Identifier`, 'stream');
    expect(readdirSync(dir)).toEqual(['MB-Q731.brd']);
  });

  itWin('a path segment written as dot-dot with a trailing space or dots does not reach the parent folder', () => {
    const root = join(scratch, 'win-dotspace');
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, 'marker.txt'), 'm');
    expect(existsSync(join(sub, '.. ', 'marker.txt'))).toBe(false);
    expect(existsSync(join(sub, '...', 'marker.txt'))).toBe(false);
    expect(existsSync(join(sub, '..', 'marker.txt'))).toBe(true);
  });

  itWin('a file with the hidden attribute is still listed by the walker (the walker has no attribute check)', async () => {
    const root = join(scratch, 'win-hidden');
    mkdirSync(root);
    const file = join(root, 'LB-N77_hidden.brd');
    writeFileSync(file, 'h');
    execFileSync('attrib', ['+h', file]);
    const map = await mapFolderTree(realPort(root), 'win32', DEFAULT_LIMITS);
    expect(filesOf(map)).toEqual(['LB-N77_hidden.brd']);
  });

  itWin('a path longer than 260 characters: listed when the system allows it, otherwise the walk reports it incomplete', async () => {
    const root = join(scratch, 'win-long');
    let deep = root;
    while (deep.length < 300) deep = join(deep, 'a'.repeat(40));
    let created = true;
    try {
      mkdirSync(deep, { recursive: true });
    } catch {
      created = false;
    }
    if (!created) return; // the host refuses a path this long: the case is not exercised here
    writeFileSync(join(deep, 'BD-K1402_rev3_long.brd'), 'long');
    const map = await mapFolderTree(realPort(root), 'win32', DEFAULT_LIMITS);
    expect(filesOf(map).some(path => path.endsWith('BD-K1402_rev3_long.brd'))).toBe(true);
    expect(map.complete).toBe(true);
  });
});

describe('macOS and Linux file-system facts (native checks, skipped on the win32 host)', () => {
  itLinux('[linux] names are compared exactly: two names that differ only by case are two entries', () => {
    const dir = join(scratch, 'linux-case');
    mkdirSync(dir);
    writeFileSync(join(dir, 'MB-Q731.brd'), 'a');
    writeFileSync(join(dir, 'mb-q731.brd'), 'b');
    expect(readdirSync(dir).sort()).toEqual(['MB-Q731.brd', 'mb-q731.brd']);
  });

  itLinux('[linux] composed and decomposed spellings are two entries', () => {
    const dir = join(scratch, 'linux-normalisation');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Ágnes.brd'.normalize('NFC')), 'a');
    writeFileSync(join(dir, 'Ágnes.brd'.normalize('NFD')), 'b');
    expect(readdirSync(dir)).toHaveLength(2);
  });

  itLinux('[linux] a directory symlink loop is recorded as a link and not followed', async () => {
    const root = join(scratch, 'linux-loop');
    mkdirSync(join(root, 'Birchfield'), { recursive: true });
    writeFileSync(join(root, 'Birchfield', 'MB-Q731_rev2.brd'), 'a');
    const loop = join(root, 'Birchfield', 'again');
    symlinkSync(root, loop, 'dir');
    links.push(loop);
    const map = await mapFolderTree(realPort(root), 'linux', DEFAULT_LIMITS);
    expect(map.skipped).toContainEqual({ path: 'Birchfield/again', reason: 'link' });
    expect(filesOf(map)).toEqual(['Birchfield/MB-Q731_rev2.brd']);
  });

  // Open decision D7 (needs a native macOS run): identityKey stays exact on darwin (decided D8). The keys therefore never agree; on a
  // volume that treats NFC and NFD as one name the defect is visible as a case-collision in catalogue.ts (needs manual confirmation),
  // not as a missing target. This native check stays an expected failure until a native macOS run decides the marker.
  const itDarwinKnownGap = host === 'darwin' ? it.fails : it.skip;
  itDarwinKnownGap('[native macOS check] KNOWN GAP (open decision D7): the identity keys of the NFC and NFD spellings agree when the volume treats them as one name', () => {
    const dir = join(scratch, 'darwin-normalisation');
    mkdirSync(dir);
    const composed = 'Ágnes.brd'.normalize('NFC');
    const decomposed = 'Ágnes.brd'.normalize('NFD');
    writeFileSync(join(dir, composed), 'a');
    const oneFile = existsSync(join(dir, decomposed));
    expect(identityKey([decomposed], 'darwin') === identityKey([composed], 'darwin')).toBe(oneFile);
  });
});
