/**
 * Cross-platform name identity: the same file names on win32, darwin and linux give the same identity. The identity is read from
 * the canonical "/"-joined relative path only, so these tests use synthetic names and need no host file system.
 *
 * KNOWN DEFECT / KNOWN GAP tests are `it.fails`: they stay green while the current behaviour differs from the expectation.
 */
import { describe, expect, it } from 'vitest';
import { extractIdentity, type FileIdentity } from './identity';
import type { DevicePlatform } from './paths';

const PLATFORMS: readonly DevicePlatform[] = ['win32', 'darwin', 'linux'];

describe('[rule] board codes in names', () => {
  it.each<[string, string, string | null]>([
    ['Birchfield/Kestrel-14-R2/MB-Q731_rev2.brd', 'MB-Q731', '2'],
    ['Birchfield/Kestrel-14-R2/MB Q731 rev 2 copy.brd', 'MB-Q731', '2'],
    ['Birchfield/Kestrel-14-R2/mb-q731 REV02.BRD', 'MB-Q731', '2'],
    ['Birchfield/Kestrel-14-R2/MBQ731.brd', 'MB-Q731', '2'],
    ['Tessaly/Mirror/BD-K1402_rev1.brd', 'BD-K1402', '1'],
    ['Tessaly/Mirror/BD-K1402_rev3.brd', 'BD-K1402', '3'],
    ['Tessaly/Symbols/[LB-N77] (rev 2) & friends #1.v2.brd', 'LB-N77', '2'],
    ['Quarrel/MB-Q731/board.brd', 'MB-Q731', null],
  ])('%s gives board code %s', (path, code, revision) => {
    const identity = extractIdentity(path, { platform: 'linux' });
    expect(identity.boardCode).toBe(code);
    expect(identity.boardCodeConfidence).toBeGreaterThanOrEqual(50);
    if (revision !== null) expect(identity.revision?.normalized).toBe(revision);
  });

  it('a name with no code gets no board code and no confidence', () => {
    const identity = extractIdentity('Quarrel/uncertain/board.brd', { platform: 'linux' });
    expect(identity.boardCode).toBeUndefined();
    expect(identity.boardCodeConfidence).toBe(0);
  });

  // Decided D5: a name with two different codes is ambiguous. It gives no board code and no confidence, and it lists the codes.
  it('a name with two different board codes is ambiguous: no code, no confidence, both codes listed (decided D5)', () => {
    const identity = extractIdentity('Quarrel/uncertain/MB-Q731 vs MB-Q732.brd', { platform: 'linux' });
    expect(identity.boardCode).toBeUndefined();
    expect(identity.boardCodeConfidence).toBe(0);
    expect(identity.ambiguousCodes).toEqual(['MB-Q731', 'MB-Q732']);
    expect(identity.aliases).toEqual(['quarrel', 'uncertain']);
  });

  it('the same code written twice in one name is not ambiguous', () => {
    const identity = extractIdentity('Birchfield/Kestrel-14-R2/MB-Q731_rev2 MB Q731 copy.brd', { platform: 'linux' });
    expect(identity.boardCode).toBe('MB-Q731');
    expect(identity.ambiguousCodes).toBeUndefined();
  });

  it('an ambiguous name gives no code from the folders either: the folder codes do not confirm the file', () => {
    const identity = extractIdentity('Tessaly/BD-K1402/MB-Q731 vs MB-Q732.brd', { platform: 'linux' });
    expect(identity.boardCode).toBeUndefined();
    expect(identity.ambiguousCodes).toEqual(['MB-Q731', 'MB-Q732']);
  });
});

describe('[rule] file role from the extension and name tokens', () => {
  it.each<[string, FileIdentity['role']]>([
    ['Birchfield/Kestrel-14-R2/MB-Q731_rev2.BRD', 'boardview'],
    ['Alder/Orion-5/MB-Q731_rev2_BIOS.bin', 'bios-candidate'],
    ['Alder/Orion-5/MB-Q731_rev2.BIN', 'bios-candidate'],
    ['Alder/Orion-5/MB-Q731.Rom', 'bios-candidate'],
    ['Alder/Orion-5/MB-Q731_rev2_EC.Bin', 'ec-firmware'],
    ['Alder/Orion-5/MB-Q731_ME.hex', 'me-firmware'],
    ['Alder/Orion-5/MB-Q731_dump.rom', 'saved-dump'],
    ['Alder/Orion-5/MB-Q731_mentett.bin', 'saved-dump'],
  ])('%s has role %s', (path, role) => {
    expect(extractIdentity(path, { platform: 'darwin' }).role).toBe(role);
  });

  it('a firmware extension alone is only a candidate: its role basis is the extension, never a verified BIOS', () => {
    const identity = extractIdentity('Alder/Orion-5/MB-Q731_rev2.bin', { platform: 'win32' });
    expect(identity.role).toBe('bios-candidate');
    expect(identity.roleBasis).toBe('extension');
  });

  it('a user role override wins over the name, for every platform', () => {
    for (const platform of PLATFORMS) {
      const identity = extractIdentity('Alder/Orion-5/MB-Q731_rev2.bin', { platform, roleOverride: 'other' });
      expect(identity.role).toBe('other');
      expect(identity.roleBasis).toBe('correction');
    }
  });

  it('a schematic name with a revision token gives the schematic role and the revision', () => {
    const identity = extractIdentity('Birchfield/Kestrel-14-R2/docs/Kestrel14_R02_schematic.pdf', { platform: 'linux' });
    expect(identity.role).toBe('schematic');
    expect(identity.revision?.normalized).toBe('2');
    expect(identity.aliases).toContain('kestrel14');
  });
});

describe('[rule] unicode, accents and letter case', () => {
  it('NFC and NFD spellings of one name give the same identity apart from the stored path', () => {
    const folder = 'Ágnes Böngésző'.normalize('NFC');
    const nfc = extractIdentity(`${folder}/${'LB-N77 Ágnes.brd'.normalize('NFC')}`, { platform: 'win32' });
    const nfd = extractIdentity(`${folder}/${'LB-N77 Ágnes.brd'.normalize('NFD')}`, { platform: 'win32' });
    expect(nfd.boardCode).toBe(nfc.boardCode);
    expect(nfd.role).toBe(nfc.role);
    expect(nfd.aliases).toEqual(nfc.aliases);
    expect(nfc.aliases).toEqual(expect.arrayContaining(['agnes', 'bongeszo']));
  });

  it('two names that differ only by letter case give the same identity (the path itself is kept as written)', () => {
    const lower = extractIdentity('Quarrel/case/lb-n77_rev2.BRD', { platform: 'linux' });
    const upper = extractIdentity('Quarrel/case/LB-N77_REV2.brd', { platform: 'linux' });
    expect({ ...lower, path: '' }).toEqual({ ...upper, path: '' });
    expect(lower.path).not.toBe(upper.path);
  });

  it('accented folder and file names contribute ASCII search aliases', () => {
    const identity = extractIdentity('Ágnes Böngésző/LB-N77 Ágnes.brd', { platform: 'darwin' });
    expect(identity.aliases).toEqual(expect.arrayContaining(['agnes', 'bongeszo']));
  });

  it('a Cyrillic folder name gives an alias (the Ukrainian locale uses Cyrillic names)', () => {
    // aliasesOf keeps tokens that contain a Unicode letter (\p{L}), so Cyrillic tokens are kept on every platform.
    const identity = extractIdentity('Плата/Кестрел-14/Кестрел-14_rev2.brd', { platform: 'linux' });
    expect(identity.revision?.normalized).toBe('2');
    expect(identity.aliases).toContain('кестрел');
  });
});

describe('[rule] generic words and hidden names', () => {
  it('generic words never become aliases; a folder name does', () => {
    const identity = extractIdentity('Quarrel/uncertain/board.brd', { platform: 'linux' });
    expect(identity.aliases).toContain('quarrel');
    expect(identity.aliases).not.toContain('board');
  });

  it('a hidden board file (leading dot) keeps its code and role', () => {
    const identity = extractIdentity('Sidecars/.LB-N77_hidden.brd', { platform: 'darwin' });
    expect(identity.role).toBe('boardview');
    expect(identity.boardCode).toBe('LB-N77');
  });

  it('a file name with only a leading dot has no extension', () => {
    expect(extractIdentity('Empty/.keep', { platform: 'linux' }).role).toBe('other');
  });
});

describe('[rule] bounded output', () => {
  it('a very long name gives a bounded, sorted, unique alias list', () => {
    const longName = `MB-Q731-${Array.from({ length: 40 }, (_value, index) => `word${index}`).join('-')}.brd`;
    const identity = extractIdentity(`Alder/${longName}`, { platform: 'win32' });
    expect(identity.aliases.length).toBeLessThanOrEqual(16);
    expect([...identity.aliases].sort()).toEqual(identity.aliases);
    expect(new Set(identity.aliases).size).toBe(identity.aliases.length);
    expect(identity.boardCode).toBe('MB-Q731');
  });

  it('a deep path (10 folders) still reads the code from the name', () => {
    const folders = Array.from({ length: 10 }, (_value, index) => `level-${String(index).padStart(2, '0')}-synthetic-folder-name`);
    const identity = extractIdentity([...folders, 'BD-K1402_rev3_deep.brd'].join('/'), { platform: 'win32' });
    expect(identity.boardCode).toBe('BD-K1402');
    expect(identity.revision?.normalized).toBe('3');
  });
});

describe('[rule] the identity does not depend on the platform option', () => {
  const samples = [
    'Birchfield/Kestrel-14-R2/MB-Q731_rev2.brd',
    'Ágnes Böngésző/LB-N77 Ágnes.brd',
    'Alder/Orion-5/MB-Q731_rev2_BIOS.bin',
    'Quarrel/uncertain/board.brd',
    'Плата/Кестрел-14/Кестрел-14_rev2.brd',
  ];
  it.each(samples)('%s is identical on every platform', path => {
    const results = PLATFORMS.map(platform => extractIdentity(path, { platform }));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});
