import { AlertCircle, Check, ChevronDown, ChevronRight, FileBox, FileSearch, FolderOpen, KeyRound, LayoutPanelLeft, Maximize2, Moon, Square, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import type { KeyRequest } from '../../app/api';
import { diagnosticSupported } from '../../app/diagnostic-session';
import { validateKeyText } from '../../app/keys';
import { LANGUAGE_NAMES, LANGUAGES, normalizeLanguage } from '../../lib/i18n';
import type { Translator } from '../../lib/i18n';
import type { AppSettings, Board, RecentFile } from '../../lib/types';
import { networkActivitySupported } from '../../lib/network-activity';
import { currentDesktop, updateCheckSupported } from '../../lib/update-check';
import NetworkSettings from '../NetworkSettings';
import NoSandboxSettings from '../NoSandboxSettings';
import { UpdateSettings } from '../UpdateNotice';
import { modifierLabels } from './shortcuts';
import { Modal } from './ui';
import { useUi } from './ui-context';

/** The modifier names come from the platform (Ctrl / Alt, or Cmd / Option on a Mac); the handlers accept both. */
const SHORTCUTS = (mod: string): ReadonlyArray<readonly [Parameters<Translator>[0], string]> => [
  ['help.open', `${mod} + O`], ['help.search', `${mod} + F`], ['help.fit', 'F'], ['help.rotate', 'R'], ['help.measure', 'M'],
  ['help.labels', 'L'], ['help.note', 'N'], ['help.zoom', '+ / −'], ['help.layout', `${mod} + 1 / 2`], ['help.settings', `${mod} + ,`], ['help.escape', 'Esc'],
];
const EXTRA_SHORTCUTS = (mod: string, alt: string, t: Translator): ReadonlyArray<readonly [Parameters<Translator>[0], string]> => [
  ['help.shortcutTabs', `${alt} + 1 / 2 / 3`], ['help.shortcutSplit', `${mod} + \\`], ['help.shortcutResize', t('dialogs.shortcutResizeKeys')],
  ['help.shortcutResults', '↑ ↓  ·  Enter'], ['help.shortcutClearSearch', 'Esc'],
];

export function SettingsDialog({ settings, onUpdate, onClose, initialFocus }: { settings: AppSettings; onUpdate(next: Partial<AppSettings>): void; onClose(): void; initialFocus?: string }) {
  const { t, language } = useUi();
  // The theme and layout buttons form groups named by their headings (a <label> without a control named nothing).
  const appearanceId = useId(), layoutId = useId();
  return <Modal title={t('settings.title')} closeLabel={t('common.close')} initialFocus={initialFocus} close={onClose} testId="settings-dialog">
    <div className="settings-section"><label className="settings-label" htmlFor="language-select">{t('settings.language')}</label><div className="select-field"><select id="language-select" className="settings-select" data-testid="language-select" value={language} aria-describedby="language-hint" onChange={e => { const next = normalizeLanguage(e.target.value); if (next) onUpdate({ language: next }); }}>{LANGUAGES.map(code => <option key={code} value={code} lang={code}>{LANGUAGE_NAMES[code]}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></div><p id="language-hint" className="settings-hint">{t('settings.languageHint')}</p></div>
    <div className="settings-section"><span className="settings-label" id={appearanceId}>{t('settings.appearance')}</span><div className="settings-options" role="group" aria-labelledby={appearanceId}>{(['dark', 'light', 'system'] as const).map(value => <button type="button" key={value} className={settings.theme === value ? 'selected' : ''} aria-pressed={settings.theme === value} data-testid={`theme-${value}`} onClick={() => onUpdate({ theme: value })}>{value === 'dark' ? <Moon size={17} /> : value === 'light' ? <Sun size={17} /> : <Square size={17} />}{t(value === 'dark' ? 'settings.themeDark' : value === 'light' ? 'settings.themeLight' : 'settings.themeSystem')}</button>)}</div></div>
    <div className="settings-section"><span className="settings-label" id={layoutId}>{t('settings.layout')}</span><div className="settings-options" role="group" aria-labelledby={layoutId}>{(['workshop', 'focus'] as const).map(value => <button type="button" key={value} aria-pressed={settings.layout === value} className={settings.layout === value ? 'selected' : ''} onClick={() => onUpdate({ layout: value })}>{value === 'workshop' ? <LayoutPanelLeft size={17} /> : <Maximize2 size={17} />}{t(value === 'workshop' ? 'layout.workshop' : 'layout.focus')}</button>)}</div></div>
    <div className="setting-toggles"><label><span><strong>{t('settings.motion')}</strong><small>{t('settings.motionHint')}</small></span><input type="checkbox" role="switch" checked={settings.motion} onChange={e => onUpdate({ motion: e.target.checked })} /></label><label><span><strong>{t('settings.labels')}</strong><small>{t('settings.labelsHint')}</small></span><input type="checkbox" role="switch" checked={settings.showLabels} onChange={e => onUpdate({ showLabels: e.target.checked })} /></label><label><span><strong>{t('settings.connections')}</strong><small>{t('settings.connectionsHint')}</small></span><input type="checkbox" role="switch" checked={settings.showConnections} onChange={e => onUpdate({ showConnections: e.target.checked })} /></label>{updateCheckSupported(currentDesktop()) && <UpdateSettings t={t} checked={settings.updateCheck} onChange={updateCheck => onUpdate({ updateCheck })} />}</div>
    {networkActivitySupported(currentDesktop()) && <NetworkSettings t={t} language={language} settings={settings} />}
    <NoSandboxSettings t={t} />
    <div className="modal-footer"><span className="muted">{t('settings.autosave')}</span><button type="button" className="primary-button" onClick={onClose}><Check size={16} />{t('common.done')}</button></div>
  </Modal>;
}

export function HelpDialog({ onClose, onDiagnostic }: { onClose(): void; onDiagnostic?(): void }) {
  const { t } = useUi();
  const { mod, alt } = modifierLabels();
  return <Modal title={t('help.title')} closeLabel={t('common.close')} close={onClose} testId="help-dialog">
    <div className="shortcuts">{SHORTCUTS(mod).map(([label, key]) => <div key={label}><span>{t(label)}</span><kbd>{key}</kbd></div>)}{EXTRA_SHORTCUTS(mod, alt, t).map(([label, key]) => <div key={label}><span>{t(label)}</span><kbd>{key}</kbd></div>)}</div>
    {onDiagnostic && diagnosticSupported(currentDesktop()) && <div className="help-diagnostic"><button type="button" className="outline-button" data-testid="help-diagnostic" onClick={onDiagnostic}><FileSearch size={15} aria-hidden="true" />{t('help.diagnosticReport')}</button><small>{t('help.diagnosticHint')}</small></div>}
    <p className="help-footer">{t('help.footer')}</p>
  </Modal>;
}

export function RecentsDialog({ recents, onOpenRecent, onOpenOther, onClose }: { recents: readonly RecentFile[]; onOpenRecent(path: string): void; onOpenOther(): void; onClose(): void }) {
  const { t } = useUi();
  return <Modal title={t('recents.title')} closeLabel={t('common.close')} close={onClose} testId="recents-dialog">
    {recents.length ? <div className="recent-modal-list">{recents.map(recent => <button type="button" className="recent-row" key={recent.path} onClick={() => onOpenRecent(recent.path)}><FileBox size={20} /><span><strong>{recent.name}</strong><small title={recent.path}>{recent.path}</small></span><ChevronRight size={16} /></button>)}</div> : <p className="empty-caption">{t('recents.empty')}</p>}
    <div className="modal-footer"><button type="button" className="primary-button" onClick={onOpenOther}><FolderOpen size={16} />{t('recents.openOther')}</button></div>
  </Modal>;
}

export function InfoDialog({ board, onClose }: { board: Board; onClose(): void }) {
  const { t, fmt, text } = useUi();
  return <Modal title={t('info.title')} closeLabel={t('common.close')} close={onClose} testId="info-dialog">
    <dl className="info-specs"><div><dt>{t('info.format')}</dt><dd>{board.format}</dd></div><div><dt>{t('info.size')}</dt><dd className="mono">{fmt.mm(board.bounds.maxX - board.bounds.minX)} × {fmt.mm(board.bounds.maxY - board.bounds.minY)} mm</dd></div><div><dt>{t('info.counts')}</dt><dd className="mono">{fmt.count(board.components.length)} / {fmt.count(board.pins.length)} / {fmt.count(board.nets.length)}</dd></div></dl>
    {board.warnings.map((warning, index) => <p className="data-warning" key={index}><AlertCircle size={16} />{text({ issue: warning })}</p>)}
    <p className="help-footer">{t('info.footer')}</p>
  </Modal>;
}

/** Key entry for an encrypted board (driven by `state.import.keyRequest`). The text is validated by src/app/keys.ts; keys are session-only. */
export function KeyDialog({ request, onSubmit, onCancel }: { request: KeyRequest; onSubmit(text: string): void; onCancel(): void }) {
  const { t, text } = useUi();
  const [draft, setDraft] = useState('');
  const check = validateKeyText(request.kind, draft);
  const invalid = 'error' in check;
  return <Modal title={t(request.kind === 'fz' ? 'dialogs.keyTitleFz' : 'dialogs.keyTitleXzz')} closeLabel={t('common.close')} initialFocus="#board-key" close={onCancel} testId="key-dialog">
    <p className="data-warning"><KeyRound size={16} /><span>{request.fileName}: {request.reason ? text(request.reason) : request.message}</span></p>
    <p>{t('key.skipHelp')}</p>
    <label className="note-label" htmlFor="board-key">{t(request.kind === 'fz' ? 'dialogs.keyLabelFz' : 'dialogs.keyLabelXzz')}</label>
    <textarea id="board-key" className="note-editor mono" spellCheck={false} autoComplete="off" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !invalid) { e.preventDefault(); onSubmit(draft); } }} />
    <div className="note-counter mono" role="status">{invalid ? (check.message ? text(check.message) : check.error) : t('dialogs.keyValid')}</div>
    <div className="modal-footer"><button type="button" className="outline-button" data-testid="key-skip" onClick={onCancel}>{t('common.skip')}</button><button type="button" className="primary-button" data-testid="key-submit" disabled={invalid} onClick={() => onSubmit(draft)}><Check size={16} />{t('dialogs.keyUse')}</button></div>
  </Modal>;
}
