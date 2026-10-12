import type { NoteSubject } from '../../lib/note-keys';

/** Identity of one open note editor: the board it was opened on, the component and the pin. A different identity mounts a fresh editor. */
export function noteEditorKey(boardKey: string | null, target: NoteSubject): string {
  return JSON.stringify([boardKey, target.componentId, target.pinId ?? null]);
}

/**
 * The stored note may replace the draft only while nothing was typed and the stored notes are readable. A repaired read (a retry or a
 * same-key reload) reaches the editor; a typed draft never does, and unreadable notes never clear the editor.
 */
export function mayReseedDraft(state: { dirty: boolean; blocked: boolean }): boolean {
  return !state.dirty && !state.blocked;
}

/**
 * U-01: a save or delete that leaves the text empty removes the text that is stored now. Only that case asks first: a stored note without
 * text (measurements only) and a blank draft over a blank note are removed or skipped at once, as before.
 */
export function removesStoredText(stored: { text: string } | undefined, submitted: { text: string }): boolean {
  return stored !== undefined && stored.text.trim() !== '' && submitted.text.trim() === '';
}
