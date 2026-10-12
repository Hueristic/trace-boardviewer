import { describe, expect, it } from 'vitest';
import { boardPayload, createHarness } from './testing';

// Synthetic refusals of the sample families (CST, LST, CSV), as the board worker reports them: the parser's own English
// text and code. A file named at start-up must end with the same error notice as the same file opened interactively.
const REFUSALS = [
  { name: 'refused.cst', failure: { message: 'CST: component layer code 0x08 occurs in real exports but its top/bottom mapping is not validated.', code: 'UNSUPPORTED_VARIANT', format: 'CST' } },
  { name: 'refused.lst', failure: { message: 'LST: synthetic refusal for the start-up notice test.', code: 'UNSUPPORTED_VARIANT', format: 'LST' } },
  { name: 'refused.csv', failure: { message: 'Pin list (CSV/TSV): the list has no X and Y columns.', code: 'INVALID_FORMAT', format: 'Pin list (CSV/TSV)' } },
];

describe('a refused start-up open is announced like an interactive open', () => {
  for (const { name, failure } of REFUSALS) {
    it(`${name}: the start-up refusal leaves the welcome state with an error notice carrying the parser text`, async () => {
      const h = createHarness();
      h.desktop.initial = boardPayload(name, 31, { startupSource: 'argument' });
      h.boardWorkers.replies[name] = { formatError: failure };
      const stop = h.controller.start();
      await h.controller.idle();
      expect(h.state().board).toBeNull();
      expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', sticky: true, message: { text: failure.message } });
      stop();
    });

    it(`${name}: the start-up notice is the same as the notice of the same file opened interactively`, async () => {
      const startup = createHarness();
      startup.desktop.initial = boardPayload(name, 31, { startupSource: 'argument' });
      startup.boardWorkers.replies[name] = { formatError: failure };
      const stop = startup.controller.start();
      await startup.controller.idle();
      const atStartup = startup.state().notices.at(-1);
      stop();

      const interactive = createHarness();
      const recent = boardPayload(name, 31);
      interactive.desktop.boards.set(recent.path, recent);
      interactive.boardWorkers.replies[name] = { formatError: failure };
      await interactive.controller.actions.openRecent(recent.path);
      await interactive.controller.idle();
      const opened = interactive.state().notices.at(-1);

      expect(atStartup).toBeDefined();
      expect(atStartup).toMatchObject({ kind: opened?.kind });
      expect(atStartup?.message).toEqual(opened?.message);
      // The interactive notice keeps its usual lifetime; only the notice of a file the application opened by itself is sticky.
      expect(atStartup?.sticky).toBe(true);
      expect(opened?.sticky).toBeUndefined();
    });
  }

  it('a start-up file that cannot be read reports the native reason as an error notice and keeps the welcome state', async () => {
    const h = createHarness();
    h.desktop.failures.initialBoard = () => new Error("Error invoking remote method 'trace:initial-board': Error: The file could not be read.");
    const stop = h.controller.start();
    await h.controller.idle();
    expect(h.state().board).toBeNull();
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', sticky: true, message: { text: 'The file could not be read.' } });
    stop();
  });
});

describe('a failed external open is announced like an interactive one, and stays until it is closed', () => {
  it('the main process message becomes a sticky error notice, without a native box', async () => {
    const h = createHarness();
    const stop = h.controller.start();
    await h.controller.idle();
    h.desktop.emitOpenFailed('The file was not found.');
    await h.controller.idle();
    expect(h.state().board).toBeNull();
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', sticky: true, message: { text: 'The file was not found.' } });
    stop();
  });

  it('the notice is removed only when the user closes it', async () => {
    const h = createHarness();
    const stop = h.controller.start();
    h.desktop.emitOpenFailed('The file was not found.');
    await h.controller.idle();
    const id = h.state().notices.at(-1)!.id;
    expect(h.state().notices.some(notice => notice.id === id)).toBe(true);
    h.controller.actions.dismissNotice(id);
    expect(h.state().notices.some(notice => notice.id === id)).toBe(false);
    stop();
  });

  it('a stopped controller announces nothing for a later failure', async () => {
    const h = createHarness();
    const stop = h.controller.start();
    stop();
    h.desktop.emitOpenFailed('The file was not found.');
    await h.controller.idle();
    expect(h.state().notices).toEqual([]);
  });
});
