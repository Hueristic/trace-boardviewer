import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchematicWorkerResponse } from './schematic-worker';

/*
 * The schematic worker run in-process with a stand-in for its scope: one request in, one answer out. The platform of the request reaches the
 * readers, so a backslash in the file name is a separator on win32 only.
 */
interface FakeScope { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null }
let scope: FakeScope;
let posted: SchematicWorkerResponse[];

beforeEach(async () => {
  vi.resetModules();
  posted = [];
  scope = { postMessage: message => { posted.push(message as SchematicWorkerResponse); }, onmessage: null };
  (globalThis as unknown as { self: FakeScope }).self = scope;
  await import('./schematic-worker');
  expect(typeof scope.onmessage).toBe('function');
});
afterEach(() => { delete (globalThis as { self?: unknown }).self; });

const enc = (text: string) => new TextEncoder().encode(text);
const eagle = (label: string) => `<eagle version="9.7.0"><drawing><schematic><libraries/><parts/><sheets><sheet><plain><text x="1" y="1" size="1">${label}</text></plain><instances/><nets/></sheet></sheets></schematic></drawing></eagle>`;

/** The name of the design the worker answers one request with; the EAGLE reader names a design by the stem of its file name. */
function designNameOf(name: string, platform?: 'win32' | 'darwin' | 'linux' | 'other'): string {
  scope.onmessage!({ data: { requestId: 1, name, data: enc(eagle('LABEL')), ...(platform ? { platform } : {}) } });
  const reply = posted.at(-1)!;
  if (!('design' in reply)) throw new Error(`the worker failed: ${reply.error.message}`);
  return reply.design.schematic.name;
}

// MAC-TEST-20261011-07: a KiCad root name follows the platform the request carries, as the EAGLE one does.
const kicad = '(kicad_sch (version 20231120) (generator "synthetic") (generator_version "8.0") (uuid "00000000-0000-4000-8000-000000000001") (paper "A4") (lib_symbols ) )';
function kicadNameOf(name: string, platform?: 'win32' | 'darwin' | 'linux' | 'other'): string {
  scope.onmessage!({ data: { requestId: 1, name, data: enc(kicad), ...(platform ? { platform } : {}) } });
  const reply = posted.at(-1)!;
  if (!('design' in reply)) throw new Error(`the worker failed: ${reply.error.message}`);
  return reply.design.schematic.name;
}

describe('schematic worker: a KiCad root name keeps a POSIX backslash too', () => {
  it('darwin and linux keep the backslash, win32 takes the folders off', () => {
    expect(kicadNameOf('dir\\main.kicad_sch', 'darwin')).toBe('dir\\main');
    expect(kicadNameOf('dir\\main.kicad_sch', 'linux')).toBe('dir\\main');
    expect(kicadNameOf('dir\\main.kicad_sch', 'win32')).toBe('main');
  });
});

describe('schematic worker: the request platform reaches the readers', () => {
  it('a backslash in the file name is a separator on win32 only', () => {
    expect(designNameOf('dir\\Board.sch', 'linux')).toBe('dir\\Board');
    expect(designNameOf('dir\\Board.sch', 'win32')).toBe('Board');
  });

  it('without a platform the readers keep the default rule: both separators split', () => {
    expect(designNameOf('dir\\Board.sch')).toBe('Board');
  });
});
