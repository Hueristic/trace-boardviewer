import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFormatters, createTranslator } from '../../lib/i18n';
import { SearchField } from './SearchPanel';
import type { SearchController } from './SearchPanel';
import { UiContext } from './ui-context';
import type { UiContextValue } from './ui-context';

/**
 * The search box hint names the platform modifier, as the shortcut help does: Cmd on Apple platforms, Ctrl elsewhere.
 * The handler accepts both keys; only the label depends on the platform (SearchField takes it from modifierLabels()).
 */
const controller = {
  draft: '', query: '', items: [], rows: [], pending: false, active: 0, identity: '',
  inputProps: { value: '', onChange: () => undefined, onCompositionStart: () => undefined, onCompositionEnd: () => undefined, onKeyDown: () => undefined },
  clear: () => undefined, activate: () => undefined,
} as unknown as SearchController;
const ui: UiContextValue = { t: createTranslator('en'), fmt: createFormatters('en'), language: 'en', text: () => '', copy: () => undefined };

/** The rendered search box with the navigator of the given platform. */
function searchBoxOn(platform: string): string {
  vi.stubGlobal('navigator', { platform });
  return renderToStaticMarkup(createElement(UiContext.Provider, { value: ui }, createElement(SearchField, { ctl: controller, inputRef: { current: null } })));
}

describe('search box key hint', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names Cmd on macOS and no longer shows the Control symbol', () => {
    const html = searchBoxOn('MacIntel');
    expect(html).toContain('<span class="key-hint">⌘F</span>');
    expect(html).not.toContain('⌃');
  });

  it('names Ctrl on Windows', () => {
    expect(searchBoxOn('Win32')).toContain('<span class="key-hint">Ctrl+F</span>');
  });

  it('names Ctrl on Linux', () => {
    expect(searchBoxOn('Linux x86_64')).toContain('<span class="key-hint">Ctrl+F</span>');
  });
});
