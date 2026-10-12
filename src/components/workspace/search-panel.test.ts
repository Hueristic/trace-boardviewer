import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceApi } from '../../app/api';
import { LANGUAGES, catalogs, createFormatters, createTranslator, renderMessage } from '../../lib/i18n';
import type { Language } from '../../lib/i18n';
import type { Board } from '../../lib/types';
import { SearchPanel } from './SearchPanel';
import { UiContext } from './ui-context';
import type { UiContextValue } from './ui-context';

const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const catalog = (lang: Language, key: string): string => (catalogs[lang] as Record<string, string>)[key];
const uiFor = (lang: Language): UiContextValue => ({ t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: message => renderMessage(lang, message), copy: () => {} });
const withUi = (lang: Language, element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(UiContext.Provider, { value: uiFor(lang) }, element));

const EMPTY_BOARD: Board = { name: 'synthetic', format: 'test', units: 'mm', components: [], pins: [], nets: [], outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [] };
/** A query that has no result rows: either the search is still pending, or it found nothing. */
const apiWithSearch = (pending: boolean) => ({
  state: { board: EMPTY_BOARD, notes: [], probe: {}, search: { query: 'no such part', result: null, pending } },
  actions: { setSearchQuery: () => {}, activateSearchRow: () => {} },
}) as unknown as WorkspaceApi;
const render = (lang: Language, pending: boolean) => withUi(lang, createElement(SearchPanel, {
  api: apiWithSearch(pending), side: 'top', allSides: false, onAllSides: () => {}, onRecents: () => {}, inputRef: { current: null }, onActivated: () => {},
}));
/** The paragraph of the empty state (inside data-testid="search-empty"). */
const emptyText = (html: string): string => decode(/data-testid="search-empty"[\s\S]*?<p>([^<]*)<\/p>/.exec(html)![1]);

describe('the empty state of the parts search is in the catalog language', () => {
  it.each(LANGUAGES)('%s: a query without a match says so', lang => {
    expect(emptyText(render(lang, false))).toBe(catalog(lang, 'search.noMatch'));
  });
  it.each(LANGUAGES)('%s: while the search is pending it says so, and the loader is labelled the same way', lang => {
    const html = render(lang, true);
    expect(emptyText(html)).toBe(catalog(lang, 'search.searching'));
    expect(decode(html)).toContain(`aria-label="${catalog(lang, 'search.searching')}"`);
  });
  it('keeps the English texts unchanged', () => {
    expect(emptyText(render('en', false))).toBe('Nothing matches this search.');
    expect(emptyText(render('en', true))).toBe('Searching…');
  });
});
