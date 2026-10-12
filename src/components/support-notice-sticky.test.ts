import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { noticeLifetimeMs } from '../app/notice-lifetime';
import { boardPayload, createHarness } from '../app/testing';
import { parseBoardDetailed } from '../lib/formats';
import { BoardFormatError } from '../lib/formats/common';
import { claimSupportNotice, errorNoticeOpen, resetSupportNoticeLaunch, restoreSupportClaim, supportClaimMark, supportDialogYields } from '../lib/support-notice';

// QA133-20261012-02: a refused open is an error notice, and the support dialog is a native modal that covers it. The dialog yields at once
// while an error notice is on screen, whatever order the open requests and the dialog arrived in, and records nothing: it is due again after
// the error has closed. The two start-up inputs are the ones the testers used: an AppleDouble companion (._x.tvw) and an invalid .cad. Both
// are synthetic, and both go through the real format dispatcher.
const shell = readFileSync(new URL('./workspace/Shell.tsx', import.meta.url), 'utf8');
const dialog = readFileSync(new URL('./SupportNotice.tsx', import.meta.url), 'utf8');

const enc = (text: string) => new TextEncoder().encode(text);
const SAMPLES: Array<{ name: string; data: Uint8Array }> = [
  { name: 'refused-f.cad', data: Uint8Array.from({ length: 2048 }, (_, i) => (i * 73 + 41 + (i >> 3) * 17) & 0xff) },
  { name: '._x.tvw', data: Uint8Array.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, ...enc('Mac OS X'), ...new Uint8Array(64)]) },
];

function refusalOf(name: string, data: Uint8Array): { message: string; code: string; format?: string } {
  try {
    parseBoardDetailed({ name, data });
  } catch (error) {
    if (error instanceof BoardFormatError) return { message: error.message, code: error.code, ...(error.format ? { format: error.format } : {}) };
    throw error;
  }
  throw new Error(`${name} was not refused by the dispatcher`);
}

const T0 = 1_000_000;

describe('the support dialog yields to an open error notice and records nothing (QA133-20261012-02)', () => {
  beforeEach(() => resetSupportNoticeLaunch());

  it('the shell and the dialog wire the error state through: the dialog yields and the shell passes it', () => {
    expect(shell).toMatch(/const errorNotice = errorNoticeOpen\(state\.notices\)/);
    expect(shell).toMatch(/<SupportNotice [^>]*errorOpen=\{errorNotice\}/);
    expect(dialog).toMatch(/supportDialogYields\(visible, errorOpen\)/);
    expect(dialog).toMatch(/restoreSupportClaim\(claimMark\.current\.claimedAt\)/);
  });

  it('shown, then an error arrives: it yields, nothing is recorded, and the same reminder is due again when the error closes', () => {
    const mark = supportClaimMark();
    expect(claimSupportNotice(T0)).toBe(true); // the reminder is shown and recorded
    expect(supportDialogYields(true, errorNoticeOpen([{ kind: 'error' }]))).toBe(true);
    restoreSupportClaim(mark); // yielded: the record goes back
    expect(supportClaimMark()).toBeNull();
    expect(supportDialogYields(false, false)).toBe(false); // the error has closed
    expect(claimSupportNotice(T0 + 1000)).toBe(true); // due again, and it shows again
  });

  it('without the restore the yielded reminder would count, so the hour gate would hide it: the restore is what keeps it due', () => {
    expect(claimSupportNotice(T0)).toBe(true);
    expect(claimSupportNotice(T0 + 1000)).toBe(false);
  });

  it('a visible dialog yields only while an error is open', () => {
    expect(supportDialogYields(true, false)).toBe(false);
    expect(supportDialogYields(false, true)).toBe(false);
    expect(supportDialogYields(true, true)).toBe(true);
  });

  it('a timed error (an in-app open refusal) yields the dialog until it expires; the expiry releases it', () => {
    const timed = { kind: 'error' as const, sticky: undefined };
    expect(noticeLifetimeMs(timed)).toBe(7500);
    expect(supportDialogYields(true, errorNoticeOpen([timed]))).toBe(true);
    expect(supportDialogYields(true, errorNoticeOpen([]))).toBe(false);
  });

  it('a sticky error (a start-up refusal) yields the dialog for as long as it stays open; closing it releases the dialog', () => {
    const sticky = { kind: 'error' as const, sticky: true };
    expect(noticeLifetimeMs(sticky)).toBeNull();
    expect(supportDialogYields(true, errorNoticeOpen([sticky]))).toBe(true);
    expect(supportDialogYields(true, errorNoticeOpen([]))).toBe(false);
  });

  for (const sample of SAMPLES) {
    it(`${sample.name}: the refusal stays visible and holds the support dialog until the user closes it`, async () => {
      const refusal = refusalOf(sample.name, sample.data);
      const h = createHarness();
      h.desktop.initial = boardPayload(sample.name, 41, { data: sample.data, startupSource: 'argument' });
      h.boardWorkers.replies[sample.name] = { formatError: refusal };
      const stop = h.controller.start();
      await h.controller.idle();
      const shown = h.state().notices.at(-1);
      expect(shown).toMatchObject({ kind: 'error', sticky: true, message: { text: refusal.message } });
      expect(errorNoticeOpen(h.state().notices)).toBe(true);
      h.controller.actions.dismissNotice(shown!.id);
      expect(errorNoticeOpen(h.state().notices)).toBe(false);
      stop();
    });
  }
});
