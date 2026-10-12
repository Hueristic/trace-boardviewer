import { describe, expect, it } from 'vitest';
import { undoFeedback } from './DevicesView';

/** The undo handler's feedback mapping (the handler itself is one call to it). Synthetic codes only. */
const refused = (code: string) => Object.assign(new Error(`device port: ${code}`), { code });

describe('undo feedback', () => {
  it('an undo refused as unknown-file shows the stale-file message the save shows, and the lists are read again', async () => {
    let refreshes = 0;
    const feedback = await undoFeedback(async () => { throw refused('unknown-file'); }, () => { refreshes += 1; });
    expect(feedback).toEqual({ tone: 'warn', key: 'libraryDevices.correction.unknownFile' });
    expect(refreshes).toBe(1);
  });

  it('an undo with nothing to undo says so, and the lists are not read again', async () => {
    let refreshes = 0;
    const feedback = await undoFeedback(async () => false, () => { refreshes += 1; });
    expect(feedback).toEqual({ tone: 'warn', key: 'libraryDevices.correction.nothingToUndo' });
    expect(refreshes).toBe(0);
  });

  it('a successful undo reads the lists again and reports success', async () => {
    let refreshes = 0;
    const feedback = await undoFeedback(async () => true, () => { refreshes += 1; });
    expect(feedback).toEqual({ tone: 'ok', key: 'libraryDevices.correction.undone' });
    expect(refreshes).toBe(1);
  });

  it('other refusals are not turned into the stale-file message: they propagate to the generic failure, and nothing is refreshed', async () => {
    let refreshes = 0;
    await expect(undoFeedback(async () => { throw refused('invalid-request'); }, () => { refreshes += 1; }))
      .rejects.toMatchObject({ code: 'invalid-request' });
    expect(refreshes).toBe(0);
  });
});
