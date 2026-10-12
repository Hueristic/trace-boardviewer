import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { WorkspaceApi } from '../../app/api';
import { STATUS_KEY } from './DocumentList';
import { exportOutcomeKey } from './export-outcome';
import { Modal } from './ui';
import { useUi } from './ui-context';

export function ExportDialog({ api, onClose }: { api: WorkspaceApi; onClose(): void }) {
  const { t, fmt } = useUi();
  const { state, actions } = api;
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [board, setBoard] = useState(false);
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const docs = state.documents;
  const toggle = (id: string) => setIds(prev => { const next = new Set(prev); if (!next.delete(id)) next.add(id); return next; });
  const empty = ids.size === 0 && !board && !notes;
  const yesNo = (value: boolean) => t(value ? 'exportDialog.yes' : 'exportDialog.no');
  const run = async () => {
    if (busy || empty) return;
    setBusy(true); setResult(null);
    const outcome = await actions.exportWorkspace({ documentIds: docs.map(d => d.record.id).filter(id => ids.has(id)), includeBoard: board, includeNotes: notes });
    setBusy(false); setResult(typeof outcome === 'string' ? t(exportOutcomeKey(outcome)) : t('exportDialog.done', { count: outcome.files, megabytes: fmt.number(outcome.bytes / 1048576, 1), path: outcome.path }));
  };
  return <Modal title={t('exportDialog.title')} closeLabel={t('common.close')} wide testId="export-dialog" close={() => { if (!busy) onClose(); }}>
    <p className="settings-hint wsp-export-intro">{t('exportDialog.intro')}</p>
    {state.persistence === 'session-only' && <p className="wsp-persist" role="note"><TriangleAlert size={13} />{t('exportDialog.sessionOnly')}</p>}
    <fieldset className="wsp-export-set" disabled={busy}><legend>{t('exportDialog.documents')}</legend>
      {docs.length === 0 ? <p className="empty-caption">{t('exportDialog.none')}</p> : <>
        <div className="wsp-export-bulk"><button type="button" className="text-button" onClick={() => setIds(new Set(docs.map(d => d.record.id)))}>{t('exportDialog.selectAll')}</button><button type="button" className="text-button" onClick={() => setIds(new Set())}>{t('exportDialog.clearAll')}</button></div>
        {docs.map(doc => <label key={doc.record.id} className="wsp-export-row"><input type="checkbox" data-testid="export-doc" checked={ids.has(doc.record.id)} onChange={() => toggle(doc.record.id)} /><span className="wsp-doc-title">{doc.record.name}</span><span className="wsp-export-status" data-status={doc.status}>{t(STATUS_KEY[doc.status])}</span></label>)}
      </>}
    </fieldset>
    <fieldset className="wsp-export-set" disabled={busy}>
      <label className="wsp-export-row"><input type="checkbox" data-testid="export-board" checked={board} onChange={e => setBoard(e.target.checked)} /><span><strong>{t('exportDialog.board')}</strong><small>{t('exportDialog.boardHint')}</small></span></label>
      <label className="wsp-export-row"><input type="checkbox" data-testid="export-notes" checked={notes} onChange={e => setNotes(e.target.checked)} /><span><strong>{t('exportDialog.notes')}</strong><small>{t('exportDialog.notesHint')}</small></span></label>
    </fieldset>
    {result && <p className="wsp-export-result" role="status" data-testid="export-result">{result}</p>}
    <div className="modal-footer"><span className="muted" data-testid="export-summary">{empty ? t('exportDialog.nothing') : t('exportDialog.summary', { count: ids.size, board: yesNo(board), notes: yesNo(notes) })}</span>
      <button type="button" className="primary-button" data-testid="export-run" disabled={busy || empty} onClick={() => void run()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? t('exportDialog.exporting') : t('exportDialog.export')}</button></div>
  </Modal>;
}
