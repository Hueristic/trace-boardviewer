import { AlertTriangle, ArrowUpRight, Bookmark, CircuitBoard, FileText, Link2, Pencil, Plus, RotateCw, ScanLine, StickyNote, Trash2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { DocumentRuntime, WorkspaceApi } from '../../app/api';
import type { BoardNetTarget, BoardTarget, Mapping, MappingReason, PdfLinkHit, PdfRefLink, PinLinkRow, PinStatus, RefLinkRow, SchematicNetTarget, SchematicTarget } from '../../lib/crossprobe';
import type { BoardNote } from '../../lib/types';
import type { MessageKey, Translator } from '../../lib/i18n';
import { noteKeyIndex } from '../../lib/note-keys';
import { OCR_LINK_MIN_CONFIDENCE } from '../../lib/ocr/contract';
import { documentScanState } from './document-scan-state';
import type { NoteSubject, NoteTargetResult } from '../../lib/note-keys';
import { MEASUREMENT_FIELDS, noteOf } from './model';
import { FALLBACK_TEXT, REFUSAL_TEXT } from './note-text';
import { sideKey, usePdfSnapshot } from './ui';
import { useUi } from './ui-context';

export const Section = ({ title, count, icon, children, testId }: { title: string; count?: number | string; icon?: ReactNode; children: ReactNode; testId?: string }) =>
  <section className="wsp-section" data-testid={testId} aria-label={title}><div className="section-heading"><span className="wsp-section-title">{icon}{title}</span>{count !== undefined && <span className="muted mono">{count}</span>}</div>{children}</section>;

const MAPPING_REASON: Record<MappingReason, MessageKey> = {
  'several-schematic-placements': 'schematic.boardMapping.reason.severalSchematicPlacements', 'several-board-parts': 'schematic.boardMapping.reason.severalBoardParts',
  'alias-merged-parts': 'schematic.boardMapping.reason.aliasMergedParts', 'unannotated-schematic-reference': 'schematic.boardMapping.reason.unannotatedReference',
  'duplicate-annotation': 'schematic.boardMapping.reason.duplicateAnnotation', 'schematic-pin-nets-conflict': 'schematic.boardMapping.reason.schematicPinNetsConflict',
  'board-pin-nets-conflict': 'schematic.boardMapping.reason.boardPinNetsConflict', 'no-schematic-part': 'schematic.boardMapping.reason.noSchematicPart', 'no-board-component': 'schematic.boardMapping.reason.noBoardComponent',
  'pin-missing-on-schematic': 'schematic.boardMapping.reason.pinMissingOnSchematic', 'pin-missing-on-board': 'schematic.boardMapping.reason.pinMissingOnBoard', 'unknown-component': 'schematic.boardMapping.reason.unknownComponent',
  'unknown-pin': 'schematic.boardMapping.reason.unknownPin', 'unknown-symbol': 'schematic.boardMapping.reason.unknownSymbol', 'virtual-symbol': 'schematic.boardMapping.reason.virtualSymbol', 'unknown-net': 'schematic.boardMapping.reason.unknownNet',
  'several-schematic-nets': 'schematic.boardMapping.reason.severalSchematicNets', 'several-board-nets': 'schematic.boardMapping.reason.severalBoardNets', 'no-schematic-net': 'schematic.boardMapping.reason.noSchematicNet', 'no-board-net': 'schematic.boardMapping.reason.noBoardNet',
  'several-schematic-documents': 'inspector.reasonSeveralDocuments',
};
export const mappingReasons = (reasons: readonly MappingReason[], t: Translator) => reasons.map(reason => (MAPPING_REASON[reason] ? t(MAPPING_REASON[reason]) : reason)).join(' ');
const NET_SCOPE: Record<SchematicNetTarget['scope'], MessageKey> = { global: 'schematic.netSection.scopeGlobal', local: 'schematic.netSection.scopeLocal', hierarchical: 'schematic.netSection.scopeHierarchical' };
const PIN_STATUS: Record<PinStatus, MessageKey> = { match: 'inspector.statusMatch', 'net-differs': 'inspector.statusNetDiffers', 'pin-missing-on-board': 'inspector.statusPinMissingOnBoard', 'pin-missing-on-schematic': 'inspector.statusPinMissingInSchematic', ambiguous: 'inspector.statusAmbiguous', 'net-unknown': 'inspector.statusNetUnknown' };
const REF_STATUS: Record<RefLinkRow['status'], MessageKey> = { unique: 'inspector.statusLinked', ambiguous: 'inspector.statusAmbiguous', 'board-only': 'inspector.statusBoardOnly', 'schematic-only': 'inspector.statusSchematicOnly', alias: 'inspector.statusLinkedByAlias' };

const docName = (documents: readonly DocumentRuntime[], id: string) => documents.find(doc => doc.record.id === id)?.record.name ?? id;
const sheetText = (target: SchematicTarget, t: Translator) => target.sheets.map(sheet => `${sheet.label || sheet.name}${sheet.page ? ` (${t('inspector.sheetPage', { page: sheet.page })})` : ''}`).join(', ') || '—';

function TargetFacts({ target, documents, pinNumber }: { target: SchematicTarget; documents: readonly DocumentRuntime[]; pinNumber: string | null }) {
  const { t } = useUi();
  const pin = target.pin;
  return <dl className="wsp-facts">
    <div><dt>{t('inspector.sheet')}</dt><dd>{sheetText(target, t)}</dd></div>
    <div><dt>{t('inspector.part')}</dt><dd className="mono">{target.ref}{target.via !== 'exact' && <em className="wsp-chip">{target.via === 'alias' ? t('inspector.viaAlias') : t('inspector.viaCase')}</em>}</dd></div>
    {pinNumber !== null && <div><dt>{t('inspector.colPin')}</dt><dd className="mono">{pin ? `${pin.number}${pin.name ? ` · ${pin.name}` : ''}` : `${pinNumber} · ${t('inspector.none')}`}</dd></div>}
    {pin && <div><dt>{t('inspector.colNet')}</dt><dd className="mono wsp-net-value">{pin.netName ?? t('inspector.none')}{pin.netAuto && <em className="wsp-chip">{t('inspector.autoNamed')}</em>}{pin.noConnect && <em className="wsp-chip warn">{t('inspector.noConnect')}</em>}{pin.netConflict && <em className="wsp-chip warn">{t('inspector.netConflict')}</em>}</dd></div>}
    {documents.filter(doc => doc.record.kind === 'schematic').length > 1 && <div><dt>{t('inspector.documents')}</dt><dd>{docName(documents, target.documentId)}</dd></div>}
  </dl>;
}

export interface SchematicSectionProps {
  api: WorkspaceApi; componentId: string; pinNumber: string | null; pinId: string | null;
  onShow(target: SchematicTarget): void;
  /** Opens the link and alias panel (a missing or case-differing counterpart can only be resolved by an explicit alias). */
  onLink?(): void;
}
/** Board → schematic resolution of the selection: one target, an explicit candidate list, or an honest "missing"; never a guess. */
export function SchematicSection({ api, componentId, pinNumber, pinId, onShow, onLink }: SchematicSectionProps) {
  const { state, actions } = api;
  const { t } = useUi();
  const mapping: Mapping<SchematicTarget> | null = state.probe.schematicMapping;
  const hasSchematic = state.documents.some(doc => doc.record.kind === 'schematic' && doc.status === 'ready' && doc.design);
  const link = state.link;
  const refRow = useMemo(() => link?.refs.rows.find(row => row.boardComponentIds.includes(componentId)), [link, componentId]);
  const pinRows = useMemo(() => link?.pins.rows.filter(row => row.boardComponentId === componentId) ?? [], [link, componentId]);
  const thisPin: PinLinkRow | undefined = pinId ? pinRows.find(row => row.boardPinIds.includes(pinId)) : undefined;
  if (!hasSchematic) {
    return <Section title={t('inspector.schematic')} testId="inspector-schematic" icon={<CircuitBoard size={12} />}><p className="empty-caption">{t('inspector.noSchematic')}</p><button type="button" className="outline-button" onClick={() => actions.setActiveTab('documents')}>{t('inspector.attachDocuments')}</button></Section>;
  }
  return <Section title={t('inspector.schematic')} testId="inspector-schematic" icon={<CircuitBoard size={12} />}>
    {!mapping && <p className="empty-caption">{t('inspector.notResolved')}</p>}
    {mapping?.status === 'unique' && mapping.candidates[0] && <div className="wsp-card" data-mapping="unique">
      <p className="wsp-status ok"><Link2 size={13} />{t('inspector.linkedOnePart')}</p>
      <TargetFacts target={mapping.candidates[0]} documents={state.documents} pinNumber={pinNumber} />
      {(thisPin || refRow) && <p className="wsp-linkline">{t('inspector.linkStatus')}: {thisPin ? t(PIN_STATUS[thisPin.status]) : refRow ? t(REF_STATUS[refRow.status]) : ''}{refRow?.pins && !thisPin ? ` · ${t('inspector.pinsMatched', { count: refRow.pins.match })}` : ''}</p>}
      <button type="button" className="outline-button" data-testid="show-schematic" onClick={() => onShow(mapping.candidates[0])}><ArrowUpRight size={14} />{t('inspector.showInSchematic')}</button>
    </div>}
    {mapping?.status === 'ambiguous' && <div className="wsp-card" data-mapping="ambiguous">
      <p className="wsp-status warn"><AlertTriangle size={13} />{t('inspector.severalCandidates')}</p>
      {mapping.reasons.length > 0 && <p className="wsp-reason">{mappingReasons(mapping.reasons, t)}</p>}
      <ol className="wsp-candidates" aria-label={t('inspector.severalCandidates')}>{mapping.candidates.map((candidate, index) => <li key={index}>
        <button type="button" className="wsp-candidate" data-testid="schematic-candidate" onClick={() => actions.chooseSchematicTarget(index)}>
          <span className="mono">{candidate.ref}</span><span className="wsp-candidate-where">{sheetText(candidate, t)}{state.documents.length > 1 ? ` · ${docName(state.documents, candidate.documentId)}` : ''}</span>
          {candidate.pin && <span className="mono wsp-candidate-pin">{pinNumber ?? candidate.pin.number} → {candidate.pin.netName ?? t('inspector.none')}</span>}
          <span className="wsp-candidate-choose">{t('inspector.useCandidate')}</span>
        </button></li>)}</ol>
      {mapping.truncated && <p className="wsp-reason">{t('inspector.moreCandidates', { shown: mapping.candidates.length, total: mapping.total })}</p>}
    </div>}
    {mapping?.status === 'missing' && <div className="wsp-card" data-mapping="missing">
      <p className="wsp-status bad"><AlertTriangle size={13} />{t('inspector.noCounterpart')}</p>
      {mapping.reasons.length > 0 && <p className="wsp-reason">{mappingReasons(mapping.reasons, t)}</p>}
      {onLink && <button type="button" className="text-button" data-testid="open-link-panel-part" onClick={onLink}>{t('inspector.linkPanel')}</button>}
    </div>}
    {mapping && mapping.caseInsensitive.length > 0 && <p className="wsp-reason">{t('inspector.flagged')} <span className="mono">{mapping.caseInsensitive.map(c => c.ref).join(', ')}</span></p>}
    {pinRows.some(row => row.status !== 'match') && <div className="wsp-disagree" data-testid="link-disagreements">
      <div className="wsp-subheading">{t('inspector.boardSchematicDisagree')}</div>
      <ul>{pinRows.filter(row => row.status !== 'match').map(row => <li key={row.pinNumber + row.status} className={row === thisPin ? 'current' : ''}>
        <span className="mono">{row.pinNumber}</span>
        <span>{t(PIN_STATUS[row.status])}{row.status === 'net-differs' ? `: ${t('inspector.boardNet')} ${row.boardNet || t('inspector.none')}, ${t('inspector.schematicNet')} ${row.schematic?.netName ?? t('inspector.none')}` : ''}</span>
      </li>)}</ul>
      {link?.pins.truncated && <p className="wsp-reason">{t('inspector.linkTruncated')}</p>}
    </div>}
  </Section>;
}

function HitList({ hits, onOpen }: { hits: readonly PdfLinkHit[]; onOpen(hit: PdfLinkHit): void }) {
  const { t } = useUi();
  return <ul className="wsp-hits">{hits.map((hit, index) => <li key={`${hit.page}:${hit.itemIndex}:${index}`}>
    <button type="button" data-testid="document-hit" onClick={() => onOpen(hit)}><span className="mono">{t('inspector.page', { page: hit.page })}</span><span className="wsp-hit-context">{hit.context}</span><ArrowUpRight size={13} aria-label={t('inspector.goTo')} /></button></li>)}</ul>;
}

function DocumentHits({ doc, link, state, onOpen }: { doc: DocumentRuntime; link: PdfRefLink | null; state: WorkspaceApi['state']; onOpen(hit: PdfLinkHit): void }) {
  const snapshot = usePdfSnapshot(doc.pdf);
  const overlay = state.overlays[doc.record.id];
  const truncated = state.pdfLinks[doc.record.id]?.truncated || overlay?.state === 'truncated';
  const { t } = useUi();
  const scanState = documentScanState(snapshot?.searchable ?? null, snapshot?.ocr.words ?? 0);
  // A scan with recognized words is indexed: say so, with the confidence floor that decides which words may become links.
  const scanNote = scanState === 'scan-recognized' && snapshot
    ? <p className="wsp-reason"><ScanLine size={13} /> {t('pdf.ocr.summary', { pages: snapshot.ocr.recognizedPages, words: snapshot.ocr.words })} {t('pdf.ocr.linkRule', { floor: OCR_LINK_MIN_CONFIDENCE })}</p>
    : null;
  let body: ReactNode;
  if (scanState === 'scan-needs-recognition') body = <p className="wsp-reason"><ScanLine size={13} /> {t('pdf.ocr.documentOffer')}</p>;
  else if (!link) body = <p className="wsp-reason">{overlay?.state === 'working' ? t('inspector.indexing') : t('inspector.noMatch')}</p>;
  else if (link.status === 'unique') body = <HitList hits={link.hits.slice(0, 1)} onOpen={onOpen} />;
  else if (link.status === 'duplicate-hits') body = <><p className="wsp-status warn"><AlertTriangle size={13} />{t('inspector.occurrences', { count: link.hitsTotal })} {t('inspector.chooseHit')}</p><HitList hits={link.hits} onOpen={onOpen} /></>;
  else if (link.status === 'ambiguous-board-ref') body = <p className="wsp-status warn"><AlertTriangle size={13} />{t('inspector.severalParts')}</p>;
  else body = <><p className="wsp-reason">{t('inspector.noMatch')}</p>{link.caseInsensitiveHits.length > 0 && <><p className="wsp-reason">{t('inspector.caseOnly')}</p><HitList hits={link.caseInsensitiveHits} onOpen={onOpen} /></>}</>;
  return <div className="wsp-card wsp-doc-card" data-testid="document-hits-card"><div className="wsp-doc-name"><FileText size={13} /><span title={doc.record.name}>{doc.record.name}</span></div>{scanNote}{body}{truncated && <p className="wsp-reason">{t('inspector.scanTruncated')}</p>}</div>;
}

export function DocumentsSection({ api, refName, onOpen }: { api: WorkspaceApi; refName: string | null; onOpen(documentId: string, hit: PdfLinkHit): void }) {
  const { state } = api;
  const { t } = useUi();
  const pdfs = state.documents.filter(doc => doc.record.kind === 'pdf' && (doc.status === 'ready' || doc.pdf));
  return <Section title={t('inspector.documents')} testId="inspector-documents" icon={<FileText size={12} />}>
    {!pdfs.length ? <p className="empty-caption">{t('inspector.noPdf')}</p> : !refName ? <p className="empty-caption">{t('inspector.selectForPdf')}</p>
      : pdfs.map(doc => <DocumentHits key={doc.record.id} doc={doc} state={state} link={state.pdfLinks[doc.record.id]?.links.find(link => link.kind === 'ref' && link.name === refName) ?? null} onOpen={hit => onOpen(doc.record.id, hit)} />)}
  </Section>;
}

/** A note card. When the file does not name the part or pin uniquely the note is bound by position, and the card says so; when even position cannot tell it from another one, nothing can be added. */
function NoteCard({ note, label, target, onEdit }: { note: BoardNote | undefined; label: string; target: NoteTargetResult | null; onEdit(): void }) {
  const { t } = useUi();
  const measurements = note?.measurements;
  const names: Record<(typeof MEASUREMENT_FIELDS)[number], string> = { voltage: t('inspector.voltage'), resistance: t('inspector.resistance'), other: t('inspector.other') };
  const fallbacks = target?.ok ? target.fallbacks.map(fallback => <p key={fallback} className="wsp-fallback-note" data-testid="note-fallback">{t(FALLBACK_TEXT[fallback])}</p>) : null;
  const refusal = target && !target.ok ? REFUSAL_TEXT[target.reason] : undefined;
  if (!note) return <>{refusal ? <p className="wsp-status warn" role="note" data-testid="note-refused"><AlertTriangle size={13} />{t(refusal)}</p>
    : <button type="button" className="outline-button wsp-add-note" data-testid="add-note" onClick={onEdit}><Plus size={14} />{t('inspector.addNote', { what: label })}</button>}{fallbacks}</>;
  return <div className="wsp-note" data-testid="note-card">
    <div className="wsp-note-head"><StickyNote size={13} /><span>{t('inspector.noteFor', { what: label })}</span><button type="button" className="tool-button" aria-label={`${t('inspector.editNote')}: ${label}`} onClick={onEdit}><Pencil size={13} /></button></div>
    {note.text && <p className="wsp-note-text">{note.text}</p>}
    {measurements && <dl className="wsp-measures">{MEASUREMENT_FIELDS.filter(name => measurements[name]).map(name => <div key={name}><dt>{names[name]}</dt><dd className="mono">{measurements[name]}</dd></div>)}</dl>}
    <p className="wsp-note-foot">{t('inspector.technician')}</p>
    {fallbacks}
  </div>;
}

export function NotesSection({ api, componentRef, componentId, pinId, pinNumber, onEdit }: { api: WorkspaceApi; componentRef: string; componentId: string; pinId: string | null; pinNumber: string | null; onEdit(target: NoteSubject): void }) {
  const { state, actions } = api;
  const { t, text } = useUi();
  const board = state.board;
  const part = useMemo(() => board ? noteKeyIndex(board).target(componentId) : null, [board, componentId]);
  const pin = useMemo(() => board && pinId ? noteKeyIndex(board).target(componentId, pinId) : null, [board, componentId, pinId]);
  return <Section title={t('inspector.notes')} testId="inspector-notes" icon={<StickyNote size={12} />}>
    {state.notesBlocked && <div className="wsp-card" role="alert"><p className="wsp-status bad"><AlertTriangle size={13} />{t('inspector.notesLocked')}</p><p className="wsp-reason">{text(state.notesBlocked)}</p>
      <button type="button" className="outline-button" data-testid="retry-notes" onClick={() => void actions.retryNotes()}><RotateCw size={14} />{t('inspector.retryNotes')}</button></div>}
    <NoteCard note={noteOf(board, state.notes, componentId)} target={part} label={`${componentRef} (${t('inspector.componentWord')})`} onEdit={() => onEdit({ componentId })} />
    {pinId && pinNumber !== null && <NoteCard note={noteOf(board, state.notes, componentId, pinId)} target={pin} label={`${componentRef} ${t('inspector.pinRef', { number: pinNumber })}`} onEdit={() => onEdit({ componentId, pinId })} />}
  </Section>;
}

export function BookmarksSection({ api, documentId, onOpen }: { api: WorkspaceApi; documentId: string | null; onOpen(documentId: string, page: number): void }) {
  const { state, actions } = api;
  const { t } = useUi();
  const doc = documentId ? state.documents.find(candidate => candidate.record.id === documentId) : undefined;
  if (!doc) return null;
  const bookmarks = doc.record.bookmarks;
  return <Section title={t('inspector.bookmarks')} count={bookmarks.length} testId="inspector-bookmarks" icon={<Bookmark size={12} />}>
    <p className="wsp-doc-name"><FileText size={13} /><span title={doc.record.name}>{doc.record.name}</span></p>
    {bookmarks.length === 0 ? <p className="empty-caption">{t('inspector.noBookmarks')}</p> : <ul className="wsp-hits">{bookmarks.map(bookmark => <li key={bookmark.id} className="wsp-bookmark">
      <button type="button" data-testid="bookmark-go" onClick={() => onOpen(doc.record.id, bookmark.page)}><span className="mono">{t('inspector.page', { page: bookmark.page })}</span><span className="wsp-hit-context">{bookmark.label}</span></button>
      <button type="button" className="tool-button" aria-label={`${t('inspector.removeBookmark')}: ${bookmark.label}`} onClick={() => actions.setBookmarks(doc.record.id, bookmarks.filter(item => item.id !== bookmark.id))}><Trash2 size={13} /></button></li>)}</ul>}
  </Section>;
}

const viaChip = (via: 'exact' | 'alias' | 'case-insensitive', t: Translator) => via === 'alias' ? <em className="wsp-chip">{t('schematic.netSection.viaAlias')}</em> : via === 'case-insensitive' ? <em className="wsp-chip warn">{t('schematic.netSection.viaCase')}</em> : null;

/** Board net selection → schematic nets: one net, an explicit candidate list (scope and sheet identity per candidate) or an honest "missing"; never a silent pick. */
export function SchematicNetSection({ api, onShow, onLink }: { api: WorkspaceApi; onShow(documentId: string): void; onLink(): void }) {
  const { state, actions } = api;
  const { t } = useUi();
  const mapping: Mapping<SchematicNetTarget> | null = state.probe.schematicNetMapping;
  const manyDocs = state.documents.filter(doc => doc.record.kind === 'schematic').length > 1;
  if (!mapping || !state.documents.some(doc => doc.record.kind === 'schematic' && doc.status === 'ready' && doc.design)) return null;
  const sheetOf = (net: SchematicNetTarget) => {
    if (net.scopePath === undefined) return t('schematic.netSection.allSheets');
    const sheet = api.sheetsOf(net.documentId).find(item => item.path === net.scopePath);
    return sheet ? `${sheet.name || t('schematic.netSection.rootSheet')}${sheet.page ? ` (${t('schematic.netSection.sheetPage', { page: sheet.page })})` : ''}` : net.scopePath || t('schematic.netSection.rootSheet');
  };
  const facts = (net: SchematicNetTarget) => <>
    <span className="mono">{net.name}</span>
    <span className="wsp-candidate-where">{t(NET_SCOPE[net.scope])} · {sheetOf(net)} · {t('schematic.netSection.connections', { count: net.memberCount })}{manyDocs ? ` · ${docName(state.documents, net.documentId)}` : ''}</span>
    <span className="wsp-candidate-chips">{net.auto && <em className="wsp-chip">{t('schematic.netSection.autoNamed')}</em>}{viaChip(net.via, t)}</span></>;
  return <Section title={t('schematic.netSection.title')} testId="inspector-schematic-net" icon={<CircuitBoard size={12} />}>
    {mapping.status === 'unique' && mapping.candidates[0] && <div className="wsp-card" data-mapping="unique">
      <p className="wsp-status ok"><Link2 size={13} />{t('schematic.netSection.unique')}</p>
      <div className="wsp-net-facts" data-testid="schematic-net-unique">{facts(mapping.candidates[0])}</div>
      <button type="button" className="outline-button" data-testid="show-schematic-net" onClick={() => onShow(mapping.candidates[0].documentId)}><ArrowUpRight size={14} />{t('schematic.netSection.showNet')}</button>
    </div>}
    {mapping.status === 'ambiguous' && <div className="wsp-card" data-mapping="ambiguous">
      <p className="wsp-status warn"><AlertTriangle size={13} />{t('schematic.netSection.ambiguous')}</p>
      {mapping.reasons.some(reason => reason !== 'several-schematic-nets') && <p className="wsp-reason">{mappingReasons(mapping.reasons.filter(reason => reason !== 'several-schematic-nets'), t)}</p>}
      <ol className="wsp-candidates" aria-label={t('schematic.netSection.ambiguous')}>{mapping.candidates.map((candidate, index) => <li key={candidate.netKey + index}>
        <button type="button" className="wsp-candidate wsp-net-candidate" data-testid="schematic-net-candidate" onClick={() => actions.chooseSchematicNet(index)}>{facts(candidate)}<span className="wsp-candidate-choose">{t('schematic.netSection.useNet')}</span></button></li>)}</ol>
      {mapping.truncated && <p className="wsp-reason">{t('schematic.netSection.moreCandidates', { shown: mapping.candidates.length, total: mapping.total })}</p>}
    </div>}
    {mapping.status === 'missing' && <div className="wsp-card" data-mapping="missing">
      <p className="wsp-status bad"><AlertTriangle size={13} />{t('schematic.netSection.missing')}</p>
      {mapping.reasons.length > 0 && <p className="wsp-reason">{mappingReasons(mapping.reasons, t)}</p>}
      <p className="wsp-reason">{t('schematic.netSection.aliasHint')}</p>
      <button type="button" className="text-button" data-testid="open-link-panel-net" onClick={onLink}>{t('schematic.netSection.linkPanel')}</button>
    </div>}
    {mapping.caseInsensitive.length > 0 && <p className="wsp-reason" data-testid="schematic-net-flagged">{t('schematic.netSection.flagged')} <span className="mono">{mapping.caseInsensitive.map(c => c.name).join(', ')}</span></p>}
  </Section>;
}

/** Schematic net → board nets (Schematic tab): an ambiguous or missing counterpart needs the technician; nothing is chosen silently. */
export function BoardNetBanner({ mapping, onChoose, onLink }: { mapping: Mapping<BoardNetTarget> | null; onChoose(index: number): void; onLink?(): void }) {
  const { t } = useUi();
  if (!mapping || mapping.status === 'unique') return null;
  return <div className="wsp-banner" role="status" data-testid="board-net-mapping" data-mapping={mapping.status}>
    <AlertTriangle size={14} />
    <div><strong>{mapping.status === 'ambiguous' ? t('schematic.netSection.boardAmbiguous') : t('schematic.netSection.boardMissing')}</strong>
      {mapping.reasons.length > 0 && <span> {mappingReasons(mapping.reasons, t)}</span>}
      {mapping.status === 'ambiguous' && <span className="wsp-banner-choices">{mapping.candidates.map((candidate, index) => <button key={candidate.name + index} type="button" className="outline-button" data-testid="board-net-candidate" onClick={() => onChoose(index)}><span className="mono">{candidate.name}</span><span>{t('unit.pins', { count: candidate.pinCount })}</span>{viaChip(candidate.via, t)}</button>)}</span>}
      {mapping.status === 'missing' && mapping.caseInsensitive.length > 0 && <span data-testid="board-net-flagged"> {t('schematic.netSection.flagged')} <span className="mono">{mapping.caseInsensitive.map(c => c.name).join(', ')}</span></span>}
      {mapping.status === 'missing' && onLink && <span className="wsp-banner-choices"><button type="button" className="text-button" data-testid="open-link-panel-banner" onClick={onLink}>{t('schematic.netSection.linkPanel')}</button></span>}
    </div></div>;
}

/** Schematic → board resolution of the current schematic selection (shown in the Schematic tab); ambiguous asks for an explicit choice. */
export function BoardMappingBanner({ mapping, onChoose }: { mapping: Mapping<BoardTarget> | null; onChoose(index: number): void }) {
  const { t } = useUi();
  if (!mapping || mapping.status === 'unique') return null;
  return <div className="wsp-banner" role="status" data-testid="board-mapping" data-mapping={mapping.status}>
    <AlertTriangle size={14} />
    <div><strong>{mapping.status === 'ambiguous' ? t('inspector.boardMappingAmbiguous') : t('inspector.boardMappingMissing')}</strong>
      {mapping.reasons.length > 0 && <span> {mappingReasons(mapping.reasons, t)}</span>}
      {mapping.status === 'ambiguous' && <span className="wsp-banner-choices">{mapping.candidates.map((candidate, index) => <button key={index} type="button" className="outline-button" data-testid="board-candidate" onClick={() => onChoose(index)}><span className="mono">{candidate.ref}</span><span>{t(sideKey(candidate.side))}</span>{candidate.pin ? <span className="mono">{t('inspector.pinRef', { number: candidate.pin.number })}</span> : null}</button>)}</span>}
    </div></div>;
}
