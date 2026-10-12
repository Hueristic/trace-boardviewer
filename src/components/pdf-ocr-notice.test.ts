import { describe, expect, it } from 'vitest';
import { LANGUAGES, translate } from '../lib/i18n';

// The OCR card joins the summary and the link rule with one space: each sentence must bring its own full stop (in its
// catalog entry), so two sentences never run together in any language.
const SENTENCE_END = /[.!?…]$/;

describe('OCR card sentences', () => {
  it('ends the summary and the link rule with a full stop in every language', () => {
    for (const language of LANGUAGES) {
      const summary = translate(language, 'pdf.ocr.summary', { pages: 2, words: 118 });
      const rule = translate(language, 'pdf.ocr.linkRule', { floor: 60 });
      expect(summary, `${language} summary`).toMatch(SENTENCE_END);
      expect(rule, `${language} link rule`).toMatch(SENTENCE_END);
    }
  });
});
