import { padBounds } from '../lib/geometry';
import type { Bounds2 } from '../lib/geometry';
import { appendPadPath, PAD_POINT_PX } from '../lib/render-geometry';
import type { BoardPin } from '../lib/types';

type PadPath = Parameters<typeof appendPadPath>[0];

/** Pads per native compound path: bounds the cost of closing contours and the number of fills (unchanged from the original renderer). */
export const PAD_BATCH_SIZE = 64;
/** Screen-pixel margin around the viewport that is always built: a display-only pad marker is at most 2.2 px around the pad centre. */
export const PAD_VIEW_MARGIN_PX = 16;
/** Extra margin (fraction of the larger canvas side) built beyond the viewport so panning does not rebuild paths on every frame. */
export const PAD_REGION_SLACK = 0.25;

export interface PadLayers<P> { ordinary: P[]; selectedComponent: P[]; net: P[] }

/** The layers of a plan in draw order (the index of each layer's table and batch list). */
export const PAD_LAYER = { ordinary: 0, selectedComponent: 1, net: 2 } as const;
const LAYER_ORDINARY = PAD_LAYER.ordinary, LAYER_COMPONENT = PAD_LAYER.selectedComponent, LAYER_NET = PAD_LAYER.net;
/** The marker size (screen px) of each layer — the same values the renderer always used. */
const MARKER_PIXELS = [1, 1.8, 2.2] as const;
/** A batch's threshold is raised by this factor: rounding at the exact boundary can never change a reused path. */
const SCALE_MARGIN = 1 + 1e-9;

/** Physical bounds of every pad of one side (canonical mm), cached per pin array: independent of the zoom. */
interface PadBoundsTable { minX: Float64Array; minY: Float64Array; maxX: Float64Array; maxY: Float64Array }
const boundsTables = new WeakMap<readonly BoardPin[], PadBoundsTable>();
function boundsTableOf(pins: readonly BoardPin[]): PadBoundsTable {
  let table = boundsTables.get(pins);
  if (table) return table;
  const count = pins.length;
  table = { minX: new Float64Array(count), minY: new Float64Array(count), maxX: new Float64Array(count), maxY: new Float64Array(count) };
  for (let i = 0; i < count; i++) {
    const b = padBounds(pins[i]);
    table.minX[i] = b.minX; table.minY[i] = b.minY; table.maxX[i] = b.maxX; table.maxY[i] = b.maxY;
  }
  boundsTables.set(pins, table);
  return table;
}

/**
 * The smallest scale from which the display path of a pad (appendPadPath) is the same at every larger scale: the marker size
 * (markerPixels / scale) no longer exceeds the pad's own radius or half extent. Infinite for a pad without a size, so that pad is
 * rebuilt at every zoom step.
 */
export function padScaleThreshold(pin: BoardPin, markerPixels: number): number {
  const radius = markerPixels / pin.radius;
  // The point level of detail (appendPadPoint) ends at the pad's own size: from that scale up the pad is drawn as itself.
  const point = PAD_POINT_PX / pin.radius;
  if (pin.shape === 'round' || !(pin.width || pin.height)) return Math.max(radius, point);
  // A missing side falls back to the radius (appendPadPath: `pin.width ?? radius * 2`), so it depends on the marker as well.
  const widthTerm = pin.width != null ? 1.5 / pin.width : Math.max(radius, 1.5 / (2 * pin.radius));
  const heightTerm = pin.height != null ? 1.5 / pin.height : Math.max(radius, 1.5 / (2 * pin.radius));
  const ownHalf = Math.max(pin.width ?? pin.radius * 2, pin.height ?? pin.radius * 2) / 2;
  return Math.max(widthTerm, heightTerm, PAD_POINT_PX / ownHalf);
}

/**
 * One layer of a plan: its batches of PAD_BATCH_SIZE pads in pin order (batch b holds members[b * 64 ..]), their physical bounds and
 * the scale from which their display paths stop depending on the zoom.
 */
export interface PadBatchTable {
  readonly members: Uint32Array;
  readonly count: number;
  readonly minX: Float64Array;
  readonly minY: Float64Array;
  readonly maxX: Float64Array;
  readonly maxY: Float64Array;
  readonly threshold: Float64Array;
}

/**
 * Which layer and which 64-pad batch every pad belongs to. It depends on the selection only (not on the zoom or the viewport), so a zoom
 * step reuses it and every batch keeps exactly the members it always had.
 */
export interface PadLayerPlan {
  readonly pins: readonly BoardPin[];
  readonly net: string | null;
  readonly component: string | null;
  readonly layer: Uint8Array;
  readonly batch: Uint32Array;
  /** The tables of the ordinary, selected-component and selected-net layers, in that order (the draw order). */
  readonly tables: readonly PadBatchTable[];
}

export function planPadLayers(pins: readonly BoardPin[], selectedNet: string | null, selectedComponent: string | null): PadLayerPlan {
  const layer = new Uint8Array(pins.length), batch = new Uint32Array(pins.length);
  const counts = [0, 0, 0];
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    const kind = selectedNet && pin.net === selectedNet ? LAYER_NET : pin.componentId === selectedComponent ? LAYER_COMPONENT : LAYER_ORDINARY;
    layer[i] = kind;
    batch[i] = Math.floor(counts[kind]++ / PAD_BATCH_SIZE);
  }
  const table = boundsTableOf(pins);
  const tables = [LAYER_ORDINARY, LAYER_COMPONENT, LAYER_NET].map(kind => batchTable(pins, layer, kind, counts[kind], table));
  return { pins, net: selectedNet, component: selectedComponent, layer, batch, tables };
}

function batchTable(pins: readonly BoardPin[], layer: Uint8Array, kind: number, size: number, table: PadBoundsTable): PadBatchTable {
  const members = new Uint32Array(size);
  let filled = 0;
  for (let i = 0; i < pins.length; i++) if (layer[i] === kind) members[filled++] = i;
  const count = Math.ceil(size / PAD_BATCH_SIZE);
  const result: PadBatchTable = {
    members, count,
    minX: new Float64Array(count), minY: new Float64Array(count), maxX: new Float64Array(count), maxY: new Float64Array(count),
    threshold: new Float64Array(count),
  };
  for (let b = 0; b < count; b++) {
    const end = Math.min(size, (b + 1) * PAD_BATCH_SIZE);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, threshold = 0;
    for (let k = b * PAD_BATCH_SIZE; k < end; k++) {
      const i = members[k];
      minX = Math.min(minX, table.minX[i]); minY = Math.min(minY, table.minY[i]);
      maxX = Math.max(maxX, table.maxX[i]); maxY = Math.max(maxY, table.maxY[i]);
      threshold = Math.max(threshold, padScaleThreshold(pins[i], MARKER_PIXELS[kind]));
    }
    result.minX[b] = minX; result.minY[b] = minY; result.maxX[b] = maxX; result.maxY[b] = maxY;
    result.threshold[b] = threshold * SCALE_MARGIN;
  }
  return result;
}

export const samePadPlan = (plan: PadLayerPlan | null, pins: readonly BoardPin[], net: string | null, component: string | null): plan is PadLayerPlan =>
  !!plan && plan.pins === pins && plan.net === net && plan.component === component;

/** True when `inner` lies completely inside `outer`. */
export const boundsCover = (outer: Bounds2, inner: Bounds2) =>
  outer.minX <= inner.minX && outer.maxX >= inner.maxX && outer.minY <= inner.minY && outer.maxY >= inner.maxY;

/**
 * P04: the display paths of the pads whose physical bounds touch `region` (canonical mm), batched exactly as a full build would batch
 * them. Pads outside the region are neither visited by the path builder nor filled. This is the reference build: PadBatchCache.build
 * returns the same paths, and the tests compare the two.
 */
export function buildPadLayers<P extends PadPath>(plan: PadLayerPlan, region: Bounds2, scale: number, createPath: () => P): PadLayers<P> {
  const table = boundsTableOf(plan.pins);
  const result: PadLayers<P> = { ordinary: [], selectedComponent: [], net: [] };
  const lists = [result.ordinary, result.selectedComponent, result.net];
  const currentBatch = [-1, -1, -1];
  const currentPath: Array<P | null> = [null, null, null];
  const { minX, minY, maxX, maxY } = table;
  for (let i = 0; i < plan.pins.length; i++) {
    if (maxX[i] < region.minX || minX[i] > region.maxX || maxY[i] < region.minY || minY[i] > region.maxY) continue;
    const kind = plan.layer[i];
    let path = currentPath[kind];
    if (!path || currentBatch[kind] !== plan.batch[i]) {
      path = createPath();
      currentPath[kind] = path; currentBatch[kind] = plan.batch[i];
      lists[kind].push(path);
    }
    appendPadPath(path, plan.pins[i], scale, MARKER_PIXELS[kind]);
  }
  return result;
}

/** True when the physical bounds of batch `batch` touch `region` (a batch that does not touch it has no pad that does). */
const batchTouches = (table: PadBatchTable, batch: number, region: Bounds2) =>
  !(table.maxX[batch] < region.minX || table.minX[batch] > region.maxX || table.maxY[batch] < region.minY || table.minY[batch] > region.maxY);

/** True when every pad of batch `batch` lies inside `region`: the region then holds the full batch. */
const batchInside = (table: PadBatchTable, batch: number, region: Bounds2) =>
  table.minX[batch] >= region.minX && table.maxX[batch] <= region.maxX && table.minY[batch] >= region.minY && table.maxY[batch] <= region.maxY;

interface BatchEntry<P> { readonly scale: number; readonly path: P }

/**
 * The display paths of a plan, kept between builds. build() returns exactly the paths buildPadLayers returns for the same region and
 * scale: the same pads in the same batches in the same order, so the pixels are the same. What it saves is the work: a batch that lies
 * wholly inside the region is its full batch, and its path is kept and reused by every later build while the region still holds the
 * batch and the batch's geometry does not change with the zoom (padScaleThreshold). A zoom step on a board whose pads are much larger
 * than a marker therefore reuses those paths. A batch that only partly lies inside the region is built from its pads in the region.
 */
export class PadBatchCache<P extends PadPath> {
  private readonly entries: Array<Array<BatchEntry<P> | undefined>>;
  private readonly bounds: PadBoundsTable;

  constructor(readonly plan: PadLayerPlan, private readonly createPath: () => P) {
    this.entries = plan.tables.map(table => new Array<BatchEntry<P> | undefined>(table.count));
    this.bounds = boundsTableOf(plan.pins);
  }

  /** The paths of the pads that touch `region` at this scale, as buildPadLayers builds them. */
  build(region: Bounds2, scale: number): PadLayers<P> {
    const result: PadLayers<P> = { ordinary: [], selectedComponent: [], net: [] };
    const lists = [result.ordinary, result.selectedComponent, result.net];
    this.plan.tables.forEach((table, layer) => {
      const entries = this.entries[layer];
      for (let batch = 0; batch < table.count; batch++) {
        if (!batchTouches(table, batch, region)) { entries[batch] = undefined; continue; }
        const path = batchInside(table, batch, region) ? this.fullPath(layer, batch, scale) : this.partPath(layer, batch, region, scale);
        if (path) lists[layer].push(path);
      }
    });
    return result;
  }

  /** The path of a whole batch at this scale: the kept one when its geometry is the same, else a new one (kept). */
  private fullPath(layer: number, batch: number, scale: number): P {
    const table = this.plan.tables[layer];
    const entries = this.entries[layer];
    const entry = entries[batch];
    if (entry && (entry.scale === scale || (entry.scale >= table.threshold[batch] && scale >= table.threshold[batch]))) return entry.path;
    const path = this.createPath();
    const end = Math.min(table.members.length, (batch + 1) * PAD_BATCH_SIZE);
    for (let k = batch * PAD_BATCH_SIZE; k < end; k++) appendPadPath(path, this.plan.pins[table.members[k]], scale, MARKER_PIXELS[layer]);
    entries[batch] = { scale, path };
    return path;
  }

  /** The path of the pads of a batch that touch `region`, or null when none does (such a path is not built, as in buildPadLayers). */
  private partPath(layer: number, batch: number, region: Bounds2, scale: number): P | null {
    const table = this.plan.tables[layer];
    const { minX, minY, maxX, maxY } = this.bounds;
    const end = Math.min(table.members.length, (batch + 1) * PAD_BATCH_SIZE);
    let path: P | null = null;
    for (let k = batch * PAD_BATCH_SIZE; k < end; k++) {
      const pad = table.members[k];
      if (maxX[pad] < region.minX || minX[pad] > region.maxX || maxY[pad] < region.minY || minY[pad] > region.maxY) continue;
      if (!path) path = this.createPath();
      appendPadPath(path, this.plan.pins[pad], scale, MARKER_PIXELS[layer]);
    }
    return path;
  }
}
