import { describe, expect, it } from 'vitest';
import type { DocumentBookmark } from '../lib/documents';
import { createTranslator } from '../lib/i18n';
import { listWithNewBookmark } from './PdfViewer';

/**
 * The default name of a new bookmark is the catalog text of the interface language at creation time; a saved bookmark keeps its
 * name, because a name is user data. The project has no DOM for the viewer, so the creation step is tested through
 * listWithNewBookmark, the function addBookmark calls with the viewer's translator.
 */
const SAVED: readonly DocumentBookmark[] = [{ id: 'saved-1', page: 2, label: 'Saját név' }];

describe('a new bookmark gets its default name in the interface language at creation', () => {
  it('hu: the new bookmark is named with the Hungarian text', () => {
    const next = listWithNewBookmark(SAVED, 5, createTranslator('hu'), 'new-1');
    expect(next[1]).toMatchObject({ id: 'new-1', page: 5, label: '5. oldal' });
  });

  it('en: the new bookmark is named with the English text', () => {
    const next = listWithNewBookmark(SAVED, 5, createTranslator('en'), 'new-1');
    expect(next[1]).toMatchObject({ id: 'new-1', page: 5, label: 'Page 5' });
  });

  it('a saved name is not changed: the same object with the same label, in either language', () => {
    for (const language of ['hu', 'en'] as const) {
      const next = listWithNewBookmark(SAVED, 5, createTranslator(language), 'new-1');
      expect(next[0]).toBe(SAVED[0]);
      expect(next[0].label).toBe('Saját név');
    }
  });

  it('keeps the position of the new bookmark and leaves the list it was given unchanged', () => {
    const before = SAVED.map(item => ({ ...item }));
    const next = listWithNewBookmark(SAVED, 5, createTranslator('hu'), 'new-1', { x: 10.5, y: 20 });
    expect(next[1]).toMatchObject({ x: 10.5, y: 20 });
    expect(SAVED).toEqual(before);
  });
});
