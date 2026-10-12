import { WORKSPACE_LIMITS } from '../../lib/documents';
import type { AliasRejection } from '../../lib/documents';
import type { MessageKey, Translator } from '../../lib/i18n';

/** The message of an alias removal: the alias was removed, or the removal could not run and nothing changed. */
export function aliasRemovalKey(removed: boolean): MessageKey {
  return removed ? 'workspace.alias.removed' : 'workspace.alias.removeFailed';
}

/** The reason a create was rejected, as a sentence in the UI language; null for "other", which has no sentence of its own. */
export function aliasRejectionText(rejection: AliasRejection, t: Translator): string | null {
  switch (rejection) {
    case 'name': return t('workspace.alias.reason.name', { max: WORKSPACE_LIMITS.alias });
    case 'target': return t('workspace.alias.reason.target', { max: WORKSPACE_LIMITS.alias });
    case 'same': return t('workspace.alias.reason.same');
    case 'limit': return t('workspace.alias.reason.limit', { max: WORKSPACE_LIMITS.aliases });
    case 'other': return null;
  }
}

/** The dialog text after a create: the success sentence, or the failure sentence followed by its reason. Every catalog entry ends its own sentence, so the parts are joined by one space. */
export function aliasCreationText(kind: 'refs' | 'nets', rejection: AliasRejection | null, source: string, target: string, t: Translator): string {
  if (!rejection) return t(kind === 'refs' ? 'workspace.alias.createdRef' : 'workspace.alias.createdNet', { source, target });
  const failed = t('workspace.alias.createFailed');
  const reason = aliasRejectionText(rejection, t);
  return reason ? `${failed} ${reason}` : failed;
}
