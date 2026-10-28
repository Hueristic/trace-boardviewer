import { describe, expect, it } from 'vitest';
import { GenCadParseError, detectGencadUnits, gencadVersionOf, parseGenCad, rewriteGencadVersion, sectionsFrom } from '../gencad';
import { parseBoard } from './index';
import { textInput } from './common';

/** A minimal GenCAD board whose version, units record and pin spacing are all under test control.
 * Each package is a 2-pin part; `halfSpacing` (in file units) is half the pin-to-pin distance, so
 * mil-pitch parts use 19.4 (38.8 mil = 0.986 mm ~ 1.0 mm) and 100-mil-pitch parts use 25
 * (50 mil = 1.27 mm). `gridStep` spreads PLACE records so the placement bbox stays plausible in
 * the file's own unit — the bbox plausibility gate must see a real board-sized spread. */
function board(options: { version?: string; units?: string | null; components?: number; halfSpacing?: number; gridStep?: number } = {}): string {
  const { version = '1.4', units = 'MM', components = 12, halfSpacing = 19.4, gridStep = 80 } = options;
  const header = units === null ? '' : `UNITS ${units}\n`;
  const comps: string[] = [];
  const shapes: string[] = [];
  for (let i = 0; i < components; i++) {
    const x = gridStep * 0.125 + (i % 6) * gridStep;
    const y = gridStep * 0.125 + Math.floor(i / 6) * gridStep * 4;
    comps.push(`COMPONENT U${i}\nPLACE ${x} ${y}\nLAYER TOP\nROTATION 0\nSHAPE S${i} 0 0\nDEVICE D`);
    // The unit detector pools pin distances per SHAPE definition, so every
    // package needs its own definition — as on real boards.
    shapes.push(`SHAPE S${i}\nRECTANGLE ${-halfSpacing} -1 ${halfSpacing * 2} 2\nPIN 1 PS ${-halfSpacing} 0 TOP 0 0\nPIN 2 PS ${halfSpacing} 0 TOP 0 0`);
  }
  return `$HEADER
GENCAD ${version}
${header}ORIGIN 0 0
$ENDHEADER
$BOARD
RECTANGLE 0 0 ${gridStep * 6} ${gridStep * 5}
$ENDBOARD
$PADS
PAD P ROUND -1
CIRCLE 0 0 0.2
$ENDPADS
$PADSTACKS
PADSTACK PS 0
PAD P TOP 0 0
$ENDPADSTACKS
$SHAPES
${shapes.join('\n')}
$ENDSHAPES
$COMPONENTS
${comps.join('\n')}
$ENDCOMPONENTS
$DEVICES
DEVICE D
VALUE "10 kOhm"
PACKAGE "0402"
$ENDDEVICES
$SIGNALS
SIGNAL GND
${Array.from({ length: components }, (_, i) => `NODE U${i} 1`).join('\n')}
SIGNAL "POWER 3V3"
${Array.from({ length: components }, (_, i) => `NODE U${i} 2`).join('\n')}
$ENDSIGNALS
`;
}

describe('GenCAD version gate', () => {
  it.each(['1.3', '1.9', '2.0'])('GENCAD %s is rejected with requiresGencad14', (version) => {
    let caught: unknown;
    try { parseBoard(textInput(board({ version }), 'b.cad')); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GenCadParseError);
    expect((caught as GenCadParseError).issue.key).toBe('parse.error.requiresGencad14');
  });

  it('GENCAD 1.4 parses through the board registry', () => {
    expect(parseBoard(textInput(board(), 'b.cad')).format).toBe('GENCAD 1.4');
  });

  it('gencadVersionOf extracts the declared version from any version line', () => {
    expect(gencadVersionOf(board({ version: '1.4' }))).toBe('1.4');
    expect(gencadVersionOf(board({ version: '1.3' }))).toBe('1.3');
    expect(gencadVersionOf(board({ version: '1.9' }))).toBe('1.9');
    expect(gencadVersionOf(board({ version: '2.0' }))).toBe('2.0');
  });

  it('rewriteGencadVersion rewrites any non-1.4 version to 1.4', () => {
    for (const version of ['1.3', '1.9', '2.0']) {
      const rewritten = rewriteGencadVersion(board({ version }));
      expect(rewritten).toContain('GENCAD 1.4');
      expect(rewritten).not.toContain(`GENCAD ${version}`);
    }
  });

  it('rewriteGencadVersion leaves a 1.4 file byte-identical', () => {
    const text = board();
    expect(rewriteGencadVersion(text)).toBe(text);
  });

  it('a rewritten 1.9 file parses and the board opens', () => {
    const parsed = parseGenCad(rewriteGencadVersion(board({ version: '1.9', units: 'MM' })), 'b.cad');
    expect(parsed.format).toBe('GENCAD 1.4');
    expect(parsed.components.length).toBe(12);
    expect(parsed.nets.length).toBe(2);
  });
});

describe('GenCAD unit inference', () => {
  it('an explicit UNITS record is used and inference stays silent', () => {
    const parsed = parseGenCad(board({ units: 'MM' }), 'b.cad');
    expect(parsed.units).toBe('mm');
    expect(parsed.warnings.some(w => /inferred/i.test(String((w.params as any)?.message)))).toBe(false);
  });

  it.each(['MM', 'MILS', 'INCH'])('explicit UNITS %s parses to mm', (units) => {
    const parsed = parseGenCad(board({ units, gridStep: units === 'INCH' ? 0.5 : 80 }), 'b.cad');
    expect(parsed.units).toBe('mm');
    expect(parsed.warnings.some(w => /inferred/i.test(String((w.params as any)?.message)))).toBe(false);
  });

  it('a file without UNITS infers MILS from mil-pitch parts (38.8 mil ~ 1.0 mm) and warns', () => {
    const parsed = parseGenCad(board({ units: null, halfSpacing: 19.4, gridStep: 100 }), 'b.cad');
    expect(parsed.units).toBe('mm');
    const warn = parsed.warnings.find(w => /inferred/i.test(String((w.params as any)?.message)));
    expect(warn).toBeDefined();
    expect(String((warn!.params as any)?.message)).toContain('mils');
  });

  it('a file without UNITS infers INCH from 50-mil-pitch parts (0.1 in = 2.54 mm) and warns', () => {
    const parsed = parseGenCad(board({ units: null, halfSpacing: 0.05, gridStep: 0.4 }), 'b.cad');
    expect(parsed.units).toBe('mm');
    const warn = parsed.warnings.find(w => /inferred/i.test(String((w.params as any)?.message)));
    expect(warn).toBeDefined();
    expect(String((warn!.params as any)?.message)).toContain('inch');
  });

  it('a version-rewritten 1.9 file without UNITS still infers units and warns', () => {
    const parsed = parseGenCad(rewriteGencadVersion(board({ version: '1.9', units: null, gridStep: 100 })), 'b.cad');
    expect(parsed.format).toBe('GENCAD 1.4');
    expect(parsed.warnings.some(w => /inferred/i.test(String((w.params as any)?.message)))).toBe(true);
  });

  it('a file with no UNITS and a sub-plausible placement bbox throws unitsMissing (no guess)', () => {
    // Components clustered 0.02 units apart: every candidate scale puts the placement
    // bbox outside [10, 600] mm, so the detector must decline rather than guess.
    expect(() => parseGenCad(board({ units: null, gridStep: 0.02 }), 'b.cad')).toThrow(/unit/i);
  });
});

describe('detectGencadUnits', () => {
  it('returns null for empty sections', () => {
    expect(detectGencadUnits(new Map())).toBeNull();
  });

  it('infers MIL for a mil-pitch board without UNITS', () => {
    const sections = sectionsFrom(board({ units: null, halfSpacing: 19.4, gridStep: 100 }), []);
    expect(detectGencadUnits(sections)).toBe(0.0254);
  });

  it('infers INCH for a 50-mil-pitch board without UNITS', () => {
    const sections = sectionsFrom(board({ units: null, halfSpacing: 0.05, gridStep: 0.4 }), []);
    expect(detectGencadUnits(sections)).toBe(25.4);
  });

  it('returns null when the placement bbox is implausible at every scale', () => {
    const sections = sectionsFrom(board({ units: null, gridStep: 0.02 }), []);
    expect(detectGencadUnits(sections)).toBeNull();
  });
});

describe('real production board without UNITS (TRACE_TEST_GENCAD_NO_UNITS)', () => {
  const external = process.env.TRACE_TEST_GENCAD_NO_UNITS;
  it.skipIf(!external)('infers MILS on the external board and reports the inference', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const text = rewriteGencadVersion(readFileSync(external!, 'latin1'));
    const parsed = parseGenCad(text, 'external.cad');
    expect(parsed.units).toBe('mm');
    const warn = parsed.warnings.find(w => /inferred/i.test(String((w.params as any)?.message)));
    expect(warn).toBeDefined();
    expect(String((warn!.params as any)?.message)).toContain('mils');
  });
});
