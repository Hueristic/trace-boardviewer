import type { Bounds2 } from '../lib/geometry';
import type { BoardCopper, CopperArc, CopperLine, CopperPad, CopperSide, DrillHole } from '../lib/types';
import { PAD_BATCH_SIZE } from './board-pad-layers';

/*
 * Copper of the board view (Board.copper, read from ODB++ today): the pads, track lines and arcs of one side and the drilled holes, built
 * as native paths for the part of the board a view shows. The culling and batching are the pads' (board-pad-layers.ts): a record is built
 * only when its bounds touch the region, pads and holes go in batches of PAD_BATCH_SIZE, and tracks and arcs in batches per stroke width,
 * so a frame makes one fill or stroke per batch. Angles are counter-clockwise in canonical Y-up millimetres, the convention of the pin
 * rotation. Every outline winds counter-clockwise, so overlapping shapes in one batch add up under the non-zero fill rule. A mirror flag
 * is not drawn: the parser folds the mirror into the angle, and these shapes are symmetric about their axes. No canvas here: the builder
 * takes any object with the path operations.
 */

/** Tracks and arcs per stroke path (one path per stroke width and batch). */
export const COPPER_STROKE_BATCH = 256;

/** The path operations copper uses (a Path2D has all of them). */
export interface CopperPath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean): void;
  closePath(): void;
}

/** The paths of one side: pads and holes are filled; strokes (tracks and arcs) are stroked, one stroke width per path. */
export interface CopperLayers<P> {
  readonly pads: P[];
  readonly strokes: Array<{ readonly width: number; readonly path: P }>;
  readonly holes: P[];
}

interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
const DEGREES = Math.PI / 180;

const overlaps = (box: Box, region: Bounds2): boolean =>
  box.maxX >= region.minX && box.minX <= region.maxX && box.maxY >= region.minY && box.minY <= region.maxY;
const circleBox = (x: number, y: number, radius: number): Box => ({ minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius });

/** Bounds of a w × h rectangle centred on (x, y) and turned `degrees` counter-clockwise (exact). */
function rectangleBox(x: number, y: number, width: number, height: number, degrees: number): Box {
  const angle = degrees * DEGREES, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const hx = (width * c + height * s) / 2, hy = (width * s + height * c) / 2;
  return { minX: x - hx, minY: y - hy, maxX: x + hx, maxY: y + hy };
}

/** The long side of an oval lies along the width direction when the width is the longer side, else along the height. */
const ovalAxis = (width: number, height: number, degrees: number): number => (width >= height ? degrees : degrees + 90) * DEGREES;

/** Bounds of a stadium (oval): two half circles of radius minor / 2 at the ends of the long axis, joined by straight sides (exact). */
function ovalBox(x: number, y: number, width: number, height: number, degrees: number): Box {
  const major = Math.max(width, height), minor = Math.min(width, height);
  const axis = ovalAxis(width, height, degrees), c = Math.abs(Math.cos(axis)), s = Math.abs(Math.sin(axis));
  const along = (major - minor) / 2, radius = minor / 2;
  const hx = along * c + radius, hy = along * s + radius;
  return { minX: x - hx, minY: y - hy, maxX: x + hx, maxY: y + hy };
}

/**
 * The outline of a pad or hole centred on (x, y): a circle, a rectangle turned by `degrees`, or a stadium. Each shape starts with its own
 * moveTo, so a fill does not join it to its neighbours, and each one winds counter-clockwise.
 */
function addOutline(path: CopperPath, shape: 'round' | 'rect' | 'oval', x: number, y: number, width: number, height: number, degrees: number): void {
  if (shape === 'round') {
    const radius = width / 2;
    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }
  if (shape === 'rect') {
    const hw = width / 2, hh = height / 2, angle = degrees * DEGREES, c = Math.cos(angle), s = Math.sin(angle);
    const corners: Array<[number, number]> = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    corners.forEach(([u, v], index) => {
      const px = x + u * c - v * s, py = y + u * s + v * c;
      if (index === 0) path.moveTo(px, py); else path.lineTo(px, py);
    });
    path.closePath();
    return;
  }
  const major = Math.max(width, height), minor = Math.min(width, height);
  const axis = ovalAxis(width, height, degrees);
  const ux = Math.cos(axis), uy = Math.sin(axis), vx = -uy, vy = ux;
  const radius = minor / 2, along = (major - minor) / 2;
  const ax = x - ux * along, ay = y - uy * along, bx = x + ux * along, by = y + uy * along;
  path.moveTo(ax - vx * radius, ay - vy * radius);
  path.lineTo(bx - vx * radius, by - vy * radius);
  path.arc(bx, by, radius, axis - Math.PI / 2, axis + Math.PI / 2);
  path.lineTo(ax + vx * radius, ay + vy * radius);
  path.arc(ax, ay, radius, axis + Math.PI / 2, axis + Math.PI * 3 / 2);
  path.closePath();
}

/** A pad with a usable size (a round pad needs a width; the others a width and a height). */
const usablePad = (pad: CopperPad): boolean => pad.shape === 'round' ? pad.width > 0 : pad.width > 0 && pad.height > 0;
const padBox = (pad: CopperPad): Box =>
  pad.shape === 'round' ? circleBox(pad.x, pad.y, pad.width / 2)
    : pad.shape === 'oval' ? ovalBox(pad.x, pad.y, pad.width, pad.height, pad.rotation)
      : rectangleBox(pad.x, pad.y, pad.width, pad.height, pad.rotation);
const holeBox = (hole: DrillHole): Box =>
  hole.shape === 'round' ? circleBox(hole.x, hole.y, hole.width / 2) : ovalBox(hole.x, hole.y, hole.width, hole.height, hole.rotation);
function lineBox(line: CopperLine): Box {
  const half = line.width / 2;
  return { minX: Math.min(line.x1, line.x2) - half, minY: Math.min(line.y1, line.y2) - half, maxX: Math.max(line.x1, line.x2) + half, maxY: Math.max(line.y1, line.y2) + half };
}
/** A circle around the arc's centre with the radius of its start point, plus half the stroke width (conservative). */
const arcBox = (arc: CopperArc): Box => circleBox(arc.cx, arc.cy, Math.hypot(arc.x1 - arc.cx, arc.y1 - arc.cy) + arc.width / 2);

/** True when the copper has no record at all (the view then draws nothing and leaves the context alone). */
export const copperIsEmpty = (copper: BoardCopper): boolean => copper.pads.length + copper.lines.length + copper.arcs.length + copper.holes.length === 0;

/**
 * The paths of the copper of one side and of the holes (both sides) that a region (canonical mm) touches. Records are visited in board
 * order and each batch keeps the records it was given, so the same region always gives the same paths. A record outside the region
 * creates no path and costs one bounds test.
 */
export function buildCopperLayers<P extends CopperPath>(copper: BoardCopper, side: CopperSide, region: Bounds2, createPath: () => P): CopperLayers<P> {
  const pads: P[] = [], holes: P[] = [], strokes: Array<{ readonly width: number; readonly path: P }> = [];
  let padPath: P | null = null, padCount = 0;
  for (const pad of copper.pads) {
    if (pad.side !== side || !usablePad(pad) || !overlaps(padBox(pad), region)) continue;
    if (!padPath || padCount === PAD_BATCH_SIZE) { padPath = createPath(); pads.push(padPath); padCount = 0; }
    padCount++;
    addOutline(padPath, pad.shape === 'round' ? 'round' : pad.shape === 'oval' ? 'oval' : 'rect', pad.x, pad.y, pad.width, pad.height, pad.rotation);
  }
  const byWidth = new Map<number, { path: P; count: number }>();
  const stroke = (width: number, draw: (path: P) => void): void => {
    let entry = byWidth.get(width);
    if (!entry || entry.count === COPPER_STROKE_BATCH) {
      entry = { path: createPath(), count: 0 };
      byWidth.set(width, entry);
      strokes.push({ width, path: entry.path });
    }
    entry.count++;
    draw(entry.path);
  };
  for (const line of copper.lines) {
    if (line.side !== side || !(line.width > 0) || !overlaps(lineBox(line), region)) continue;
    stroke(line.width, path => { path.moveTo(line.x1, line.y1); path.lineTo(line.x2, line.y2); });
  }
  for (const arc of copper.arcs) {
    const radius = Math.hypot(arc.x1 - arc.cx, arc.y1 - arc.cy);
    if (arc.side !== side || !(arc.width > 0) || !(radius > 0) || !overlaps(arcBox(arc), region)) continue;
    const start = Math.atan2(arc.y1 - arc.cy, arc.x1 - arc.cx), end = Math.atan2(arc.y2 - arc.cy, arc.x2 - arc.cx);
    // The file's clockwise flag is the canvas anticlockwise flag: both mean a decreasing angle in Y-up coordinates.
    stroke(arc.width, path => { path.moveTo(arc.x1, arc.y1); path.arc(arc.cx, arc.cy, radius, start, end, arc.clockwise); });
  }
  let holePath: P | null = null, holeCount = 0;
  for (const hole of copper.holes) {
    if (!(hole.width > 0) || (hole.shape === 'oval' && !(hole.height > 0)) || !overlaps(holeBox(hole), region)) continue;
    if (!holePath || holeCount === PAD_BATCH_SIZE) { holePath = createPath(); holes.push(holePath); holeCount = 0; }
    holeCount++;
    addOutline(holePath, hole.shape === 'round' ? 'round' : 'oval', hole.x, hole.y, hole.width, hole.height, hole.rotation);
  }
  return { pads, strokes, holes };
}
