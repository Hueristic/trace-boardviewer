import type { Message } from '../lib/i18n';
import type { ImportOptions } from '../lib/types';

export type KeyKind = 'fz' | 'xzz';
/** `error` is the English hint (developers, tests); `message` is the same hint as a catalog message, shown in the active language. */
export type KeyCheck = { options: ImportOptions } | { error: string; message?: Message };

/**
 * FZ/CAE: 44 hexadecimal 32-bit words (0x optional; spaces, commas or new lines between them). XZZ: 16 hexadecimal digits.
 * The result is `{ options }` (ready for the parser) or `{ error }` (a hint for the key dialog). Keys never persist.
 */
export function validateKeyText(kind: KeyKind, text: string): KeyCheck {
  if (kind === 'xzz') {
    const digits = text.replace(/\s+/g, '').replace(/^0x/i, '');
    if (!/^[0-9a-f]*$/i.test(digits)) return { error: 'Only hexadecimal digits (0-9, a-f) are allowed.', message: { key: 'dialogs.keyXzzHexOnly' } };
    return digits.length === 16
      ? { options: { xzzKey: digits.toLowerCase() } }
      : { error: `Enter exactly 16 hexadecimal digits (${digits.length} so far).`, message: { key: 'dialogs.keyXzzCount', params: { count: digits.length } } };
  }
  const words = text.split(/[\s,;]+/).filter(Boolean);
  const bad = words.find(word => !/^(?:0x)?[0-9a-f]{1,8}$/i.test(word));
  if (bad) return { error: `"${bad.slice(0, 24)}" is not a hexadecimal 32-bit word.`, message: { key: 'dialogs.keyFzWordInvalid', params: { word: bad.slice(0, 24) } } };
  if (words.length !== 44) return { error: `Enter 44 hexadecimal 32-bit words (${words.length} so far).`, message: { key: 'dialogs.keyFzWordCount', params: { count: words.length } } };
  return { options: { fzKey: words.map(word => parseInt(word.replace(/^0x/i, ''), 16)) } };
}
export const parseKeyText = validateKeyText;
