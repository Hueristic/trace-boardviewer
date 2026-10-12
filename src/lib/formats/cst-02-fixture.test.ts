import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCst } from './cst';

// The generator is CommonJS (it also writes the sample and feeds the Mac check): loaded the same way here.
const { build } = createRequire(import.meta.url)('../../../tests/fixtures/cst/make-cst-02.cjs') as { build: (options?: { partLayers?: number[] }) => Uint8Array };

// The synthetic CST-02 sample (TB-322): built from the documented CST layout only (tests/fixtures/cst/make-cst-02.cjs), so it is
// free of any licence and of any private test sample content. The pinned SHA-256 keeps the bytes that the start-up checks rely on fixed.
const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/cst/cst-02-synthetic.cst', import.meta.url));
const SHA256 = '05af86747a2d3951c5a81b76717316b3f14094d05455fbb996ea2a7ff23d90c5';

describe('synthetic CST-02 fixture', () => {
  it('its bytes are the pinned ones', () => {
    expect(createHash('sha256').update(readFileSync(FIXTURE)).digest('hex')).toBe(SHA256);
  });

  it('it opens as a board with a component on each accepted layer, three nets and four pins', () => {
    const board = parseCst({ name: 'cst-02-synthetic.cst', data: new Uint8Array(readFileSync(FIXTURE)) });
    expect(board).not.toBeNull();
    expect(board!.format).toBe('CST');
    expect(board!.components.map(part => [part.ref, part.side])).toEqual([['U1', 'top'], ['U2', 'bottom']]);
    expect(board!.pins).toHaveLength(4);
    expect(board!.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 2], ['VCC', 1], ['SIG', 1]]);
  });

  it('the refused sample of the Mac check (same generator, layer 0x08) is refused with UNSUPPORTED_VARIANT', () => {
    let caught: unknown = null;
    try { parseCst({ name: 'refused.cst', data: build({ partLayers: [0x08, 0x01] }) }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'CST' });
  });
});
