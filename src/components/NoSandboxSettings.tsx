import { useEffect, useState } from 'react';
import type { Translator } from '../lib/i18n';
import type { NoSandboxConsent } from '../lib/types';
import { currentDesktop } from '../lib/update-check';

/**
 * Settings > Linux: the stored "Do not ask again" answer for starting without the Chromium sandbox. The section is shown only where
 * the desktop bridge has the two calls and the platform is Linux (Windows and macOS are never asked). The button takes the stored answer
 * back, so the question comes again at the next start without the sandbox. Optional: Settings works without this section.
 */
export interface NoSandboxView { visible: boolean; saved: boolean; canRevoke: boolean }

/** What the section shows for a read answer; `null` (not read yet, or no bridge) shows nothing. */
export function noSandboxView(consent: NoSandboxConsent | null): NoSandboxView {
  const visible = consent?.applicable === true;
  const saved = visible && consent?.saved === true;
  return { visible, saved, canRevoke: saved };
}

export default function NoSandboxSettings({ t }: { t: Translator }) {
  const [consent, setConsent] = useState<NoSandboxConsent | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const read = currentDesktop()?.getNoSandboxConsent;
    if (typeof read === 'function') {
      read().then(value => { if (active) setConsent(value); }).catch(() => { if (active) setConsent(null); });
    }
    return () => { active = false; };
  }, []);

  const revoke = async () => {
    const revokeAnswer = currentDesktop()?.revokeNoSandboxConsent;
    if (typeof revokeAnswer !== 'function') return;
    setBusy(true);
    setFailed(false);
    try { setConsent(await revokeAnswer()); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };

  const view = noSandboxView(consent);
  if (!view.visible) return null;
  return <div className="settings-section" data-testid="no-sandbox-settings">
    <span className="settings-label">{t('settings.noSandbox.title')}</span>
    <p className="settings-hint">{t('settings.noSandbox.hint')}</p>
    <p className="settings-hint" data-testid="no-sandbox-status">{view.saved ? t('settings.noSandbox.saved') : t('settings.noSandbox.unsaved')}</p>
    <div><button type="button" className="outline-button" data-testid="no-sandbox-revoke" disabled={!view.canRevoke || busy} onClick={() => void revoke()}>{t('settings.noSandbox.revoke')}</button></div>
    {failed && <p className="settings-hint" role="alert">{t('toast.noSandboxRevokeFailed')}</p>}
  </div>;
}
