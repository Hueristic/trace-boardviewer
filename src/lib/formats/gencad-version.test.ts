import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GenCadParseError, parseGenCad, gencadVersionOf, rewriteGencadVersion, detectGencadUnits, sectionsFrom } from '../gencad';
import { parseBoard } from './index';
import { textInput } from '../formats/common';

const FIX = resolve(__dirname, '../../../tests/fixtures/gencad');

function readFixture(name: string): string {
  return readFileSync(resolve(FIX, name), 'latin1');
}

describe('GenCAD version gate', () => {
  it('1.4 parses normally', () => {
    const board = parseBoard(textInput(readFixture('gencad_1.4_MM.cad'), 'b.cad'));
    expect(board.format).toBe('GENCAD 1.4');
  });

  it('1.9 throws requiresGencad14 (version guard)', () => {
    let caught: unknown;
    try { parseBoard(textInput(readFixture('gencad_1.9_MM.cad'), 'b.cad')); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GenCadParseError);
    expect((caught as GenCadParseError).issue.key).toBe('parse.error.requiresGencad14');
  });

  it('2.0 throws requiresGencad14 (version guard)', () => {
    let caught: unknown;
    try { parseBoard(textInput(readFixture('gencad_2.0_MM.cad'), 'b.cad')); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GenCadParseError);
    expect((caught as GenCadParseError).issue.key).toBe('parse.error.requiresGencad14');
  });

  it('gencadVersionOf extracts the declared version', () => {
    expect(gencadVersionOf(readFixture('gencad_1.4_MM.cad'))).toBe('1.4');
    expect(gencadVersionOf(readFixture('gencad_1.9_MM.cad'))).toBe('1.9');
    expect(gencadVersionOf(readFixture('gencad_2.0_MM.cad'))).toBe('2.0');
  });

  it('rewriteGencadVersion rewrites 1.9 -> 1.4', () => {
    const text = readFixture('gencad_1.9_MM.cad');
    const rewritten = rewriteGencadVersion(text);
    expect(rewritten).toContain('GENCAD 1.4');
    expect(rewritten).not.toContain('GENCAD 1.9');
  });

  it('rewriteGencadVersion rewrites 2.0 -> 1.4', () => {
    const text = readFixture('gencad_2.0_MM.cad');
    const rewritten = rewriteGencadVersion(text);
    expect(rewritten).toContain('GENCAD 1.4');
    expect(rewritten).not.toContain('GENCAD 2.0');
  });

  it('rewriteGencadVersion leaves 1.4 unchanged', () => {
    const text = readFixture('gencad_1.4_MM.cad');
    expect(rewriteGencadVersion(text)).toBe(text);
  });
});

describe('GenCAD unit inference', () => {
  it('1.4 MM file parses with mm units', () => {
    const board = parseGenCad(readFixture('gencad_1.4_MM.cad'), 'b.cad');
    expect(board.units).toBe('mm');
  });

  it('1.4 MILS file parses with mm units (scaled from mils)', () => {
    const board = parseGenCad(readFixture('gencad_1.4_MILS.cad'), 'b.cad');
    expect(board.units).toBe('mm');
  });

  it('1.4 INCH file parses with mm units', () => {
    const board = parseGenCad(readFixture('gencad_1.4_INCH.cad'), 'b.cad');
    expect(board.units).toBe('mm');
  });

  it('1.9 MM file parses with mm units (after version rewrite)', () => {
    const text = rewriteGencadVersion(readFixture('gencad_1.9_MM.cad'));
    const board = parseGenCad(text, 'b.cad');
    expect(board.units).toBe('mm');
  });

  it('1.9 MILS file parses with mm units (after version rewrite)', () => {
    const text = rewriteGencadVersion(readFixture('gencad_1.9_MILS.cad'));
    const board = parseGenCad(text, 'b.cad');
    expect(board.units).toBe('mm');
  });

  it('2.0 MM file parses with mm units (after version rewrite)', () => {
    const text = rewriteGencadVersion(readFixture('gencad_2.0_MM.cad'));
    const board = parseGenCad(text, 'b.cad');
    expect(board.units).toBe('mm');
  });

  it('2.0 MILS file parses with mm units (after version rewrite)', () => {
    const text = rewriteGencadVersion(readFixture('gencad_2.0_MILS.cad'));
    const board = parseGenCad(text, 'b.cad');
    expect(board.units).toBe('mm');
  });

  it('real 1.9 board (no UNITS) infers MILS correctly', () => {
    const text = rewriteGencadVersion(readFileSync('/home/lichelord/Downloads/TUF-RX6900XT-O16G-I3SR1.01X(D412BSSAM).cad.bak', 'latin1'));
    const board = parseGenCad(text, 'b.cad');
    const warn = board.warnings.find(w => /inferred/i.test(String((w.params as any)?.message)));
    expect(warn).toBeDefined();
    expect(String((warn!.params as any)?.message)).toContain('mils');
  });

  it('explicit UNITS record is used (no inference)', () => {
    const text = readFixture('gencad_1.4_MM.cad');
    const board = parseGenCad(text, 'b.cad');
    expect(board.warnings.some(w => /inferred/i.test(String((w.params as any)?.message)))).toBe(false);
  });
});

describe('detectGencadUnits', () => {
  it('returns null for empty sections', () => {
    expect(detectGencadUnits(new Map())).toBeNull();
  });

  it('infers MIL for the real board (no UNITS)', () => {
    const text = readFileSync('/home/lichelord/Downloads/TUF-RX6900XT-O16G-I3SR1.01X(D412BSSAM).cad.bak', 'latin1');
    const sections = sectionsFrom(text, []);
    expect(detectGencadUnits(sections)).toBe(0.0254);
  });

  it('does not run when UNITS record exists (guard check)', () => {
    const text = readFixture('gencad_1.4_MM.cad');
    const board = parseGenCad(text, 'b.cad');
    expect(board.warnings.some(w => /inferred/i.test(String((w.params as any)?.message)))).toBe(false);
  });
});
