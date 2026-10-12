import { describe, expect, it } from 'vitest';
import type { TextItem } from './document';
import { extractRefCandidatesBounded } from './search';
import type { TextIndex } from './search';
import { OCR_LINK_MIN_CONFIDENCE } from '../ocr/contract';

const ocrItem = (str: string, confidence: number): TextItem => ({ str, x: 10, y: 20, width: 24, height: 10, page: 1, source: 'ocr', confidence });
const indexOf = (items: TextItem[]): TextIndex => ({ pageCount: 1, items, pageStarts: [0, items.length], indexedPages: 1, truncated: false });

describe('recognized (OCR) words in the cross-reference scan', () => {
  it('uses a 60 percent confidence floor', () => {
    expect(OCR_LINK_MIN_CONFIDENCE).toBe(60);
  });

  it('lists a letter-case-only word at the floor and drops it just below it', () => {
    const refs = new Set(['U10']);
    const atFloor = extractRefCandidatesBounded(indexOf([ocrItem('u10', 60)]), refs, new Set());
    expect(atFloor.candidates.map(candidate => [candidate.name, candidate.hits.length])).toEqual([['U10', 1]]);
    expect(atFloor.candidates[0].hits[0]).toMatchObject({ source: 'ocr', confidence: 60, page: 1 });
    expect(atFloor.candidates[0].hits[0].context).toContain('u10');
    const belowFloor = extractRefCandidatesBounded(indexOf([ocrItem('u10', 59.9)]), refs, new Set());
    expect(belowFloor.candidates).toEqual([]);
  });

  it('keeps the exact-token rule for recognized words: U1, U100 and O10 are never U10', () => {
    const refs = new Set(['U10']);
    const scan = extractRefCandidatesBounded(indexOf([ocrItem('U1', 95), ocrItem('U100', 95), ocrItem('O10', 95)]), refs, new Set());
    expect(scan.candidates).toEqual([]);
    expect(scan.totalHits).toBe(0);
  });
});
