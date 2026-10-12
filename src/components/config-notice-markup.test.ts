import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, translate } from '../lib/i18n';
import type { Language, MessageKey } from '../lib/i18n';
import type { ConfigState } from '../lib/types';
import { ConfigStrip } from './ConfigNotice';

/**
 * Markup of the settings file notice (HUNT-WIN-20261011-02, follow-up): nothing in the ok state; for each other state a persistent, labelled strip
 * with no close button, in all eight languages. The state handling is covered by tests/desktop-checks.cjs (the main process) and the bridge tests.
 */
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const STATES: ReadonlyArray<readonly [Exclude<ConfigState, 'ok'>, MessageKey]> = [
  ['locked', 'config.locked'],
  ['unreadable', 'config.unreadable'],
  ['readonly', 'config.readOnly'],
];

describe('the settings file notice (markup)', () => {
  it('shows nothing when the settings file is ok, and a persistent strip with its text for every other state, in all eight languages', () => {
    for (const language of LANGUAGES) {
      const t = (key: MessageKey) => translate(language as Language, key);
      expect(renderToStaticMarkup(createElement(ConfigStrip, { t, state: 'ok' }))).toBe('');
      for (const [state, key] of STATES) {
        const html = renderToStaticMarkup(createElement(ConfigStrip, { t, state }));
        expect(html, `${language} ${state}`).toContain('role="status"');
        expect(html, `${language} ${state}`).toContain(`data-state="${state}"`);
        expect(html, `${language} ${state}: persistent, no close button`).not.toContain('<button');
        expect(decode(html), `${language} ${state}`).toContain(translate(language as Language, key));
      }
    }
  });
});
