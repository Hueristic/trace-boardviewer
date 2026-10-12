import { describe, expect, it } from 'vitest';
import type { ImageDraft } from '../ImageViewer';
import { pruneImageDrafts, rememberImageDraft } from './DocumentViewer';

const draft = (text: string, x = 1, y = 2): ImageDraft => ({ editor: { mode: 'new', x, y }, text });

describe('image drafts across document and tab switches', () => {
  it('hands the draft back to the same document only, never to another one', () => {
    const store = new Map<string, ImageDraft>();
    rememberImageDraft(store, 'doc-a', draft('unsent'));
    expect(store.get('doc-a')?.text).toBe('unsent');
    expect(store.get('doc-b')).toBeUndefined();
  });

  it('keeps an edit draft bound to its own note id', () => {
    const store = new Map<string, ImageDraft>();
    rememberImageDraft(store, 'doc-a', { editor: { mode: 'edit', id: 'note-1', x: 4, y: 5 }, text: 'changed' });
    expect(store.get('doc-a')?.editor).toEqual({ mode: 'edit', id: 'note-1', x: 4, y: 5 });
  });

  it('a newer dirty report replaces the stored draft of the same document', () => {
    const store = new Map<string, ImageDraft>();
    rememberImageDraft(store, 'doc-a', draft('first'));
    rememberImageDraft(store, 'doc-a', draft('second'));
    expect(store.get('doc-a')?.text).toBe('second');
    expect(store.size).toBe(1);
  });

  it('a clean report forgets the stored draft, so nothing is restored later', () => {
    const store = new Map<string, ImageDraft>();
    rememberImageDraft(store, 'doc-a', draft('unsent'));
    rememberImageDraft(store, 'doc-a', null);
    expect(store.has('doc-a')).toBe(false);
  });

  it('a removed document leaves no draft behind, while live documents keep theirs', () => {
    const store = new Map<string, ImageDraft>();
    rememberImageDraft(store, 'doc-a', draft('kept'));
    rememberImageDraft(store, 'doc-gone', draft('removed'));
    pruneImageDrafts(store, [{ record: { id: 'doc-a' } }]);
    expect(store.has('doc-gone')).toBe(false);
    expect(store.get('doc-a')?.text).toBe('kept');
  });
});
