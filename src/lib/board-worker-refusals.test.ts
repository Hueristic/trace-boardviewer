import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormatFailureError } from '../app/errors';
import { unsupportedAllegro } from './formats/adapters/allegro-brd/fixtures';
import { LANGUAGES, renderMessage, translate } from './i18n';
import type { FormatFailure } from './types';

/** The board worker answers one import through `self`; this stands in for that scope and returns the failure it reports. */
async function refusalOf(name: string, data: Uint8Array): Promise<FormatFailure> {
  const posted: Array<Record<string, unknown>> = [];
  const scope: { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null } = { postMessage: message => posted.push(message as Record<string, unknown>), onmessage: null };
  vi.stubGlobal('self', scope);
  await import('./board-worker');
  scope.onmessage!({ data: { name, data } });
  const reply = posted.find(message => 'formatError' in message);
  if (!reply) throw new Error('the board worker did not report a format failure');
  return reply.formatError as FormatFailure;
}

describe('a localized refusal reaches the UI-facing message', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it.each(LANGUAGES)('shows the Allegro layout refusal in %s through the worker reply, not as the English developer text', async language => {
    const failure = await refusalOf('legacy.brd', unsupportedAllegro(0x00120a0a, 'allv15-7'));
    const params = { layout: '0x00120a00' };
    expect(failure.issue).toEqual({ key: 'parse.error.allegroLayoutUnsupported', params });
    const shown = renderMessage(language, new FormatFailureError(failure).msg);
    expect(shown).toBe(translate(language, 'parse.error.allegroLayoutUnsupported', params));
    expect(shown).toContain('GENCAD 1.4');
    expect(shown).not.toBe(failure.message);
  });
});
