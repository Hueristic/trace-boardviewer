import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BugReportSession, requestBugReportClose, shouldPreserveBugReportOnBoardChange } from '../app/bug-report-session';
import { LANGUAGES, catalogs, createTranslator } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import BugReportDialog from './BugReportDialog';

/**
 * Windows-hosted scenario for the in-app bug report form. It needs no window, no receiver and no network:
 * it renders the real dialog markup in all eight languages, runs the real close decision, checks the rule that keeps
 * the form open when a board arrives, and confirms that no bug-report code path hands data to the operating system or a browser.
 * It never prepares a send, never calls the receiver. The Linux and macOS checks are in
 * the manual native checklist.
 */
const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const markup = (language: Language) => renderToStaticMarkup(createElement(BugReportDialog, {
  t: createTranslator(language), surface: 'welcome', lastImport: null, onClose: () => undefined,
}));

describe('bug report native scenario (Windows-hosted, no receiver)', () => {
  it('S1 opens the report form in all eight languages with its localized title, question and Cancel label', () => {
    for (const language of LANGUAGES) {
      const html = markup(language);
      const text = catalogs[language] as Record<string, string>;
      expect(html, language).toContain('data-testid="bug-report-dialog"');
      expect(html, language).toContain(text['diagnostic.bugWhatHappened']);
      expect(html, language).toContain(text['diagnostic.cancel']);
      expect(html, language).toContain(text['diagnostic.bugReview']);
    }
  });

  it('S2 Cancel on an untouched form closes at once; a form with text asks before it closes', () => {
    const session = new BugReportSession({ surface: 'welcome', lastImport: null });
    const onClose = vi.fn();
    const onPrompt = vi.fn();
    requestBugReportClose(session, onClose, onPrompt);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPrompt).not.toHaveBeenCalled();

    session.setDescription('Synthetic text typed before Cancel.');
    requestBugReportClose(session, onClose, onPrompt);
    expect(onPrompt).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('S3 an import that arrives while the report is open keeps the form; other dialogs close as before', () => {
    expect(shouldPreserveBugReportOnBoardChange('bug-report')).toBe(true);
    expect(shouldPreserveBugReportOnBoardChange('settings')).toBe(false);
    expect(shouldPreserveBugReportOnBoardChange(null)).toBe(false);
    expect(source('src/components/workspace/Shell.tsx')).toMatch(/if \(!shouldPreserveBugReportOnBoardChange\(modalRef\.current\)\) setModal\(null\);/);
  });

  it('S4 the support notice bug button opens the local form, not an external link', () => {
    const notice = source('src/components/SupportNotice.tsx');
    expect(notice).toMatch(/const reportBug = \(\) => \{ onClose\(\); window\.setTimeout\(\(\) => onReportBug\?\.\(\), 0\); \};/);
    expect(notice).toContain('data-testid="support-bug" onClick={reportBug}');
  });

  it('S5 no bug-report code path hands data to the operating system or a browser', () => {
    const files = [
      'src/components/BugReportDialog.tsx', 'src/app/bug-report-session.ts', 'src/lib/bug-report-description.ts',
      'electron/bug-reports.cjs', 'shared/bug-report-contract.cjs',
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(/openExternal|xdg-open|shell\.|window\.open|location\.href/);
    }
  });
});
