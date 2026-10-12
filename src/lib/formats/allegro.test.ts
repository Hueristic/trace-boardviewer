import { describe, expect, it } from 'vitest';
import { allegroHook, parseAllegro } from './allegro';
import { makeAllegro } from './allegro-fixture';
import { BoardFormatError, MAX_NATIVE_ALLEGRO_IMPORT_BYTES, MAX_NATIVE_ALLEGRO_RECORDS } from './common';
import { parseBoard, parseWith } from './index';
import { collectDiagnostic } from '../diagnostics/collect';
import allegroAdapter from './adapters/allegro-brd';
import { unsupportedAllegro } from './adapters/allegro-brd/fixtures';

const parse = (data: Uint8Array) => parseAllegro({ name: 'synthetic.brd', data })!;
function failure(data: Uint8Array): BoardFormatError {
  try { parse(data); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected format failure');
}
const mutate = (name: string, offset: number, value: number, size: 2 | 4 = 4) => {
  const fixture = makeAllegro(); new DataView(fixture.data.buffer)[size === 2 ? 'setUint16' : 'setUint32'](fixture.offsets[name] + offset, value, true); return fixture.data;
};

describe('native Allegro database', () => {
  it.each([160, 162, 164, 165, 166, 172, 174, 175] as const)('reads version %s using its explicit layout', version => {
    const board = parse(makeAllegro({ version }).data);
    expect(board.components).toHaveLength(1); expect(board.pins).toHaveLength(2);
    expect(board.components[0]).toMatchObject({ ref: 'U1', side: 'top', rotation: 90, package: 'SYNTHETIC_PACKAGE', value: '10k' });
    expect(board.components[0].position.x).toBeCloseTo(2.54); expect(board.components[0].position.y).toBeCloseTo(5.08);
    expect(board.pins[0]).toMatchObject({ number: '1', net: 'GND', shape: 'rect', rotation: 120, side: 'top' });
    expect(board.pins[0].x).toBeCloseTo(2.032); expect(board.pins[0].y).toBeCloseTo(5.334);
    expect(board.pins[0].width).toBeCloseTo(0.0508); expect(board.pins[0].height).toBeCloseTo(0.0254);
    expect(board.nets.map(net => net.name)).toEqual(['GND', 'SIGNAL_A']);
    expect(board.outline).toHaveLength(4); expect(board.warnings.map(warning => warning.key)).not.toContain('parse.warning.missingBoardOutline');
  });

  it('flips bottom pad coordinates before rotating, and keeps local sizes and absolute orientation', () => {
    const board = parse(makeAllegro({ bottom: true, throughHole: true }).data);
    expect(board.components[0].side).toBe('bottom');
    expect(board.pins[0]).toMatchObject({ rotation: 60, side: 'both' });
    expect(board.pins[0].x).toBeCloseTo(2.032); expect(board.pins[0].y).toBeCloseTo(4.826);
  });

  it('reads the alternate 16.2 identifier with its validated record widths', () => {
    const fixture = makeAllegro({ version: 162 }); new DataView(fixture.data.buffer).setUint32(0, 0x00130503, true);
    const board = parse(fixture.data);
    expect(board.components[0]).toMatchObject({ ref: 'U1', side: 'top', package: 'SYNTHETIC_PACKAGE' });
    expect(board.pins).toHaveLength(2); expect(board.pins[0].net).toBe('GND'); expect(board.pins[0].x).toBeCloseTo(2.032);
  });

  it('uses the divisor and retains anonymous mechanical and unnumbered pad identities honestly', () => {
    const board = parse(makeAllegro({ divisor: 1000, mechanical: true, unnamedPad: true }).data);
    expect(board.components[0]).toMatchObject({ refGenerated: true });
    expect(board.pins.every(pin => pin.numberGenerated)).toBe(true);
    expect(board.components[0].position.x).toBeCloseTo(0.254);
  });

  it.each([166, 172] as const)('retains mechanical drill-only pads in version %s', version => {
    const board = parse(makeAllegro({ version, holeOnly: true, unnamedPad: true, mechanical: true }).data);
    expect(board.pins[0]).toMatchObject({ shape: 'round', side: 'both', numberGenerated: true });
    expect(board.pins[0].radius).toBeCloseTo(0.01016);
  });

  it.each([166, 172] as const)('does not treat undrilled multilayer copper as a through hole in version %s', version => {
    const fixture = makeAllegro({ version, bottom: true, throughHole: true });
    new DataView(fixture.data.buffer).setUint32(fixture.offsets.stack + (version >= 172 ? 64 : 16), 0, true);
    expect(parse(fixture.data).pins[0].side).toBe('bottom');
  });

  it('accepts zero padding but rejects an unparsed nonzero database suffix', () => {
    const fixture = makeAllegro(), padded = new Uint8Array(fixture.data.length + 16);
    padded.set(fixture.data); expect(parse(padded).pins).toHaveLength(2);
    padded[padded.length - 1] = 1;
    expect(failure(padded).code).toBe('INVALID_FORMAT');
  });

  it('registers native parsing independently of the filename', async () => {
    const data = makeAllegro().data;
    expect(parseBoard({ name: 'renamed.cad', data }).format).toBe('Allegro BRD');
    expect(parseWith(allegroAdapter, { name: 'synthetic.brd', data })?.pins).toHaveLength(2);
    expect(parseAllegro({ name: 'bad.brd', data: new Uint8Array(100) })).toBeNull();
  });

  it.each([
    ['duplicate object', () => mutate('geometry0', 4, 1)],
    ['missing geometry', () => mutate('pad0', 32, 999999)],
    ['wrong geometry type', () => mutate('pad0', 32, 8)],
    ['missing string', () => mutate('reference', 20, 999999)],
    ['component disagreement', () => mutate('reference', 12, 99)],
    ['wrong parent', () => mutate('pad0', 24, 99)],
    ['pad cycle', () => mutate('pad1', 20, 5)],
    ['outline cycle', () => mutate('edge3', 8, 41)],
    ['wrong outline type', () => mutate('edge1', 8, 8)],
    ['wrong outline parent', () => mutate('edge1', 12, 99)],
    ['negative pad dimension', () => mutate('stack', 88 + 13 * 28 + 4, 0xffffffff)],
    ['invalid divisor', () => { const fixture = makeAllegro(); new DataView(fixture.data.buffer).setUint32(0x26c, 0, true); return fixture.data; }],
    ['object count mismatch', () => { const fixture = makeAllegro(); new DataView(fixture.data.buffer).setUint32(20, 1, true); return fixture.data; }],
  ] as const)('rejects %s with a native format error', (_name, data) => {
    expect(failure(data())).toMatchObject({ code: 'INVALID_FORMAT', format: 'allegro-brd' });
  });

  it('bounds dynamic counts before allocating', () => {
    expect(failure(mutate('stack', 50, 257, 2)).code).toBe('LIMIT_EXCEEDED');
    const fixture = makeAllegro(); new DataView(fixture.data.buffer).setUint32(0x194, 1_000_001, true);
    expect(failure(fixture.data).code).toBe('LIMIT_EXCEEDED');
  });

  it('refuses a native database one byte above the native import limit and accepts one exactly at it', () => {
    const limit = MAX_NATIVE_ALLEGRO_IMPORT_BYTES, data = new Uint8Array(limit + 1);
    data.set(makeAllegro().data);
    expect(parse(data.subarray(0, limit)).pins).toHaveLength(2);
    expect(failure(data)).toMatchObject({ code: 'LIMIT_EXCEEDED', format: 'allegro-brd' });
    expect(failure(data).message).toBe('Allegro: database exceeds the 240 MiB import limit.');
    expect(failure(data).issue).toEqual({ key: 'parse.error.nativeByteLimit', params: { max: 240 } });
  }, 60_000);
  it('applies the same native limit through the format dispatcher', () => {
    const limit = MAX_NATIVE_ALLEGRO_IMPORT_BYTES, data = new Uint8Array(limit + 1);
    data.set(makeAllegro().data);
    expect(parseBoard({ name: 'native.brd', data: data.subarray(0, limit) }).format).toBe('Allegro BRD');
    expect(() => parseBoard({ name: 'native.brd', data })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED', message: 'Allegro: database exceeds the 240 MiB import limit.' }));
  }, 60_000);
  it('refuses a native database that declares more objects than the record budget', () => {
    const fixture = makeAllegro();
    new DataView(fixture.data.buffer).setUint32(20, MAX_NATIVE_ALLEGRO_RECORDS + 1, true);
    expect(failure(fixture.data)).toMatchObject({ code: 'LIMIT_EXCEEDED', format: 'allegro-brd' });
    expect(failure(fixture.data).message).toMatch(/record limit/);
    expect(failure(fixture.data).issue).toEqual({ key: 'parse.error.nativeRecordLimit', params: { max: MAX_NATIVE_ALLEGRO_RECORDS } });
  });
  it('rejects an undocumented side as an unsupported variant', () => {
    const fixture = makeAllegro(); fixture.data[fixture.offsets.component + 2] = 8;
    expect(failure(fixture.data).code).toBe('UNSUPPORTED_VARIANT');
    expect(failure(fixture.data).issue).toEqual({ key: 'parse.error.allegroLayerUnsupported', params: { code: 8 } });
  });

  it('identifies legacy layouts and reports only the writer version before refusing their records', async () => {
    const data = unsupportedAllegro(0x00120a0a, 'allv15-7');
    expect(failure(data)).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'allegro-brd' });
    expect(failure(data).message).toMatch(/layout 0x00120a00.*requires a documented 16\.0–17\.5 layout/);
    expect(failure(data).issue).toEqual({ key: 'parse.error.allegroLayoutUnsupported', params: { layout: '0x00120a00' } });
    const report = await collectDiagnostic({ name: 'renamed.bin', data }, { os: 'win32' });
    expect(report.structure).toMatchObject({ hook: 'allegro-brd', headerOk: false, header: { codes: { version: 157 } } });
    expect(report.detection.adapters.find(entry => entry.id === 'allegro-brd')).toMatchObject({ sniff: 'certain', code: 'UNSUPPORTED_VARIANT', stage: 'header' });
  });

  it('fails truncated framing and unknown records instead of scanning for replacement data', () => {
    const fixture = makeAllegro();
    for (const end of [0x100, 0x1200, fixture.offsets.stack + 60, fixture.offsets.pad0 + 75, fixture.data.length - 8]) expect(failure(fixture.data.subarray(0, end)).code).toBe('INVALID_FORMAT');
    fixture.data[fixture.offsets.geometry0] = 0x7f;
    expect(failure(fixture.data).code).toBe('UNSUPPORTED_VARIANT');
  });

  it('reports only whitelisted native structure facts', async () => {
    const report = await collectDiagnostic({ name: 'synthetic.brd', data: makeAllegro().data }, { os: 'win32' });
    expect(report.detection.outcome).toBe('opened');
    expect(report.structure).toMatchObject({ hook: 'allegro-brd', headerOk: true, header: { codes: { version: 166, unitCode: 1 } } });
    expect(report.structure!.blocks!.tagBits).toBe(8);
    expect(JSON.stringify(report.structure)).not.toMatch(/U1|SIGNAL_A|SYNTHETIC_PACKAGE|10k/);
    const sink = new Proxy({ level: 2 }, { get: (_target, key) => key === 'level' ? 2 : () => {} });
    expect(() => allegroHook.collect({ data: new Uint8Array(5000).fill(255), companions: {}, extension: '.brd', keys: {} }, sink as never)).not.toThrow();
  });
});
