import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, textInput, type FormatErrorCode } from './common';
import { EASYEDA_PRO_INFO, parseEasyedaPro, sniffEasyedaPro } from './easyeda-pro';
import { parseBoardDetailed } from './dispatch';

// Synthetic V3 documents, written here. The record structure follows the vendor's V3 log (a header object, "||", a payload object, "|"; DOCHEAD starts
// a document; the highest ticket per type and id is current; an empty payload deletes a record). Every id, name, number and coordinate is invented.
const MIL = 0.0254;
const MID = (value: number) => value * MIL;
const header = (type: string, ticket: number, id?: string): string => JSON.stringify(id === undefined ? { type, ticket } : { type, ticket, id });
const record = (type: string, ticket: number, id: string | undefined, payload: unknown): string => `${header(type, ticket, id)}||${payload === undefined ? '' : JSON.stringify(payload)}|`;
const dochead = (ticket: number, docType: string, uuid: string, updateTime: number): string => record('DOCHEAD', ticket, undefined, { docType, client: 'synthetic-client', uuid, updateTime, editVersion: '0.0.0' });
const layer = (ticket: number, layerId: number, layerType: string): string => record('LAYER', ticket, `["LAYER",${layerId}]`, { layerId, layerType, layerName: layerType, use: true, show: true });
const canvas = (ticket: number, unit: string): string => record('CANVAS', ticket, 'CANVAS', { originX: 0, originY: 0, unit, gridXSize: 10 });
const pad = (ticket: number, id: string, num: string, layerId: number, x: number, y: number, shape: Record<string, unknown>, angle = 0): string =>
  record('PAD', ticket, id, { groupId: 0, netName: '', layerId, num, centerX: x, centerY: y, padAngle: angle, hole: null, defaultPad: shape, specialPad: [], padOffsetX: 0, padOffsetY: 0, relativeAngle: 0, plated: true, padType: 'NORMAL' });
const component = (ticket: number, id: string, layerId: number, x: number, y: number, angle: number): string =>
  record('COMPONENT', ticket, id, { partitionId: '', groupId: 0, layerId, x, y, angle, attrs: {}, locked: false, zIndex: -1 });
const attr = (ticket: number, id: string, parentId: string, key: string, value: string): string =>
  record('ATTR', ticket, id, { groupId: 0, parentId, layerId: 3, x: null, y: null, key, value, keyVisible: false, valueVisible: false });
const padNet = (ticket: number, componentId: string, num: string, padId: string, net: string | undefined): string =>
  record('PAD_NET', ticket, JSON.stringify(['PAD_NET', componentId, num, padId]), net === undefined ? undefined : { partitionId: '', padNet: net, padLen: null, attrsMap: {} });
const lines = (...records: string[]): string => records.join('\n');

const FOOTPRINT = 'fp-synthetic-chip';
const footprintLog = lines(
  dochead(1, 'FOOTPRINT', FOOTPRINT, 100), record('META', 2, 'meta', { title: 'SYN-CHIP' }),
  pad(3, 'p1', '1', 1, -30, 0, { padType: 'RECT', width: 40, height: 20, radius: 0 }),
  pad(4, 'p2', '2', 1, 30, 0, { padType: 'RECT', width: 40, height: 20, radius: 0 }),
  pad(5, 'p3', '3', 12, 0, 40, { padType: 'OVAL', width: 30, height: 20 }),
);
const pcbLog = lines(
  dochead(10, 'PCB', 'pcb-synthetic', 500), canvas(11, 'mil'),
  layer(12, 1, 'TOP'), layer(13, 2, 'BOTTOM'), layer(14, 11, 'OUTLINE'), layer(15, 12, 'MULTI'),
  component(20, 'c-top', 1, 1, 1, 0), component(21, 'c-top', 1, 1000, 800, 0),   // the second record of c-top is the current one
  component(22, 'c-bot', 2, 2000, 800, 180), component(23, 'c-bot0', 2, 2500, 800, 0),
  attr(30, 'a1', 'c-top', 'Footprint', FOOTPRINT), attr(31, 'a2', 'c-top', 'Designator', 'R1'), attr(32, 'a3', 'c-top', 'Name', '10k'),
  attr(33, 'a4', 'c-bot', 'Footprint', FOOTPRINT), attr(34, 'a5', 'c-bot', 'Designator', 'C1'), attr(35, 'a6', 'c-bot', 'Name', '={Value}'),
  attr(36, 'a7', 'c-bot0', 'Footprint', FOOTPRINT), attr(37, 'a8', 'c-bot0', 'Designator', 'C2'),
  padNet(40, 'c-top', '1', 'p1', 'N1'), padNet(41, 'c-top', '2', 'p2', 'N2'),
  padNet(42, 'c-bot', '1', 'p1', 'N3'),
  padNet(43, 'c-bot0', '1', 'p1', 'N5'), padNet(44, 'c-bot0', '1', 'p1', undefined),   // the last record deletes the net of c-bot0 pad 1
  record('PAD', 50, 'tp1', { groupId: 0, netName: 'TP1', layerId: 1, num: 'TP1', centerX: 500, centerY: 500, padAngle: 0, hole: null, defaultPad: { padType: 'RECT', width: 40, height: 40, radius: 0 }, specialPad: [] }),
  record('POLY', 51, 'outline', { partitionId: '', groupId: 0, netName: '', layerId: 11, width: 10, path: ['R', 0, 2000, 3000, 2000, 0, 200], locked: false, zIndex: -1, polyType: 'BOARD_OUTLINE' }),
);
const emptyPcbLog = lines(dochead(60, 'PCB', 'pcb-empty', 900), canvas(61, 'mil'));

const project = JSON.stringify({ title: 'synthetic', cbb_project: false, editorVersion: '0.0.0' });
const container = (...logs: string[]): Uint8Array => zipSync(Object.fromEntries([['project2.json', strToU8(project)], ...logs.map((log, index) => [`synthetic-${index}.epru`, strToU8(log)])]));
const parse = (data: Uint8Array | string, name = 'synthetic.epro2'): Board => {
  const result = parseEasyedaPro(typeof data === 'string' ? textInput(data, name) : { name, data });
  if (!result) throw new Error('unexpectedly unrecognized');
  return result;
};
const failure = (work: () => unknown): BoardFormatError => {
  try { work(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const expectFailure = (work: () => unknown, code: FormatErrorCode, pattern?: RegExp) => {
  const error = failure(work);
  expect(error.code).toBe(code);
  if (pattern) expect(error.message).toMatch(pattern);
};
const notes = (board: Board): string[] => board.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));
const pinOf = (board: Board, ref: string, number: string) => {
  const component = board.components.find(c => c.ref === ref);
  const found = board.pins.find(p => p.componentId === component?.id && p.number === number);
  if (!found) throw new Error(`no pin ${ref}.${number}`);
  return found;
};
const baseLog = (): string => lines(footprintLog, pcbLog, emptyPcbLog);

describe('EasyEDA Pro V3: recognition', () => {
  it('recognizes a V3 project container at 0.95 and a bare V3 log with components as a PCB at 0.9', () => {
    expect(sniffEasyedaPro(container(baseLog()), 'p.epro2')).toMatchObject({ id: 'easyeda-pro', variant: 'epro2-v3', kind: 'pcb', confidence: 0.95 });
    expect(sniffEasyedaPro(strToU8(baseLog()), 'p.epru')).toMatchObject({ variant: 'log-v3', kind: 'pcb', confidence: 0.9 });
  });
  it('keeps a V3 log without a PCB component as an unsupported log, refused by name', () => {
    const bare = lines(dochead(1, 'PCB', 'empty', 1), canvas(2, 'mil'));
    expect(sniffEasyedaPro(strToU8(bare))).toMatchObject({ variant: 'log-v3', kind: 'unsupported' });
    expectFailure(() => parse(bare, 'empty.epru'), 'UNSUPPORTED_VARIANT', /V3/);
  });
});

describe('EasyEDA Pro V3: a .epro2 file opens, and an unreadable one is refused with its file name', () => {
  it('declares the .epro2 extension and opens a synthetic project through the dispatcher that the file opener uses', () => {
    expect(EASYEDA_PRO_INFO.extensions).toContain('.epro2');
    const imported = parseBoardDetailed({ name: 'synthetic.epro2', data: container(baseLog()) });
    expect(imported.adapter).toBe('easyeda-pro');
    expect(imported.board.components.length).toBeGreaterThan(0);
  });
  it('names the file in the localized refusal when the archive holds no V3 document log', () => {
    const error = failure(() => parse(zipSync({ 'project2.json': strToU8(project) }), 'broken.epro2'));
    expect(error.code).toBe('INVALID_FORMAT');
    expect(error.message).toMatch(/no V3 document log/);
    expect(error.issue).toEqual({ key: 'parse.error.v3ProjectUnreadable', params: { file: 'broken.epro2' } });
  });
  it('names the file in the localized refusal when the project holds no PCB document with components', () => {
    const error = failure(() => parse(container(lines(footprintLog, emptyPcbLog)), 'schematic-only.epro2'));
    expect(error.code).toBe('WRONG_KIND');
    expect(error.issue).toEqual({ key: 'parse.error.v3ProjectUnreadable', params: { file: 'schematic-only.epro2' } });
  });
  it('refuses a damaged .epro2 archive by name, not as unrecognized', () => {
    const error = failure(() => parse(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]), 'damaged.epro2'));
    expect(error.code).toBe('INVALID_FORMAT');
    expect(error.issue).toEqual({ key: 'parse.error.v3ProjectUnreadable', params: { file: 'damaged.epro2' } });
  });
});

describe('EasyEDA Pro V3: board reading', () => {
  const board = parse(container(baseLog()));
  it('reads the components of the latest PCB document with components: the current record wins, footprints give packages', () => {
    // The free pad with a net is a one-pad part at the end, as in the V2.2 reader.
    expect(board.components.map(c => c.ref)).toEqual(['R1', 'C1', 'C2', 'PAD1']);
    expect(board.components.map(c => c.side)).toEqual(['top', 'bottom', 'bottom', 'top']);
    expect(board.components.slice(0, 3).every(c => c.package === 'SYN-CHIP')).toBe(true);
    expect(board.components[0].position.x).toBeCloseTo(MID(1000), 9);
    expect(board.components.find(c => c.ref === 'R1')?.value).toBe('10k');
    expect(board.components.find(c => c.ref === 'C1')?.value).toBe('');
  });
  it('places pads of a top part by its angle, and bottom parts with the V2.2 rule: turned by the angle plus 180 degrees', () => {
    expect(pinOf(board, 'R1', '1')).toMatchObject({ net: 'N1', side: 'top' });
    expect(pinOf(board, 'R1', '1').x).toBeCloseTo(MID(970), 9); expect(pinOf(board, 'R1', '1').y).toBeCloseTo(MID(800), 9);
    expect(pinOf(board, 'R1', '3')).toMatchObject({ side: 'both', shape: 'rect' }); expect(pinOf(board, 'R1', '3').x).toBeCloseTo(MID(1000), 9);
    // A 180-degree bottom part: mirrored in x only (turn 0), so pad 1 (local -30) lands at +30; its TOP-layer pad is on the bottom side.
    expect(pinOf(board, 'C1', '1')).toMatchObject({ net: 'N3', side: 'bottom' });
    expect(pinOf(board, 'C1', '1').x).toBeCloseTo(MID(2030), 9); expect(pinOf(board, 'C1', '1').y).toBeCloseTo(MID(800), 9);
    // A 0-degree bottom part: turned by 0 + 180, so pad 1 (local -30) lands at -30 from the origin 2500 (mirrored in y).
    expect(pinOf(board, 'C2', '1').x).toBeCloseTo(MID(2470), 9); expect(pinOf(board, 'C2', '1').y).toBeCloseTo(MID(800), 9);
    // The part keeps its reported angle; the turn is carried by the pad positions above.
    expect(board.components.find(c => c.ref === 'C2')?.rotation).toBe(0);
  });
  it('takes pad nets from the PAD_NET records; a deleted record leaves its pad unnetted, a missing record too', () => {
    expect(pinOf(board, 'R1', '2').net).toBe('N2');
    expect(pinOf(board, 'C1', '2').net).toBe('');
    expect(pinOf(board, 'C2', '1').net).toBe('');
    expect(board.nets.map(n => n.name).sort()).toEqual(['N1', 'N2', 'N3', 'TP1']);
  });
  it('reads the rounded outline of the R primitive: top-left corner, extending right and down, corners made of arcs', () => {
    expect(board.bounds).toMatchObject({ minX: 0, minY: 0 });
    expect(board.bounds.maxX).toBeCloseTo(MID(3000), 9); expect(board.bounds.maxY).toBeCloseTo(MID(2000), 9);
    expect(board.outline.length).toBeGreaterThan(4);
  });
  it('keeps a free pad with a net as a one-pad part', () => {
    expect(pinOf(board, 'PAD1', 'TP1')).toMatchObject({ net: 'TP1' });
  });
  it('discloses the other PCB documents, the approximated pads and the bottom-side placement', () => {
    expect(notes(board)).toContain('The project has 2 PCB documents; the one with components and the latest update was opened and the others were not.');
    expect(board.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 3 } });
    expect(notes(board).some(text => /^2 bottom-side components are placed mirrored and turned by the part angle plus 180 degrees/.test(text))).toBe(true);
    expect(notes(board)).toContain('Tracks, vias, copper pours and text are not imported; nets come from the part pad assignments only.');
  });
  it('reads a millimetre project with its coordinates unscaled', () => {
    const mm = lines(dochead(1, 'FOOTPRINT', FOOTPRINT, 100), record('META', 2, 'meta', { title: 'SYN-CHIP' }),
      pad(3, 'p1', '1', 1, -30, 0, { padType: 'RECT', width: 40, height: 20, radius: 0 }), pad(4, 'p2', '2', 1, 30, 0, { padType: 'RECT', width: 40, height: 20, radius: 0 }),
      dochead(10, 'PCB', 'pcb-mm', 500), canvas(11, 'mm'), layer(12, 1, 'TOP'), component(20, 'c-mm', 1, 10, 20, 0), attr(30, 'a1', 'c-mm', 'Footprint', FOOTPRINT), attr(31, 'a2', 'c-mm', 'Designator', 'R9'));
    const millimetre = parse(container(mm));
    expect(pinOf(millimetre, 'R9', '1').x).toBeCloseTo(-20, 9); expect(pinOf(millimetre, 'R9', '1').y).toBeCloseTo(20, 9);
  });
});

describe('EasyEDA Pro V3: refusals are named', () => {
  it('refuses a project with no PCB document that has components, by name', () => {
    expectFailure(() => parse(container(lines(footprintLog, emptyPcbLog))), 'WRONG_KIND', /V3 project has no PCB document with components/);
  });
  it('refuses a unit the reader does not read', () => {
    expectFailure(() => parse(container(lines(footprintLog, pcbLog.replace('"unit":"mil"', '"unit":"inch"')))), 'UNSUPPORTED_VARIANT', /declares the unit "inch"/);
  });
  it('refuses a pad shape that is not documented', () => {
    expectFailure(() => parse(container(lines(footprintLog.replace('"padType":"RECT"', '"padType":"HEXAGON"'), pcbLog))), 'UNSUPPORTED_VARIANT', /shape "HEXAGON", which is not documented/);
  });
  it('refuses a component on a layer that is neither TOP nor BOTTOM', () => {
    expectFailure(() => parse(container(lines(footprintLog, pcbLog.replace('"layerId":1,"x":1000', '"layerId":12,"x":1000')))), 'UNSUPPORTED_VARIANT', /TOP and BOTTOM components/);
  });
  it('refuses an outline path command the reader does not support', () => {
    const bad = pcbLog.replace('"path":["R",0,2000,3000,2000,0,200]', '"path":[0,0,"CARC",90,10,10]');
    expectFailure(() => parse(container(lines(footprintLog, bad))), 'UNSUPPORTED_VARIANT', /"CARC" command/);
  });
});
