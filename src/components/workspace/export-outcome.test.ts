import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs } from '../../lib/i18n';
import { exportOutcomeKey } from './export-outcome';

describe('workspace export outcome message', () => {
  it('gives a cancelled save and a failed export their own message', () => {
    expect(exportOutcomeKey('cancelled')).toBe('workspace.export.cancelled');
    expect(exportOutcomeKey('failed')).toBe('workspace.export.failed');
    expect(exportOutcomeKey('failed')).not.toBe(exportOutcomeKey('cancelled'));
  });

  it('has both messages in all eight languages', () => {
    for (const language of LANGUAGES) {
      for (const key of ['workspace.export.cancelled', 'workspace.export.failed'] as const) {
        expect(catalogs[language][key], `${language} ${key}`).toEqual(expect.any(String));
      }
    }
  });
});
