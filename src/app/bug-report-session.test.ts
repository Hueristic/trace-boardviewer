import { describe, expect, it, vi } from 'vitest';
import { BugReportSession, discardBugReportDraft, hasBugReportSendCapability, leaveBugReportWithoutPersistence, requestBugReportClose, shouldPreserveBugReportOnBoardChange, shouldPromptForBugReportClose } from './bug-report-session';
import type { TraceDesktop } from '../lib/types';

const lastImport = { outcome: 'failed', stage: 'parse', formatId: null, extensionClass: '.cad', errorCode: 'INVALID_FORMAT' } as const;
function harness(sendEnabled = true) {
  const prepareBugReport = vi.fn(async (request: { description: string; includeDiagnostics: boolean; context: unknown }) => ({
    status: 'prepared' as const, prepareId: 'prepare-a', report: { schema: 'trace-bug-report/1' as const, reportId: 'report-a', description: request.description, diagnostics: request.includeDiagnostics ? null : null }, canonicalText: JSON.stringify(request), payloadHash: 'a'.repeat(64),
  }));
  const sendBugReport = vi.fn(async () => ({ status: 'received' as const, reportId: 'report-a', payloadHash: 'a'.repeat(64) }));
  const cancelBugReport = vi.fn(async () => ({ status: 'cancelled' as const, uncertain: true }));
  const desktop = { prepareBugReport, sendBugReport, cancelBugReport } as unknown as TraceDesktop;
  return { session: new BugReportSession({ desktop, surface: 'board', lastImport, sendEnabled }), desktop, prepareBugReport, sendBugReport, cancelBugReport };
}

describe('bug report session', () => {
  it('captures the latest import context once and disables diagnostics with a null context', () => {
    const { session } = harness();
    expect(session.getSnapshot().input.context).toEqual({ surface: 'board', lastImport });
    session.setDiagnostics(false);
    expect(session.getSnapshot().input.context).toBeNull();
    session.setDiagnostics(true);
    expect(session.getSnapshot().input.context).toEqual({ surface: 'board', lastImport });
  });

  it.each(['description', 'diagnostics'] as const)('drops a held prepare after a %s edit without clearing a newer request', async edit => {
    const { session, prepareBugReport } = harness();
    session.setDescription('Original text.');
    let finishFirst!: (result: Awaited<ReturnType<typeof prepareBugReport>>) => void;
    prepareBugReport.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    const first = session.prepare();
    expect(session.getSnapshot().busy).toBe(true);
    if (edit === 'description') session.setDescription('Edited while preparing.');
    else session.setDiagnostics(false);
    expect(session.getSnapshot()).toMatchObject({ busy: false, preview: null, phase: 'editing' });

    const second = session.prepare();
    expect(session.getSnapshot().busy).toBe(true);
    await second;
    const current = session.getSnapshot().preview;
    expect(current).not.toBeNull();
    finishFirst({ status: 'prepared', prepareId: 'prepare-old', report: { schema: 'trace-bug-report/1', reportId: 'report-old', description: 'Original text.', diagnostics: null }, canonicalText: '{"description":"Original text."}', payloadHash: 'b'.repeat(64) });
    expect(await first).toBeNull();
    expect(session.getSnapshot().preview).toBe(current);
    expect(session.getSnapshot().input.description).toBe(edit === 'description' ? 'Edited while preparing.' : 'Original text.');
    if (edit === 'diagnostics') expect(prepareBugReport.mock.calls[1][0]).toMatchObject({ includeDiagnostics: false, context: null });
  });

  it.each([false, true])('restores diagnostics-off %s draft/pending with the form-open context available when turned on', pending => {
    const { session } = harness();
    const originalContext = session.getSnapshot().input.context;
    const revision = session.getInputRevision();
    const restored = { description: 'Saved report.', includeDiagnostics: false, context: null };
    expect(session.restoreIfUnchanged(restored, pending, revision)).toBe(true);
    expect(session.getSnapshot().input.context).toBeNull();
    session.setDiagnostics(true);
    expect(session.getSnapshot().input).toMatchObject({ includeDiagnostics: true, context: originalContext });
  });

  it.each(['privacy choice', 'sensitive-text removal'] as const)('does not restore a delayed local draft after %s', change => {
    const { session } = harness();
    const revision = session.getInputRevision();
    if (change === 'privacy choice') session.setDiagnostics(false);
    else session.setDescription('Current text with reviewed details removed.');
    expect(session.restoreIfUnchanged({ description: 'Saved local text.', includeDiagnostics: true, context: null }, false, revision)).toBe(false);
    expect(session.getSnapshot().input).toMatchObject(change === 'privacy choice'
      ? { description: '', includeDiagnostics: false, context: null }
      : { description: 'Current text with reviewed details removed.', includeDiagnostics: true });
  });

  it('prevents duplicate previews, invalidates a prepared preview on edits, and prepares the current text', async () => {
    const { session, prepareBugReport } = harness();
    session.setDescription('The view did not open.');
    const first = await session.prepare();
    expect(first?.status).toBe('prepared');
    expect(session.getSnapshot().preview?.canonicalText).toContain('The view did not open.');
    session.setDescription('The view opened after retry.');
    expect(session.getSnapshot().preview).toBeNull();
    expect(session.getSnapshot().phase).toBe('editing');
    await session.prepare();
    expect(prepareBugReport).toHaveBeenCalledTimes(2);
    expect(prepareBugReport.mock.calls[1][0].description).toBe('The view opened after retry.');
  });

  it('blocks a second rapid prepare request while the first is pending', async () => {
    const { session, prepareBugReport } = harness();
    session.setDescription('A synthetic problem.');
    let finish!: (result: Awaited<ReturnType<typeof prepareBugReport>>) => void;
    prepareBugReport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = session.prepare();
    expect(await session.prepare()).toBeNull();
    expect(prepareBugReport).toHaveBeenCalledTimes(1);
    finish({ status: 'prepared', prepareId: 'prepare-a', report: { schema: 'trace-bug-report/1', reportId: 'report-a', description: 'A synthetic problem.', diagnostics: null }, canonicalText: '{"description":"A synthetic problem."}', payloadHash: 'a'.repeat(64) });
    await first;
  });

  it('disposes a held local prepare so close is available and late previews are ignored', async () => {
    const { session, prepareBugReport } = harness();
    session.setDescription('Unsaved report text.');
    let finish!: (result: Awaited<ReturnType<typeof prepareBugReport>>) => void;
    prepareBugReport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = session.prepare();
    expect(session.getSnapshot().busy).toBe(true);
    session.disposePendingPrepare();
    expect(session.getSnapshot().busy).toBe(false);
    expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
    finish({ status: 'prepared', prepareId: 'prepare-late', report: { schema: 'trace-bug-report/1', reportId: 'report-late', description: 'Unsaved report text.', diagnostics: null }, canonicalText: '{}', payloadHash: 'c'.repeat(64) });
    expect(await pending).toBeNull();
    expect(session.getSnapshot().preview).toBeNull();
    expect(session.getSnapshot().busy).toBe(false);
  });

  it('only clears a local draft after the bridge confirms discard', async () => {
    const afterDiscard = vi.fn();
    expect(await discardBugReportDraft(async () => ({ status: 'discarded' }), afterDiscard)).toBeNull();
    expect(afterDiscard).toHaveBeenCalledTimes(1);
    afterDiscard.mockClear();
    expect(await discardBugReportDraft(async () => ({ status: 'error', error: 'storage' }), afterDiscard)).toBe('storage');
    expect(afterDiscard).not.toHaveBeenCalled();
    expect(await discardBugReportDraft(async () => { throw new Error('write failed'); }, afterDiscard)).toBe('storage');
    expect(afterDiscard).not.toHaveBeenCalled();
    expect(await discardBugReportDraft(undefined, afterDiscard)).toBe('unavailable');
    expect(afterDiscard).not.toHaveBeenCalled();
  });

  it('lets a browser-only in-memory report leave without calling draft persistence methods', async () => {
    const session = new BugReportSession({ surface: 'board', lastImport, sendEnabled: true });
    session.setDescription('A local-only report.');
    const close = vi.fn();
    const prompt = vi.fn();
    await requestBugReportClose(session, close, prompt);
    expect(close).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledOnce();
    leaveBugReportWithoutPersistence(session, close);
    expect(close).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({ input: { description: 'A local-only report.' }, attempted: false, outcome: 'idle' });
  });

  it('keeps partial-bridge journal state untouched when choosing to leave', async () => {
    const getBugReportDraft = vi.fn(async () => ({ status: 'error' as const, error: 'storage' as const }));
    const saveBugReportDraft = vi.fn();
    const discardBugReportDraft = vi.fn();
    const desktop = { getBugReportDraft, saveBugReportDraft, discardBugReportDraft } as unknown as TraceDesktop;
    const session = new BugReportSession({ desktop, surface: 'board', lastImport, sendEnabled: true });
    session.setDescription('Keep any existing local journal.');
    const close = vi.fn();
    const prompt = vi.fn();
    await requestBugReportClose(session, close, prompt);
    expect(prompt).toHaveBeenCalledOnce();
    leaveBugReportWithoutPersistence(session, close);
    expect(close).toHaveBeenCalledOnce();
    expect(saveBugReportDraft).not.toHaveBeenCalled();
    expect(discardBugReportDraft).not.toHaveBeenCalled();
    expect(getBugReportDraft).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ input: { description: 'Keep any existing local journal.' }, attempted: false });
  });

  it('requires prepare, send, and cancel before enabling send and never starts an uninterruptible send', async () => {
    const { prepareBugReport, sendBugReport, cancelBugReport } = harness();
    const desktop = { prepareBugReport, sendBugReport } as unknown as TraceDesktop;
    expect(hasBugReportSendCapability(desktop, true)).toBe(false);
    expect(hasBugReportSendCapability({ prepareBugReport, sendBugReport, cancelBugReport } as unknown as TraceDesktop, true)).toBe(true);
    const session = new BugReportSession({ desktop, surface: 'board', lastImport, sendEnabled: true });
    session.setDescription('Do not start a send without cancellation support.');
    await session.prepare();
    expect(await session.send()).toMatchObject({ status: 'error', error: 'unavailable' });
    expect(sendBugReport).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ busy: false, outcome: 'unavailable' });
  });

  it('offers an explicit leave route for an in-flight operation after cancel capability disappears', async () => {
    const { session, desktop, sendBugReport } = harness();
    let finish!: (result: Awaited<ReturnType<typeof sendBugReport>>) => void;
    sendBugReport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    session.setDescription('An operation whose outcome is still pending.');
    await session.prepare();
    const pending = session.send();
    delete (desktop as Partial<TraceDesktop>).cancelBugReport;
    const close = vi.fn();
    const prompt = vi.fn();
    await requestBugReportClose(session, close, prompt);
    expect(close).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledOnce();
    leaveBugReportWithoutPersistence(session, close);
    expect(close).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({ busy: true, outcome: 'idle', attempted: true });
    finish({ status: 'error', error: 'unknown' });
    await pending;
    expect(session.getSnapshot()).toMatchObject({ busy: false, outcome: 'uncertain', error: 'unknown' });
  });

  it('applies dirty-close and board-change policies without losing a form snapshot', async () => {
    const { session } = harness();
    expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(false);
    session.setDescription('Unsaved local text.');
    expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
    expect(shouldPreserveBugReportOnBoardChange('bug-report')).toBe(true);
    expect(shouldPreserveBugReportOnBoardChange('settings')).toBe(false);
    const before = session.getSnapshot().input.context;
    await session.prepare();
    expect(session.getSnapshot().input.context).toEqual(before);
  });

  it('restores a pending retry as uncertain without changing its exact report input', () => {
    const { session } = harness();
    const pending = { description: 'Pending report text.', includeDiagnostics: false, context: null };
    session.restore(pending, true);
    expect(session.getSnapshot()).toMatchObject({ input: pending, attempted: true, outcome: 'uncertain', phase: 'editing' });
    expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
  });

  it('keeps an uncertain attempt on the same prepared identity when retrying without edits', async () => {
    const { session, sendBugReport } = harness();
    session.setDescription('A synthetic problem.');
    await session.prepare();
    sendBugReport.mockResolvedValueOnce({ status: 'error', error: 'timeout' });
    await session.send();
    expect(session.getSnapshot()).toMatchObject({ attempted: true, outcome: 'uncertain', phase: 'result' });
    await session.send();
    expect(sendBugReport.mock.calls).toEqual([[{ prepareId: 'prepare-a' }], [{ prepareId: 'prepare-a' }]]);
    expect(session.getSnapshot().outcome).toBe('received');
  });

  it('returns a reviewed draft to editing with its description intact (Continue editing)', async () => {
    const { session } = harness();
    session.setDescription('Synthetic draft kept while reviewing.');
    await session.prepare();
    expect(session.getSnapshot().phase).toBe('review');
    session.back();
    expect(session.getSnapshot()).toMatchObject({ phase: 'editing', input: { description: 'Synthetic draft kept while reviewing.' } });
  });

  it('clears retry state when the user edits an attempted report so the next preview is a new report', async () => {
    const { session } = harness();
    session.setDescription('Original report.');
    await session.prepare();
    await session.send();
    session.back();
    session.setDescription('Edited report.');
    expect(session.getSnapshot()).toMatchObject({ attempted: false, phase: 'editing', preview: null });
    await session.prepare();
    expect(session.getSnapshot().preview?.report.description).toBe('Edited report.');
  });

  it('keeps a refused cancellation from overriding a durable received send result', async () => {
    const { session, cancelBugReport, sendBugReport } = harness();
    let finish!: (result: Awaited<ReturnType<typeof sendBugReport>>) => void;
    sendBugReport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    cancelBugReport.mockResolvedValueOnce({ status: 'error', error: 'stale-preview' });
    session.setDescription('A synthetic problem.');
    await session.prepare();
    const pending = session.send();
    expect(await session.cancel()).toBe(true);
    expect(cancelBugReport).toHaveBeenCalledWith({ prepareId: 'prepare-a' });
    expect(session.getSnapshot()).toMatchObject({ busy: true, phase: 'sending', attempted: true });
    finish({ status: 'received', reportId: 'report-a', payloadHash: 'a'.repeat(64) });
    await pending;
    expect(session.getSnapshot()).toMatchObject({ outcome: 'received', attempted: true, busy: false });
  });

  it('reports an accepted cancellation only after the send operation returns cancelled', async () => {
    const { session, sendBugReport } = harness();
    let finish!: (result: Awaited<ReturnType<typeof sendBugReport>>) => void;
    sendBugReport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    session.setDescription('A synthetic problem.');
    await session.prepare();
    const pending = session.send();
    await session.cancel();
    expect(session.getSnapshot()).toMatchObject({ busy: true, phase: 'sending' });
    finish({ status: 'cancelled', uncertain: true });
    await pending;
    expect(session.getSnapshot()).toMatchObject({ outcome: 'uncertain', attempted: true, error: 'cancelled' });
  });

  it('keeps a cancelled send that never left the machine unconfirmed too, with the same cancelled shape', async () => {
    const { session, sendBugReport } = harness();
    sendBugReport.mockImplementationOnce(async () => ({ status: 'cancelled' as const, uncertain: false }));
    session.setDescription('A synthetic problem.');
    await session.prepare();
    await session.send();
    expect(session.getSnapshot()).toMatchObject({ phase: 'result', outcome: 'uncertain', error: 'cancelled' });
  });

  it('keeps source submission unavailable until the receiver gate opens', async () => {
    const { session, sendBugReport } = harness(false);
    session.setDescription('A synthetic problem.');
    await session.prepare();
    expect(await session.send()).toMatchObject({ status: 'error', error: 'unavailable' });
    expect(sendBugReport).not.toHaveBeenCalled();
    expect(session.getSnapshot().outcome).toBe('unavailable');
  });

  it('allows the explicitly enabled desktop flow to submit only after a reviewed preview', async () => {
    const { session, prepareBugReport, sendBugReport } = harness(true);
    session.setDescription('A synthetic problem.');
    await session.prepare();
    expect(prepareBugReport).toHaveBeenCalledTimes(1);
    expect(sendBugReport).not.toHaveBeenCalled();
    expect(await session.send()).toMatchObject({ status: 'received', reportId: 'report-a' });
    expect(sendBugReport).toHaveBeenCalledWith({ prepareId: 'prepare-a' });
    expect(session.getSnapshot()).toMatchObject({ outcome: 'received', busy: false });
  });

  // Regression: after the draft was saved, Cancel with nothing changed closed through the "Leave?" question.
  describe('close after a saved draft', () => {
    async function closeAttempt(session: BugReportSession) {
      const close = vi.fn();
      const prompt = vi.fn();
      await requestBugReportClose(session, close, prompt);
      return { close, prompt };
    }

    it('closes at once when the saved text and privacy choice are unchanged, and the draft stays saved', async () => {
      const { session } = harness();
      session.setDescription('A saved synthetic problem.');
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
      session.markSaved(session.getSnapshot().input);
      const { close, prompt } = await closeAttempt(session);
      expect(prompt).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(session.getSnapshot().input.description).toBe('A saved synthetic problem.');
    });

    it('asks again once the text changes after the save, and closes again when the change is reverted', () => {
      const { session } = harness();
      session.setDescription('A saved synthetic problem.');
      session.markSaved(session.getSnapshot().input);
      session.setDescription('A saved synthetic problem, edited.');
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
      session.setDescription('A saved synthetic problem.');
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(false);
    });

    it('asks again when the saved privacy choice is changed, and clearing the saved text is a change too', () => {
      const { session } = harness();
      session.setDescription('A saved synthetic problem.');
      session.markSaved(session.getSnapshot().input);
      session.setDiagnostics(false);
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
      session.setDiagnostics(true);
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(false);
      session.setDescription('');
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
    });

    it('restores a plain saved draft as saved, so an untouched restored form closes without asking', async () => {
      const { session } = harness();
      session.restore({ description: 'Restored synthetic draft.', includeDiagnostics: false, context: null }, false);
      const { close, prompt } = await closeAttempt(session);
      expect(prompt).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      session.setDescription('Restored synthetic draft, changed.');
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
    });

    it('keeps asking about a pending retry, which was never confirmed, even when nothing changed', () => {
      const { session } = harness();
      session.restore({ description: 'Pending synthetic retry.', includeDiagnostics: false, context: null }, true);
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
    });

    it('asks again after the draft is discarded, because the text is no longer saved', () => {
      const { session } = harness();
      session.setDescription('A saved synthetic problem.');
      session.markSaved(session.getSnapshot().input);
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(false);
      session.markDiscarded();
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
    });

    // The Escape key reaches the same decision as Cancel: the dialog's key handler calls requestClose, which calls requestBugReportClose.
    it('Escape after an edit made following the save asks, and does not close the form', async () => {
      const { session } = harness();
      session.setDescription('A saved synthetic problem.');
      session.markSaved(session.getSnapshot().input);
      session.setDescription('A saved synthetic problem, edited after the save.');
      const { close, prompt } = await closeAttempt(session);
      expect(prompt).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(session.getSnapshot().input.description).toBe('A saved synthetic problem, edited after the save.');
    });

    it('an edit made while the save is still running is not lost: the saved baseline is the text at the click, so Escape asks', async () => {
      const { session } = harness();
      session.setDescription('Text at the moment of the save click.');
      const clicked = session.getSnapshot().input;
      session.setDescription('Text typed while the save was still running.');
      session.markSaved(clicked);
      const { close, prompt } = await closeAttempt(session);
      expect(prompt).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    });

    it('Escape after an edit of a restored saved draft asks', async () => {
      const { session } = harness();
      session.restore({ description: 'Restored saved draft.', includeDiagnostics: true, context: null }, false);
      session.setDescription('Restored saved draft, edited.');
      const { close, prompt } = await closeAttempt(session);
      expect(prompt).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    });

    it('a new form with text and no save still asks, and an empty new form closes at once', () => {
      const { session } = harness();
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(false);
      session.setDescription('Never saved synthetic text.');
      expect(shouldPromptForBugReportClose(session.getSnapshot())).toBe(true);
    });
  });
});
