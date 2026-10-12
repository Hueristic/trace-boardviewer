import { describe, expect, it } from 'vitest';
import { MAX_RELATIVE_SEGMENTS, baseName, canonicalPath, collidingKeys, extensionOf, identityKey, parseRelativePath, searchKey } from './paths';

describe('relative path parsing', () => {
  const rows: Array<[string, 'win32' | 'darwin' | 'linux', string[] | string]> = [
    ['Birchfield/Kestrel-14-R2/MB-Q731.brd', 'win32', ['Birchfield', 'Kestrel-14-R2', 'MB-Q731.brd']],
    ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd', 'win32', ['Birchfield', 'Kestrel-14-R2', 'MB-Q731.brd']],
    ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd', 'linux', ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd']],
    ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd', 'darwin', ['Birchfield\\Kestrel-14-R2\\MB-Q731.brd']],
    ['./a//b/./c.bin', 'linux', ['a', 'b', 'c.bin']],
    ['a/../b', 'linux', 'escapes-root'],
    ['a\\..\\b', 'win32', 'escapes-root'],
    ['/etc/passwd', 'linux', 'absolute'],
    ['\\\\server\\share\\x.brd', 'win32', 'absolute'],
    ['C:\\Boards\\x.brd', 'win32', 'drive'],
    ['C:relative.brd', 'linux', ['C:relative.brd']],
    ['', 'linux', 'empty'],
    ['.', 'win32', 'empty'],
  ];
  it.each(rows)('%j on %s', (input, platform, expected) => {
    const result = parseRelativePath(input, platform);
    if (Array.isArray(expected)) {
      expect(result).toEqual({ ok: true, segments: expected });
    } else {
      expect(result).toEqual({ ok: false, reason: expected === 'escapes-root' ? 'escapes-root' : expected });
    }
  });

  it('refuses paths deeper than the segment limit', () => {
    const deep = Array.from({ length: MAX_RELATIVE_SEGMENTS + 1 }, (_value, index) => `d${index}`).join('/');
    expect(parseRelativePath(deep, 'linux')).toEqual({ ok: false, reason: 'too-deep' });
    expect(parseRelativePath(deep.split('/').slice(1).join('/'), 'linux')).toMatchObject({ ok: true });
  });

  it('refuses non-string input without throwing', () => {
    expect(parseRelativePath(42 as unknown as string, 'win32')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('identity keys', () => {
  it('folds case on win32 only; darwin and linux keep the spelling, because darwin volumes may be case-sensitive', () => {
    const segments = ['Alder', 'Orion-5', 'MB-Q731_rev2.BIN'];
    expect(identityKey(segments, 'win32')).toBe('alder/orion-5/mb-q731_rev2.bin');
    expect(identityKey(segments, 'darwin')).toBe('Alder/Orion-5/MB-Q731_rev2.BIN');
    expect(identityKey(segments, 'linux')).toBe('Alder/Orion-5/MB-Q731_rev2.BIN');
    expect(canonicalPath(segments)).toBe('Alder/Orion-5/MB-Q731_rev2.BIN');
  });

  it('keeps two darwin names that differ only by case apart', () => {
    expect(identityKey(['MB.brd'], 'darwin')).not.toBe(identityKey(['mb.brd'], 'darwin'));
  });
});

describe('collisions', () => {
  it('reports a key that two distinct paths share, and nothing else', () => {
    const entries = [
      { key: identityKey(['a', 'MB.brd'], 'win32'), path: 'a/MB.brd' },
      { key: identityKey(['a', 'mb.brd'], 'win32'), path: 'a/mb.brd' },
      { key: identityKey(['a', 'other.brd'], 'win32'), path: 'a/other.brd' },
    ];
    expect([...collidingKeys(entries)]).toEqual(['a/mb.brd']);
  });

  it('does not report one path listed twice as a collision', () => {
    expect(collidingKeys([{ key: 'k', path: 'x' }, { key: 'k', path: 'x' }]).size).toBe(0);
  });
});

describe('search key', () => {
  const rows: Array<[string, string]> = [
    ['MB-Q731_rev2.BRD', 'mb q731 rev2 brd'],
    ['Kestrel  14   Plus', 'kestrel 14 plus'],
    ['Ágnes_Böngésző', 'agnes bongeszo'],
    ['Cafe\u0301', 'cafe'],
    ['a\\b/c.d', 'a b c d'],
    ['', ''],
  ];
  it.each(rows)('%j becomes %j', (input, expected) => {
    expect(searchKey(input)).toBe(expected);
  });
  it('is bounded: text beyond 1024 units is ignored', () => {
    expect(searchKey(`${'x'.repeat(1024)}yyyy`)).toHaveLength(1024);
  });
  it('tolerates a non-string', () => {
    expect(searchKey(null as unknown as string)).toBe('');
  });
});

describe('name helpers', () => {
  it('reads the last segment and the lower-case extension', () => {
    expect(baseName('a/b/MB-Q731.BRD')).toBe('MB-Q731.BRD');
    expect(baseName('solo.bin')).toBe('solo.bin');
    expect(extensionOf('MB-Q731.BRD')).toBe('brd');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
});
