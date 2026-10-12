import { describe, expect, it } from 'vitest';
import type { BoardCopper, CopperArc, CopperLine, CopperPad, DrillHole } from '../lib/types';
import { buildCopperLayers, COPPER_STROKE_BATCH, copperIsEmpty } from './board-copper';
import { PAD_BATCH_SIZE } from './board-pad-layers';

// Synthetic copper written in this file; no owner or corpus data. The path records what the builder asked it to draw.
interface Call { op: 'M' | 'L' | 'A' | 'Z'; x?: number; y?: number; r?: number; start?: number; end?: number; ccw?: boolean }
class TestPath {
  readonly calls: Call[] = [];
  moveTo(x: number, y: number) { this.calls.push({ op: 'M', x, y }); }
  lineTo(x: number, y: number) { this.calls.push({ op: 'L', x, y }); }
  arc(x: number, y: number, r: number, start: number, end: number, ccw = false) { this.calls.push({ op: 'A', x, y, r, start, end, ccw }); }
  closePath() { this.calls.push({ op: 'Z' }); }
}

const EMPTY: BoardCopper = { pads: [], lines: [], arcs: [], holes: [] };
const EVERYWHERE = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
const build = (copper: BoardCopper, side: 'top' | 'bottom' = 'top', region = EVERYWHERE) => buildCopperLayers(copper, side, region, () => new TestPath());
const pad = (over: Partial<CopperPad>): CopperPad => ({ side: 'top', x: 0, y: 0, shape: 'round', width: 0.5, height: 0.5, rotation: 0, mirrored: false, ...over });
const hole = (over: Partial<DrillHole>): DrillHole => ({ x: 0, y: 0, shape: 'round', width: 0.5, height: 0.5, rotation: 0, plating: 'plated', ...over });
const line = (over: Partial<CopperLine>): CopperLine => ({ side: 'top', x1: 0, y1: 0, x2: 1, y2: 0, width: 0.2, ...over });
const arcOf = (over: Partial<CopperArc>): CopperArc => ({ side: 'top', x1: 1, y1: 0, x2: 0, y2: 1, cx: 0, cy: 0, width: 0.2, clockwise: false, ...over });
const ops = (path: TestPath) => path.calls.map(call => call.op).join('');

describe('copper paths: culling and sides', () => {
  it('keeps the pads of one side and the holes that the region touches, and nothing else', () => {
    const copper: BoardCopper = {
      ...EMPTY,
      pads: [pad({ x: 0, y: 0 }), pad({ x: 100, y: 0 }), pad({ x: 0, y: 0, side: 'bottom' })],
      holes: [hole({ x: 0, y: 0 }), hole({ x: 100, y: 100 })],
    };
    const layers = build(copper, 'top', { minX: -5, minY: -5, maxX: 5, maxY: 5 });
    expect(layers.pads).toHaveLength(1);
    expect(ops(layers.pads[0] as TestPath)).toBe('MA');
    expect(layers.holes).toHaveLength(1);
    expect(layers.strokes).toEqual([]);
  });

  it('creates no path for records the region does not touch', () => {
    const copper: BoardCopper = { ...EMPTY, pads: [pad({ x: 0, y: 0 })], lines: [line({})], holes: [hole({})] };
    const layers = build(copper, 'top', { minX: 50, minY: 50, maxX: 60, maxY: 60 });
    expect(layers).toEqual({ pads: [], strokes: [], holes: [] });
  });

  it('takes the copper of the bottom side for the bottom view and leaves the top out', () => {
    const copper: BoardCopper = { ...EMPTY, lines: [line({ side: 'top' }), line({ side: 'bottom', x1: 5, x2: 6 })] };
    const bottom = build(copper, 'bottom');
    expect(bottom.strokes).toHaveLength(1);
    expect(bottom.strokes[0].path.calls[1]).toMatchObject({ op: 'L', x: 6, y: 0 });
  });

  it('skips pads and holes without a size, and reports an empty copper record', () => {
    const copper: BoardCopper = { ...EMPTY, pads: [pad({ width: 0 }), pad({ shape: 'rect', height: 0 })], holes: [hole({ width: 0 })] };
    expect(build(copper)).toEqual({ pads: [], strokes: [], holes: [] });
    expect(copperIsEmpty(EMPTY)).toBe(true);
    expect(copperIsEmpty(copper)).toBe(false);
  });

  it('culls an oval by its rotated extent, not by its unrotated box', () => {
    // A 4 mm × 0.5 mm slot turned 90 degrees lies along y, from y = -2 to y = 2.
    const copper: BoardCopper = { ...EMPTY, pads: [pad({ shape: 'oval', width: 4, height: 0.5, rotation: 90 })] };
    expect(build(copper, 'top', { minX: 5, minY: -1, maxX: 10, maxY: 1 }).pads).toEqual([]);
    expect(build(copper, 'top', { minX: -0.1, minY: 1.9, maxX: 0.1, maxY: 3 }).pads).toHaveLength(1);
  });
});

describe('copper paths: batching', () => {
  it('batches pads and holes in groups of PAD_BATCH_SIZE', () => {
    const pads = Array.from({ length: PAD_BATCH_SIZE * 2 + 5 }, (_, index) => pad({ x: index * 0.01 }));
    const holes = Array.from({ length: PAD_BATCH_SIZE + 1 }, (_, index) => hole({ x: index * 0.01 }));
    const layers = build({ ...EMPTY, pads, holes });
    // A round pad is a move and an arc; a round hole the same.
    expect(layers.pads.map(path => path.calls.length)).toEqual([PAD_BATCH_SIZE * 2, PAD_BATCH_SIZE * 2, 10]);
    expect(layers.holes.map(path => path.calls.length)).toEqual([PAD_BATCH_SIZE * 2, 2]);
  });

  it('groups tracks and arcs by stroke width, in the order each width first appears', () => {
    const lines = [line({ width: 0.2 }), line({ width: 0.3 }), line({ width: 0.2, x1: 2, x2: 3 })];
    const layers = build({ ...EMPTY, lines, arcs: [arcOf({ width: 0.2 })] });
    expect(layers.strokes.map(stroke => stroke.width)).toEqual([0.2, 0.3]);
    expect(ops(layers.strokes[0].path as TestPath)).toBe('MLMLMA');
    expect(ops(layers.strokes[1].path as TestPath)).toBe('ML');
  });

  it('starts a new stroke path for every COPPER_STROKE_BATCH strokes of one width', () => {
    const lines = Array.from({ length: COPPER_STROKE_BATCH + 3 }, (_, index) => line({ x1: index * 0.1, x2: index * 0.1 + 0.05 }));
    const layers = build({ ...EMPTY, lines });
    expect(layers.strokes.map(stroke => stroke.path.calls.length)).toEqual([COPPER_STROKE_BATCH * 2, 3 * 2]);
  });

  it('gives the same paths for the same region (the batches keep their members)', () => {
    const pads = Array.from({ length: 150 }, (_, index) => pad({ x: index * 0.2 }));
    const first = build({ ...EMPTY, pads }, 'top', { minX: 0, minY: -1, maxX: 15, maxY: 1 });
    const second = build({ ...EMPTY, pads }, 'top', { minX: 0, minY: -1, maxX: 15, maxY: 1 });
    expect(second.pads.map(path => path.calls)).toEqual(first.pads.map(path => path.calls));
  });
});

describe('copper paths: shapes and directions', () => {
  it('draws an arc from its start point to its end point, with the file direction as the anticlockwise flag', () => {
    const cw = build({ ...EMPTY, arcs: [arcOf({ clockwise: true })] }).strokes[0].path.calls;
    expect(cw[0]).toMatchObject({ op: 'M', x: 1, y: 0 });
    expect(cw[1].op).toBe('A');
    expect(cw[1].r).toBeCloseTo(1, 9);
    expect(cw[1].start).toBeCloseTo(0, 9);
    expect(cw[1].end).toBeCloseTo(Math.PI / 2, 9);
    expect(cw[1].ccw).toBe(true);
    const ccw = build({ ...EMPTY, arcs: [arcOf({ clockwise: false })] }).strokes[0].path.calls;
    expect(ccw[1].ccw).toBe(false);
  });

  it('turns a rectangle pad counter-clockwise by its angle', () => {
    // A 2 × 1 rectangle turned 90 degrees: its corner (-1, -0.5) goes to (0.5, -1), so x runs to ±0.5 and y to ±1.
    const path = build({ ...EMPTY, pads: [pad({ shape: 'rect', width: 2, height: 1, rotation: 90 })] }).pads[0] as TestPath;
    expect(path.calls[0]).toMatchObject({ op: 'M' });
    expect(path.calls[0].x).toBeCloseTo(0.5, 9);
    expect(path.calls[0].y).toBeCloseTo(-1, 9);
    const corners = path.calls.filter(call => call.op !== 'Z');
    expect(Math.max(...corners.map(call => call.x ?? 0))).toBeCloseTo(0.5, 9);
    expect(Math.min(...corners.map(call => call.x ?? 0))).toBeCloseTo(-0.5, 9);
    expect(Math.max(...corners.map(call => call.y ?? 0))).toBeCloseTo(1, 9);
    expect(path.calls[path.calls.length - 1].op).toBe('Z');
  });

  it('draws an oval hole as a stadium along its long side, both half circles counter-clockwise', () => {
    // Width 1, height 2: the long side is along y, so the two half circles (radius 0.5) sit at y = ±0.5.
    const path = build({ ...EMPTY, holes: [hole({ shape: 'oval', width: 1, height: 2, rotation: 0 })] }).holes[0] as TestPath;
    const arcs = path.calls.filter(call => call.op === 'A');
    expect(arcs).toHaveLength(2);
    expect(path.calls.filter(call => call.op === 'L')).toHaveLength(2);
    expect(arcs.map(call => call.ccw)).toEqual([false, false]);
    expect(arcs.map(call => call.r)).toEqual([0.5, 0.5]);
    const centres = arcs.map(call => [call.x ?? 0, call.y ?? 0]);
    expect(centres[0][0]).toBeCloseTo(0, 9);
    expect(centres[0][1]).toBeCloseTo(0.5, 9);
    expect(centres[1][1]).toBeCloseTo(-0.5, 9);
  });

  it('draws a round pad as one circle that starts its own subpath', () => {
    const path = build({ ...EMPTY, pads: [pad({ x: 3, y: 4, width: 1 })] }).pads[0] as TestPath;
    expect(path.calls).toEqual([{ op: 'M', x: 3.5, y: 4 }, { op: 'A', x: 3, y: 4, r: 0.5, start: 0, end: Math.PI * 2, ccw: false }]);
  });
});
