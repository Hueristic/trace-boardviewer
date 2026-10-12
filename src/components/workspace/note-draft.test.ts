import { describe, expect, it } from 'vitest';
import { mayReseedDraft, noteEditorKey } from './note-draft';

const BOARD_A = 'a'.repeat(64);
const BOARD_B = 'b'.repeat(64);

describe('note editor identity (X12)', () => {
  it('the same component reference on another board is a different editor', () => {
    expect(noteEditorKey(BOARD_A, { componentId: 'R1' })).not.toBe(noteEditorKey(BOARD_B, { componentId: 'R1' }));
  });

  it('a pin editor and the component editor of the same component are different editors', () => {
    expect(noteEditorKey(BOARD_A, { componentId: 'U1', pinId: 'p2' })).not.toBe(noteEditorKey(BOARD_A, { componentId: 'U1' }));
  });

  it('two pins of the same component are different editors', () => {
    expect(noteEditorKey(BOARD_A, { componentId: 'U1', pinId: 'p1' })).not.toBe(noteEditorKey(BOARD_A, { componentId: 'U1', pinId: 'p2' }));
  });

  it('the same board, component and pin keep one editor (a same-key reload does not remount it)', () => {
    expect(noteEditorKey(BOARD_A, { componentId: 'U1', pinId: 'p2' })).toBe(noteEditorKey(BOARD_A, { componentId: 'U1', pinId: 'p2' }));
  });

  it('a missing board key still yields a stable identity', () => {
    expect(noteEditorKey(null, { componentId: 'R1' })).toBe(noteEditorKey(null, { componentId: 'R1' }));
    expect(noteEditorKey(null, { componentId: 'R1' })).not.toBe(noteEditorKey(BOARD_A, { componentId: 'R1' }));
  });
});

describe('draft reseeding rule (X8, X13 and the positive control)', () => {
  it('positive control: a clean draft over readable notes takes the stored note', () => {
    expect(mayReseedDraft({ dirty: false, blocked: false })).toBe(true);
  });

  it('X8: a typed draft is never overwritten by a changed stored note', () => {
    expect(mayReseedDraft({ dirty: true, blocked: false })).toBe(false);
  });

  it('X13: a typed draft stays typed when the notes become readable again', () => {
    expect(mayReseedDraft({ dirty: true, blocked: false })).toBe(false);
  });

  it('no reseed while the stored notes are unreadable, so an unreadable state never clears the editor', () => {
    expect(mayReseedDraft({ dirty: false, blocked: true })).toBe(false);
  });
});
