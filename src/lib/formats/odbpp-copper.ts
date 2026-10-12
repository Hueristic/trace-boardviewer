/*
 * Original TRACE module (MIT). Copper pads, track lines and arcs of the top and bottom copper layers, and drilled holes (from the drill
 * layers and their tools file) of one ODB++ step. Record grammar: the layer features files (P pads, L lines, A arcs with the symbol table
 * "$n name" and an optional UNITS directive) and the tools files (TOOLS blocks with NUM, TYPE and DRILL_SIZE). Layer and step structure
 * come from odbpp.ts; this module only interprets the two file kinds.
 *
 * Units: coordinates are in the file's units (MM or INCH) and become board millimetres, the same frame as the component records. A
 * standard symbol's size is in 1/1000 of the file's units (micrometres for MM, mils for INCH), as the symbol names say.
 * Orientation: only ODB++ orientation codes 8 (angle) and 9 (mirrored, angle) are read; other codes are counted and skipped. The file turns
 * a feature clockwise by its angle and mirrors it after the turn (code 9), as it does a component's rotation (odbpp.ts header). The angle
 * is stored counter-clockwise, the pin convention (traceAngle); the shape itself is not transformed. Arcs: the direction flag Y is
 * clockwise in the file's frame, N counter-clockwise.
 * Drill plating: each hole's diameter (slots: their short side) selects the tools of that size; PLATED and VIA are plated, NON_PLATED is
 * not, and a size that matches tools of different types is reported as unknown.
 *
 * Checked only on counts from KiCad 9.0.9 ODB++ exports of open designs (a scratch comparison, not in the repository and not a test); no
 * vendor-written file has been read. Not read: pours (surfaces), text, barcodes, custom symbols, negative (clear) features, inner copper
 * layers, silkscreen, paste and mask. Every skipped record is counted and reported in an import note.
 */
import type { BoardCopper, CopperArc, CopperLine, CopperPad, CopperSide, DrillHole } from '../types';
import { MM_PER_UNIT, type OdbUnits } from './odbpp-records';

/** Most copper and drill records one board may hold; above it the copper data is not read at all (and the import says so). */
export const COPPER_RECORD_LIMIT = 1_000_000;

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const num = (token: string | undefined): number | null => {
  if (token === undefined || !NUMBER.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
};

export type FeatureRecord =
  | { kind: 'P'; x: number; y: number; sym: string; polarity: string; orient: string; angle: number | null }
  | { kind: 'L'; x1: number; y1: number; x2: number; y2: number; sym: string; polarity: string }
  | { kind: 'A'; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; sym: string; polarity: string; direction: string };

export interface FeatureFile {
  units?: OdbUnits;
  /** Symbol index (as written) to standard symbol name. */
  symbols: Map<string, string>;
  records: FeatureRecord[];
  /** Records that are read by no part of this module. */
  unread: { surfaces: number; texts: number; other: number };
  /** Lines with a missing or malformed number, or an unknown polarity. */
  malformed: number;
}

const IGNORED_KEYWORDS = new Set(['F', 'ID', 'U', 'OB', 'OS', 'OC', 'OE', 'SE']);

/** Parses one layer features file (line records; attributes after ';' are ignored). */
export function parseFeatures(text: string): FeatureFile {
  const symbols = new Map<string, string>();
  const records: FeatureRecord[] = [];
  const unread = { surfaces: 0, texts: 0, other: 0 };
  let malformed = 0, units: OdbUnits | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (line.startsWith('UNITS=')) {
      const value = line.slice(6).trim().toUpperCase();
      if (units === undefined && (value === 'MM' || value === 'INCH')) units = value;
      continue;
    }
    const symbol = /^\$(\d+)\s+(\S+)/.exec(line);
    if (symbol) { symbols.set(symbol[1], symbol[2]); continue; }
    if (line[0] === '@' || line[0] === '&' || line[0] === '%') continue;
    const semi = line.indexOf(';');
    const body = (semi < 0 ? line : line.slice(0, semi)).trim().split(/\s+/);
    const key = body[0].toUpperCase();
    if (key === 'P') {
      const x = num(body[1]), y = num(body[2]);
      if (x === null || y === null || body[3] === undefined || body[4] === undefined) { malformed++; continue; }
      records.push({ kind: 'P', x, y, sym: body[3], polarity: body[4].toUpperCase(), orient: body[6] ?? '', angle: num(body[7]) });
    } else if (key === 'L') {
      const x1 = num(body[1]), y1 = num(body[2]), x2 = num(body[3]), y2 = num(body[4]);
      if (x1 === null || y1 === null || x2 === null || y2 === null || body[5] === undefined || body[6] === undefined) { malformed++; continue; }
      records.push({ kind: 'L', x1, y1, x2, y2, sym: body[5], polarity: body[6].toUpperCase() });
    } else if (key === 'A') {
      const v = [1, 2, 3, 4, 5, 6].map(index => num(body[index]));
      if (v.some(value => value === null) || body[7] === undefined || body[8] === undefined) { malformed++; continue; }
      records.push({ kind: 'A', x1: v[0]!, y1: v[1]!, x2: v[2]!, y2: v[3]!, cx: v[4]!, cy: v[5]!, sym: body[7], polarity: body[8].toUpperCase(), direction: (body[10] ?? '').toUpperCase() });
    } else if (key === 'S') unread.surfaces++;
    else if (key === 'T') unread.texts++;
    else if (key === 'B') unread.other++;
    else if (!IGNORED_KEYWORDS.has(key)) unread.other++;
  }
  return { units, symbols, records, unread, malformed };
}

export interface ToolRecord { type: string; size: number | null }
export interface ToolFile { units?: OdbUnits; tools: ToolRecord[] }

/** Parses a drill tools file: "TOOLS { NUM= TYPE= DRILL_SIZE= }" blocks and the UNITS directive. */
export function parseTools(text: string): ToolFile {
  const tools: ToolRecord[] = [];
  let units: OdbUnits | undefined, current: { type: string; size: number | null } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (/^TOOLS\s*\{$/i.test(line)) { current = { type: '', size: null }; continue; }
    if (line === '}') { if (current) tools.push({ type: current.type.toUpperCase(), size: current.size }); current = null; continue; }
    if (!current) {
      if (line.startsWith('UNITS=')) {
        const value = line.slice(6).trim().toUpperCase();
        if (units === undefined && (value === 'MM' || value === 'INCH')) units = value;
      }
      continue;
    }
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim().toUpperCase(), value = line.slice(equals + 1).trim();
    if (key === 'TYPE') current.type = value;
    else if (key === 'DRILL_SIZE') current.size = num(value);
  }
  return { units, tools };
}

interface StandardSymbol { shape: 'round' | 'square' | 'rect' | 'oval'; a: number; b: number }
/** Standard symbol by name: r<d>, s<side>, rect<w>x<h> and oval<w>x<h> (sizes in 1/1000 of the file's units). */
export function standardSymbol(name: string | undefined): StandardSymbol | null {
  if (!name) return null;
  let match = /^r(\d+(?:\.\d+)?)$/.exec(name);
  if (match) return { shape: 'round', a: Number(match[1]), b: Number(match[1]) };
  match = /^s(\d+(?:\.\d+)?)$/.exec(name);
  if (match) return { shape: 'square', a: Number(match[1]), b: Number(match[1]) };
  match = /^(rect|oval)(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(name);
  if (match) return { shape: match[1] === 'rect' ? 'rect' : 'oval', a: Number(match[2]), b: Number(match[3]) };
  return null;
}

/**
 * A feature's angle in TRACE's convention: counter-clockwise degrees in [0, 360). ODB++ turns a feature clockwise by its angle and then
 * mirrors it in X when orientation code 9 is set (the rule odbpp.ts states for component rotation: clockwise, mirror after the turn). The
 * symbols read here are symmetric about their centre and both axes, so a clockwise turn by θ followed by the mirror has the same outline
 * as a counter-clockwise turn by +θ: a mirrored feature keeps the file's angle, an unmirrored one takes its negative. Right angles give the
 * same outline either way; other angles do not (odbpp-copper.test.ts pins both).
 */
export function traceAngle(angle: number, mirrored: boolean): number {
  const value = (((mirrored ? angle : -angle) % 360) + 360) % 360;
  return value === 0 ? 0 : value;
}

/** Plating of a hole from the tool types of its diameter: PLATED or VIA are plated, NON_PLATED not; any disagreement is unknown. */
export function platingOf(types: ReadonlySet<string>): DrillHole['plating'] {
  if (types.size === 0) return 'unknown';
  if (types.size === 1) {
    const [only] = types;
    return only === 'PLATED' ? 'plated' : only === 'NON_PLATED' ? 'non-plated' : only === 'VIA' ? 'via' : 'unknown';
  }
  return [...types].every(type => type === 'PLATED' || type === 'VIA') ? 'plated' : 'unknown';
}

/** What the caller knows about the step's copper and drill layers: outer copper layer names, drill layer names, inner copper count. */
export interface CopperPlan { top?: string; bottom?: string; drills: string[]; innerLayers: number }
/** Reads a layer file of the step as text (with its path for notes); undefined when the layer has no such file. */
export interface CopperLayerIO {
  read(layer: string, kind: 'features' | 'tools'): { file: string; text: string } | undefined;
  /** Units a file declares, else the product model's fallback (the caller records the fallback). */
  units(file: string, declared: OdbUnits | undefined): OdbUnits;
}
export interface CopperResult { copper?: BoardCopper; notes: string[] }

/** Reads the copper pads, lines, arcs and drill holes of one step; `copper` is absent when none is read. */
export function readCopper(plan: CopperPlan, io: CopperLayerIO): CopperResult {
  const notes: string[] = [];
  const copper: BoardCopper = { pads: [], lines: [], arcs: [], holes: [] };
  const skipped = { symbol: 0, orient: 0, negative: 0, malformed: 0, noPlating: 0, surfaces: 0, texts: 0, other: 0 };
  const outer: Array<[CopperSide, string]> = [];
  if (plan.top) outer.push(['top', plan.top]);
  if (plan.bottom && plan.bottom !== plan.top) outer.push(['bottom', plan.bottom]);
  const missing: string[] = [];
  for (const [side, layer] of outer) {
    const read = io.read(layer, 'features');
    if (!read) { missing.push(layer); continue; }
    const file = parseFeatures(read.text);
    const scale = MM_PER_UNIT[io.units(read.file, file.units)];
    skipped.malformed += file.malformed;
    skipped.surfaces += file.unread.surfaces; skipped.texts += file.unread.texts; skipped.other += file.unread.other;
    for (const record of file.records) {
      if (record.polarity === 'N') { skipped.negative++; continue; }
      if (record.polarity !== 'P') { skipped.malformed++; continue; }
      const symbol = standardSymbol(file.symbols.get(record.sym));
      if (record.kind === 'P') {
        if (!symbol) { skipped.symbol++; continue; }
        if (record.orient !== '8' && record.orient !== '9') { skipped.orient++; continue; }
        if (record.angle === null) { skipped.malformed++; continue; }
        const pad: CopperPad = { side, x: record.x * scale, y: record.y * scale, shape: symbol.shape, width: symbol.a * scale / 1000, height: symbol.b * scale / 1000, rotation: traceAngle(record.angle, record.orient === '9'), mirrored: record.orient === '9' };
        copper.pads.push(pad);
      } else if (record.kind === 'L') {
        if (!symbol || symbol.shape !== 'round') { skipped.symbol++; continue; }
        const line: CopperLine = { side, x1: record.x1 * scale, y1: record.y1 * scale, x2: record.x2 * scale, y2: record.y2 * scale, width: symbol.a * scale / 1000 };
        copper.lines.push(line);
      } else {
        if (!symbol || symbol.shape !== 'round') { skipped.symbol++; continue; }
        if (record.direction !== 'Y' && record.direction !== 'N') { skipped.malformed++; continue; }
        const arc: CopperArc = { side, x1: record.x1 * scale, y1: record.y1 * scale, x2: record.x2 * scale, y2: record.y2 * scale, cx: record.cx * scale, cy: record.cy * scale, width: symbol.a * scale / 1000, clockwise: record.direction === 'Y' };
        copper.arcs.push(arc);
      }
    }
  }
  for (const layer of plan.drills) {
    const read = io.read(layer, 'features');
    if (!read) { missing.push(layer); continue; }
    const file = parseFeatures(read.text);
    const scale = MM_PER_UNIT[io.units(read.file, file.units)];
    skipped.malformed += file.malformed;
    skipped.surfaces += file.unread.surfaces; skipped.texts += file.unread.texts; skipped.other += file.unread.other;
    const toolsRead = io.read(layer, 'tools');
    const tools = toolsRead ? parseTools(toolsRead.text) : null;
    const toolScale = tools ? MM_PER_UNIT[io.units(toolsRead!.file, tools.units)] / 1000 : 0;
    for (const record of file.records) {
      if (record.kind !== 'P') { skipped.other++; continue; }
      if (record.polarity !== 'P') { skipped.negative++; continue; }
      const symbol = standardSymbol(file.symbols.get(record.sym));
      if (!symbol || (symbol.shape !== 'round' && symbol.shape !== 'oval')) { skipped.symbol++; continue; }
      const orientOk = record.orient === '8' || record.orient === '9';
      if (symbol.shape === 'oval' && !orientOk) { skipped.orient++; continue; }
      if (orientOk && record.angle === null) { skipped.malformed++; continue; }
      const width = symbol.a * scale / 1000, height = symbol.b * scale / 1000;
      // Plating: the tools whose diameter (slots: their short side) equals the hole's.
      const target = symbol.shape === 'round' ? width : Math.min(width, height);
      const types = new Set<string>();
      if (tools) for (const tool of tools.tools) if (tool.size !== null && Math.abs(tool.size * toolScale - target) < 1e-6) types.add(tool.type);
      const plating = platingOf(types);
      if (plating === 'unknown') skipped.noPlating++;
      const hole: DrillHole = { x: record.x * scale, y: record.y * scale, shape: symbol.shape, width, height, rotation: orientOk ? traceAngle(record.angle ?? 0, record.orient === '9') : 0, plating };
      copper.holes.push(hole);
    }
  }
  const total = copper.pads.length + copper.lines.length + copper.arcs.length + copper.holes.length;
  if (total > COPPER_RECORD_LIMIT) {
    notes.push(`Copper and drill records exceed ${COPPER_RECORD_LIMIT}; no copper was read.`);
    return { notes };
  }
  // Notes below describe copper that is read; a step without copper records returns no notes at all.
  if (total === 0) return { notes };
  if (plan.top && !plan.bottom) notes.push('The board has one copper layer; it is read as the top side.');
  notes.push(`Copper read from the top and bottom copper and drill layers: ${copper.pads.length} pad(s), ${copper.lines.length} line(s), ${copper.arcs.length} arc(s) and ${copper.holes.length} drilled hole(s). They are kept in the board data and drawn in the board view.`);
  if (plan.innerLayers > 0) notes.push(`${plan.innerLayers} inner copper layer(s) are not read.`);
  if (missing.length) notes.push(`No features file for ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}: the records of those layers are not read.`);
  const parts: string[] = [];
  if (skipped.symbol) parts.push(`${skipped.symbol} with an unsupported symbol`);
  if (skipped.orient) parts.push(`${skipped.orient} with an unsupported orientation code`);
  if (skipped.negative) parts.push(`${skipped.negative} negative (clear) feature(s)`);
  if (skipped.malformed) parts.push(`${skipped.malformed} malformed record(s)`);
  if (parts.length) notes.push(`Copper features not read: ${parts.join(', ')}.`);
  if (skipped.surfaces || skipped.texts || skipped.other) notes.push(`Not read: ${skipped.surfaces} surface (pour) record(s), ${skipped.texts} text record(s) and ${skipped.other} other record(s) in the copper and drill layers.`);
  if (skipped.noPlating) notes.push(`${skipped.noPlating} drill hole(s) have no clear plating: their diameter matches tools of different types, or no tool.`);
  return { copper, notes };
}
