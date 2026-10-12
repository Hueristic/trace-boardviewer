import { describe, expect, it } from 'vitest';
import { buildCopperLayers, type CopperPath } from '../../components/board-copper';
import { bytesOf, writeJob, zipOf } from './odbpp-fixture';
import { openOdbppFiles, parseOdbpp, parseOdbppFiles } from './odbpp';
import { platingOf, standardSymbol, traceAngle } from './odbpp-copper';

// Synthetic copper and drill layers written by this file (no external bytes).
const TOP = [
  'UNITS=MM',
  '#',
  '$0 r300',
  '$1 rect600x800',
  '$2 oval1000x2000',
  '$3 s500',
  'F 9',
  'L 1 2 3 4 0 P 0',
  'A 0 0 1 0 0.5 0 0 P 0 Y',
  'A 0 0 1 0 0.5 0 0 P 0 N',
  'P 10 20 1 P 0 8 90.0 ;0=1',
  'P 30 40 2 P 0 9 45.0 ;0=1',
  'P 50 60 0 P 0 0 0',
  'P 70 80 0 N 0 8 0.0',
  'P 90 100 3 P 0 8 0.0',
  'P 110 120 9 P 0 8 0.0',
  'S P 0',
  'OB 0 0 I',
  'OS 1 0',
  'OS 1 1',
  'OE',
  'SE',
  'T 1 1 0 P 0 0 0 0 text',
].join('\n') + '\n';
const BOTTOM = ['UNITS=MM', '$0 r300', 'P 1 1 0 P 0 8 0.0'].join('\n') + '\n';
const DRILL = [
  'UNITS=MM',
  '$0 r900',
  '$1 r1000',
  '$2 oval1000x2000',
  '$3 r600',
  '$4 r200',
  'P 100 100 0 P 0 8 0.0',
  'P 200 100 1 P 0 8 0.0',
  'P 300 100 2 P 0 8 90.0',
  'P 400 100 3 P 0 8 0.0',
  'P 500 100 4 P 0 8 0.0',
].join('\n') + '\n';
const TOOLS = [
  'UNITS=MM',
  'TOOLS {', 'NUM=1', 'TYPE=PLATED', 'DRILL_SIZE=900.0', '}',
  'TOOLS {', 'NUM=2', 'TYPE=NON_PLATED', 'DRILL_SIZE=1000.0', '}',
  'TOOLS {', 'NUM=3', 'TYPE=PLATED', 'DRILL_SIZE=600.0', '}',
  'TOOLS {', 'NUM=4', 'TYPE=NON_PLATED', 'DRILL_SIZE=600.0', '}',
  'TOOLS {', 'NUM=5', 'TYPE=VIA', 'DRILL_SIZE=200.0', '}',
].join('\n') + '\n';

const withCopper = (overrides: Record<string, string> = {}): Record<string, string> => ({
  ...writeJob(),
  'steps/pcb/layers/top/features': TOP,
  'steps/pcb/layers/bottom/features': BOTTOM,
  'steps/pcb/layers/drill/features': DRILL,
  'steps/pcb/layers/drill/tools': TOOLS,
  ...overrides,
});
const filesOf = (record: Record<string, string>): Record<string, Uint8Array> =>
  Object.fromEntries(Object.entries(record).map(([path, data]) => [path, bytesOf(data)]));
const readFiles = (record: Record<string, string>) => parseOdbppFiles({ name: 'job', files: filesOf(record) });
const messagesOf = (board: { warnings: Array<{ params?: Record<string, unknown> }> }) => board.warnings.map(warning => String(warning.params?.message ?? ''));

describe('ODB++ copper and drill records', () => {
  it('reads top and bottom pads, lines, arcs and drilled holes into the board copper field', () => {
    const board = readFiles(withCopper());
    expect(board.copper).toBeDefined();
    const copper = board.copper!;
    expect(copper.pads).toHaveLength(4);
    // ODB++ 90 degrees clockwise, not mirrored: 270 counter-clockwise (see the convention block at the end of this file).
    expect(copper.pads[0]).toMatchObject({ side: 'top', shape: 'rect', rotation: 270, mirrored: false });
    expect(copper.pads[0].x).toBeCloseTo(10, 9);
    expect(copper.pads[0].y).toBeCloseTo(20, 9);
    expect(copper.pads[0].width).toBeCloseTo(0.6, 9);
    expect(copper.pads[0].height).toBeCloseTo(0.8, 9);
    expect(copper.pads[1]).toMatchObject({ side: 'top', shape: 'oval', rotation: 45, mirrored: true });
    expect(copper.pads[1].width).toBeCloseTo(1, 9);
    expect(copper.pads[1].height).toBeCloseTo(2, 9);
    expect(copper.pads[2]).toMatchObject({ side: 'top', shape: 'square' });
    expect(copper.pads[2].width).toBeCloseTo(0.5, 9);
    expect(copper.pads[3]).toMatchObject({ side: 'bottom', shape: 'round' });
    expect(copper.pads[3].width).toBeCloseTo(0.3, 9);
    expect(copper.pads[3].height).toBeCloseTo(0.3, 9);
    expect(copper.lines).toHaveLength(1);
    expect(copper.lines[0]).toMatchObject({ side: 'top' });
    expect(copper.lines[0].x2).toBeCloseTo(3, 9);
    expect(copper.lines[0].y2).toBeCloseTo(4, 9);
    expect(copper.lines[0].width).toBeCloseTo(0.3, 9);
    expect(copper.arcs.map(arc => arc.clockwise)).toEqual([true, false]);
    expect(copper.arcs[0].cx).toBeCloseTo(0.5, 9);
    expect(copper.arcs[0].width).toBeCloseTo(0.3, 9);
  });

  it('places holes by drill tool: plated, non-plated, slot, unknown when tools disagree, and via', () => {
    const copper = readFiles(withCopper()).copper!;
    expect(copper.holes.map(hole => hole.plating)).toEqual(['plated', 'non-plated', 'non-plated', 'unknown', 'via']);
    expect(copper.holes.map(hole => hole.shape)).toEqual(['round', 'round', 'oval', 'round', 'round']);
    expect(copper.holes[0].width).toBeCloseTo(0.9, 9);
    // ODB++ 90 degrees clockwise, not mirrored: 270 counter-clockwise.
    expect(copper.holes[2]).toMatchObject({ shape: 'oval', rotation: 270 });
    expect(copper.holes[2].width).toBeCloseTo(1, 9);
    expect(copper.holes[2].height).toBeCloseTo(2, 9);
  });

  it('converts inch files: inch coordinates and mil symbol sizes become millimetres', () => {
    const board = readFiles({ ...writeJob(), 'steps/pcb/layers/top/features': ['UNITS=INCH', '$0 r1000', 'P 1 2 0 P 0 8 0.0', 'L 0 0 0 1 0 P 0'].join('\n') + '\n' });
    expect(board.copper!.pads[0].x).toBeCloseTo(25.4, 9);
    expect(board.copper!.pads[0].y).toBeCloseTo(50.8, 9);
    expect(board.copper!.pads[0].width).toBeCloseTo(25.4, 9);
    expect(board.copper!.lines[0].y2).toBeCloseTo(25.4, 9);
    expect(board.copper!.lines[0].width).toBeCloseTo(25.4, 9);
  });

  it('keeps the board unchanged when the product has no copper or drill records', () => {
    const board = readFiles(writeJob());
    expect(board.copper).toBeUndefined();
    expect(messagesOf(board).some(message => message.includes('Copper read'))).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(board, 'copper')).toBe(false);
  });

  it('discloses every record it does not read, and never guesses them', () => {
    const board = readFiles(withCopper());
    const messages = messagesOf(board);
    expect(messages.some(message => message.startsWith('Copper read from the top and bottom copper and drill layers: 4 pad(s), 1 line(s), 2 arc(s) and 5 drilled hole(s).'))).toBe(true);
    expect(messages.some(message => message.includes('Copper features not read: 1 with an unsupported symbol, 1 with an unsupported orientation code, 1 negative (clear) feature(s).'))).toBe(true);
    expect(messages.some(message => message.includes('1 surface (pour) record(s), 1 text record(s)'))).toBe(true);
    expect(messages.some(message => message.includes('inner copper layer(s) are not read'))).toBe(true);
    expect(messages.some(message => message.includes('1 drill hole(s) have no clear plating'))).toBe(true);
    expect(messages.some(message => message.includes('copper pads, lines, arcs and drilled holes are kept in the board data and drawn in the board view'))).toBe(true);
  });

  it('marks every hole unknown when the drill layer has no tools file', () => {
    const record = withCopper();
    delete record['steps/pcb/layers/drill/tools'];
    const board = readFiles(record);
    expect(board.copper!.holes.map(hole => hole.plating)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(board.copper!.pads).toHaveLength(4);
  });

  it('reads the same copper from a zipped product model', () => {
    const board = parseOdbpp({ name: 'job.zip', data: zipOf(withCopper()) });
    expect(board?.copper?.pads).toHaveLength(4);
    expect(board?.copper?.holes).toHaveLength(5);
  });

  it('reads no copper when a copper or drill file is over the layer-file budget, and names the files', () => {
    const board = parseOdbppFiles({ name: 'job', files: filesOf(withCopper()) }, { limits: { maxAuxBytes: 1 } });
    expect(board.copper).toBeUndefined();
    const messages = messagesOf(board);
    expect(messages.some(message => message.includes('steps/pcb/layers/top/features (over the layer-file limit)'))).toBe(true);
    expect(messages.some(message => message.includes('Partial copper would mislead, so none is read.'))).toBe(true);
    expect(messages.some(message => message.includes('copper features, drills and other layers are not drawn'))).toBe(true);
  });

  it('reads no copper when a copper file is not text (a UTF-16 byte-order mark with an odd length)', () => {
    const files = { ...filesOf(withCopper()), 'steps/pcb/layers/bottom/features': new Uint8Array([0xff, 0xfe, 0x31]) };
    const board = parseOdbppFiles({ name: 'job', files });
    expect(board.copper).toBeUndefined();
    expect(messagesOf(board).some(message => message.includes('steps/pcb/layers/bottom/features (not text)'))).toBe(true);
  });

  it('reads the copper of the other layers and says which copper layer has no features file', () => {
    const record = withCopper();
    delete record['steps/pcb/layers/bottom/features'];
    const board = readFiles(record);
    expect(board.copper!.pads).toHaveLength(3);
    expect(board.copper!.pads.every(pad => pad.side === 'top')).toBe(true);
    expect(messagesOf(board).some(message => message.startsWith('No features file for bottom:'))).toBe(true);
  });

  it('discloses a copper file that declares no UNITS directive', () => {
    const board = readFiles(withCopper({ 'steps/pcb/layers/top/features': TOP.replace('UNITS=MM\n', '') }));
    expect(messagesOf(board).some(message => message.includes('no UNITS directive') && message.includes('steps/pcb/layers/top/features'))).toBe(true);
  });

  it('lists the units of the copper files it reads in the model', () => {
    const model = openOdbppFiles({ name: 'job', files: filesOf(withCopper()) }).read();
    expect(model.units['steps/pcb/layers/top/features']).toBe('MM');
    expect(model.units['steps/pcb/layers/drill/tools']).toBe('MM');
  });
});

describe('ODB++ copper helpers', () => {
  it('reads standard symbols by name and rejects other shapes', () => {
    expect(standardSymbol('r300')).toEqual({ shape: 'round', a: 300, b: 300 });
    expect(standardSymbol('s500')).toEqual({ shape: 'square', a: 500, b: 500 });
    expect(standardSymbol('rect600x800')).toEqual({ shape: 'rect', a: 600, b: 800 });
    expect(standardSymbol('oval1000x2000')).toEqual({ shape: 'oval', a: 1000, b: 2000 });
    expect(standardSymbol('donut_r990x1900x50xr25')).toBeNull();
    expect(standardSymbol(undefined)).toBeNull();
  });

  it('chooses plating from the types of the tools matching a diameter', () => {
    expect(platingOf(new Set(['PLATED']))).toBe('plated');
    expect(platingOf(new Set(['NON_PLATED']))).toBe('non-plated');
    expect(platingOf(new Set(['VIA']))).toBe('via');
    expect(platingOf(new Set(['PLATED', 'VIA']))).toBe('plated');
    expect(platingOf(new Set(['PLATED', 'NON_PLATED']))).toBe('unknown');
    expect(platingOf(new Set())).toBe('unknown');
  });

  it('turns a file angle into the counter-clockwise convention: an unmirrored angle is negated, a mirrored one kept, in [0, 360)', () => {
    expect(traceAngle(0, false)).toBe(0);
    expect(Object.is(traceAngle(0, false), 0)).toBe(true);
    expect(traceAngle(90, false)).toBe(270);
    expect(traceAngle(180, false)).toBe(180);
    expect(traceAngle(270, false)).toBe(90);
    expect(traceAngle(30, false)).toBe(330);
    expect(traceAngle(90, true)).toBe(90);
    expect(traceAngle(270, true)).toBe(270);
    expect(traceAngle(-30, true)).toBe(330);
    expect(traceAngle(360, true)).toBe(0);
  });
});

// --- ODB++ feature orientation: the convention, pinned on synthetic features only ---
// Source (no vendor file is available and none is used): odbpp.ts header, lines 11-15 (ODB++ is Y-up; a component's rotation is clockwise
// in ODB++, and its mirror is applied after the rotation, as the placement code does) and the odbpp-copper.ts header (the arc direction
// flag Y is clockwise). The expected outlines follow those words only: a feature is turned clockwise by its angle, then mirrored in X
// when orientation code 9 is set. A right angle draws the same outline with either sign and with or without the mirror, so the 30-degree
// pair is what makes the drawn direction and the mirror visible.
const CONVENTION_CASES: Array<[orient: '8' | '9', angle: number, trace: number]> = [
  // [ODB++ orientation code, ODB++ angle (clockwise), TRACE angle (counter-clockwise, degrees)]
  ['8', 0, 0], ['8', 90, 270], ['8', 180, 180], ['8', 270, 90], ['8', 30, 330],
  ['9', 0, 0], ['9', 90, 90], ['9', 180, 180], ['9', 270, 270], ['9', 30, 30],
];
const CONVENTION_TOP = [
  'UNITS=MM',
  '$0 rect2000x500',
  '$1 r200',
  ...CONVENTION_CASES.map(([orient, angle], index) => `P ${10 * (index + 1)} 20 0 P 0 ${orient} ${angle}`),
  'L 0 -5 0 5 1 P 0',
  'A 0 5 5 0 0 0 1 P 0 Y',
].join('\n') + '\n';
const CONVENTION_REGION = { minX: -100, minY: -100, maxX: 200, maxY: 200 };
const readConvention = () => readFiles({ ...writeJob(), 'steps/pcb/layers/top/features': CONVENTION_TOP });

/** Where ODB++ draws pad `index`: its 2 x 0.5 mm rectangle turned clockwise by its angle, then mirrored in X for code 9. */
function odbOutline(index: number): Array<[number, number]> {
  const [orient, angle] = CONVENTION_CASES[index];
  const turn = angle * Math.PI / 180, cos = Math.cos(turn), sin = Math.sin(turn);
  const x0 = 10 * (index + 1), y0 = 20, hw = 1, hh = 0.25;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Array<[number, number]>).map(([u, v]): [number, number] => {
    const x = u * cos + v * sin, y = -u * sin + v * cos; // clockwise by `turn`
    return [x0 + (orient === '9' ? -x : x), y0 + y];
  });
}

/** Records what a builder asks for: one list of points per outline (a moveTo starts one, a lineTo adds a point) and the arcs. */
class OutlineRecorder implements CopperPath {
  readonly outlines: Array<Array<[number, number]>> = [];
  readonly arcs: Array<{ anticlockwise: boolean; start: number; end: number }> = [];
  moveTo(x: number, y: number): void { this.outlines.push([[x, y]]); }
  lineTo(x: number, y: number): void { this.outlines[this.outlines.length - 1].push([x, y]); }
  arc(_x: number, _y: number, _radius: number, start: number, end: number, anticlockwise = false): void {
    this.arcs.push({ anticlockwise, start, end });
  }
  closePath(): void { /* the last corner closes a rectangle */ }
}

function expectCorners(drawn: Array<[number, number]>, expected: Array<[number, number]>, label: string): void {
  expect(drawn, label).toHaveLength(4);
  for (const [x, y] of expected) {
    expect(drawn.some(([dx, dy]) => Math.hypot(dx - x, dy - y) < 1e-9), `${label}: no corner at ${x.toFixed(4)}, ${y.toFixed(4)}`).toBe(true);
  }
}

describe('ODB++ feature orientation: the convention', () => {
  it('stores each pad angle counter-clockwise: an unmirrored pad takes the negative of its file angle, a mirrored one keeps it', () => {
    const copper = readConvention().copper!;
    expect(copper.pads).toHaveLength(CONVENTION_CASES.length);
    CONVENTION_CASES.forEach(([orient, , trace], index) => {
      const pad = copper.pads[index];
      expect(pad, `pad ${index}`).toMatchObject({ side: 'top', shape: 'rect', mirrored: orient === '9' });
      expect(pad.x).toBeCloseTo(10 * (index + 1), 9);
      expect(pad.y).toBeCloseTo(20, 9);
      expect(pad.width).toBeCloseTo(2, 9);
      expect(pad.height).toBeCloseTo(0.5, 9);
      expect(pad.rotation, `pad ${index}`).toBeCloseTo(trace, 9);
    });
  });

  it('draws each pad where ODB++ puts it: turned clockwise by its angle, then mirrored in X', () => {
    const copper = readConvention().copper!;
    const layers = buildCopperLayers(copper, 'top', CONVENTION_REGION, () => new OutlineRecorder());
    expect(layers.pads).toHaveLength(1);
    const outlines = layers.pads[0].outlines;
    expect(outlines).toHaveLength(CONVENTION_CASES.length);
    CONVENTION_CASES.forEach((kase, index) => expectCorners(outlines[index], odbOutline(index), `pad ${index} (${kase.join(' ')})`));
  });

  it('keeps the copper line at its file position and draws the Y arc clockwise (canvas anticlockwise)', () => {
    const copper = readConvention().copper!;
    expect(copper.lines).toHaveLength(1);
    expect([copper.lines[0].x1, copper.lines[0].y1, copper.lines[0].x2, copper.lines[0].y2]).toEqual([0, -5, 0, 5]);
    expect(copper.arcs).toHaveLength(1);
    expect(copper.arcs[0].clockwise).toBe(true);
    const layers = buildCopperLayers(copper, 'top', CONVENTION_REGION, () => new OutlineRecorder());
    expect(layers.strokes).toHaveLength(1);
    const stroke = layers.strokes[0].path;
    expect(stroke.outlines[0]).toEqual([[0, -5], [0, 5]]);
    // From the top point (90 degrees) clockwise to the right point (0 degrees): a decreasing angle, the short quarter in the first quadrant.
    expect(stroke.arcs).toHaveLength(1);
    expect(stroke.arcs[0].anticlockwise).toBe(true);
    expect(stroke.arcs[0].start).toBeCloseTo(Math.PI / 2, 9);
    expect(stroke.arcs[0].end).toBeCloseTo(0, 9);
  });
});
