import { describe, expect, it } from 'vitest';
import { createHarness, openNative } from './testing';

// A rejected native chooser (the main process could not read the chosen file) is announced like any failed open: its reason is the
// error notice, the visible board stays, and the notice is an ordinary one (it expires as before).
describe('a rejected native open shows its reason as an error notice', () => {
  it('the chooser read fails: the reason is an error notice and the visible board stays', async () => {
    const h = createHarness();
    await openNative(h, 'visible.cad', 21);
    h.desktop.failures.openBoard = () => new Error("Error invoking remote method 'trace:open-board': Error: The file could not be read.");
    await h.controller.actions.openBoard();
    await h.controller.idle();
    expect(h.state().board?.name).toBe('visible.cad');
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { text: 'The file could not be read.' } });
    expect(h.state().notices.at(-1)?.sticky).toBeUndefined();
  });
});
