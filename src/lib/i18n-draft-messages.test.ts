import { describe, expect, it } from 'vitest';
import { LANGUAGES, LEGACY_LANGUAGE, catalogs, translate } from './i18n';
import type { Language } from './i18n';

// The four messages of unsaved note drafts (src/components/ImageViewer.tsx). Every language must carry its own text: a missing key would
// silently show the English or Hungarian fallback instead.
const KEYS = ['notes.draftBlocked', 'notes.draftKept', 'notes.draftMoved', 'notes.draftRestored'] as const;

describe('draft message catalogs', () => {
  it.each(KEYS)('%s has a non-empty text in every language, with no placeholder and no raw key', key => {
    for (const language of LANGUAGES) {
      const text = catalogs[language][key];
      expect(typeof text, `${language}:${key}`).toBe('string');
      expect((text as string).trim().length, `${language}:${key} is empty`).toBeGreaterThan(0);
      expect(text, `${language}:${key} has a placeholder`).not.toMatch(/[{}]/);
      expect(text, `${language}:${key} shows the raw key`).not.toContain('notes.draft');
    }
  });

  it.each(KEYS)('%s is translated: each language differs from the English text, except English itself', key => {
    const english = catalogs.en[key];
    for (const language of LANGUAGES) {
      if (language === 'en') continue;
      expect(catalogs[language][key], `${language}:${key} is still the English text`).not.toBe(english);
    }
  });

  it.each(KEYS)('%s is returned by the engine unchanged, in every language', key => {
    for (const language of LANGUAGES) {
      expect(translate(language, key), `${language}:${key}`).toBe(catalogs[language][key]);
    }
  });

  it('an unknown language falls back to the legacy Hungarian text, and a missing key is shown as its key', () => {
    const unknown = 'xx' as unknown as Language;
    for (const key of KEYS) expect(translate(unknown, key)).toBe(catalogs[LEGACY_LANGUAGE][key]);
    expect(translate('de', 'notes.draftNotInAnyCatalog')).toBe('notes.draftNotInAnyCatalog');
  });

  it('a key missing from one language falls back to the English text (in memory, restored afterwards)', () => {
    const german = catalogs.de as Record<string, string>;
    const saved = german['notes.draftKept'];
    try {
      delete german['notes.draftKept'];
      expect(translate('de', 'notes.draftKept')).toBe(catalogs.en['notes.draftKept']);
      expect(translate('de', 'notes.draftBlocked')).toBe(catalogs.de['notes.draftBlocked']);
    } finally {
      german['notes.draftKept'] = saved;
    }
    expect(translate('de', 'notes.draftKept')).toBe(saved);
  });
});

// The labels that replaced English-only texts in ImageViewer (common.save, common.delete, common.note and the three new keys).
const LABEL_KEYS = ['common.save', 'common.cancel', 'common.delete', 'common.note', 'notes.addNote', 'notes.saveWithShortcut', 'notes.newNote', 'notes.editNote', 'notes.bookmarksAndNotes'] as const;

describe('viewer label catalogs', () => {
  it.each(LABEL_KEYS)('%s has a non-empty text in every language, with no placeholder', key => {
    for (const language of LANGUAGES) {
      const text = catalogs[language][key];
      expect(typeof text, `${language}:${key}`).toBe('string');
      expect((text as string).trim().length, `${language}:${key} is empty`).toBeGreaterThan(0);
      expect(text, `${language}:${key} has a placeholder`).not.toMatch(/[{}]/);
    }
  });

  // "Note" is also the French word for a note, so common.note is exempt from the differs-from-English check.
  it.each(LABEL_KEYS.filter(key => key !== 'common.note'))('%s is translated away from English in every language except English', key => {
    for (const language of LANGUAGES) {
      if (language === 'en') continue;
      expect(catalogs[language][key], `${language}:${key} is still English`).not.toBe(catalogs.en[key]);
    }
  });
});
