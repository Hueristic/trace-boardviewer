import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { noticeLifetimeMs } from './notice-lifetime';
import { boardPayload, createHarness } from './testing';
import { parseBoardDetailed } from '../lib/formats';
import { BoardFormatError } from '../lib/formats/common';

// TB-009 / TB-072: a refused CST, LST or CSV at start-up must leave a visible error notice that does not expire. The three samples are
// synthetic (none is a private test sample file). Each one goes through the real format dispatcher, the same call the board worker makes, and
// its refusal is passed to the start-up path the way the worker reports it ({ formatError }). The start-up path must then show the
// parser's text as a sticky error notice.
const { build: buildCst02 } = createRequire(import.meta.url)('../../tests/fixtures/cst/make-cst-02.cjs') as { build: (options?: { partLayers?: number[] }) => Uint8Array };

const enc = (text: string) => new TextEncoder().encode(text);
const SAMPLES: Array<{ name: string; data: Uint8Array }> = [
  { name: 'refused-a.cst', data: buildCst02({ partLayers: [0x08, 0x01] }) },
  { name: 'refused-b.cst', data: buildCst02({ partLayers: [0x0c, 0x02] }) },
  { name: 'refused-c.lst', data: enc('$VS2 assembly listing\r\nU1 PLN 1 CODE 2\r\n') },
  { name: 'refused-d.csv', data: enc('RefDes,Pin,Net\nU1,1,GND\nU1,2,VCC\n') },
  { name: 'refused-e.csv', data: enc('RefDes,Pin,Net\nU2,1,SIG\nU2,2,GND\n') },
  // The same two inputs as the packaged repro (QA133-20261012-02): an invalid .cad and an AppleDouble ._x.tvw companion (synthetic bytes).
  { name: 'refused-f.cad', data: Uint8Array.from({ length: 2048 }, (_, i) => (i * 73 + 41 + (i >> 3) * 17) & 0xff) },
  { name: '._x.tvw', data: Uint8Array.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, ...enc('Mac OS X'), ...new Uint8Array(64)]) },
];

// The worker's own view of a refusal (src/lib/board-worker.ts): the parser's message, code and format label.
function refusalOf(name: string, data: Uint8Array): { message: string; code: string; format?: string } {
  try {
    parseBoardDetailed({ name, data });
  } catch (error) {
    if (error instanceof BoardFormatError) return { message: error.message, code: error.code, ...(error.format ? { format: error.format } : {}) };
    throw error;
  }
  throw new Error(`${name} was not refused by the dispatcher`);
}

describe('a refused start-up sample leaves a visible, lasting error notice (TB-009 / TB-072)', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}: the parser's refusal is the start-up notice, sticky, so it does not expire`, async () => {
      const refusal = refusalOf(sample.name, sample.data);
      const h = createHarness();
      h.desktop.initial = boardPayload(sample.name, 41, { data: sample.data, startupSource: 'argument' });
      h.boardWorkers.replies[sample.name] = { formatError: refusal };
      const stop = h.controller.start();
      await h.controller.idle();
      const notice = h.state().notices.at(-1);
      expect(h.state().board).toBeNull();
      expect(notice).toMatchObject({ kind: 'error', sticky: true, message: { text: refusal.message } });
      expect(noticeLifetimeMs(notice!)).toBeNull();
      stop();
    });
  }
});
