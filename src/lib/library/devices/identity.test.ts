import { describe, expect, it } from 'vitest';
import { extractIdentity, revisionsDiffer } from './identity';

const opts = { platform: 'linux' as const };

describe('file identity from the path', () => {
  it('reads the board code, revision and role of a board file with a label-prefixed code', () => {
    const id = extractIdentity('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', opts);
    expect(id.boardCode).toBe('MB-Q731');
    expect(id.boardCodeConfidence).toBe(55);
    expect(id.revision?.normalized).toBe('2');
    expect(id.role).toBe('boardview');
    expect(id.roleBasis).toBe('analysis');
    expect(id.aliases).toEqual(['birchfield', 'kestrel']);
  });

  it('reads a schematic PDF by its document words', () => {
    const id = extractIdentity('Birchfield/Kestrel-14-R2/docs/Kestrel14_R02_schematic.pdf', opts);
    expect(id.role).toBe('schematic');
    expect(id.revision?.normalized).toBe('2');
  });

  it('treats a firmware extension as a BIOS candidate only, and keeps its code', () => {
    const id = extractIdentity('Alder/Orion-5/MB-Q731_rev2_BIOS.bin', opts);
    expect(id.role).toBe('bios-candidate');
    expect(id.roleBasis).toBe('extension');
    expect(id.boardCode).toBe('MB-Q731');
    expect(id.revision?.normalized).toBe('2');
  });

  it('does not read a "backup" folder as a saved dump', () => {
    const id = extractIdentity('backup/Orion5_Q731_R1.rom', opts);
    expect(id.role).toBe('bios-candidate');
    expect(id.revision?.normalized).toBe('1');
  });

  it('keeps generic names generic: no board code, no alias from "BIOS" or "main"', () => {
    const bios = extractIdentity('Alder/Orion-5/BIOS_backup.bin', opts);
    expect(bios.boardCode).toBeUndefined();
    expect(bios.aliases).toEqual(['alder', 'orion']);
    const main = extractIdentity('misc/mainboard.bin', opts);
    expect(main.role).toBe('bios-candidate');
    expect(main.boardCode).toBeUndefined();
    expect(main.aliases).toEqual([]);
  });

  it('separates EC and ME firmware from the BIOS candidates by name tokens', () => {
    expect(extractIdentity('Alder/Orion-5/EC-Q731.bin', opts).role).toBe('ec-firmware');
    expect(extractIdentity('Alder/Orion-5/ME_Q731.bin', opts).role).toBe('me-firmware');
    expect(extractIdentity('Alder/Orion-5/dump_Q731.bin', opts).role).toBe('saved-dump');
    expect(extractIdentity('Alder/Orion-5/MB-Q731.fd', opts).role).toBe('bios-candidate');
  });

  it('applies a user role override and marks it as a correction', () => {
    const id = extractIdentity('Alder/Orion-5/MB-Q731.fd', { platform: 'linux', roleOverride: 'saved-dump' });
    expect(id.role).toBe('saved-dump');
    expect(id.roleBasis).toBe('correction');
    expect(id.evidence.find(item => item.field === 'role')?.source).toBe('correction');
  });

  it('reads a file with no folder and a file name with a space or an accent', () => {
    const id = extractIdentity('Kestrel 14 Plus notes.pdf', opts);
    expect(id.aliases).toEqual(['kestrel', 'notes', 'plus']);
    expect(id.role).toBe('other');
  });

  it('does not produce a board code for an unrelated number', () => {
    const id = extractIdentity('misc/readme 12.txt', opts);
    expect(id.boardCode).toBeUndefined();
  });

  it('is total on an empty or odd path', () => {
    expect(extractIdentity('', opts).path).toBe('');
    expect(extractIdentity('a//b/', opts).path).toBe('a/b');
  });

  it('keeps every fact with its source and segment', () => {
    const id = extractIdentity('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', opts);
    const code = id.evidence.find(item => item.field === 'board-code');
    expect(code).toMatchObject({ value: 'MB-Q731', source: 'label', segment: 3, confidence: 55 });
  });
});

describe('revision comparison', () => {
  const rev = (normalized: string, rank: number[]) => ({ normalized, scheme: 'number' as const, rank });
  it('is undefined when either side is missing or the schemes differ', () => {
    expect(revisionsDiffer(undefined, rev('2', [2]))).toBeUndefined();
    expect(revisionsDiffer(rev('2', [2]), { normalized: 'A', scheme: 'letter', rank: [1] })).toBeUndefined();
  });
  it('is false for equal and true for different revisions of one scheme', () => {
    expect(revisionsDiffer(rev('2', [2]), rev('2', [2]))).toBe(false);
    expect(revisionsDiffer(rev('1', [1]), rev('2', [2]))).toBe(true);
  });
});
