import { describe, expect, it } from 'vitest';
import { sourceBaseName, sourceSegments } from './adapter';
import { companionNames } from './registry';
import { baseName } from './sniff';

// A backslash is a separator on win32 and an ordinary character of a POSIX file name. Each case states the platform it is read on.
describe('sourceBaseName: the file name follows the platform separators', () => {
  it('on win32 both separators split the directories', () => {
    expect(sourceBaseName('dir\\Pins.ASC', 'win32')).toBe('Pins.ASC');
    expect(sourceBaseName('dir/Pins.ASC', 'win32')).toBe('Pins.ASC');
  });

  it('elsewhere only the slash splits the directories, so a backslash stays in the file name', () => {
    expect(sourceBaseName('dir\\Pins.ASC', 'linux')).toBe('dir\\Pins.ASC');
    expect(sourceBaseName('dir\\Pins.ASC', 'darwin')).toBe('dir\\Pins.ASC');
    expect(sourceBaseName('dir/Pins.ASC', 'darwin')).toBe('Pins.ASC');
  });

  it('an unknown platform keeps the rule the readers always used: both separators split (archive entry names)', () => {
    expect(sourceBaseName('dir\\Pins.ASC')).toBe('Pins.ASC');
    expect(sourceBaseName('dir\\Pins.ASC', undefined)).toBe('Pins.ASC');
  });

  it('a name without a separator is the whole name, and a trailing separator gives an empty name', () => {
    expect(sourceBaseName('Pins.ASC', 'linux')).toBe('Pins.ASC');
    expect(sourceBaseName('dir/', 'darwin')).toBe('');
  });
});

describe('sourceSegments: the directories follow the same platform rule', () => {
  it('on win32 both separators split; elsewhere only the slash does', () => {
    expect(sourceSegments('a\\b/c', 'win32')).toEqual(['a', 'b', 'c']);
    expect(sourceSegments('a\\b/c', 'linux')).toEqual(['a\\b', 'c']);
  });
});

describe('the sniff and companion helpers take the platform of a direct file', () => {
  it('baseName keeps a POSIX backslash in the name and drops it on win32', () => {
    expect(baseName('a\\B.ASC', 'linux')).toBe('a\\b.asc');
    expect(baseName('a\\B.ASC', 'win32')).toBe('b.asc');
    expect(baseName('a\\B.ASC')).toBe('b.asc');
  });

  it('a companion is found by its name on win32, and not under a POSIX name that holds a backslash', () => {
    expect(companionNames('format.asc').length).toBeGreaterThan(0);
    expect(companionNames('x\\format.asc', undefined, 'win32')).toEqual(companionNames('format.asc'));
    expect(companionNames('x\\format.asc', undefined, 'linux')).toEqual([]);
  });
});
