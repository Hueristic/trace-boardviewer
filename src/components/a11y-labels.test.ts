import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs } from '../lib/i18n';

/**
 * Accessible names come from the catalogs in all eight languages. A literal English aria-label in a component
 * would reach screen readers untranslated, so no component may carry one.
 */
const COMPONENTS = new URL('.', import.meta.url);

describe('accessible names come from the catalogs', () => {
  it('no component labels an element with a literal English aria-label', () => {
    const offenders = readdirSync(COMPONENTS, { recursive: true }).map(String)
      .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
      .flatMap((file) => [...readFileSync(new URL(file, COMPONENTS), 'utf8').matchAll(/aria-label="[A-Za-z]/g)].map(() => file));
    expect(offenders).toEqual([]);
  });

  it('the status bar region name exists in all eight languages', () => {
    for (const language of LANGUAGES) {
      expect((catalogs[language] as Record<string, string>)['status.region'], language).toBeTruthy();
    }
  });
});
