import { describe, expect, it } from 'vitest';
import { LANGUAGES, createTranslator, type MessageKey } from './i18n';

/**
 * Regression guard for defect O-06: the texts of the multi-format build must not say GenCAD only. The unsupported-file
 * refusal and the open-dialog filter name no single format; the welcome hint lists the supported families, GenCAD being
 * one of them. In every language these texts must keep naming more than GenCAD. The GenCAD reader's own messages
 * (parse.error.*) are not checked: they name GenCAD on purpose and only appear for a file that carries a GenCAD $HEADER.
 */
const GENERIC_KEYS: readonly MessageKey[] = ['native.error.unsupportedFile', 'native.dialog.openFilter'];
const OTHER_FORMATS = ['KiCad', 'EAGLE', 'BRD', 'BVR', 'Altium'];

describe('texts of the multi-format build do not say GenCAD only (O-06)', () => {
  it.each(LANGUAGES)('%s: the unsupported-file refusal and the open-dialog filter do not name GenCAD', (lang) => {
    const t = createTranslator(lang);
    for (const key of GENERIC_KEYS) expect(t(key)).not.toMatch(/gencad/i);
  });

  it.each(LANGUAGES)('%s: the welcome hint names at least three formats besides GenCAD', (lang) => {
    const hint = createTranslator(lang)('welcome.fileHint');
    expect(OTHER_FORMATS.filter(name => hint.includes(name)).length).toBeGreaterThanOrEqual(3);
  });
});
