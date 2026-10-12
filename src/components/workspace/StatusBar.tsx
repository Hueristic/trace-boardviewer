import { AlertCircle, Keyboard, StickyNote } from 'lucide-react';
import { memo, useSyncExternalStore } from 'react';
import type { SaveState, StatusStore } from '../../app/api';
import type { Formatters, Translator } from '../../lib/i18n';
import './workspace.css';
import { useUi } from './ui-context';

/** Subscriptions of pointer-rate canvas status. Only these tiny components re-render when the pointer moves (P01). */
const useSlice = <T,>(store: StatusStore, pick: (snapshot: ReturnType<StatusStore['getSnapshot']>) => T): T => useSyncExternalStore(store.subscribe, () => pick(store.getSnapshot()), () => pick(store.getSnapshot()));

export function LiveZoom({ store }: { store: StatusStore }) {
  const { t } = useUi();
  const zoom = useSlice(store, s => Math.round(s.zoom));
  return <span className="zoom-value mono" data-testid="zoom-value" aria-label={t('status.zoom')}>{zoom}%</span>;
}
export function LiveRotation({ store }: { store: StatusStore }) {
  const { t } = useUi();
  const rotation = useSlice(store, s => s.rotation);
  return rotation !== 0 ? <span className="rotation-badge mono" aria-label={t('workspace.rotation')}>{rotation}°</span> : null;
}
export function LiveMeasurement({ store, fmt, prompt }: { store: StatusStore; fmt: Formatters; prompt: string }) {
  const measurement = useSlice(store, s => s.measurement);
  return <span data-testid="measure-text">{measurement == null ? prompt : `${fmt.mm(measurement)} mm`}</span>;
}

function LiveStatus({ store, fmt }: { store: StatusStore; fmt: Formatters }) {
  const { t } = useUi();
  const zoom = useSlice(store, s => Math.round(s.zoom));
  const x = useSlice(store, s => s.x), y = useSlice(store, s => s.y);
  const measurement = useSlice(store, s => s.measurement);
  const source = useSlice(store, s => s.source);
  return <>
    <div className="status-center mono" data-testid="status-coords"><span>{zoom}%</span><span className="status-separator">·</span><span>X {fmt.mm(x)} · Y {fmt.mm(y)} mm</span>
      {measurement != null && <><span className="status-separator">·</span><span className="status-measure" data-testid="status-measure">{t('workspace.measurement')} {fmt.mm(measurement)} mm</span></>}</div>
    {source && <span className="status-source" data-testid="status-source" title={source}>{source}</span>}
  </>;
}

function SaveBadge({ save, persistence, t }: { save: SaveState; persistence: 'native' | 'session-only'; t: Translator }) {
  const text = persistence === 'session-only' ? t('status.notSaved') : save.failure ? t('status.failed', { message: save.failure }) : save.saving ? t('status.saving') : save.dirty ? t('status.unsaved') : t('status.saved');
  const state = persistence === 'session-only' ? 'session' : save.failure ? 'failed' : save.saving ? 'saving' : save.dirty ? 'dirty' : 'saved';
  return <span className="status-save" data-state={state} data-testid="save-state" role={save.failure ? 'alert' : 'status'} title={text}>{save.failure && <AlertCircle size={12} />}<span>{text}</span></span>;
}

export interface StatusBarProps {
  store: StatusStore; fmt: Formatters; t: Translator;
  counts: { components: number; pins: number; nets: number };
  warnings: number; save: SaveState; persistence: 'native' | 'session-only'; breadcrumb: string;
  /** Notes not attached to any component of the board (0 hides the button). */
  unresolvedNotes: number;
  onInfo(): void; onHelp(): void; onUnresolvedNotes(): void;
}
export const StatusBar = memo(function StatusBar({ store, fmt, t, counts, warnings, save, persistence, breadcrumb, unresolvedNotes, onInfo, onHelp, onUnresolvedNotes }: StatusBarProps) {
  return <footer className="statusbar" aria-label={t('status.region')}>
    <div className="status-left"><span className="status-dot" /><span>{t('unit.components', { count: counts.components })}</span><span className="status-separator">·</span><span>{t('unit.pins', { count: counts.pins })}</span><span className="status-separator">·</span><span>{t('unit.nets', { count: counts.nets })}</span>
      {warnings > 0 && <button type="button" className="data-info" title={t('status.fileInfo')} aria-label={t('status.fileInfo')} onClick={onInfo}><AlertCircle size={13} /></button>}
      {unresolvedNotes > 0 && <button type="button" className="data-info note-info" title={`${t('notes.unresolvedTitle')}: ${unresolvedNotes}`} aria-label={`${t('notes.unresolvedTitle')}: ${unresolvedNotes}`} data-testid="unresolved-notes-button" onClick={onUnresolvedNotes}><StickyNote size={13} /><span className="mono">{unresolvedNotes}</span></button>}</div>
    <LiveStatus store={store} fmt={fmt} />
    <div className="status-right"><SaveBadge save={save} persistence={persistence} t={t} /><span className="selection-breadcrumb mono" title={breadcrumb}>{breadcrumb}</span><button type="button" aria-label={t('status.shortcuts')} onClick={onHelp}><Keyboard size={15} /></button></div>
  </footer>;
});
