import type { WorkspaceExportOutcome } from '../../lib/documents';
import type { MessageKey } from '../../lib/i18n';

/** The message of an export that wrote no bundle. A written bundle has no key: its text names the saved file. */
export function exportOutcomeKey(outcome: Extract<WorkspaceExportOutcome, string>): MessageKey {
  return outcome === 'cancelled' ? 'workspace.export.cancelled' : 'workspace.export.failed';
}
