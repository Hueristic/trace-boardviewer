/**
 * A macOS AppleDouble companion ("._name", 26 bytes) gets the same named explanation on win32, darwin and linux, under every name it can
 * reach the readers by: its own "._" name, a renamed copy, and the neutral name the diagnostic report gives it. The refusal depends on the
 * bytes (the AppleDouble header) and never on the platform: the reader is called with each platform, the open runs with the renderer of
 * each platform (navigator.platform, the injection the controller tests use), and the diagnostic runs with each OS family.
 * The fixture is built here from the header layout only; no private sample bytes are used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDiagnostic } from '../lib/diagnostics/collect';
import { BoardFormatError } from '../lib/formats/common';
import { parseBoardDetailed } from '../lib/formats/dispatch';
import { createHarness } from './testing';

const KEY = 'parse.error.appleDoubleMetadata';
/** The 26-byte AppleDouble header (RFC 1740): magic 0x00051607, version 0x00020000, the 16-byte filler macOS writes, and no entries. */
const appleDouble = (): Uint8Array<ArrayBuffer> => Uint8Array.from([0, 5, 0x16, 7, 0, 2, 0, 0, ...new TextEncoder().encode('Mac OS X        '), 0, 0]);
/** The names the stub reaches the readers under: its own "._" name, a renamed copy, and the neutral name of the diagnostic (electron/diagnostics.cjs). */
const NAMES = ['._board.cad', 'board.cad', 'diagnostic.cad'] as const;
const PLATFORMS = [
  { platform: 'win32', navigatorPlatform: 'Win32' },
  { platform: 'darwin', navigatorPlatform: 'MacIntel' },
  { platform: 'linux', navigatorPlatform: 'Linux x86_64' },
] as const;

/** The reply the board worker posts for a refused parse (board-worker.ts): the same fields, taken from the same reader error. */
function refusalReply(name: string, data: Uint8Array, platform: 'win32' | 'darwin' | 'linux') {
  try { parseBoardDetailed({ name, data, platform }); } catch (error) {
    if (!(error instanceof BoardFormatError)) throw error;
    return { formatError: { message: error.message, code: error.code, ...(error.format ? { format: error.format } : {}), ...(error.issue ? { issue: error.issue } : {}) } };
  }
  throw new Error('the AppleDouble fixture was not refused');
}

describe.each(PLATFORMS)('an AppleDouble companion on $platform', ({ platform, navigatorPlatform }) => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(NAMES)('is refused by the reader under the name %s with the explanation of the catalog key', name => {
    let refused: unknown;
    try { parseBoardDetailed({ name, data: appleDouble(), platform }); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(BoardFormatError);
    expect((refused as BoardFormatError).code).toBe('INVALID_FORMAT');
    expect((refused as BoardFormatError).issue).toEqual({ key: KEY });
    expect((refused as BoardFormatError).message).toMatch(/AppleDouble companion file/);
  });

  it.each(['._board.cad', 'board.cad'])('is opened as the app runs it: the notice is the named explanation, not the generic open failure (%s)', async name => {
    const data = appleDouble();
    const h = createHarness({ browser: true });
    h.boardWorkers.replies[name] = refusalReply(name, data, platform);
    h.pickQueue.push([new File([data], name)]);
    vi.stubGlobal('navigator', { platform: navigatorPlatform });
    await h.controller.actions.openBoard();
    await h.controller.idle();
    expect(h.state().notices.map(notice => ({ kind: notice.kind, message: notice.message })))
      .toEqual([{ kind: 'error', message: { issue: { key: KEY } } }]);
  });

  it('is reported by the format diagnostic as refused by its reader, not as unrecognized', async () => {
    const report = await collectDiagnostic({ name: 'diagnostic.cad', data: appleDouble() }, { os: platform });
    expect(report.detection.outcome).toBe('failed');
    expect(report.detection.adapters.some(entry => entry.code === 'INVALID_FORMAT')).toBe(true);
  });
});
