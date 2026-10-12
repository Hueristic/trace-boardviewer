import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removesStoredText } from './note-draft';

// U-01 (BH-NDR-RISK1). Before: a blank Save or Delete removed the stored note at once, whatever it held. Now: removing stored TEXT asks first;
// a blank draft over a note without text (measurements only, or no note) is removed or skipped at once, as before.
describe('blank save or delete of stored text asks first (U-01)', () => {
  it('a blank draft over a stored note with text needs the user\'s confirmation', () => {
    expect(removesStoredText({ text: 'Cap measured 98 nF' }, { text: '' })).toBe(true);
    expect(removesStoredText({ text: 'Cap measured 98 nF' }, { text: '   ' })).toBe(true);
  });

  it('a note without text (measurements only) is removed at once, as before', () => {
    expect(removesStoredText({ text: '' }, { text: '' })).toBe(false);
    expect(removesStoredText({ text: '   ' }, { text: '' })).toBe(false);
  });

  it('a saved note whose text is kept, and a new note with no stored note, never ask', () => {
    expect(removesStoredText({ text: 'Cap measured 98 nF' }, { text: 'Cap measured 97 nF' })).toBe(false);
    expect(removesStoredText(undefined, { text: '' })).toBe(false);
    expect(removesStoredText(undefined, { text: 'new note' })).toBe(false);
  });
});

// O-01 (BH-NDR-LAT): the dialog is keyed by its target, so a change of target mounts a fresh editor and no draft carries over. The keying
// is pinned at the one place it is applied (Shell.tsx) and in the identity rule (note-draft.ts, X12 tests).
describe('note dialog is keyed by its target (O-01)', () => {
  it('the shell mounts NoteDialog with the target identity key', () => {
    const shell = readFileSync(new URL('./Shell.tsx', import.meta.url), 'utf8');
    expect(shell).toContain('<NoteDialog key={noteEditorKey(state.boardKey, noteTarget)}');
  });

  it('the dialog asks before removing stored text through its confirmation row', () => {
    const dialog = readFileSync(new URL('./NoteDialog.tsx', import.meta.url), 'utf8');
    expect(dialog).toContain('removesStoredText(existingRef.current, payload)');
    expect(dialog).toContain('data-testid="note-remove-confirm-row"');
  });
});
