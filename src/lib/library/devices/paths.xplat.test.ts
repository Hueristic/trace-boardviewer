/**
 * Cross-platform rules of the relative path helpers. Every case is a synthetic string and the platform is an argument, so these
 * tests give the same result on any host. Host file-system facts are in folder-map.xplat.test.ts, not here.
 *
 * Tags used in titles:
 *   [rule]     a rule of this module, the same on every host
 *   KNOWN DEFECT / KNOWN GAP  the current implementation does not meet the expectation; the test is written as `it.fails`, so it
 *              stays green until the behaviour changes, and turns red when the defect is fixed (then remove the marker).
 */
import { describe, expect, it } from 'vitest';
import { MAX_RELATIVE_SEGMENTS, canonicalPath, identityKey, parseRelativePath, searchKey, spellingKey, type DevicePlatform } from './paths';

const BACKSLASH = String.fromCharCode(92);
const PLATFORMS: readonly DevicePlatform[] = ['win32', 'darwin', 'linux'];

describe('[rule] separators', () => {
  it.each<[string, DevicePlatform, string[]]>([
    ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd', 'win32', ['Birchfield', 'Kestrel-14-R2', 'MB-Q731.brd']],
    ['Birchfield/Kestrel-14-R2\\MB-Q731.brd', 'win32', ['Birchfield', 'Kestrel-14-R2', 'MB-Q731.brd']],
    ['Birchfield\\\\Kestrel-14-R2\\\\\\MB-Q731.brd', 'win32', ['Birchfield', 'Kestrel-14-R2', 'MB-Q731.brd']],
    ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd', 'darwin', ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd']],
    ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd', 'linux', ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd']],
    ['Birchfield/Kestrel-14-R2/MB-Q731.brd', 'darwin', ['Birchfield', 'Kestrel-14-R2', 'MB-Q731.brd']],
    ['Birchfield/Kestrel-14-R2/MB-Q731.brd', 'linux', ['Birchfield', 'Kestrel-14-R2', 'MB-Q731.brd']],
    ['a//b/./c/', 'linux', ['a', 'b', 'c']],
    ['a//b/./c/', 'win32', ['a', 'b', 'c']],
  ])('%j on %s splits into %j', (input, platform, expected) => {
    expect(parseRelativePath(input, platform)).toEqual({ ok: true, segments: expected });
  });

  it('a backslash inside a name is kept on darwin and linux, so the name is not split there', () => {
    const name = `old${BACKSLASH}copy.brd`;
    for (const platform of ['darwin', 'linux'] as const) {
      expect(parseRelativePath(name, platform)).toEqual({ ok: true, segments: [name] });
    }
  });
});

describe('[rule] drive letters and absolute spellings', () => {
  it.each<[string, DevicePlatform, string]>([
    ['C:\\Boards\\x.brd', 'win32', 'drive'],
    ['c:/Boards/x.brd', 'win32', 'drive'],
    ['Z:', 'win32', 'drive'],
    ['\\\\server\\share\\x.brd', 'win32', 'absolute'],
    ['\\\\?\\C:\\x.brd', 'win32', 'absolute'],
    ['\\\\?\\UNC\\server\\share\\x.brd', 'win32', 'absolute'],
    ['//server/share/x.brd', 'win32', 'absolute'],
    ['//server/share/x.brd', 'linux', 'absolute'],
    ['//server/share/x.brd', 'darwin', 'absolute'],
    ['/etc/boards/x.brd', 'darwin', 'absolute'],
  ])('%j on %s is refused as %s', (input, platform, reason) => {
    expect(parseRelativePath(input, platform)).toEqual({ ok: false, reason });
  });

  it('a drive-like prefix is an ordinary name where drives do not exist (darwin, linux)', () => {
    expect(parseRelativePath('C:/x.brd', 'linux')).toEqual({ ok: true, segments: ['C:', 'x.brd'] });
    expect(parseRelativePath('C:relative.brd', 'darwin')).toEqual({ ok: true, segments: ['C:relative.brd'] });
  });

  it('a backslash-led name is relative on darwin and linux, and refused as absolute on win32', () => {
    expect(parseRelativePath(`${BACKSLASH}${BACKSLASH}server${BACKSLASH}share`, 'linux')).toEqual({ ok: true, segments: [`${BACKSLASH}${BACKSLASH}server${BACKSLASH}share`] });
    expect(parseRelativePath(`${BACKSLASH}board.brd`, 'win32')).toEqual({ ok: false, reason: 'absolute' });
  });
});

describe('[rule] traversal stays inside the root', () => {
  it.each<[string, DevicePlatform]>([
    ['../secret.brd', 'win32'],
    ['../secret.brd', 'darwin'],
    ['../secret.brd', 'linux'],
    ['a/../../b', 'linux'],
    ['a/../b', 'darwin'],
    ['a\\..\\b', 'win32'],
    ['a/..\\b', 'win32'],
    ['..', 'win32'],
  ])('%j on %s is refused as escapes-root', (input, platform) => {
    expect(parseRelativePath(input, platform)).toEqual({ ok: false, reason: 'escapes-root' });
  });

  it('on darwin and linux, a backslash in a traversal-looking name is an ordinary name (no escape)', () => {
    const name = `..${BACKSLASH}b`;
    expect(parseRelativePath(`a/${name}`, 'linux')).toEqual({ ok: true, segments: ['a', name] });
    expect(parseRelativePath(`a/${name}`, 'darwin')).toEqual({ ok: true, segments: ['a', name] });
  });

  it.each<[string]>([['...'], ['.. x'], ['..x']])('%j is an ordinary name on every platform', input => {
    for (const platform of PLATFORMS) expect(parseRelativePath(input, platform)).toEqual({ ok: true, segments: [input] });
  });
});

describe('[rule] empty, dot-only and non-text input', () => {
  it.each<[string]>([[''], ['.'], ['./'], ['.//.']])('%j is empty on every platform', input => {
    for (const platform of PLATFORMS) expect(parseRelativePath(input, platform)).toEqual({ ok: false, reason: 'empty' });
  });

  it('a non-string value is refused without throwing', () => {
    for (const platform of PLATFORMS) {
      expect(parseRelativePath(undefined as unknown as string, platform)).toEqual({ ok: false, reason: 'empty' });
      expect(parseRelativePath(null as unknown as string, platform)).toEqual({ ok: false, reason: 'empty' });
    }
  });
});

describe('[rule] depth limit', () => {
  it.each<DevicePlatform>(PLATFORMS)('%s accepts exactly MAX_RELATIVE_SEGMENTS and refuses one more', platform => {
    const sep = platform === 'win32' ? '\\' : '/';
    const segments = (count: number) => Array.from({ length: count }, (_value, index) => `d${index}`);
    expect(parseRelativePath(segments(MAX_RELATIVE_SEGMENTS).join(sep), platform)).toMatchObject({ ok: true });
    expect(parseRelativePath(segments(MAX_RELATIVE_SEGMENTS + 1).join(sep), platform)).toEqual({ ok: false, reason: 'too-deep' });
  });
});

describe('[rule] long relative paths', () => {
  it('a relative path longer than 260 characters is accepted on every platform (the length limit is the OS, not this module)', () => {
    const segments = Array.from({ length: 10 }, (_value, index) => `level-${String(index).padStart(2, '0')}-synthetic-folder-name`);
    const deep = [...segments, 'BD-K1402_rev3_deep.brd'].join('/');
    expect(deep.length).toBeGreaterThan(260);
    for (const platform of PLATFORMS) {
      const result = parseRelativePath(platform === 'win32' ? deep.replaceAll('/', '\\') : deep, platform);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(canonicalPath(result.segments)).toBe(deep);
    }
  });
});

describe('[rule] identity keys', () => {
  const segments = ['Alder', 'Orion-5', 'MB-Q731_rev2.BIN'];

  it('win32 folds ASCII case, linux compares exactly', () => {
    expect(identityKey(segments, 'win32')).toBe('alder/orion-5/mb-q731_rev2.bin');
    expect(identityKey(segments, 'linux')).toBe('Alder/Orion-5/MB-Q731_rev2.BIN');
  });

  // Decided D8: darwin keys stay exact, whatever the volume policy. A case-only difference is handled as a case-collision in
  // catalogue.ts (needs a manual confirmation), not by folding here.
  it('darwin keys are exact for ASCII case (decided D8): the spelling is kept and no folding happens', () => {
    expect(identityKey(segments, 'darwin')).toBe('Alder/Orion-5/MB-Q731_rev2.BIN');
    expect(identityKey(['Alder', 'orion-5', 'mb-q731_rev2.bin'], 'darwin')).not.toBe(identityKey(segments, 'darwin'));
  });

  it('win32 folds non-ASCII letter case (Hungarian and Ukrainian names); linux compares exactly', () => {
    expect(identityKey(['ÁGNES Böngésző.brd'], 'win32')).toBe(identityKey(['ágnes böngésző.brd'], 'win32'));
    expect(identityKey(['ЛІНІЯ-1.brd'], 'linux')).not.toBe(identityKey(['лінія-1.brd'], 'linux'));
  });

  it('darwin keys are exact for non-ASCII case too (decided D8; Ukrainian names)', () => {
    expect(identityKey(['ЛІНІЯ-1.brd'], 'darwin')).not.toBe(identityKey(['лінія-1.brd'], 'darwin'));
  });

  it('spellingKey folds case and NFD to NFC for candidate search only; it never changes identityKey', () => {
    expect(spellingKey('Ágnes/MB-Q731.BRD'.normalize('NFD'))).toBe(spellingKey('Ágnes/mb-q731.brd'.normalize('NFC')));
    expect(identityKey(['MB-Q731.BRD'], 'darwin')).not.toBe(identityKey(['mb-q731.brd'], 'darwin'));
  });

  it('win32 keeps NFC and NFD spellings apart (NTFS keeps them as two names; see the Windows facts in folder-map.xplat.test.ts)', () => {
    const nfc = 'Ágnes.brd'.normalize('NFC');
    const nfd = 'Ágnes.brd'.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(identityKey([nfc], 'win32')).not.toBe(identityKey([nfd], 'win32'));
    expect(identityKey([nfc], 'linux')).not.toBe(identityKey([nfd], 'linux'));
  });

  it('the empty path has the empty key on every platform', () => {
    for (const platform of PLATFORMS) expect(identityKey([], platform)).toBe('');
  });

  it('the key never changes the segments; a key is not a name', () => {
    const input = ['Birchfield', 'MB-Q731.BRD'];
    identityKey(input, 'win32');
    expect(input).toEqual(['Birchfield', 'MB-Q731.BRD']);
  });
});

describe('[rule] search key of text', () => {
  it.each<[string, string]>([
    ['MB-Q731_rev2.BRD', 'mb q731 rev2 brd'],
    ['Kestrel_14-Plus.v2', 'kestrel 14 plus v2'],
    ['Őrség Űrhajó', 'orseg urhajo'],
    ['İzmir', 'izmir'],
    ['Кестрел-14', 'кестрел 14'],
    ['ＭＢ－Ｑ７３１', 'mb q731'],
    ['ﬁle', 'file'],
    ['a\\b/c.d', 'a b c d'],
    ['   ', ''],
  ])('%j becomes %j', (input, expected) => {
    expect(searchKey(input)).toBe(expected);
  });

  it('NFC and NFD spellings of the same accented name give the same search key', () => {
    expect(searchKey('Ágnes Böngésző'.normalize('NFC'))).toBe(searchKey('Ágnes Böngésző'.normalize('NFD')));
    expect(searchKey('Ágnes Böngésző'.normalize('NFD'))).toBe('agnes bongeszo');
  });

  it('an emoji or a surrogate pair is kept without throwing', () => {
    expect(() => searchKey('board \u{1F4DF} x')).not.toThrow();
    expect(searchKey('x\u{1F600}y')).toBe('x\u{1F600}y');
  });

  it('Polish stroke letters are folded (the name "Łódź" gives the key of "Lodz")', () => {
    // NFKD does not decompose the stroked L (U+0141 and U+0142), so searchKey folds them to l and L explicitly.
    expect(searchKey('Łódź')).toBe('lodz');
    expect(searchKey('Wrocław Łąka')).toBe('wroclaw laka');
  });
});
