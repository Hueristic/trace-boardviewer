import { Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MessageKey, Translator } from '../lib/i18n';
import { currentDesktop } from '../lib/update-check';
import type { ConfigState } from '../lib/types';
import './update-notice.css';

/**
 * The settings file notice (HUNT-WIN-20261011-02, follow-up): while config.json cannot be used as it is, a persistent strip stays under the top bar
 * until the state is back to ok. The main process holds the state (electron/main.cjs configState): "locked" (another program holds the file, the
 * settings are the defaults and nothing is written over it), "unreadable" (damaged, or written by another version), "readonly" (the file cannot be
 * written: the changes apply to this session only). The notice has no close button: it describes the state, and it goes when the state is ok again.
 * The state is read when the notice mounts and followed afterwards; a bridge without the calls (the browser build) shows nothing.
 */
const KEYS: Record<Exclude<ConfigState, 'ok'>, MessageKey> = {
  locked: 'config.locked',
  unreadable: 'config.unreadable',
  readonly: 'config.readOnly',
};

export default function ConfigNotice({ t }: { t: Translator }) {
  const [state, setState] = useState<ConfigState>('ok');
  useEffect(() => {
    const desktop = currentDesktop();
    if (!desktop?.getConfigState || !desktop.onConfigStateChanged) return undefined;
    let alive = true;
    const off = desktop.onConfigStateChanged((next) => { if (alive) setState(next); });
    void desktop.getConfigState().then((result) => { if (alive) setState(result.state); }).catch(() => {});
    return () => { alive = false; off(); };
  }, []);
  return <ConfigStrip t={t} state={state} />;
}

/** The strip itself (exported for the markup test). Nothing is shown in the ok state. */
export function ConfigStrip({ t, state }: { t: Translator; state: ConfigState }) {
  if (state === 'ok') return null;
  return <div className="update-strip config-notice" role="status" data-testid="config-notice" data-state={state}>
    <Info size={14} aria-hidden="true" />
    <span className="update-strip-text" data-testid="config-notice-text">{t(KEYS[state])}</span>
  </div>;
}
