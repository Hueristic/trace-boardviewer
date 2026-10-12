import { describe, expect, it } from 'vitest';
import { boardToScreen, screenToBoard, viewportBounds } from './geometry';
import { appendPadPath, clipSegmentToBounds } from './render-geometry';
import type { BoardPin } from './types';

describe('viewport relation clipping', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 8 };

  it('retains crossings even with both endpoints outside, and clips to the true segment', () => {
    expect(clipSegmentToBounds({ x: -10, y: -5 }, { x: 20, y: 10 }, bounds)).toEqual({
      from: { x: 0, y: 0 }, to: { x: 10, y: 5 },
    });
    expect(clipSegmentToBounds({ x: -10, y: 7 }, { x: 20, y: 7 }, bounds)).toEqual({
      from: { x: 0, y: 7 }, to: { x: 10, y: 7 },
    });
    expect(clipSegmentToBounds({ x: 20, y: 7 }, { x: -10, y: 7 }, bounds)).toEqual({
      from: { x: 10, y: 7 }, to: { x: 0, y: 7 },
    });
  });

  it('rejects misses without dropping edge tangents or zero-length relations', () => {
    expect(clipSegmentToBounds({ x: -10, y: 9 }, { x: 20, y: 9 }, bounds)).toBeNull();
    expect(clipSegmentToBounds({ x: -2, y: -2 }, { x: -1, y: -1 }, bounds)).toBeNull();
    expect(clipSegmentToBounds({ x: 3, y: -10 }, { x: 3, y: 20 }, bounds)).toEqual({
      from: { x: 3, y: 0 }, to: { x: 3, y: 8 },
    });
    expect(clipSegmentToBounds({ x: -1, y: 0 }, { x: 11, y: 0 }, bounds)).toEqual({
      from: { x: 0, y: 0 }, to: { x: 10, y: 0 },
    });
    expect(clipSegmentToBounds({ x: 3, y: 4 }, { x: 3, y: 4 }, bounds)).toEqual({
      from: { x: 3, y: 4 }, to: { x: 3, y: 4 },
    });
  });

  for (const mirrored of [false, true]) for (const rotation of [0, 90, 180, 270]) {
    it(`keeps the correct viewport crossing at ${rotation} degrees, mirrored=${mirrored}`, () => {
      const view = { center: { x: 21, y: -4 }, scale: 3, rotation, mirrored };
      const from = screenToBoard({ x: -200, y: 200 }, view, 800, 600);
      const to = screenToBoard({ x: 1000, y: 400 }, view, 800, 600);
      const clipped = clipSegmentToBounds(from, to, viewportBounds(view, 800, 600))!;
      const a = boardToScreen(clipped.from, view, 800, 600);
      const b = boardToScreen(clipped.to, view, 800, 600);
      expect(a.x).toBeCloseTo(0, 9); expect(a.y).toBeCloseTo(233.333333333, 8);
      expect(b.x).toBeCloseTo(800, 9); expect(b.y).toBeCloseTo(366.666666667, 8);
    });
  }
});

describe('batched display pads', () => {
  const pin: BoardPin = { id: 'R1:1', componentId: 'R1', number: '1', name: '1', net: 'GND', side: 'top', x: 10, y: 20, radius: 0, shape: 'round' };
  function record() {
    const operations: Array<{ kind: string; values: number[] }> = [];
    return { operations, path: {
      moveTo: (...values: number[]) => { operations.push({ kind: 'move', values }); },
      lineTo: (...values: number[]) => { operations.push({ kind: 'line', values }); },
      arc: (...values: number[]) => { operations.push({ kind: 'arc', values }); },
      closePath: () => { operations.push({ kind: 'close', values: [] }); },
    } };
  }

  it('preserves zero-size physical pads and creates separate visible circle subpaths', () => {
    const { path, operations } = record();
    appendPadPath(path, pin, 10, 2.2);
    appendPadPath(path, { ...pin, x: 30, radius: 0.5 }, 10, 2.2);
    expect(operations.map(item => item.kind)).toEqual(['move', 'arc', 'move', 'arc']);
    expect(operations[1].values[2]).toBeCloseTo(0.22, 10);
    expect(operations[3].values[2]).toBe(0.5);
    expect(pin.radius).toBe(0);
  });

  it('places real rectangular corners with the source rotation and original dimensions', () => {
    const { path, operations } = record();
    const rectangle = { ...pin, shape: 'rect' as const, width: 4, height: 2, rotation: 90 };
    appendPadPath(path, rectangle, 10, 1);
    const corners = operations.filter(item => item.kind === 'move' || item.kind === 'line');
    const expected = [[11, 18], [11, 22], [9, 22], [9, 18]];
    corners.forEach((corner, index) => {
      expect(corner.values[0]).toBeCloseTo(expected[index][0], 10);
      expect(corner.values[1]).toBeCloseTo(expected[index][1], 10);
    });
    expect(rectangle).toMatchObject({ x: 10, y: 20, width: 4, height: 2, rotation: 90 });
  });
});

describe('pad level of detail: a pad below 1.5 px is a square point, a larger pad is drawn as before', () => {
  /** The operations a pad appends to a path, as strings. */
  class Ops {
    ops: string[] = [];
    moveTo(x: number, y: number) { this.ops.push(`m${x},${y}`); }
    lineTo(x: number, y: number) { this.ops.push(`l${x},${y}`); }
    arc(x: number, y: number, r: number) { this.ops.push(`a${x},${y},${r}`); }
    closePath() { this.ops.push('z'); }
  }
  const round = (radius: number): BoardPin => ({ id: 'r', componentId: 'C', number: '1', name: '1', net: 'N', side: 'top', x: 10, y: 20, radius, shape: 'round' });
  const rect = (width: number, height: number, radius = 0.1): BoardPin => ({ ...round(radius), shape: 'rect', width, height, rotation: 45 });
  const opsOf = (pin: BoardPin, scale: number, marker = 1) => { const path = new Ops(); appendPadPath(path, pin, scale, marker); return path.ops; };

  it('draws a small round pad (1 px marker) as a square with the marker circle\'s area, with no curve', () => {
    // radius 0.2 mm at 4 px/mm is 0.8 px, so the 1 px marker sets the radius to 0.25 mm; the square has the circle's area
    const half = 0.25 * Math.sqrt(Math.PI) / 2;
    expect(opsOf(round(0.2), 4)).toEqual([`m${10 - half},${20 - half}`, `l${10 + half},${20 - half}`, `l${10 + half},${20 + half}`, `l${10 - half},${20 + half}`]);
    expect(4 * half * half).toBeCloseTo(Math.PI * 0.25 * 0.25, 12);
  });

  it('keeps a round pad of 1.5 px or more exactly as before (moveTo and an arc)', () => {
    // radius 0.5 mm at 4 px/mm is 2 px: a circle, the same ops as the original renderer
    expect(opsOf(round(0.5), 4)).toEqual(['m10.5,20', 'a10,20,0.5']);
    // exactly 1.5 px is no longer a point
    expect(opsOf(round(0.375), 4)).toEqual(['m10.375,20', 'a10,20,0.375']);
  });

  it('keeps a larger marker (the selected component, 1.8 px) as a circle even for a tiny pad', () => {
    expect(opsOf(round(0.01), 4, 1.8)[1]).toMatch(/^a/);
  });

  it('draws a small rectangular pad as a square of its larger half-size, and a larger one as a rotated rectangle', () => {
    const small = opsOf(rect(0.2, 0.1), 2);   // 0.2 x 0.1 mm at 2 px/mm: 0.4 x 0.2 px, the 1.5 px floor sets the half-size to 0.75 px = 0.375 mm
    expect(small).toHaveLength(4);
    expect(small[0]).toBe('m9.625,19.625');
    const large = opsOf(rect(2, 1), 2);       // 2 x 1 mm at 2 px/mm: a rotated rectangle with its closing contour
    expect(large[large.length - 1]).toBe('z');
    expect(large).toHaveLength(5);
  });
});
