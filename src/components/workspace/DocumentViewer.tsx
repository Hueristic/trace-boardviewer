import { AlertCircle, FileWarning, LoaderCircle, RefreshCcw, Trash2 } from 'lucide-react';
import { Suspense, lazy, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { DocumentRuntime, WorkspaceApi } from '../../app/api';
import { createTranslator, renderMessage, type Message, type Translator } from '../../lib/i18n';
import type { SchematicSelection, ViewerCamera } from '../viewer-contracts';
import type { ImageDraft } from '../ImageViewer';
import { UiContext } from './ui-context';
import './workspace.css';

/** The workspace translator; a viewer rendered on its own (tests, previews) reads English. */
const englishT = createTranslator('en');
const useDocumentT = (): Translator => useContext(UiContext)?.t ?? englishT;
const useDocumentText = (): ((message: Message) => string) => useContext(UiContext)?.text ?? ((message: Message) => renderMessage('en', message));
const PdfViewer = lazy(() => import('../PdfViewer').then(m => ({ default: m.PdfViewer })));
const ImageViewer = lazy(() => import('../ImageViewer').then(m => ({ default: m.ImageViewer })));
const SchematicViewer = lazy(() => import('../SchematicViewer'));

const EMPTY_SELECTION: SchematicSelection = Object.freeze({});
const sameCamera = (a: ViewerCamera, b: ViewerCamera) => a.page === b.page && a.zoom === b.zoom && a.rotation === b.rotation && a.x === b.x && a.y === b.y && a.fit === b.fit;

/**
 * Camera of one document: the viewer drives it locally at frame rate, the core persists it, and a camera the core moved
 * itself (a search hit, a bookmark) is adopted when `cameraOf` returns a different one.
 */
export function useDocumentCamera(api: WorkspaceApi, id: string): [ViewerCamera, (next: ViewerCamera) => void] {
  const core = api.actions.cameraOf(id);
  const [local, setLocal] = useState<ViewerCamera>(core);
  const seen = useRef(core);
  if (core !== seen.current) { seen.current = core; if (!sameCamera(core, local)) setLocal(core); }
  const actionsRef = useRef(api.actions); actionsRef.current = api.actions;
  const change = useCallback((next: ViewerCamera) => { setLocal(next); actionsRef.current.setCamera(id, next); }, [id]);
  return [local, change];
}

export function StateCard({ api, doc }: { api: WorkspaceApi; doc: DocumentRuntime }) {
  const t = useDocumentT();
  const renderText = useDocumentText();
  const { actions } = api;
  const { status } = doc;
  const id = doc.record.id;
  const busy = status === 'loading';
  const title = status === 'missing' ? t('documents.fileMissing') : status === 'changed' ? t('documents.fileChanged') : status === 'unreadable' ? t('documents.fileUnreadable') : status === 'error' ? t('documents.fileError') : t('documents.opening', { name: doc.record.name });
  const hint = doc.message !== undefined ? renderText(doc.message) : (status === 'missing' ? t('documents.missingHint') : status === 'changed' ? t('documents.changedHint') : '');
  return <div className="wsp-state" role={busy ? 'status' : 'alert'} data-status={status} data-testid="document-state">
    {busy ? <LoaderCircle size={28} className="spin wsp-state-icon" /> : status === 'missing' || status === 'changed' ? <FileWarning size={28} className="wsp-state-icon warn" /> : <AlertCircle size={28} className="wsp-state-icon bad" />}
    <h2>{title}</h2>
    {!busy && <p className="wsp-state-name mono" title={doc.record.path || doc.record.name}>{doc.record.name}</p>}
    {hint && <p>{hint}</p>}
    {!busy && <div className="wsp-state-actions">
      {status === 'changed' && <button type="button" className="primary-button" data-testid="accept-changed" onClick={() => void actions.acceptChangedDocument(id)}><RefreshCcw size={15} />{t('documents.acceptChangedFile')}</button>}
      <button type="button" className={status === 'changed' ? 'outline-button' : 'primary-button'} data-testid="relink" onClick={() => void actions.relinkDocument(id)}>{t('documents.relinkFile')}</button>
      <button type="button" className="text-button danger wsp-inline-danger" onClick={() => actions.removeDocument(id)}><Trash2 size={14} />{t('documents.removeFromWorkspace')}</button>
    </div>}
  </div>;
}

export interface ViewerChrome { theme: 'dark' | 'light'; motion: boolean; compact: boolean }

function SchematicDocument({ api, doc, chrome }: { api: WorkspaceApi; doc: DocumentRuntime; chrome: ViewerChrome }) {
  const t = useDocumentT();
  const { state, actions } = api;
  const id = doc.record.id;
  const [camera, setCamera] = useDocumentCamera(api, id);
  const actionsRef = useRef(actions); actionsRef.current = actions;
  const sheets = api.sheetsOf(id);
  const probe = state.probe.schematic?.documentId === id ? state.probe.schematic : null;
  const instancePath = probe && sheets.some(sheet => sheet.path === probe.instancePath) ? probe.instancePath : sheets[0]?.path ?? '';
  const onInstanceChange = useCallback((path: string) => actionsRef.current.setSchematicInstance(id, path), [id]);
  const onSelectSymbol = useCallback((target: { instancePath: string; symbolId: string; ref: string }) => actionsRef.current.selectSchematicSymbol({ documentId: id, ...target }), [id]);
  const onSelectPin = useCallback((target: { instancePath: string; symbolId: string; pinId: string; ref: string; pinNumber: string }) => actionsRef.current.selectSchematicPin({ documentId: id, ...target }), [id]);
  const onSelectNet = useCallback((netId: string | null) => actionsRef.current.selectSchematicNet(id, netId), [id]);
  if (doc.designState === 'error' || !doc.design) {
    if (doc.designState === 'parsing' || !doc.designState) return <div className="wsp-state" role="status"><LoaderCircle size={28} className="spin wsp-state-icon" /><h2>{t('documents.parsing', { name: doc.record.name })}</h2></div>;
    return <div className="wsp-state" role="alert"><AlertCircle size={28} className="wsp-state-icon bad" /><h2>{t('documents.schematicFailed')}</h2><p>{doc.designError?.message}</p>{doc.designError && <p className="mono wsp-state-name">{doc.designError.code}</p>}
      <button type="button" className="text-button danger wsp-inline-danger" onClick={() => actions.removeDocument(id)}><Trash2 size={14} />{t('documents.removeFromWorkspace')}</button></div>;
  }
  return <SchematicViewer design={doc.design} instancePath={instancePath} onInstanceChange={onInstanceChange} selection={probe?.selection ?? EMPTY_SELECTION} onSelectSymbol={onSelectSymbol} onSelectPin={onSelectPin} onSelectNet={onSelectNet}
    camera={camera} onCameraChange={setCamera} theme={chrome.theme} motion={chrome.motion} compact={chrome.compact} />;
}

function PdfDocument({ api, doc, chrome, focusNonce }: { api: WorkspaceApi; doc: DocumentRuntime; chrome: ViewerChrome; focusNonce: number }) {
  const { state, actions } = api;
  const id = doc.record.id;
  const [camera, setCamera] = useDocumentCamera(api, id);
  const actionsRef = useRef(actions); actionsRef.current = actions;
  // The unified search drives the viewer's own search box (one direction: typing inside the viewer never re-runs the global search).
  const [query, setQuery] = useState(state.search.query);
  useEffect(() => { setQuery(state.search.query); }, [state.search.query]);
  const overlay = state.overlays[id];
  const onBookmarks = useCallback((next: DocumentRuntime['record']['bookmarks']) => actionsRef.current.setBookmarks(id, next), [id]);
  const onAnnotations = useCallback((next: DocumentRuntime['record']['annotations']) => actionsRef.current.setAnnotations(id, next), [id]);
  const onProbe = useCallback((regionId: string) => actionsRef.current.activateProbeRegion(id, regionId), [id]);
  const language = useContext(UiContext)?.language;
  if (!doc.pdf) return <StateCard api={api} doc={{ ...doc, status: 'error' }} />;
  return <PdfViewer session={doc.pdf} camera={camera} onCameraChange={setCamera} theme={chrome.theme} motion={chrome.motion} compact={chrome.compact}
    bookmarks={doc.record.bookmarks} annotations={doc.record.annotations} onBookmarksChange={onBookmarks} onAnnotationsChange={onAnnotations}
    highlights={overlay?.highlights} probeRegions={overlay?.probeRegions} onProbeRegionClick={onProbe} searchQuery={query} onSearchQueryChange={setQuery} focusSearchNonce={focusNonce} navigateNonce={state.probe.nonce} language={language} />;
}

/**
 * Unsaved note text of image documents, by document id. It is kept in memory only: a document or tab switch remounts the viewer, and the
 * draft is handed back when the document is shown again. Nothing is written to disk, and a reload of the window clears it.
 */
const imageDrafts = new Map<string, ImageDraft>();
/** Keeps the draft of one document, or forgets it when the viewer reports that nothing is unsaved. */
export function rememberImageDraft(store: Map<string, ImageDraft>, id: string, draft: ImageDraft | null): void {
  if (draft) store.set(id, draft);
  else store.delete(id);
}
/** Forgets the drafts of documents that are no longer in the workspace, so a removed document leaves no text behind. */
export function pruneImageDrafts(store: Map<string, ImageDraft>, documents: readonly { record: { id: string } }[]): void {
  const live = new Set(documents.map(doc => doc.record.id));
  for (const id of [...store.keys()]) if (!live.has(id)) store.delete(id);
}
/** Called by the always-mounted shell with the current document list. */
export function forgetRemovedImageDrafts(documents: readonly { record: { id: string } }[]): void {
  pruneImageDrafts(imageDrafts, documents);
}

function ImageDocument({ api, doc, chrome }: { api: WorkspaceApi; doc: DocumentRuntime; chrome: ViewerChrome }) {
  const id = doc.record.id;
  const [camera, setCamera] = useDocumentCamera(api, id);
  const actionsRef = useRef(api.actions); actionsRef.current = api.actions;
  const onCalibration = useCallback((next: DocumentRuntime['record']['calibration']) => actionsRef.current.setCalibration(id, next), [id]);
  const onBookmarks = useCallback((next: DocumentRuntime['record']['bookmarks']) => actionsRef.current.setBookmarks(id, next), [id]);
  const onAnnotations = useCallback((next: DocumentRuntime['record']['annotations']) => actionsRef.current.setAnnotations(id, next), [id]);
  if (!doc.bytes) return <StateCard api={api} doc={{ ...doc, status: 'error' }} />;
  return <ImageViewer name={doc.record.name} data={doc.bytes} calibration={doc.record.calibration} onCalibrationChange={onCalibration} bookmarks={doc.record.bookmarks} annotations={doc.record.annotations}
    onBookmarksChange={onBookmarks} onAnnotationsChange={onAnnotations} camera={camera} onCameraChange={setCamera} theme={chrome.theme} motion={chrome.motion} compact={chrome.compact}
    draft={imageDrafts.get(id) ?? null} onDraftChange={next => rememberImageDraft(imageDrafts, id, next)} />;
}

/** The viewer (or the explicit state card) of one document; relink / accept-changed live on the card, never as silent actions. */
export function DocumentViewer({ api, doc, chrome, focusNonce }: { api: WorkspaceApi; doc: DocumentRuntime; chrome: ViewerChrome; focusNonce: number }) {
  const t = useDocumentT();
  // A PDF follows its session (I06 / W-win-viewers-04): `loading` while pdf.js opens it and `error` once it rejected the file. The PDF viewer owns the
  // panels of those two states (opening spinner, "could not be opened" with its code), so the document stays in it instead of switching to the card.
  const ownsState = doc.record.kind === 'pdf' && doc.pdf !== undefined && (doc.status === 'loading' || doc.status === 'error');
  if (doc.status !== 'ready' && !ownsState) return <StateCard api={api} doc={doc} />;
  const body = doc.record.kind === 'pdf' ? <PdfDocument api={api} doc={doc} chrome={chrome} focusNonce={focusNonce} />
    : doc.record.kind === 'image' ? <ImageDocument api={api} doc={doc} chrome={chrome} /> : <SchematicDocument api={api} doc={doc} chrome={chrome} />;
  return <div className="wsp-viewer" data-kind={doc.record.kind} data-testid="document-viewer"><Suspense fallback={<div className="wsp-state" role="status"><LoaderCircle size={24} className="spin wsp-state-icon" /><h2>{t('documents.loadingViewer')}</h2></div>}>{body}</Suspense></div>;
}
