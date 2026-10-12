import { CircuitBoard, FileImage, FileText, Paperclip, PackageOpen, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useContext, useState } from 'react';
import type { DocumentRuntime, DocumentStatus, WorkspaceApi } from '../../app/api';
import { createTranslator, type MessageKey, type Translator } from '../../lib/i18n';
import { Tool, usePdfSnapshot } from './ui';
import { UiContext } from './ui-context';
import './workspace.css';

const KIND_KEY: Readonly<Record<DocumentRuntime['record']['kind'], MessageKey>> = { pdf: 'documents.kindPdf', image: 'documents.kindImage', schematic: 'documents.kindSchematic' };
/** Catalog key of each status text: the chip draws the translated text. */
export const STATUS_KEY: Readonly<Record<DocumentStatus, MessageKey>> = { loading: 'documents.statusLoading', ready: 'documents.statusReady', missing: 'documents.statusMissing', changed: 'documents.statusChanged', unreadable: 'documents.statusUnreadable', error: 'documents.statusError' };

/** The workspace translator; a list rendered on its own (tests, previews) reads English. */
const englishT = createTranslator('en');
const useDocumentsT = (): Translator => useContext(UiContext)?.t ?? englishT;

const formatBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export function StatusChip({ status }: { status: DocumentStatus }) {
  const t = useDocumentsT();
  return <span className="wsp-status-chip" data-status={status} data-testid="status-chip">{t(STATUS_KEY[status])}</span>;
}

function KindIcon({ kind }: { kind: DocumentRuntime['record']['kind'] }) {
  return kind === 'pdf' ? <FileText size={16} /> : kind === 'image' ? <FileImage size={16} /> : <CircuitBoard size={16} />;
}

function Row({ api, doc, selected, onSelect }: { api: WorkspaceApi; doc: DocumentRuntime; selected: boolean; onSelect(id: string): void }) {
  const t = useDocumentsT();
  const { actions } = api;
  const { record } = doc;
  const [confirming, setConfirming] = useState(false);
  const snapshot = usePdfSnapshot(doc.pdf);
  const meta = [t(KIND_KEY[record.kind]), record.pageCount ? t('documents.pages', { count: record.pageCount }) : '', formatBytes(record.size)].filter(Boolean).join(' · ');
  const extra = doc.status === 'missing' || doc.status === 'changed' || confirming;
  return <li className={'wsp-doc' + (selected ? ' selected' : '')} data-status={doc.status} data-testid="document-row">
    <div className="wsp-doc-line">
      <button type="button" className="wsp-doc-main" aria-current={selected} onClick={() => onSelect(record.id)} title={record.path || record.name}>
        <span className="component-icon"><KindIcon kind={record.kind} /></span>
        <span className="component-row-text"><span className="wsp-doc-title" title={record.name}>{record.name}</span><span className="component-value">{meta}{snapshot?.searchable === false && <em className="wsp-chip warn"> {t('documents.scanOnly')}</em>}</span></span>
        <StatusChip status={doc.status} />
      </button>
      <button type="button" className="tool-button" aria-label={`${t('documents.remove')}: ${record.name}`} data-testid="remove-document" onClick={() => setConfirming(true)}><Trash2 size={14} /></button>
    </div>
    {extra && <span className="wsp-doc-actions">
      {doc.status === 'missing' && <button type="button" className="outline-button" data-testid="relink-row" onClick={() => void actions.relinkDocument(record.id)}>{t('documents.relink')}</button>}
      {doc.status === 'changed' && <button type="button" className="outline-button" data-testid="accept-row" onClick={() => void actions.acceptChangedDocument(record.id)}>{t('documents.accept')}</button>}
      {confirming && <><span className="wsp-confirm">{t('documents.confirmRemove')}</span><button type="button" className="text-button danger" data-testid="remove-confirm" onClick={() => { setConfirming(false); actions.removeDocument(record.id); }}>{t('documents.yes')}</button><button type="button" className="text-button" onClick={() => setConfirming(false)}>{t('documents.keep')}</button></>}
    </span>}
  </li>;
}

export interface DocumentListProps {
  api: WorkspaceApi;
  selectedId: string | null;
  onSelect(id: string): void;
  onAttach(): void;
  onExport(): void;
  /** 'aside' = full list for the Documents tab; 'strip' = one compact row for narrow panes. */
  layout: 'aside' | 'strip';
}

export function DocumentList({ api, selectedId, onSelect, onAttach, onExport, layout }: DocumentListProps) {
  const t = useDocumentsT();
  const { state } = api;
  const docs = state.documents;
  const notice = state.persistence === 'session-only' && <p className="wsp-persist" role="note" data-testid="session-only"><TriangleAlert size={13} />{t('documents.sessionOnly')}</p>;
  if (layout === 'strip') {
    // W-win-viewers-03: the controls sit OUTSIDE the chip list so they never scroll away, and the chips wrap instead of scrolling sideways.
    return <div className="wsp-docstrip" data-testid="document-strip" role="group" aria-label={t('documents.list')}>
      <div className="wsp-docstrip-actions">
        <Tool label={t('documents.attachDocuments')} testId="attach" onClick={onAttach}><Paperclip size={16} /></Tool>
        {docs.length > 0 && <Tool label={t('documents.export')} testId="export-open" onClick={onExport}><Upload size={16} /></Tool>}
      </div>
      <ul className="wsp-docstrip-chips">{docs.map(doc => <li key={doc.record.id}><button type="button" className={'wsp-docchip' + (doc.record.id === selectedId ? ' selected' : '')} aria-current={doc.record.id === selectedId} data-status={doc.status} onClick={() => onSelect(doc.record.id)} title={doc.record.name}>
        <KindIcon kind={doc.record.kind} /><span>{doc.record.name}</span><StatusChip status={doc.status} /></button></li>)}</ul>
    </div>;
  }
  return <aside className="wsp-doclist" aria-label={t('documents.title')} data-testid="document-list">
    <div className="pane-title"><span>{t('documents.title')}</span><span className="mono">{docs.length}</span></div>
    <div className="wsp-doclist-actions">
      <button type="button" className="primary-button" data-testid="attach" aria-label={t('documents.attachDocuments')} onClick={onAttach}><Paperclip size={15} />{t('documents.attach')}</button>
      <button type="button" className="outline-button" data-testid="export-open" disabled={!docs.length} onClick={onExport}><Upload size={14} />{t('documents.export')}</button>
    </div>
    {notice}
    {docs.length === 0 ? <div className="wsp-doc-empty"><PackageOpen size={30} /><h3>{t('documents.empty')}</h3><p>{t('documents.emptyHint')}</p></div>
      : <ul className="wsp-doc-items" aria-label={t('documents.list')}>{docs.map(doc => <Row key={doc.record.id} api={api} doc={doc} selected={doc.record.id === selectedId} onSelect={onSelect} />)}</ul>}
  </aside>;
}
