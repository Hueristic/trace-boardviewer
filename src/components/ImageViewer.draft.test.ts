import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentAnnotation } from '../lib/documents';
import { LANGUAGES, catalogs, createFormatters, createTranslator, renderMessage } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import { ImageViewer, editorCloseDecision, editorOpenDecision, formatDecimal, formatMillimetres, isDraftDirty, isSameNoteTarget, missingNoteDecision, nextBookmarkLabel, savedNoteText } from './ImageViewer';
import { UiContext } from './workspace/ui-context';
import type { UiContextValue } from './workspace/ui-context';

const note = (id: string, text: string): DocumentAnnotation => ({ id, page: 1, x: 10, y: 20, text, updatedAt: '2026-10-10T00:00:00.000Z' });
const edit = (id: string) => ({ mode: 'edit' as const, id, x: 10, y: 20 });
const fresh = (x: number, y: number) => ({ mode: 'new' as const, x, y });

describe('unsaved note drafts', () => {
  it('a closed editor or a clean editor has no draft', () => {
    const notes = [note('a', 'kept')];
    expect(isDraftDirty(null, 'anything', notes)).toBe(false);
    expect(isDraftDirty(fresh(1, 2), '', notes)).toBe(false);
    expect(isDraftDirty(edit('a'), 'kept', notes)).toBe(false);
  });

  it('typed text on a new note is an unsaved draft', () => {
    expect(isDraftDirty(fresh(1, 2), 'hello', [])).toBe(true);
  });

  it('changed text of an existing note is an unsaved draft until it is saved', () => {
    expect(isDraftDirty(edit('a'), 'changed', [note('a', 'kept')])).toBe(true);
  });

  it('a note that vanished keeps its draft dirty while the text is not empty', () => {
    expect(isDraftDirty(edit('a'), 'still typed', [])).toBe(true);
    expect(isDraftDirty(edit('a'), '', [])).toBe(false);
  });

  it('the saved text of a target: empty for a new note, the stored text for an edit, null when the note is gone', () => {
    expect(savedNoteText(fresh(1, 2), [])).toBe('');
    expect(savedNoteText(edit('a'), [note('a', 'stored')])).toBe('stored');
    expect(savedNoteText(edit('a'), [])).toBeNull();
  });
});

describe('note target identity', () => {
  it('the same note or the same point is the same target; any other pair is not', () => {
    expect(isSameNoteTarget(edit('a'), { mode: 'edit', id: 'a' })).toBe(true);
    expect(isSameNoteTarget(edit('a'), { mode: 'edit', id: 'b' })).toBe(false);
    expect(isSameNoteTarget(fresh(1, 2), fresh(1, 2))).toBe(true);
    expect(isSameNoteTarget(fresh(1, 2), fresh(3, 4))).toBe(false);
    expect(isSameNoteTarget(fresh(1, 2), { mode: 'edit', id: 'a' })).toBe(false);
  });
});

describe('replacing the open editor', () => {
  it('opening a different note while a draft is pending is blocked, so the text is never moved', () => {
    expect(editorOpenDecision(edit('a'), true, { mode: 'edit', id: 'b' })).toBe('block');
    expect(editorOpenDecision(fresh(1, 2), true, fresh(3, 4))).toBe('block');
    expect(editorOpenDecision(fresh(1, 2), true, { mode: 'edit', id: 'a' })).toBe('block');
  });

  it('the editor that already shows the target keeps its draft exactly as it is', () => {
    expect(editorOpenDecision(fresh(1, 2), true, fresh(1, 2))).toBe('keep');
    expect(editorOpenDecision(edit('a'), true, { mode: 'edit', id: 'a' })).toBe('keep');
  });

  it('a clean editor, or no editor, can be replaced freely', () => {
    expect(editorOpenDecision(edit('a'), false, { mode: 'edit', id: 'b' })).toBe('allow');
    expect(editorOpenDecision(null, false, fresh(3, 4))).toBe('allow');
    expect(editorOpenDecision(null, true, { mode: 'edit', id: 'b' })).toBe('allow');
  });
});

describe('closing the editor', () => {
  it('Escape and Cancel keep an unsaved draft and close only a clean editor', () => {
    expect(editorCloseDecision(true)).toBe('keep');
    expect(editorCloseDecision(false)).toBe('close');
  });

  it('a note removed elsewhere moves its unsaved draft to a new note; a clean editor just closes', () => {
    expect(missingNoteDecision(true)).toBe('move');
    expect(missingNoteDecision(false)).toBe('close');
  });
});

// The Save button of the note editor names the platform's modifier: Cmd on Apple platforms, Ctrl elsewhere. The handler accepts both
// keys (ctrlKey or metaKey), so only the label differs. The editor is open at mount through the draft prop, so the markup holds the button.
describe('Save label of the note editor', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const uiFor = (lang: Language): UiContextValue => ({ t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: message => renderMessage(lang, message), copy: () => undefined });
  const renderEditor = (lang: Language): string => renderToStaticMarkup(createElement(UiContext.Provider, { value: uiFor(lang) }, createElement(ImageViewer, {
    name: 'sample.png', data: new Uint8Array([0]), bookmarks: [], annotations: [], theme: 'dark', motion: false, compact: false, camera: {},
    onCameraChange: () => undefined, onCalibrationChange: () => undefined, onBookmarksChange: () => undefined, onAnnotationsChange: () => undefined,
    draft: { editor: { mode: 'new', x: 10, y: 20 }, text: 'typed' }, onDraftChange: () => undefined,
  })));

  it('macOS shows Cmd+Enter on the Save button, never Ctrl+Enter', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const markup = renderEditor('en');
    expect(markup).toContain('title="Save (Cmd+Enter)"');
    expect(markup).not.toContain('Ctrl+Enter');
  });

  it('macOS is recognised from userAgentData as well', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: '' });
    expect(renderEditor('en')).toContain('title="Save (Cmd+Enter)"');
  });

  it.each([['Windows', 'Win32'], ['Linux', 'Linux x86_64']])('%s keeps Ctrl+Enter on the Save button, never Cmd+Enter', (_name, platform) => {
    vi.stubGlobal('navigator', { platform });
    const markup = renderEditor('en');
    expect(markup).toContain('title="Save (Ctrl+Enter)"');
    expect(markup).not.toContain('Cmd+Enter');
  });

  it.each(LANGUAGES)('%s: macOS uses images.saveWithCmd, the other platforms keep notes.saveWithShortcut', (lang) => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(renderEditor(lang)).toContain(`title="${String(catalogs[lang]['images.saveWithCmd'])}"`);
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(renderEditor(lang)).toContain(`title="${String(catalogs[lang]['notes.saveWithShortcut'])}"`);
  });
});

// A default bookmark name is the catalog name of the UI language at creation; names a document already has are never changed.
describe('default bookmark names', () => {
  const german = createTranslator('de');
  const name = (number: number) => german('images.bookmarkName', { number: String(number) });

  it('a new bookmark takes the catalog name of the UI language: the first number after the count that no saved bookmark uses', () => {
    expect(nextBookmarkLabel([], 0, name)).toBe('Lesezeichen 1');
    expect(nextBookmarkLabel(['Lesezeichen 1'], 1, name)).toBe('Lesezeichen 2');
    expect(nextBookmarkLabel(['Lesezeichen 2'], 1, name)).toBe('Lesezeichen 3');
    const english = createTranslator('en');
    expect(nextBookmarkLabel([], 0, number => english('images.bookmarkName', { number: String(number) }))).toBe('Bookmark 1');
  });

  it('saved names stay as they are, including the English names of an earlier session', () => {
    const saved = ['Bookmark 1', 'Lesezeichen 2'];
    expect(nextBookmarkLabel(saved, 2, name)).toBe('Lesezeichen 3');
    expect(saved).toEqual(['Bookmark 1', 'Lesezeichen 2']);
  });
});

// The digits of every decimal display are those of the original display; only the decimal separator follows the UI language.
describe('decimal display: the digits stay, only the separator follows the UI language', () => {
  /** The digits after the decimal separator (a comma or a dot). */
  const digitsOf = (text: string): number => (text.split(/[.,]/)[1] ?? '').length;

  it.each([
    ['100 mm and up: one decimal', 123.456, 1, '123,5', '123.5'],
    ['1 mm up to 100 mm: two decimals', 12.3456, 2, '12,35', '12.35'],
    ['below 1 mm: three decimals', 0.12345, 3, '0,123', '0.123'],
  ])('measured millimetres, %s (de keeps a comma, en a dot)', (_tier, mm, digits, comma, dot) => {
    const de = formatMillimetres(mm, 'de');
    const en = formatMillimetres(mm, 'en');
    expect(de).toBe(comma);
    expect(en).toBe(dot);
    expect(digitsOf(de)).toBe(digits);
    expect(digitsOf(en)).toBe(digits);
  });

  it('the tier edges: 100 mm has one decimal, 1 mm two, 0.999 mm three', () => {
    expect(formatMillimetres(100, 'hu')).toBe('100,0');
    expect(formatMillimetres(1, 'hu')).toBe('1,00');
    expect(formatMillimetres(0.999, 'hu')).toBe('0,999');
  });

  it('the calibration ratio keeps three decimals, the status ratio and the pixels of 1 mm two, the pixel values one', () => {
    expect(formatDecimal(3.14159, 3, 'de')).toBe('3,142');
    expect(formatDecimal(3.14159, 2, 'de')).toBe('3,14');
    expect(formatDecimal(12.345, 1, 'en')).toBe('12.3');
    expect(digitsOf(formatDecimal(3.14159, 3, 'de'))).toBe(3);
    expect(digitsOf(formatDecimal(3.14159, 2, 'en'))).toBe(2);
    expect(digitsOf(formatDecimal(12.345, 1, 'en'))).toBe(1);
  });

  it('grouping stays off: only the decimal separator changes', () => {
    expect(formatDecimal(1234.5, 1, 'hu')).toBe('1234,5');
    expect(formatDecimal(1234.5, 1, 'en')).toBe('1234.5');
  });
});
