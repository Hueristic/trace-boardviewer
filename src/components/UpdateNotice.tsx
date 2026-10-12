import { Download, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Translator } from '../lib/i18n';
import {
  UPDATE_KEYS, beginStartupUpdateCheck, checkNowOffersDownload, checkNowStatus, createUpdateActions, currentDesktop, dismissStartupUpdate,
  getStartupUpdateState, startupUpdateToShow, subscribeStartupUpdate, updateCheckAllowed, updateCheckSupported,
} from '../lib/update-check';
import type { CheckNowState, UpdateActions, UpdateAnswer } from '../lib/update-check';
import './update-notice.css';

/**
 * Update notification (the logic is in src/lib/update-check.ts, the main-process half in electron/updates.cjs). Two small pieces of markup:
 *  - UpdateNotice: one check per launch, once the shell is ready and the setting is on, and a dismissible strip under the top bar when a newer
 *    release exists. The strip waits until the support dialog is out of the way (`after`), so the two never compete. A failed check is silent.
 *    Until the first-start question is answered (`asked` false), the same place shows the question instead: yes, no or skip. Skip leaves the check off.
 *  - UpdateSettings: the switch and the "Check now" row of the Settings dialog (the caller shows them only when the desktop bridge has the update calls).
 * Nothing is ever downloaded or installed: Download asks the main process to open the release page in the browser.
 */
export default function UpdateNotice({ enabled, asked = true, ready, after, t, onOpenFailed, onAnswer }: {
  enabled: boolean; asked?: boolean; ready: boolean; after: boolean; t: Translator; onOpenFailed?: () => void; onAnswer?: (answer: UpdateAnswer) => void;
}) {
  const state = useSyncExternalStore(subscribeStartupUpdate, getStartupUpdateState, getStartupUpdateState);
  const actions = useMemo(() => createUpdateActions(currentDesktop()), []);
  // The decision is made at the moment the shell becomes ready, with the setting as it is then (the launch's one claim is taken either way).
  const enabledNow = useRef(enabled);
  enabledNow.current = enabled;
  useEffect(() => { if (ready) void beginStartupUpdateCheck(currentDesktop(), enabledNow.current && updateCheckAllowed()); }, [ready]);
  if (!asked && ready && after && onAnswer && updateCheckSupported(currentDesktop())) return <UpdateQuestion t={t} onAnswer={onAnswer} />;
  const version = startupUpdateToShow(state, enabled && after);
  if (version === null) return null;
  return <UpdateStrip t={t} version={version} onDownload={() => { void actions.open().then(opened => { if (!opened) onOpenFailed?.(); }); }} onDismiss={dismissStartupUpdate} />;
}

/** The first-start question (exported for the markup test): yes, no, or skip. Nothing is requested before an answer; skip leaves the check off. */
export function UpdateQuestion({ t, onAnswer }: { t: Translator; onAnswer: (answer: UpdateAnswer) => void }) {
  return <div className="update-strip update-question" role="group" aria-label={t(UPDATE_KEYS.askText)} data-testid="update-question">
    <Download size={14} aria-hidden="true" />
    <span className="update-strip-text" data-testid="update-question-text">{t(UPDATE_KEYS.askText)}</span>
    <button type="button" className="primary-button" data-testid="update-question-yes" onClick={() => onAnswer('on')}>{t(UPDATE_KEYS.askYes)}</button>
    <button type="button" className="outline-button" data-testid="update-question-no" onClick={() => onAnswer('off')}>{t(UPDATE_KEYS.askNo)}</button>
    <button type="button" className="tool-button" data-testid="update-question-skip" onClick={() => onAnswer('skip')}>{t(UPDATE_KEYS.askSkip)}</button>
  </div>;
}

/** The strip itself (exported for the markup test). */
export function UpdateStrip({ t, version, onDownload, onDismiss }: { t: Translator; version: string; onDownload: () => void; onDismiss: () => void }) {
  return <div className="update-strip" role="status" data-testid="update-strip">
    <Download size={14} aria-hidden="true" />
    <span className="update-strip-text" data-testid="update-strip-text">{t(UPDATE_KEYS.available, { version })}</span>
    <button type="button" className="outline-button update-strip-download" data-testid="update-download" onClick={onDownload}>{t(UPDATE_KEYS.download)}</button>
    <button type="button" className="tool-button update-strip-dismiss" aria-label={t(UPDATE_KEYS.dismiss)} title={t(UPDATE_KEYS.dismiss)} data-testid="update-dismiss" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>
  </div>;
}

/** The Settings rows: a switch (same look as the other switches of the list) and the Check now row. Rendered inside `.setting-toggles`. */
export function UpdateSettings({ t, checked, onChange, actions }: { t: Translator; checked: boolean; onChange: (checked: boolean) => void; actions?: UpdateActions }) {
  return <>
    <label><span><strong>{t(UPDATE_KEYS.setting)}</strong><small>{t(UPDATE_KEYS.settingHint)}</small></span><input type="checkbox" role="switch" data-testid="update-check-switch" checked={checked} onChange={event => onChange(event.target.checked)} /></label>
    <CheckNow t={t} actions={actions} />
  </>;
}

/** "Check now": a button, a polite status line and, next to an "available" answer, a Download button. */
export function CheckNow({ t, actions: provided, initial = { phase: 'idle' } }: { t: Translator; actions?: UpdateActions; initial?: CheckNowState }) {
  const actions = useMemo(() => provided ?? createUpdateActions(currentDesktop()), [provided]);
  const [state, setState] = useState<CheckNowState>(initial);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const check = async () => {
    setState({ phase: 'checking' });
    const result = await actions.check();
    if (alive.current && result) setState({ phase: 'done', result });
  };
  const download = async () => {
    const opened = await actions.open();
    if (alive.current && !opened) setState(current => (current.phase === 'done' ? { ...current, openFailed: true } : current));
  };
  const status = checkNowStatus(state);
  return <div className="update-check" data-testid="update-check">
    <button type="button" className="outline-button" data-testid="update-check-now" disabled={state.phase === 'checking'} onClick={() => void check()}>{t(UPDATE_KEYS.checkNow)}</button>
    <span className="update-check-status" role="status" data-testid="update-check-status">{status ? t(status.key, status.params) : ''}</span>
    {checkNowOffersDownload(state) && <button type="button" className="primary-button update-check-download" data-testid="update-check-download" onClick={() => void download()}>{t(UPDATE_KEYS.download)}</button>}
  </div>;
}
