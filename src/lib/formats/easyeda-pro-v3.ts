/*
 * Original TRACE code (MIT). EasyEDA Pro V3 PCB reader. The V3 project is a ".epro2" ZIP holding project2.json and one or more *.epru logs; a bare
 * .epru log is read the same way. Vendor references: the public V3 overview (log records, documents, ticket and deletion rules) and the PCB pages
 * (pads and vias, shape primitives, basic primitives, footprints). No implementation source was read or copied.
 *
 * A log holds one record per line: a header object {"type","ticket"[,"id"]}, "||", a payload object and a closing "|". A DOCHEAD record starts a document
 * (its payload gives docType, uuid and updateTime); the records that follow belong to it until the next DOCHEAD. For one document the record with the
 * highest ticket per type and id is the current one; an empty payload deletes that record; a DELETE_DOC with isDelete true deletes the whole document.
 * The board is the latest PCB document that has COMPONENT records; the other PCB documents are disclosed.
 *
 * A component names its footprint document in its Footprint attribute. The footprint pads (PAD records) are footprint-local and are placed with the same
 * rule as the V2.2 reader (turnOf in easyeda-common.ts): a bottom part is turned by its angle plus 180 degrees (mirrored in x and turned by that, which is
 * the same as mirrored in y and turned by the angle). Pad nets come from the component's PAD_NET records. Units: the CANVAS record declares "mil" or "mm"; any other unit is refused by name.
 * Coordinates are read on a Y-up plane with counter-clockwise angles (checked against same-net track ends in the open samples, read-only).
 * Not read: tracks, vias, copper pours, text, rules and regions (disclosed). Refused by name: unknown shapes, layers and path commands.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, localizedFormatError, stitchOutlines, type ParseInput, type RawPart, type RawPin } from './common';
import { sourceBaseName } from './source-name';
import {
  EASYEDA_PRO_FORMAT, MAX_PARTS, MAX_PINS, MAX_SOURCE_UNITS, OUTLINE_CLOSURE_MM, PRO_UNIT_MM, PointBudget, arcBySweep, boxCorners, boxIsEmpty, circlePoints,
  edgesOf, emptyBox, fail, grow, normalizeAngle, note, quantity, rotateAbout, turnOf,
} from './easyeda-common';
import { openZip, ZIP_MAX_ENTRY_BYTES } from './easyeda-zip';

const FORMAT = EASYEDA_PRO_FORMAT;
const MAX_LOG_LINES = 3_000_000, MAX_LINE_CHARS = 16 * 1024 * 1024, MAX_PATH_TOKENS = 200_000, BEZIER_STEPS = 32;
/** The record types the reader reads; every other record of a log is skipped without being parsed. */
const WANTED = new Set(['DOCHEAD', 'DELETE_DOC', 'CANVAS', 'LAYER', 'COMPONENT', 'ATTR', 'PAD', 'PAD_NET', 'POLY', 'LINE', 'ARC', 'META']);
/** Layer types of the default table, used only when a document declares no LAYER records. */
const DEFAULT_LAYER_TYPES: Record<number, string> = { 1: 'TOP', 2: 'BOTTOM', 3: 'TOP_SILK', 4: 'BOT_SILK', 9: 'TOP_ASSEMBLY', 10: 'BOT_ASSEMBLY', 11: 'OUTLINE', 12: 'MULTI' };
const TEMPLATE = /^=\{([^{}]{1,80})\}$/;

type Json = Record<string, unknown>;
interface Rec { id: string; ticket: number; payload: Json | undefined }
interface Doc { docType: string; uuid: string; updateTime: number; order: number; deleted: boolean; records: Map<string, Map<string, Rec>> }
interface FootprintPad { id: string; number: string; x: number; y: number; angle: number; layer: string; kind: string; width: number; height: number; radius: number; polygon: boolean }
interface PadGeometry { shape: RawPin['shape']; width: number; height: number; radius: number; rotation: number; approx: boolean }

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** A finite number of source units (a number or plain decimal text) within the supported magnitude. */
function num(value: unknown, label: string): number {
  const result = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isFinite(result)) return fail(FORMAT, `${FORMAT}: ${label} is missing or not a number.`);
  if (Math.abs(result) > MAX_SOURCE_UNITS) return fail(FORMAT, `${FORMAT}: ${label} ${result} exceeds the supported magnitude.`, 'LIMIT_EXCEEDED');
  return result;
}
function jsonOf(source: string, label: string): unknown {
  try { return JSON.parse(source); } catch (error) {
    return fail(FORMAT, error instanceof RangeError ? `${FORMAT}: ${label} nests deeper than the import limit.` : `${FORMAT}: ${label} is not valid JSON.`, error instanceof RangeError ? 'LIMIT_EXCEEDED' : 'INVALID_FORMAT');
  }
}

/** The records of a type that are not deleted, in the order they first appeared (the current version of each). */
function live(doc: Doc, type: string): Rec[] {
  const bucket = doc.records.get(type);
  return bucket ? [...bucket.values()].filter(record => record.payload !== undefined) : [];
}

/** Reads the documents of one log. A record before the first DOCHEAD belongs to no document and is ignored. */
function readLog(source: string, budget: { lines: number }, orderBase: number): Doc[] {
  const docs: Doc[] = [];
  let current: Doc | undefined;
  let order = orderBase;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (++budget.lines > MAX_LOG_LINES) fail(FORMAT, `${FORMAT}: the V3 log has more than ${MAX_LOG_LINES} records.`, 'LIMIT_EXCEEDED');
    if (line.length > MAX_LINE_CHARS) fail(FORMAT, `${FORMAT}: a V3 log record is longer than ${MAX_LINE_CHARS} characters.`, 'LIMIT_EXCEEDED');
    const separator = line.indexOf('}||');
    if (!line.startsWith('{') || separator < 0) throw new BoardFormatError(`${FORMAT}: a line of the V3 log is not a "header||payload" record.`, 'INVALID_FORMAT', FORMAT);
    const header = jsonOf(line.slice(0, separator + 1), 'a record header');
    if (!isObject(header) || typeof header.type !== 'string') throw new BoardFormatError(`${FORMAT}: a record header has no type.`, 'INVALID_FORMAT', FORMAT);
    const body = line.slice(separator + 3);
    const payloadText = body.endsWith('|') ? body.slice(0, -1) : body;
    const type = header.type;
    if (type === 'DOCHEAD') {
      const payload = payloadText ? jsonOf(payloadText, 'a DOCHEAD payload') : undefined;
      if (!isObject(payload) || typeof payload.docType !== 'string') throw new BoardFormatError(`${FORMAT}: a DOCHEAD record has no document type.`, 'INVALID_FORMAT', FORMAT);
      current = { docType: payload.docType, uuid: textOf(payload.uuid), updateTime: typeof payload.updateTime === 'number' ? payload.updateTime : 0, order: ++order, deleted: false, records: new Map() };
      docs.push(current);
      continue;
    }
    if (!current) continue;
    if (type === 'DELETE_DOC') {
      const payload = payloadText ? jsonOf(payloadText, 'a DELETE_DOC payload') : undefined;
      if (isObject(payload) && payload.isDelete === true) current.deleted = true;
      continue;
    }
    if (!WANTED.has(type)) continue;
    const payload = payloadText ? jsonOf(payloadText, `a ${type} payload`) : undefined;
    if (payloadText && !isObject(payload)) throw new BoardFormatError(`${FORMAT}: a ${type} payload is not an object.`, 'INVALID_FORMAT', FORMAT);
    const id = textOf(header.id), ticket = typeof header.ticket === 'number' ? header.ticket : 0;
    let bucket = current.records.get(type);
    if (!bucket) { bucket = new Map(); current.records.set(type, bucket); }
    const prior = bucket.get(id);
    if (!prior || ticket >= prior.ticket) bucket.set(id, { id, ticket, payload: isObject(payload) ? payload : undefined });
  }
  return docs;
}

/** The rounded rectangle of the R primitive: (x, y) is the top-left corner and the rectangle extends right and down (Y-up plane). */
function roundedRect(x: number, y: number, width: number, height: number, round: number, budget: PointBudget): Point[] {
  const radius = Math.max(0, Math.min(round, width / 2, height / 2));
  const left = x, right = x + width, top = y, bottom = y - height;
  if (radius === 0) return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }, { x: left, y: top }];
  const corner = (cx: number, cy: number, from: number, to: number): Point[] => {
    const steps = 8;
    budget.take(steps + 1);
    const points: Point[] = [];
    for (let s = 0; s <= steps; s++) { const a = (from + ((to - from) * s) / steps) * Math.PI / 180; points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) }); }
    return points;
  };
  const points = [
    ...corner(left + radius, bottom + radius, 180, 270), ...corner(right - radius, bottom + radius, 270, 360),
    ...corner(right - radius, top - radius, 0, 90), ...corner(left + radius, top - radius, 90, 180),
  ];
  points.push(points[0]);
  return points;
}

/** The R primitive: R X Y width height rot [isCCW] round. A rotated rectangle is refused: the vendor does not state the turn direction. */
function rectanglePath(tokens: unknown[], budget: PointBudget): { points: Point[]; curved: boolean } {
  const values = tokens.slice(1).map((value, index) => num(value, `rectangle parameter ${index + 1}`));
  if (values.length < 5 || values.length > 7) throw new BoardFormatError(`${FORMAT}: a rectangle has ${values.length} parameters; only the documented forms are read.`, 'UNSUPPORTED_VARIANT', FORMAT);
  const [x, y, width, height, rotation] = values;
  const round = values.length === 5 ? 0 : values.length === 6 ? values[5] : values[6];
  if (normalizeAngle(rotation) !== 0) throw new BoardFormatError(`${FORMAT}: a rotated rectangle is not read; the vendor does not state the turn direction of the R primitive.`, 'UNSUPPORTED_VARIANT', FORMAT);
  if (!(width > 0) || !(height > 0)) throw new BoardFormatError(`${FORMAT}: a rectangle has no size.`, 'INVALID_FORMAT', FORMAT);
  return { points: roundedRect(x, y, width, height, round, budget), curved: round > 0 };
}

/** One path: a point, then L (line), ARC (angle, endX, endY) or C (three control points) commands; or a single R or CIRCLE primitive. */
function singlePath(tokens: unknown[], budget: PointBudget): { points: Point[]; curved: boolean } {
  if (tokens.length > MAX_PATH_TOKENS) fail(FORMAT, `${FORMAT}: a shape path has more than ${MAX_PATH_TOKENS} elements.`, 'LIMIT_EXCEEDED');
  if (tokens[0] === 'R') return rectanglePath(tokens, budget);
  if (tokens[0] === 'CIRCLE') return { points: circlePoints({ x: num(tokens[1], 'circle x'), y: num(tokens[2], 'circle y') }, Math.abs(num(tokens[3], 'circle radius')), budget), curved: true };
  const points: Point[] = [{ x: num(tokens[0], 'path x'), y: num(tokens[1], 'path y') }];
  let mode: 'L' | 'ARC' | 'C' = 'L', curved = false;
  for (let i = 2; i < tokens.length;) {
    const token = tokens[i];
    if (typeof token === 'string') {
      const command = token.toUpperCase();
      if (command !== 'L' && command !== 'ARC' && command !== 'C') throw new BoardFormatError(`${FORMAT}: a shape path uses the "${token.slice(0, 12)}" command, which is not supported.`, 'UNSUPPORTED_VARIANT', FORMAT);
      mode = command as 'L' | 'ARC' | 'C';
      curved = curved || command !== 'L';
      i++;
      continue;
    }
    const last = points[points.length - 1];
    if (mode === 'L') { points.push({ x: num(token, 'path x'), y: num(tokens[i + 1], 'path y') }); i += 2; }
    else if (mode === 'ARC') {
      const end = { x: num(tokens[i + 1], 'arc end x'), y: num(tokens[i + 2], 'arc end y') };
      points.push(...arcBySweep(last, end, num(token, 'arc angle'), budget).slice(1));
      i += 3;
    } else {
      const p2 = { x: num(token, 'curve x'), y: num(tokens[i + 1], 'curve y') }, p3 = { x: num(tokens[i + 2], 'curve x'), y: num(tokens[i + 3], 'curve y') };
      const p4 = { x: num(tokens[i + 4], 'curve x'), y: num(tokens[i + 5], 'curve y') };
      budget.take(BEZIER_STEPS);
      for (let s = 1; s <= BEZIER_STEPS; s++) {
        const t = s / BEZIER_STEPS, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        points.push({ x: a * last.x + b * p2.x + c * p3.x + d * p4.x, y: a * last.y + b * p2.y + c * p3.y + d * p4.y });
      }
      i += 6;
    }
  }
  return { points, curved };
}

/** A shape path: one path, or a complex shape (a list of paths: the first is the outer frame, the others are holes). */
function pathOf(path: unknown, budget: PointBudget): { loops: Point[][]; curved: boolean } {
  if (path === undefined || path === null) return { loops: [], curved: false };
  if (!Array.isArray(path)) return fail(FORMAT, `${FORMAT}: a shape path is not a list.`);
  if (path.length && Array.isArray(path[0])) {
    let curved = false;
    const loops = path.map(single => {
      if (!Array.isArray(single)) return fail(FORMAT, `${FORMAT}: a complex shape holds a non-list.`);
      const one = singlePath(single as unknown[], budget);
      curved = curved || one.curved;
      return one.points;
    });
    return { loops, curved };
  }
  const one = singlePath(path as unknown[], budget);
  return { loops: one.points.length ? [one.points] : [], curved: one.curved };
}

/** A pad of a footprint (or a free pad of the board). OVAL and ELLIPSE pads keep their width and height; POLYGON pads keep their box. */
function footprintPad(record: Rec, typeOf: (id: number) => string, budget: PointBudget): FootprintPad {
  const payload = record.payload ?? {};
  const layerId = num(payload.layerId, 'a pad layer');
  const layer = typeOf(layerId);
  if (layer !== 'TOP' && layer !== 'BOTTOM' && layer !== 'MULTI') throw new BoardFormatError(`${FORMAT}: a pad is on layer ${layerId} (${layer || 'unknown'}); only TOP, BOTTOM and MULTI pads are supported.`, 'UNSUPPORTED_VARIANT', FORMAT);
  const shape: Json = isObject(payload.defaultPad) ? payload.defaultPad : {};
  const kind = textOf(shape.padType).toUpperCase();
  const angle = payload.padAngle === undefined || payload.padAngle === null ? 0 : num(payload.padAngle, 'pad angle');
  const number = textOf(payload.num).trim();
  if (kind === 'POLYGON') {
    const box = emptyBox();
    for (const loop of pathOf(shape.path, budget).loops) for (const p of loop) grow(box, p.x, p.y);
    if (boxIsEmpty(box)) throw new BoardFormatError(`${FORMAT}: a polygon pad has no outline.`, 'INVALID_FORMAT', FORMAT);
    return { id: record.id, number, x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, angle, layer, kind, width: box.maxX - box.minX, height: box.maxY - box.minY, radius: 0, polygon: true };
  }
  if (kind !== 'RECT' && kind !== 'ELLIPSE' && kind !== 'OVAL') throw new BoardFormatError(`${FORMAT}: a pad has shape "${kind.slice(0, 20)}", which is not documented.`, 'UNSUPPORTED_VARIANT', FORMAT);
  return {
    id: record.id, number, x: num(payload.centerX, 'pad x'), y: num(payload.centerY, 'pad y'), angle, layer, kind,
    width: Math.abs(num(shape.width, 'pad width')), height: Math.abs(num(shape.height, 'pad height')),
    radius: shape.radius === undefined || shape.radius === null ? 0 : Math.abs(num(shape.radius, 'pad radius')), polygon: false,
  };
}

/** Shape, size, rotation and whether the shape is approximated, for a pad on a part turned by `turn` (bottom parts are mirrored in x first). */
function padGeometry(pad: FootprintPad, bottom: boolean, turn: number): PadGeometry {
  const rotation = normalizeAngle(pad.polygon ? turn : bottom ? 180 - pad.angle + turn : turn + pad.angle);
  const { width, height } = pad;
  const equal = Math.abs(width - height) < 1e-9 * Math.max(width, height, 1);
  if (pad.polygon) return { shape: equal ? 'square' : 'rect', width, height, radius: Math.min(width, height) / 2, rotation, approx: true };
  if (pad.kind === 'RECT') return { shape: equal ? 'square' : 'rect', width, height, radius: Math.min(width, height) / 2, rotation, approx: pad.radius > 0 };
  if (equal) return { shape: 'round', width, height, radius: width / 2, rotation, approx: false };
  return { shape: 'rect', width, height, radius: Math.min(width, height) / 2, rotation, approx: true };
}

/** A footprint's title (its META record), used as the package name. */
function titleOf(doc: Doc): string {
  const meta = live(doc, 'META').find(record => typeof record.payload?.title === 'string');
  return meta ? textOf(meta.payload?.title).trim() : '';
}

/** An attribute's text; a "={Other}" template is resolved against the same part, one level deep (as in the V2.2 reader). */
function attributeText(attrs: Map<string, { value: string; ticket: number }> | undefined, key: string): string {
  const raw = attrs?.get(key)?.value.trim() ?? '';
  const match = TEMPLATE.exec(raw);
  if (!match) return raw;
  const target = attrs?.get(match[1])?.value.trim() ?? '';
  return TEMPLATE.test(target) ? '' : target;
}

/** The board of the chosen PCB document, placed with the V2.2 rules. Refuses by name when there is no PCB document with components. */
function boardOfV3(docs: Doc[], input: ParseInput): Board {
  const pcbs = docs.filter(doc => doc.docType === 'PCB' && !doc.deleted);
  const boards = pcbs.filter(doc => live(doc, 'COMPONENT').length > 0);
  if (!boards.length) throw new BoardFormatError(`${FORMAT}: this EasyEDA Pro V3 project has no PCB document with components (it holds schematics, symbols and footprints only), so there is no board to read.`, 'WRONG_KIND', FORMAT);
  const chosen = boards.reduce((best, doc) => (doc.updateTime > best.updateTime || (doc.updateTime === best.updateTime && doc.order > best.order) ? doc : best));
  const warnings: ParseIssue[] = [];
  if (pcbs.length > 1) warnings.push(note(`The project has ${pcbs.length} PCB documents; the one with components and the latest update was opened and the others were not.`));
  const unit = textOf(live(chosen, 'CANVAS')[0]?.payload?.unit);
  if (unit !== 'mil' && unit !== 'mm') throw new BoardFormatError(`${FORMAT}: the PCB document declares the unit "${unit.slice(0, 12)}", which the reader does not read (mil and mm are read).`, 'UNSUPPORTED_VARIANT', FORMAT);
  const scale = unit === 'mil' ? PRO_UNIT_MM : 1;
  const layerTypes = new Map<number, string>();
  for (const record of live(chosen, 'LAYER')) {
    const id = Number(record.payload?.layerId), type = record.payload?.layerType;
    if (Number.isInteger(id) && typeof type === 'string') layerTypes.set(id, type);
  }
  const typeOf = (id: number): string => layerTypes.get(id) ?? (layerTypes.size ? '' : DEFAULT_LAYER_TYPES[id] ?? '');
  const footprints = new Map<string, Doc>();
  for (const doc of docs) if (doc.docType === 'FOOTPRINT' && !doc.deleted && doc.uuid) {
    const prior = footprints.get(doc.uuid);
    if (!prior || doc.updateTime >= prior.updateTime) footprints.set(doc.uuid, doc);
  }
  const padNet = new Map<string, string>();
  for (const record of live(chosen, 'PAD_NET')) {
    const parts = jsonOf(record.id, 'a PAD_NET identity');
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'PAD_NET') throw new BoardFormatError(`${FORMAT}: a PAD_NET record is malformed.`, 'INVALID_FORMAT', FORMAT);
    const net = typeof record.payload?.padNet === 'string' ? record.payload.padNet.trim() : '';
    padNet.set(`${textOf(parts[1])}\u0001${textOf(parts[3])}`, net);
    padNet.set(`${textOf(parts[1])}\u0001#${textOf(parts[2])}`, net);
  }
  const attrs = new Map<string, Map<string, { value: string; ticket: number }>>();
  for (const record of live(chosen, 'ATTR')) {
    const parent = textOf(record.payload?.parentId), key = textOf(record.payload?.key), value = record.payload?.value;
    if (!parent || !key || (typeof value !== 'string' && typeof value !== 'number')) continue;
    const map = attrs.get(parent) ?? new Map<string, { value: string; ticket: number }>();
    attrs.set(parent, map);
    const prior = map.get(key);
    if (!prior || record.ticket >= prior.ticket) map.set(key, { value: String(value), ticket: record.ticket });
  }
  const budget = new PointBudget(FORMAT);
  const parts: RawPart[] = [], pins: RawPin[] = [];
  let approximated = 0, mirrored = 0, unresolved = 0;
  const components = live(chosen, 'COMPONENT');
  if (components.length > MAX_PARTS) throw new BoardFormatError(`${FORMAT}: the board has more components than the import limit.`, 'LIMIT_EXCEEDED', FORMAT);
  components.forEach((component, index) => {
    const layerId = num(component.payload?.layerId, 'a component layer');
    const layer = typeOf(layerId);
    if (layer !== 'TOP' && layer !== 'BOTTOM') throw new BoardFormatError(`${FORMAT}: a component is on layer ${layerId} (${layer || 'unknown'}); only TOP and BOTTOM components are supported.`, 'UNSUPPORTED_VARIANT', FORMAT);
    const bottom = layer === 'BOTTOM';
    const theta = component.payload?.angle === undefined || component.payload?.angle === null ? 0 : num(component.payload?.angle, 'component angle');
    const origin = { x: num(component.payload?.x, 'component x'), y: num(component.payload?.y, 'component y') };
    const turn = turnOf(theta, bottom);
    const place = (p: Point): Point => { const turned = rotateAbout({ x: bottom ? -p.x : p.x, y: p.y }, { x: 0, y: 0 }, turn); return { x: origin.x + turned.x, y: origin.y + turned.y }; };
    const attributes = attrs.get(component.id);
    const reference = attributeText(attributes, 'Designator');
    const value = attributeText(attributes, 'Value') || attributeText(attributes, 'Name');
    const footprintDoc = footprints.get(attributeText(attributes, 'Footprint'));
    let packageName = '', outline: Point[] | undefined;
    if (!footprintDoc) unresolved++;
    else {
      packageName = titleOf(footprintDoc);
      const pads = live(footprintDoc, 'PAD').map(record => footprintPad(record, typeOf, budget));
      const taken = new Set(pads.map(pad => pad.number));
      let spare = 0;
      const box = emptyBox();
      if (bottom && pads.length) mirrored++;
      for (const pad of pads) {
        const geometry = padGeometry(pad, bottom, turn);
        if (geometry.approx) approximated++;
        let number = pad.number, generated = false;
        if (number === '') { let candidate: string; do candidate = `~${++spare}`; while (taken.has(candidate)); taken.add(candidate); number = candidate; generated = true; }
        const side: BoardSide = pad.layer === 'MULTI' ? 'both' : (pad.layer === 'TOP') !== bottom ? 'top' : 'bottom';
        const net = padNet.get(`${component.id}\u0001${pad.id}`) ?? padNet.get(`${component.id}\u0001#${pad.number}`) ?? '';
        pins.push({ part: component.id, number, ...(generated ? { numberGenerated: true } : {}), name: number, net, ...place({ x: pad.x, y: pad.y }), side,
          shape: geometry.shape, width: geometry.width, height: geometry.height, radius: geometry.radius, rotation: geometry.rotation });
        const reach = Math.max(pad.width, pad.height) / 2;
        grow(box, pad.x - reach, pad.y - reach); grow(box, pad.x + reach, pad.y + reach);
      }
      if (!boxIsEmpty(box)) outline = boxCorners(box).map(place);
    }
    if (pins.length > MAX_PINS) throw new BoardFormatError(`${FORMAT}: the board has more pads than the import limit.`, 'LIMIT_EXCEEDED', FORMAT);
    parts.push({ key: component.id, ref: reference || `FP${index + 1}`, ...(reference ? {} : { refGenerated: true }), value, package: packageName,
      side: bottom ? 'bottom' : 'top', position: origin, rotation: normalizeAngle(theta), outline });
  });
  // Free pads of the board: one part each, only when the pad carries a net.
  let free = 0, unnetted = 0;
  for (const record of live(chosen, 'PAD')) {
    const net = textOf(record.payload?.netName).trim();
    if (!net) { unnetted++; continue; }
    const pad = footprintPad(record, typeOf, budget);
    const geometry = padGeometry(pad, false, 0);
    if (geometry.approx) approximated++;
    const key = `free:${free++}`, reach = Math.max(pad.width, pad.height) / 2;
    parts.push({ key, ref: `PAD${free}`, refGenerated: true, value: '', package: '', side: pad.layer === 'BOTTOM' ? 'bottom' : 'top', position: { x: pad.x, y: pad.y },
      bounds: { minX: pad.x - reach, minY: pad.y - reach, maxX: pad.x + reach, maxY: pad.y + reach } });
    pins.push({ part: key, number: pad.number || '~1', ...(pad.number ? {} : { numberGenerated: true }), name: pad.number || '~1', net, x: pad.x, y: pad.y,
      side: pad.layer === 'MULTI' ? 'both' : pad.layer === 'BOTTOM' ? 'bottom' : 'top', shape: geometry.shape, width: geometry.width, height: geometry.height,
      radius: geometry.radius, rotation: geometry.rotation });
  }
  // Board outline: OUTLINE-layer polygons, lines and arcs, stitched into closed loops (the inner loops are disclosed as cutouts).
  const segments: Array<[Point, Point]> = [];
  let arcs = 0;
  const onOutline = (record: Rec): boolean => typeOf(num(record.payload?.layerId, 'a shape layer')) === 'OUTLINE';
  for (const record of live(chosen, 'POLY')) if (onOutline(record)) {
    const shape = pathOf(record.payload?.path, budget);
    if (shape.curved) arcs++;
    for (const loop of shape.loops) segments.push(...edgesOf(loop));
  }
  for (const record of live(chosen, 'LINE')) if (onOutline(record)) {
    segments.push([{ x: num(record.payload?.startX, 'outline start x'), y: num(record.payload?.startY, 'outline start y') }, { x: num(record.payload?.endX, 'outline end x'), y: num(record.payload?.endY, 'outline end y') }]);
  }
  for (const record of live(chosen, 'ARC')) if (onOutline(record)) {
    const path = arcBySweep({ x: num(record.payload?.startX, 'outline arc start x'), y: num(record.payload?.startY, 'outline arc start y') },
      { x: num(record.payload?.endX, 'outline arc end x'), y: num(record.payload?.endY, 'outline arc end y') }, num(record.payload?.angle, 'outline arc angle'), budget);
    if (path.length > 2) arcs++;
    segments.push(...edgesOf(path));
  }
  const { loops, openChains } = stitchOutlines(segments, OUTLINE_CLOSURE_MM / scale);
  if (segments.length && !loops.length) warnings.push(note('EasyEDA board outline (OUTLINE layer) does not form a closed contour; an estimated boundary is shown.'));
  else if (openChains) warnings.push(note(`${openChains} open EasyEDA outline chain${openChains === 1 ? '' : 's'} (spurs, chords or gaps) are not part of a closed contour and were ignored.`));
  if (arcs && loops.length) warnings.push(note(`${arcs} EasyEDA outline arcs/curves were approximated by straight segments.`));
  if (loops.length > 1) warnings.push({ key: 'parse.warning.boardCutouts' });
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });
  if (mirrored) warnings.push(note(`${quantity(mirrored, 'bottom-side component')} ${mirrored === 1 ? 'is' : 'are'} placed mirrored and turned by the part angle plus 180 degrees, the EasyEDA Pro placement; real files confirm this for bottom parts turned by 0, 90, 180 or 270 degrees, and no real file has been checked for other angles, so check the pad positions before probing.`));
  if (unresolved) warnings.push(note(`${quantity(unresolved, 'component')} ${unresolved === 1 ? 'has' : 'have'} no footprint in the file, so ${unresolved === 1 ? 'it has' : 'they have'} no pads.`));
  if (unnetted) warnings.push(note(`${quantity(unnetted, 'free pad')} without a net (mounting pads and the like) ${unnetted === 1 ? 'was' : 'were'} not imported.`));
  warnings.push(note('Tracks, vias, copper pours and text are not imported; nets come from the part pad assignments only.'));
  return buildBoard(input, { format: FORMAT, unitsToMm: scale, parts, pins, outline: loops[0] ?? [], outlines: loops, warnings });
}

/** The bare V3 log text: "pcb" when it holds a PCB document with components, otherwise "unsupported" (recognized, refused by name). */
export function sniffV3LogKind(source: string): 'pcb' | 'unsupported' {
  return /\{\s*"type"\s*:\s*"COMPONENT"/.test(source) && /"docType"\s*:\s*"PCB"/.test(source) ? 'pcb' : 'unsupported';
}

/** A bare V3 log (the .epru text itself). */
export function parseEasyedaProV3Log(input: ParseInput): Board {
  const docs = readLog(decodeText(input.data), { lines: 0 }, 0);
  return boardOfV3(docs, input);
}

/**
 * A V3 project container: the ".epro2" ZIP with project2.json and its .epru logs. A project that cannot be read is refused with its file name in
 * the catalog text (parse.error.v3ProjectUnreadable); the English message stays the developer text. A size limit keeps its own message.
 */
export function parseEasyedaProV3Container(input: ParseInput): Board {
  try { return readV3Container(input); }
  catch (error) {
    if (error instanceof BoardFormatError && error.code !== 'LIMIT_EXCEEDED' && !error.issue) {
      throw localizedFormatError(error.message, error.code, { key: 'parse.error.v3ProjectUnreadable', params: { file: sourceBaseName(input.name, input.platform) } }, FORMAT);
    }
    throw error;
  }
}
function readV3Container(input: ParseInput): Board {
  const archive = openZip(input.data, FORMAT);
  if (!archive) throw new BoardFormatError(`${FORMAT}: the file is not a readable ZIP archive.`, 'INVALID_FORMAT', FORMAT);
  const logs = archive.entries.filter(entry => /\.epru$/i.test(entry.name));
  if (!logs.length) throw new BoardFormatError(`${FORMAT}: the archive holds no V3 document log (.epru).`, 'INVALID_FORMAT', FORMAT);
  const budget = { lines: 0 }, docs: Doc[] = [];
  for (const entry of logs) docs.push(...readLog(decodeText(archive.read(entry, ZIP_MAX_ENTRY_BYTES)), budget, docs.length));
  return boardOfV3(docs, input);
}
