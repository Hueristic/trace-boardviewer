import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs } from './i18n';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Reads `const NAME = <days> * 24 * 60 * 60 * 1000;` from the receiver source. */
function retentionDays(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = (\\d+) \\* 24 \\* 60 \\* 60 \\* 1000;`));
  if (!match) throw new Error(`${name} is not declared in the receiver source`);
  return Number(match[1]);
}

describe('bug report retention copy', () => {
  it('states the receiver expiry plus one daily cleanup run in every language', () => {
    const worker = read('services/bug-report-worker/worker.mjs');
    const bundle = read('services/bug-report-worker/bundle.mjs');
    const expiryDays = retentionDays(worker, 'RETENTION_MS');
    expect(retentionDays(bundle, 'RETENTION_MS')).toBe(expiryDays);
    expect(read('services/bug-report-worker/README.md')).toContain('one daily Cron trigger for `0 4 * * *`');

    // Reports expire after `expiryDays`; the next daily 04:00 run removes them, at most one day later.
    const cleanupIntervalDays = 1;
    const copyDays = expiryDays + cleanupIntervalDays;
    expect(copyDays).toBe(30);
    expect(read('docs/BUG-REPORTS.md')).toContain(`up to ${copyDays} days`);
    expect(read('services/bug-report-worker/README.md')).toContain(`up to ${copyDays} days`);

    for (const language of LANGUAGES) {
      const copy = (catalogs[language] as Record<string, string>)['diagnostic.bugRetention'];
      // Whole numbers only: the "1" in the product name "D1" is not a day count.
      const numbers = copy.match(/\b\d+\b/g) ?? [];
      expect(numbers[0], `${language} report retention`).toBe(String(copyDays));
      expect(numbers[1], `${language} D1 recovery history`).toBe('7');
    }
  });
});
