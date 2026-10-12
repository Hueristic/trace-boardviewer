import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SaveState } from '../../app/api';
import { createStatusStore } from '../../app/statusStore';
import { LANGUAGES, catalogs, createFormatters, createTranslator, renderMessage } from '../../lib/i18n';
import type { Language } from '../../lib/i18n';
import { StatusBar } from './StatusBar';
import { UiContext } from './ui-context';
import type { UiContextValue } from './ui-context';

const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const catalog = (lang: Language, key: string): string => (catalogs[lang] as Record<string, string>)[key];
const uiFor = (lang: Language): UiContextValue => ({ t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: message => renderMessage(lang, message), copy: () => {} });
const withUi = (lang: Language, element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(UiContext.Provider, { value: uiFor(lang) }, element));

const render = (lang: Language, save: SaveState, persistence: 'native' | 'session-only' = 'native') => withUi(lang, createElement(StatusBar, {
  store: createStatusStore(), fmt: createFormatters(lang), t: createTranslator(lang), counts: { components: 2, pins: 3, nets: 1 }, warnings: 0,
  save, persistence, breadcrumb: '', unresolvedNotes: 0, onInfo: () => {}, onHelp: () => {}, onUnresolvedNotes: () => {},
}));
/** The visible text of the save state badge (data-testid="save-state"), past its optional alert icon. */
const saveText = (html: string): string => decode(/data-testid="save-state"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>([^<]*)<\/span>/.exec(html)![1]);
const SAVED: SaveState = { dirty: false, saving: false, failure: null };

describe('the save state of the status bar is in the catalog language', () => {
  it.each(LANGUAGES)('%s: saved, unsaved, saving, failed and not saved (browser mode) each have their catalog text', lang => {
    expect(saveText(render(lang, SAVED))).toBe(catalog(lang, 'status.saved'));
    expect(saveText(render(lang, { ...SAVED, dirty: true }))).toBe(catalog(lang, 'status.unsaved'));
    expect(saveText(render(lang, { ...SAVED, dirty: true, saving: true }))).toBe(catalog(lang, 'status.saving'));
    expect(saveText(render(lang, { ...SAVED, dirty: true, failure: 'disk full' }))).toBe(catalog(lang, 'status.failed').replace('{message}', 'disk full'));
    expect(saveText(render(lang, SAVED, 'session-only'))).toBe(catalog(lang, 'status.notSaved'));
  });
  it('keeps the English words unchanged', () => {
    expect(saveText(render('en', SAVED))).toBe('Saved');
    expect(saveText(render('en', { ...SAVED, dirty: true }))).toBe('Unsaved changes');
    expect(saveText(render('en', { ...SAVED, dirty: true, saving: true }))).toBe('Saving…');
    expect(saveText(render('en', { ...SAVED, dirty: true, failure: 'disk full' }))).toBe('Save failed: disk full');
    expect(saveText(render('en', SAVED, 'session-only'))).toBe('Not saved (browser mode)');
  });
});
