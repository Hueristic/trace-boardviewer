import { describe, expect, it } from 'vitest';
import { designatorWord, wordsToTextItems } from '../ocr/pdf-pages';
import { extractRefCandidates, findText } from './search';
import type { TextIndex } from './search';

// MAC-TEST-20261011-01: OCR reads a scanned "U10" as "u10". A reference designator is matched upper-cased for search and cross-probe;
// the OCR reading stays on the item (ocrRaw) and on the hit (token). Other recognized words are left exactly as read.
const ocrWord = (text: string) => ({ text, x: 30, y: 60, width: 40, height: 20, confidence: 95, rotation: 0 });
const indexOf = (texts: string[]): TextIndex => {
  const items = wordsToTextItems(texts.map(ocrWord), 1, 1);
  return { pageCount: 1, indexedPages: 1, truncated: false, items, pageStarts: [0, items.length] };
};

describe('OCR reference designators (MAC-TEST-20261011-01)', () => {
  it('upper-cases a word that is only letters then digits, and leaves every other word as read', () => {
    expect(designatorWord('u10')).toBe('U10');
    expect(designatorWord('r1')).toBe('R1');
    expect(designatorWord('PU301')).toBe('PU301');
    expect(designatorWord('gnd')).toBe('gnd');
    expect(designatorWord('+3V3')).toBe('+3V3');
    expect(designatorWord('U10A')).toBe('U10A');
    expect(designatorWord('10')).toBe('10');
  });

  it('stores the normalized word as str and keeps the OCR reading only where the word changed', () => {
    const items = wordsToTextItems([ocrWord('u10'), ocrWord('R1'), ocrWord('resistor')], 1, 1);
    expect(items.map(item => item.str)).toEqual(['U10', 'R1', 'resistor']);
    expect(items.map(item => item.ocrRaw)).toEqual(['u10', undefined, undefined]);
    expect(items.every(item => item.source === 'ocr')).toBe(true);
  });

  it('a scanned "u10" links as U10 in the reference scan, and text search finds it either way; the hit keeps the OCR reading', () => {
    const index = indexOf(['u10']);
    const candidates = extractRefCandidates(index, new Set(['U10']), new Set());
    expect(candidates[0].hits).toEqual([expect.objectContaining({ token: 'u10', source: 'ocr', confidence: 95 })]);
    expect(findText(index, 'U10')).toEqual([expect.objectContaining({ token: 'u10', source: 'ocr' })]);
    expect(findText(index, 'u10')).toHaveLength(1);
  });

  it('an ordinary recognized word keeps its reading as the hit token (no ocrRaw)', () => {
    const index = indexOf(['resistor']);
    expect(findText(index, 'resistor')).toEqual([expect.objectContaining({ token: 'resistor', source: 'ocr' })]);
  });
});
