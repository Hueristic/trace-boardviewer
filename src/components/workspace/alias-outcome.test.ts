import { describe, expect, it } from 'vitest';
import { WORKSPACE_LIMITS } from '../../lib/documents';
import type { AliasRejection } from '../../lib/documents';
import { LANGUAGES, catalogs, createTranslator } from '../../lib/i18n';
import { aliasCreationText, aliasRejectionText, aliasRemovalKey } from './alias-outcome';

const REJECTIONS: AliasRejection[] = ['name', 'target', 'same', 'limit'];

describe('alias removal message', () => {
  it('shows the removed message only for a real removal, and the catalog error otherwise', () => {
    expect(aliasRemovalKey(true)).toBe('workspace.alias.removed');
    expect(aliasRemovalKey(false)).toBe('workspace.alias.removeFailed');
  });

  it('has both messages in all eight languages, with the alias name in the success message', () => {
    for (const language of LANGUAGES) {
      expect(catalogs[language]['workspace.alias.removed'], `${language} removed`).toMatch(/\{name\}/);
      expect(catalogs[language]['workspace.alias.removeFailed'], `${language} removeFailed`).toEqual(expect.any(String));
    }
  });
});

describe('alias creation text', () => {
  it('names the kind of a created alias with both names in it', () => {
    const t = createTranslator('en');
    expect(aliasCreationText('refs', null, 'U1A', 'U1', t)).toBe('Created reference alias: schematic U1A → board U1.');
    expect(aliasCreationText('nets', null, 'VDD', 'PP_VDD', t)).toBe('Created net alias: schematic VDD → board PP_VDD.');
  });

  it('shows the failure sentence and then the reason, as two sentences, in every language', () => {
    for (const language of LANGUAGES) {
      const t = createTranslator(language);
      const failed = t('workspace.alias.createFailed');
      for (const rejection of REJECTIONS) {
        const reason = aliasRejectionText(rejection, t);
        expect(reason, `${language} ${rejection} reason`).toEqual(expect.any(String));
        expect(aliasCreationText('refs', rejection, 'A', 'B', t), `${language} ${rejection}`).toBe(`${failed} ${reason}`);
        expect(failed, `${language} failure ends its sentence`).toMatch(/[.!?]$/);
        expect(reason, `${language} ${rejection} reason ends its sentence`).toMatch(/[.!?]$/);
      }
    }
  });

  it('gives no reason for an other rejection: only the failure sentence stands', () => {
    const t = createTranslator('en');
    expect(aliasRejectionText('other', t)).toBeNull();
    expect(aliasCreationText('nets', 'other', 'A', 'B', t)).toBe('The alias could not be created. Nothing was changed.');
  });

  it('states the real limits in the name, target and count reasons', () => {
    const t = createTranslator('en');
    expect(aliasRejectionText('name', t)).toContain(String(WORKSPACE_LIMITS.alias));
    expect(aliasRejectionText('target', t)).toContain(String(WORKSPACE_LIMITS.alias));
    expect(aliasRejectionText('limit', t)).toContain(WORKSPACE_LIMITS.aliases.toLocaleString('en-GB'));
  });

  it('has every creation and reason message in all eight languages, with both names in the success messages', () => {
    for (const language of LANGUAGES) {
      for (const key of ['workspace.alias.createdRef', 'workspace.alias.createdNet'] as const) {
        expect(catalogs[language][key], `${language} ${key}`).toMatch(/\{source\}.*\{target\}/);
      }
      expect(catalogs[language]['workspace.alias.createFailed'], `${language} createFailed`).toEqual(expect.any(String));
      for (const key of ['workspace.alias.reason.name', 'workspace.alias.reason.target', 'workspace.alias.reason.same', 'workspace.alias.reason.limit'] as const) {
        expect(catalogs[language][key], `${language} ${key}`).toEqual(expect.any(String));
      }
    }
  });
});
