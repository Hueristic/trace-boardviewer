/**
 * The device database view ("Adatbázis"): root folders, the folder hierarchy, the motherboard list with board, schematic and BIOS
 * candidate status, the reasons and files of one motherboard, a manual correction form, and the scan controls with progress.
 *
 * The view talks only to a DeviceDatabasePort (src/lib/library/devices/ui-port.ts). All decisions and texts come from the pure
 * view-model in src/lib/library/devices/ui-model.ts. The presentational DevicesPanel takes plain state so that its markup can be
 * tested without effects; DevicesView owns the state, the port calls and the response ordering.
 *
 * It is opened from the top bar (the Shell's device dialog). Without a port (no window bridge) it shows the unavailable note only.
 * Optional port members (folder map, board list, board detail) are skipped while they are absent, and optional controls are shown
 * only when the port's capabilities allow them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { RejectReason } from '../../lib/library/devices/corrections';
import { needsClassification, rejectionEntries, rejectionLines } from '../../lib/library/devices/ui-model';
import type { Translator } from '../../lib/i18n';
import { ALL_STEPS, type StepName, type StepSwitches } from '../../lib/library/devices/catalogue';
import type { FileRole } from '../../lib/library/devices/identity';
import type { DevicePlatform } from '../../lib/library/devices/paths';
import {
  BASIS_KEY, CONFIDENCE_KEY, COVERAGE_KEY, OP_KEY, ROLE_KEY, SLOT_REASON_KEY, STEP_KEY, boardStatus, buildCorrection, buildTreeRows, confidenceOf,
  needsFile, normalizeSteps, nextScanPhase, pendingFolderLoads, progressView, reasonLines, slotView, sortBoardFiles, treeKeyAction,
  type CorrectionDraft, type CorrectionOp, type DeviceKey, type ReasonLine, type ScanEvent, type ScanPhase, type SlotView, type TreeKey, type TreeRow,
} from '../../lib/library/devices/ui-model';
import { DEFAULT_PAGE, type BoardDetail, type BoardFile, type BoardRow, type BoardStatusFilter, type DeviceCapabilities, type DeviceDatabasePort,
  type FolderSummary, type RootSummary, type ScanProgressView, type ScanResultView } from '../../lib/library/devices/ui-port';
import './devices-view.css';

const STEP_ORDER: readonly StepName[] = ['folderMap', 'nameIdentity', 'biosCandidates', 'matching', 'corrections'];
/** The step that must be on for this one to run (the catalogue runs a step only when its prerequisite ran). */
const NEEDS: Partial<Record<StepName, { step: StepName; key: DeviceKey }>> = {
  nameIdentity: { step: 'folderMap', key: 'libraryDevices.scan.stepNeedsFolders' },
  biosCandidates: { step: 'nameIdentity', key: 'libraryDevices.scan.stepNeedsNames' },
  matching: { step: 'nameIdentity', key: 'libraryDevices.scan.stepNeedsNames' },
};
const FILTERS: readonly BoardStatusFilter[] = ['all', 'found', 'notFound', 'unknown'];
const FILTER_KEY: Record<BoardStatusFilter, DeviceKey> = {
  all: 'libraryDevices.boards.filter.all',
  found: 'libraryDevices.boards.filter.found',
  notFound: 'libraryDevices.boards.filter.notFound',
  unknown: 'libraryDevices.boards.filter.unknown',
};
const CORRECTION_OPS: readonly CorrectionOp[] = ['link', 'unlink', 'role', 'aliasAdd', 'aliasRemove', 'boardCode', 'revision'];
const ROLES: readonly FileRole[] = ['boardview', 'schematic', 'board-pdf', 'document', 'bios-candidate', 'ec-firmware', 'me-firmware', 'saved-dump', 'other'];
const TREE_KEYS: readonly TreeKey[] = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' '];
const EMPTY_DRAFT: CorrectionDraft = { op: 'link', file: undefined, value: '', role: '' };
const PHASE_IDLE: DeviceKey = 'libraryDevices.scan.idle';
const unavailableSkip: Feedback = { tone: 'warn', key: 'libraryDevices.scan.skipUnavailable' };
const unknownFileFeedback: Feedback = { tone: 'warn', key: 'libraryDevices.correction.unknownFile' };
const invalidRequestFeedback: Feedback = { tone: 'error', key: 'libraryDevices.correction.invalidRequest' };
/** The error code of a rejected port call (the adapter's codes), or undefined. */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
}

export interface Feedback { tone: 'ok' | 'error' | 'warn'; key: DeviceKey; params?: Record<string, string | number> }

export interface DevicesViewState {
  /** False when the port is not provided: the view then shows only the unavailable note. */
  available: boolean;
  platform: DevicePlatform;
  roots: readonly RootSummary[];
  rows: readonly TreeRow[];
  /** Folder notes: not read entries and whether the map of that folder is complete. */
  folderNotes: ReadonlyMap<string, { notRead: number; complete: boolean }>;
  focusKey: string | null;
  text: string;
  status: BoardStatusFilter;
  boards: readonly BoardRow[];
  boardTotal: number;
  hasMore: boolean;
  selectedAnchor: string | null;
  detail: BoardDetail | null;
  phase: ScanPhase;
  progress: ScanProgressView | null;
  steps: StepSwitches;
  feedback: Feedback | null;
  draft: CorrectionDraft;
  busy: boolean;
  /** Closed reasons why stored corrections were left out (one line each). */
  rejections?: readonly RejectReason[];
  /** Folder ids the next scan leaves out. */
  skippedFolders?: ReadonlySet<string>;
  /** What the port can do. Absent means every optional control is offered, as before the capabilities existed. */
  capabilities?: DeviceCapabilities;
}

export interface DevicesViewHandlers {
  addRoot(): void;
  removeRoot(rootId: string): void;
  toggleFolderSkip?(folderId: string): void;
  toggleRow(key: string, expand: boolean): void;
  treeKey(key: TreeKey, index: number): void;
  focusRow(key: string): void;
  setText(text: string): void;
  setStatus(status: BoardStatusFilter): void;
  selectBoard(anchorId: string): void;
  loadMore(): void;
  setStep(step: StepName, on: boolean): void;
  startScan(): void;
  pauseScan(): void;
  resumeScan(): void;
  cancelScan(): void;
  skipStep(step: StepName): void;
  setDraft(patch: Partial<CorrectionDraft>): void;
  saveCorrection(): void;
  undoCorrection(): void;
  /** Confirms the file's current type as a correction (for a file that needs a manual classification). */
  confirmRole?(file: BoardFile): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Presentation

function SlotCell({ t, slot, kind }: { t: Translator; slot: SlotView; kind: 'boardview' | 'schematic' | 'bios' }) {
  if (slot.kind === 'found') {
    return (
      <span className={`devices-slot devices-slot-found devices-slot-${kind}`}>
        <span>{t('libraryDevices.slot.found', { count: slot.count })}</span>
        <span className={`devices-confidence devices-confidence-${slot.confidence}`}>{t(CONFIDENCE_KEY[slot.confidence])}</span>
      </span>
    );
  }
  if (slot.kind === 'present') {
    return (
      <span className={`devices-slot devices-slot-found devices-slot-${kind}`}>
        <span>{t(slot.presence === 'confirmed' ? 'libraryDevices.slot.presentConfirmed' : 'libraryDevices.slot.presentCandidate')}</span>
      </span>
    );
  }
  if (slot.kind === 'not-found') {
    return <span className={`devices-slot devices-slot-missing devices-slot-${kind}`} title={t('libraryDevices.slot.notFoundNote')}>{t('libraryDevices.slot.notFound')}</span>;
  }
  return (
    <span className={`devices-slot devices-slot-unknown devices-slot-${kind}`}>
      <span>{t('libraryDevices.slot.unknown')}</span>
      <span className="devices-slot-reason">{t(SLOT_REASON_KEY[slot.reason])}</span>
      {slot.knownOffline > 0 ? <span className="devices-slot-reason">{t('libraryDevices.slot.knownOffline', { count: slot.knownOffline })}</span> : null}
    </span>
  );
}

function ReasonList({ t, lines }: { t: Translator; lines: readonly ReasonLine[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="devices-reasons">
      {lines.map((line, index) => (
        <li key={index}>
          {line.itemKeys.length > 0
            ? t(line.key, { items: line.itemKeys.map(item => t(item)).join(', ') })
            : t(line.key, line.params)}
        </li>
      ))}
    </ul>
  );
}

function FileItem({ t, file, rootLabel, onConfirm }: { t: Translator; file: BoardFile; rootLabel: string; onConfirm?: () => void }) {
  const association = file.association;
  return (
    <li className="devices-file">
      <div className="devices-file-head">
        <span className="devices-file-role">{t(ROLE_KEY[file.role])}</span>
        {file.path === '' && file.name === undefined ? null : <span className="devices-file-path">{file.path === '' ? file.name : file.path}</span>}
      </div>
      <div className="devices-file-meta">
        <span>{rootLabel}</span>
        {file.online === true ? <span className="devices-file-online">{t('libraryDevices.file.onlineOnly')}</span> : null}
        {association === undefined && file.confidence !== undefined ? <span className={`devices-confidence devices-confidence-${file.confidence}`}>{t(CONFIDENCE_KEY[file.confidence])}</span> : null}
        {association === undefined ? null : (
          <>
            <span className={`devices-confidence devices-confidence-${confidenceOf(association.state)}`}>{t(CONFIDENCE_KEY[confidenceOf(association.state)])}</span>
            <span>{t(BASIS_KEY[association.basis])}</span>
          </>
        )}
      </div>
      {association === undefined ? null : <ReasonList t={t} lines={reasonLines(association)} />}
      {file.role === 'bios-candidate' ? <p className="devices-note">{t('libraryDevices.bios.notProven')}</p> : null}
      {needsClassification(file.role) ? (
        <div className="devices-classify">
          <p className="devices-note">{t('libraryDevices.role.needsClassification')}</p>
          {onConfirm === undefined ? null : <button type="button" className="outline-button" onClick={onConfirm}>{t('libraryDevices.correction.confirmRole')}</button>}
        </div>
      ) : null}
    </li>
  );
}

function BoardLine({ t, row, selected, onSelect }: { t: Translator; row: BoardRow; selected: boolean; onSelect(anchorId: string): void }) {
  const views = { boardview: slotView(row.boardview), schematic: slotView(row.schematic), bios: slotView(row.bios) };
  const status = boardStatus(row);
  return (
    <tr className={selected ? 'devices-board devices-board-selected' : 'devices-board'} data-status={status}>
      <td>
        <button type="button" className="devices-board-select" aria-pressed={selected} onClick={() => onSelect(row.anchorId)}>
          <span className="devices-board-code">{row.boardCode ?? t('libraryDevices.detail.none')}</span>
          {row.revision === undefined ? null : <span className="devices-board-rev">{row.revision}</span>}
        </button>
        {row.models.length > 0 ? <span className="devices-board-models">{row.models.join(', ')}</span> : null}
      </td>
      <td><SlotCell t={t} slot={views.boardview} kind="boardview" /></td>
      <td><SlotCell t={t} slot={views.schematic} kind="schematic" /></td>
      <td><SlotCell t={t} slot={views.bios} kind="bios" /></td>
    </tr>
  );
}

function CorrectionForm({ t, state, handlers, files }: { t: Translator; state: DevicesViewState; handlers: DevicesViewHandlers; files: readonly BoardFile[] }) {
  const { draft } = state;
  const chosen = draft.file === undefined ? -1 : files.findIndex(file => file.fileId !== undefined && file.fileId === draft.file);
  const valueField = draft.op === 'aliasAdd' || draft.op === 'aliasRemove' || draft.op === 'boardCode' || draft.op === 'revision';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    handlers.saveCorrection();
  };
  return (
    <form className="devices-correction" onSubmit={submit} data-testid="devices-correction">
      <h4>{t('libraryDevices.correction.heading')}</h4>
      <p className="devices-note">{t('libraryDevices.correction.hint')}</p>
      <label className="devices-field">
        <span>{t('libraryDevices.correction.action')}</span>
        <select value={draft.op} disabled={state.busy} onChange={event => handlers.setDraft({ op: event.target.value as CorrectionOp })}>
          {CORRECTION_OPS.map(op => <option key={op} value={op}>{t(OP_KEY[op])}</option>)}
        </select>
      </label>
      {needsFile(draft.op) ? (
        <label className="devices-field">
          <span>{t('libraryDevices.correction.file')}</span>
          <select
            value={chosen >= 0 ? String(chosen) : ''}
            disabled={state.busy}
            onChange={event => {
              const picked = event.target.value === '' ? undefined : files[Number(event.target.value)];
              handlers.setDraft({ file: picked?.fileId });
            }}
          >
            <option value="">{t('libraryDevices.correction.chooseFile')}</option>
            {files.map((file, index) => <option key={index} value={String(index)}>{file.name ?? file.path}</option>)}
          </select>
        </label>
      ) : null}
      {draft.op === 'role' ? (
        <label className="devices-field">
          <span>{t('libraryDevices.correction.value')}</span>
          <select value={draft.role} disabled={state.busy} onChange={event => handlers.setDraft({ role: event.target.value as FileRole | '' })}>
            <option value="">{t('libraryDevices.correction.automatic')}</option>
            {ROLES.map(role => <option key={role} value={role}>{t(ROLE_KEY[role])}</option>)}
          </select>
        </label>
      ) : null}
      {valueField ? (
        <label className="devices-field">
          <span>{t('libraryDevices.correction.value')}</span>
          <input type="text" value={draft.value} disabled={state.busy} onChange={event => handlers.setDraft({ value: event.target.value })} />
        </label>
      ) : null}
      <div className="devices-actions">
        <button type="submit" className="primary-button" disabled={state.busy || state.selectedAnchor === null}>{t('libraryDevices.correction.save')}</button>
        <button type="button" className="outline-button" disabled={state.busy} onClick={handlers.undoCorrection}>{t('libraryDevices.correction.undo')}</button>
      </div>
    </form>
  );
}

function DetailPane({ t, state, handlers, rootLabel }: { t: Translator; state: DevicesViewState; handlers: DevicesViewHandlers; rootLabel(rootId: string): string }) {
  const detail = state.detail;
  if (state.selectedAnchor === null || detail === null) {
    return <div className="devices-detail-empty"><p>{t('libraryDevices.detail.empty')}</p></div>;
  }
  const row = detail.row;
  const files = sortBoardFiles(detail.files);
  return (
    <div className="devices-detail-body">
      <h3>{t('libraryDevices.detail.heading')} {row.boardCode ?? t('libraryDevices.detail.none')}</h3>
      <dl className="devices-facts">
        <dt>{t('libraryDevices.detail.boardCode')}</dt>
        <dd>{row.boardCode ?? t('libraryDevices.detail.none')}</dd>
        <dt>{t('libraryDevices.detail.revision')}</dt>
        <dd>{row.revision ?? t('libraryDevices.detail.none')}</dd>
        <dt>{t('libraryDevices.detail.names')}</dt>
        <dd>{row.names.length > 0 ? row.names.join(', ') : t('libraryDevices.detail.none')}</dd>
        <dt>{t('libraryDevices.detail.models')}</dt>
        <dd>{row.models.length > 0 ? row.models.join(', ') : t('libraryDevices.detail.none')}</dd>
      </dl>
      <h4>{t('libraryDevices.detail.reasons')}</h4>
      <p className="devices-slot-summary">
        <SlotCell t={t} slot={slotView(row.boardview)} kind="boardview" />
        <SlotCell t={t} slot={slotView(row.schematic)} kind="schematic" />
        <SlotCell t={t} slot={slotView(row.bios)} kind="bios" />
      </p>
      <h4>{t('libraryDevices.detail.files')}</h4>
      {files.length === 0 ? <p className="devices-note">{t('libraryDevices.detail.noFiles')}</p> : (
        <ul className="devices-files">
          {files.map((file, index) => <FileItem key={`${file.rootId}\u0001${file.path}\u0001${index}`} t={t} file={file} rootLabel={rootLabel(file.rootId)} onConfirm={handlers.confirmRole === undefined ? undefined : () => handlers.confirmRole?.(file)} />)}
        </ul>
      )}
      {detail.filesTruncated ? <p className="devices-note">{t('libraryDevices.detail.truncated', { count: files.length })}</p> : null}
      <CorrectionForm t={t} state={state} handlers={handlers} files={files} />
    </div>
  );
}

/** Counts of a finished scan. The file count is in the progress line above; no path is ever shown. */
function ScanResult({ t, result }: { t: Translator; result: ScanResultView }) {
  return (
    <section className="devices-result" aria-labelledby="devices-result-heading">
      <h4 id="devices-result-heading">{t('libraryDevices.result.heading')}</h4>
      {result.complete === false ? <p className="devices-note">{t('libraryDevices.result.incomplete')}</p> : null}
      {result.correctionsStatus === 'quarantined' ? <p className="devices-note" role="status">{t('libraryDevices.result.quarantined')}</p> : null}
      <ul className="devices-result-list">
        <li>{t('libraryDevices.result.associations', { count: result.associationCount })}</li>
        <li>{result.missingTargetCount === undefined ? t('libraryDevices.result.missingTargetsUnknown') : t('libraryDevices.result.missingTargets', { count: result.missingTargetCount })}</li>
        <li>{t('libraryDevices.result.excludedFirmware', { count: result.excludedFirmwareCount })}</li>
        <li>{t('libraryDevices.result.collisions', { count: result.collisionCount })}</li>
        <li>{t('libraryDevices.result.needsManual', { count: result.needsManualCount })}</li>
        <li>{t('libraryDevices.tree.notRead', { count: result.notRead })}</li>
      </ul>
    </section>
  );
}

function ScanControls({ t, state, handlers }: { t: Translator; state: DevicesViewState; handlers: DevicesViewHandlers }) {
  const { phase, progress, busy } = state;
  const canStart = (nextScanPhase(phase, 'start') !== undefined) && state.roots.length > 0 && !busy;
  const canPause = nextScanPhase(phase, 'pause') !== undefined && !busy;
  const canResume = nextScanPhase(phase, 'resume') !== undefined && !busy;
  const canCancel = nextScanPhase(phase, 'cancel') !== undefined && !busy;
  const view = progress === null ? null : progressView(progress);
  // A step is blocked when a step it needs does not run, including one that is itself blocked (the catalogue runs no step after a missing one).
  const effective = normalizeSteps(state.steps).steps;
  return (
    <section className="devices-scan" aria-labelledby="devices-scan-heading">
      <h3 id="devices-scan-heading">{t('libraryDevices.scan.heading')}</h3>
      <fieldset className="devices-steps">
        <legend className="devices-note">{t('libraryDevices.scan.stepsHint')}</legend>
        {STEP_ORDER.map(step => {
          const needs = NEEDS[step];
          const blocked = needs !== undefined && !effective[needs.step];
          return (
            <label key={step} className={blocked ? 'devices-step devices-step-blocked' : 'devices-step'}>
              <input type="checkbox" checked={state.steps[step]} disabled={busy || phase === 'running'} onChange={event => handlers.setStep(step, event.target.checked)} />
              <span>{t(STEP_KEY[step])}</span>
              <span className="devices-badge">{t('libraryDevices.step.optional')}</span>
              {blocked && needs !== undefined ? <span className="devices-note">{t(needs.key)}</span> : null}
            </label>
          );
        })}
      </fieldset>
      <div className="devices-actions">
        <button type="button" className="primary-button" disabled={!canStart} onClick={handlers.startScan}>{t('libraryDevices.scan.start')}</button>
        {!offers(state.capabilities, 'pauseScan') ? null : phase === 'paused' ? (
          <button type="button" className="outline-button" disabled={!canResume} onClick={handlers.resumeScan}>{t('libraryDevices.scan.resume')}</button>
        ) : (
          <button type="button" className="outline-button" disabled={!canPause} onClick={handlers.pauseScan}>{t('libraryDevices.scan.pause')}</button>
        )}
        <button type="button" className="outline-button" disabled={!canCancel} onClick={handlers.cancelScan}>{t('libraryDevices.scan.cancel')}</button>
        {phase !== 'running' || busy || !offers(state.capabilities, 'skipStep') ? null : (
          // While a scan runs, each step that is still on can be switched off before it starts.
          STEP_ORDER.filter(step => state.steps[step] && !(progress?.skipped ?? []).includes(step)).map(step => (
            <button key={step} type="button" className="outline-button" onClick={() => handlers.skipStep(step)}>{`${t('libraryDevices.scan.skip')}: ${t(STEP_KEY[step])}`}</button>
          ))
        )}
      </div>
      <div className="devices-progress-head">
        <span>{t(view?.phaseKey ?? PHASE_IDLE)}</span>
        {view?.stepKey === undefined ? null : <span>{t(view.stepKey)}</span>}
        {view === null ? null : <span>{t('libraryDevices.scan.percent', { percent: view.percent })}</span>}
      </div>
      <div className="devices-progress" role="progressbar" aria-label={t('libraryDevices.scan.heading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view?.percent ?? 0}>
        <div className="devices-progress-fill" style={{ width: `${view?.percent ?? 0}%` }} />
      </div>
      {view === null ? null : (
        <div className="devices-progress-foot">
          <span>{t('libraryDevices.scan.files', { count: view.files })}</span>
          {progress !== null && progress.skipped.length > 0 ? <span>{t('libraryDevices.scan.skipped', { count: progress.skipped.length })}</span> : null}
        </div>
      )}
      {progress?.result === undefined ? null : <ScanResult t={t} result={progress.result} />}
    </section>
  );
}

/** The presentational view: all state comes in as props, so the markup can be rendered in any state. */
export function DevicesPanel({ t, state, handlers }: { t: Translator; state: DevicesViewState; handlers: DevicesViewHandlers }) {
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (state.focusKey === null) return;
    rowRefs.current.get(state.focusKey)?.focus();
  }, [state.focusKey]);

  const rootLabel = useMemo(() => {
    const labels = new Map(state.roots.map(root => [root.rootId, root.label]));
    return (rootId: string) => labels.get(rootId) ?? rootId;
  }, [state.roots]);

  const header = (
    <header className="devices-head">
      <h2>{t('libraryDevices.title')}</h2>
      <p>{t('libraryDevices.intro')}</p>
      <p className="devices-privacy">{t('libraryDevices.privacy')}</p>
    </header>
  );
  if (!state.available) {
    return <section className="devices-view" data-testid="devices-view">{header}<p className="devices-alert" role="alert">{t('libraryDevices.error.unavailable')}</p></section>;
  }

  const onTreeKey = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    const mapped = TREE_KEYS.find(key => key === event.key);
    if (mapped === undefined) return;
    event.preventDefault();
    handlers.treeKey(mapped, index);
  };

  return (
    <section className="devices-view" data-testid="devices-view" aria-labelledby="devices-title">
      {header}
      {state.feedback === null ? null : (
        <p className={`devices-feedback devices-feedback-${state.feedback.tone}`} role="status">{t(state.feedback.key, state.feedback.params)}</p>
      )}
      <div className="devices-grid">
        <aside className="devices-side">
          <section className="devices-roots" aria-labelledby="devices-roots-heading">
            <div className="devices-row-head">
              <h3 id="devices-roots-heading">{t('libraryDevices.roots.heading')}</h3>
              <button type="button" className="primary-button" disabled={state.busy} onClick={handlers.addRoot}>{t('libraryDevices.roots.add')}</button>
            </div>
            {state.roots.length === 0 ? <p className="devices-note">{t('libraryDevices.roots.empty')}</p> : (
              <ul className="devices-root-list">
                {state.roots.map(root => (
                  <li key={root.rootId} className="devices-root">
                    <span className="devices-root-label">{root.label}</span>
                    <span className={`devices-coverage devices-coverage-${root.coverage}`}>{t(COVERAGE_KEY[root.coverage])}</span>
                    {offers(state.capabilities, 'removeRoot') ? <button type="button" className="text-button" disabled={state.busy} onClick={() => handlers.removeRoot(root.rootId)}>{t('libraryDevices.roots.remove')}</button> : null}
                  </li>
                ))}
              </ul>
            )}
            {state.roots.length > 0 && offers(state.capabilities, 'removeRoot') ? <p className="devices-note">{t('libraryDevices.roots.removeNote')}</p> : null}
          </section>
          {rejectionLines(state.rejections ?? []).length === 0 ? null : (
            <section className="devices-rejections" aria-labelledby="devices-rejections-heading">
              <h3 id="devices-rejections-heading">{t('libraryDevices.rejection.heading')}</h3>
              <ul className="devices-reasons">
                {rejectionEntries(state.rejections ?? []).map(({ key, reason }) => <li key={key}>{t(key)} <code>{reason}</code></li>)}
              </ul>
            </section>
          )}
          <ScanControls t={t} state={state} handlers={handlers} />
        </aside>

        <div className="devices-main">
          <section className="devices-tree-section" aria-labelledby="devices-tree-heading">
            <h3 id="devices-tree-heading">{t('libraryDevices.tree.heading')}</h3>
            {state.rows.length === 0 ? <p className="devices-note">{t('libraryDevices.tree.empty')}</p> : (
              <ul className="devices-tree" role="tree" aria-labelledby="devices-tree-heading">
                {state.rows.map((row, index) => {
                  const note = state.folderNotes.get(row.key);
                  const focused = state.focusKey === null ? index === 0 : state.focusKey === row.key;
                  return (
                    <li
                      key={row.key}
                      role="treeitem"
                      aria-level={row.depth + 1}
                      aria-expanded={row.hasChildren ? row.expanded : undefined}
                      aria-selected={false}
                      tabIndex={focused ? 0 : -1}
                      className="devices-tree-row"
                      style={{ paddingInlineStart: `${row.depth * 16 + 6}px` }}
                      ref={element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }}
                      onFocus={() => handlers.focusRow(row.key)}
                      onKeyDown={event => onTreeKey(event, index)}
                      data-depth={row.depth}
                    >
                      {row.hasChildren ? (
                        <button
                          type="button"
                          className="devices-tree-toggle"
                          tabIndex={-1}
                          aria-label={t(row.expanded ? 'libraryDevices.tree.collapse' : 'libraryDevices.tree.expand')}
                          onClick={() => handlers.toggleRow(row.key, !row.expanded)}
                        >
                          {row.expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        </button>
                      ) : <span className="devices-tree-spacer" aria-hidden="true" />}
                      <span className="devices-tree-name">{row.label === '' ? t('libraryDevices.tree.unnamed') : row.label}</span>
                      {row.readState === undefined || row.readState === 'listed' ? (
                        <span className="devices-tree-counts">{t('libraryDevices.tree.counts', { folders: row.folderCount, files: row.fileCount })}</span>
                      ) : (
                        // A folder that was not read must not look empty: its state and, for an unreadable one, its code are shown instead of counts.
                        <span className={`devices-tree-state devices-tree-state-${row.readState}`}>
                          {t(row.readState === 'unreadable' ? 'libraryDevices.tree.stateUnreadable' : row.readState === 'skipped' ? 'libraryDevices.tree.stateSkipped' : 'libraryDevices.tree.statePending')}
                          {row.code === undefined ? null : <span className="devices-tree-state-code">{t('libraryDevices.tree.stateCode', { code: row.code })}</span>}
                        </span>
                      )}
                      {state.capabilities?.skipFolders === true && row.path !== '' ? (
                        <button type="button" className="text-button" disabled={state.busy} onClick={() => handlers.toggleFolderSkip?.(row.path)}>
                          {t(state.skippedFolders?.has(row.path) === true ? 'libraryDevices.tree.unskipFolder' : 'libraryDevices.tree.skipFolder')}
                        </button>
                      ) : null}
                      {row.loading ? <span className="devices-note">{t('libraryDevices.tree.loading')}</span> : null}
                      {note === undefined || (note.complete && note.notRead === 0) ? null : (
                        <span className="devices-note">
                          {note.complete ? null : <span>{t('libraryDevices.tree.incomplete')}</span>}
                          {note.notRead > 0 ? <span>{t('libraryDevices.tree.notRead', { count: note.notRead })}</span> : null}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="devices-boards-section" aria-labelledby="devices-boards-heading">
            <div className="devices-row-head">
              <h3 id="devices-boards-heading">{t('libraryDevices.boards.heading')}</h3>
              {/* A filter is applied to the loaded page only: the count then says so and counts the loaded, matching rows. */}
              <span className="devices-note">
                {state.text.trim() !== '' || state.status !== 'all'
                  ? t('libraryDevices.boards.loadedCount', { count: state.boards.length })
                  : t('libraryDevices.boards.count', { count: state.boardTotal })}
              </span>
            </div>
            <div className="devices-toolbar">
              <input
                type="search"
                className="devices-search"
                value={state.text}
                placeholder={t('libraryDevices.boards.search')}
                aria-label={t('libraryDevices.boards.search')}
                onChange={event => handlers.setText(event.target.value)}
              />
              <div className="devices-filters" role="group" aria-label={t('libraryDevices.boards.heading')}>
                {FILTERS.map(filter => (
                  <button key={filter} type="button" className={state.status === filter ? 'outline-button devices-filter devices-filter-on' : 'outline-button devices-filter'} aria-pressed={state.status === filter} onClick={() => handlers.setStatus(filter)}>
                    {t(FILTER_KEY[filter])}
                  </button>
                ))}
              </div>
            </div>
            {state.boards.length === 0 ? <p className="devices-note">{t('libraryDevices.boards.empty')}</p> : (
              <table className="devices-board-table">
                <thead>
                  <tr>
                    <th scope="col">{t('libraryDevices.boards.heading')}</th>
                    <th scope="col">{t('libraryDevices.boards.columns.boardview')}</th>
                    <th scope="col">{t('libraryDevices.boards.columns.schematic')}</th>
                    <th scope="col">{t('libraryDevices.boards.columns.bios')}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.boards.map(row => <BoardLine key={row.anchorId} t={t} row={row} selected={row.anchorId === state.selectedAnchor} onSelect={handlers.selectBoard} />)}
                </tbody>
              </table>
            )}
            {state.hasMore ? <button type="button" className="outline-button" disabled={state.busy} onClick={handlers.loadMore}>{t('libraryDevices.boards.more')}</button> : null}
          </section>
        </div>

        <aside className="devices-detail" aria-label={t('libraryDevices.detail.heading')}>
          <DetailPane t={t} state={state} handlers={handlers} rootLabel={rootLabel} />
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Container

/** An optional control is offered unless the port says it cannot do it. */
function offers(capabilities: DeviceCapabilities | undefined, key: keyof DeviceCapabilities): boolean {
  return capabilities === undefined || capabilities[key];
}

function errorFeedback(error: unknown): Feedback {
  void error;
  return { tone: 'error', key: 'libraryDevices.error.failed' };
}

/**
 * The feedback of an undo. A snapshot that names a removed root's file is refused as unknown-file (the port drops it); that gets the
 * same message as a stale save: the lists are read again and the file is chosen again. Other failures keep the generic message.
 */
export async function undoFeedback(undo: () => Promise<boolean>, refresh: () => void): Promise<Feedback> {
  let undone: boolean;
  try {
    undone = await undo();
  } catch (error) {
    if (codeOf(error) !== 'unknown-file') throw error;
    refresh();
    return unknownFileFeedback;
  }
  if (!undone) return { tone: 'warn', key: 'libraryDevices.correction.nothingToUndo' };
  refresh();
  return { tone: 'ok', key: 'libraryDevices.correction.undone' };
}

/** The stateful device view. `port` null means the service is not available in this build. */
export default function DevicesView({ t, port }: { t: Translator; port: DeviceDatabasePort | null }) {
  const [roots, setRoots] = useState<RootSummary[]>([]);
  const [cache, setCache] = useState<ReadonlyMap<string, readonly FolderSummary[]>>(() => new Map());
  const [folderNotes, setFolderNotes] = useState<ReadonlyMap<string, { notRead: number; complete: boolean }>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<BoardStatusFilter>('all');
  const [boards, setBoards] = useState<BoardRow[]>([]);
  const [boardTotal, setBoardTotal] = useState(0);
  const [boardCursor, setBoardCursor] = useState<string | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [selectedAnchor, setSelectedAnchor] = useState<string | null>(null);
  const [detail, setDetail] = useState<BoardDetail | null>(null);
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [progress, setProgress] = useState<ScanProgressView | null>(null);
  const [steps, setSteps] = useState<StepSwitches>({ ...ALL_STEPS });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [draft, setDraft] = useState<CorrectionDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [rejections, setRejections] = useState<readonly RejectReason[]>([]);
  const [skippedFolders, setSkippedFolders] = useState<ReadonlySet<string>>(() => new Set());

  const boardSeq = useRef(0);
  const detailSeq = useRef(0);
  const cacheGen = useRef(0);
  const loading = useRef(new Set<string>());

  const rows = useMemo(() => buildTreeRows({ roots, cache, expanded }), [roots, cache, expanded]);

  // Roots, live progress and "changed" events from the service. A change drops the folder cache: the open folders reload.
  useEffect(() => {
    if (port === null) return undefined;
    void port.listRoots().then(setRoots).catch(error => setFeedback(errorFeedback(error)));
    return port.subscribe(event => {
      if (event.type === 'progress') {
        setProgress(event.progress);
        setPhase(event.progress.phase);
      } else if (event.type === 'failed') {
        setFeedback(errorFeedback(event));
      } else {
        // Folder ids belong to one scan: after a finished scan the skips of the old one are no longer valid.
        setSkippedFolders(new Set());
        cacheGen.current++;
        // Folder loads of the old generation are dropped; clearing the marks lets the open folders ask again.
        loading.current.clear();
        setCache(new Map());
        setFolderNotes(new Map());
        setVersion(value => value + 1);
        void port.listRoots().then(setRoots).catch(() => undefined);
      }
    });
  }, [port]);

  // Motherboard list: a short debounce on typing; a response for an older request is dropped.
  useEffect(() => {
    if (port === null || port.listBoards === undefined) return undefined;
    const listBoards = port.listBoards.bind(port);
    const seq = ++boardSeq.current;
    const timer = setTimeout(() => {
      listBoards({ text, status, limit: DEFAULT_PAGE }).then(page => {
        if (seq !== boardSeq.current) return;
        setBoards([...page.rows]);
        setBoardTotal(page.total);
        setBoardCursor(page.cursor);
      }).catch(error => { if (seq === boardSeq.current) setFeedback(errorFeedback(error)); });
    }, 150);
    return () => clearTimeout(timer);
  }, [port, text, status, version]);

  // Detail of the selected motherboard.
  useEffect(() => {
    if (port === null || port.boardDetail === undefined || selectedAnchor === null) { setDetail(null); return undefined; }
    const boardDetail = port.boardDetail.bind(port);
    const seq = ++detailSeq.current;
    boardDetail(selectedAnchor).then(value => { if (seq === detailSeq.current) setDetail(value); })
      .catch(error => { if (seq === detailSeq.current) setFeedback(errorFeedback(error)); });
    return undefined;
  }, [port, selectedAnchor, version]);

  // Expanded folders without children in the cache: load them once, in the cache generation they were asked for.
  useEffect(() => {
    if (port === null || port.listFolders === undefined) return;
    const listFolders = port.listFolders.bind(port);
    for (const load of pendingFolderLoads(rows)) {
      if (loading.current.has(load.key)) continue;
      loading.current.add(load.key);
      const generation = cacheGen.current;
      listFolders(load.rootId, load.path).then(page => {
        if (generation !== cacheGen.current) return;
        setCache(previous => new Map(previous).set(load.key, page.folders));
        setFolderNotes(previous => new Map(previous).set(load.key, { notRead: page.notRead, complete: page.complete }));
      }).catch(error => {
        if (generation !== cacheGen.current) return;
        setCache(previous => new Map(previous).set(load.key, []));
        setFeedback(errorFeedback(error));
      }).finally(() => { if (generation === cacheGen.current) loading.current.delete(load.key); });
    }
  }, [port, rows]);

  // Refused correction entries, read again after every change to the corrections.
  useEffect(() => {
    if (port === null || port.correctionRejections === undefined) return;
    const correctionRejections = port.correctionRejections.bind(port);
    void correctionRejections().then(setRejections).catch(() => undefined);
  }, [port, version]);

  const normalized = useMemo(() => normalizeSteps(steps), [steps]);

  // A work function may return its own feedback (a correction result); otherwise the given success text, or none, is shown.
  const act = async (work: () => Promise<Feedback | void>, success?: Feedback): Promise<void> => {
    if (port === null) return;
    setBusy(true);
    try {
      const outcome = await work();
      setFeedback(outcome ?? success ?? null);
    } catch (error) {
      setFeedback(errorFeedback(error));
    } finally {
      setBusy(false);
    }
  };

  const moveScan = (event: ScanEvent, call: () => Promise<void>) => {
    const next = nextScanPhase(phase, event);
    if (next === undefined) return;
    void act(async () => { await call(); setPhase(next); });
  };

  const handlers: DevicesViewHandlers = {
    addRoot: () => {
      if (port === null) return;
      void act(async () => {
        const picked = await port.pickRoot();
        if (picked === null) return;
        setRoots(await port.listRoots());
        setVersion(value => value + 1);
      });
    },
    toggleFolderSkip: folderId => setSkippedFolders(previous => {
      const next = new Set(previous);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    }),
    removeRoot: rootId => {
      if (port === null) return;
      void act(async () => {
        await port.removeRoot(rootId);
        const prefix = `${rootId}\u0000`;
        cacheGen.current++;
        setCache(previous => new Map([...previous].filter(([key]) => !key.startsWith(prefix))));
        setFolderNotes(previous => new Map([...previous].filter(([key]) => !key.startsWith(prefix))));
        setExpanded(previous => new Set([...previous].filter(key => !key.startsWith(prefix))));
        setRoots(await port.listRoots());
        setVersion(value => value + 1);
      });
    },
    toggleRow: (key, expand) => {
      setFocusKey(key);
      setExpanded(previous => {
        const next = new Set(previous);
        if (expand) next.add(key); else next.delete(key);
        return next;
      });
    },
    treeKey: (key, index) => {
      const action = treeKeyAction(rows, index, key);
      if (action.type === 'focus') setFocusKey(rows[action.index].key);
      if (action.type === 'toggle') handlers.toggleRow(rows[action.index].key, action.expand);
    },
    focusRow: key => setFocusKey(key),
    setText,
    setStatus,
    selectBoard: anchorId => {
      setSelectedAnchor(anchorId);
      setDetail(null);
      setDraft(EMPTY_DRAFT);
      setFeedback(null);
    },
    loadMore: () => {
      if (port === null || port.listBoards === undefined || boardCursor === undefined) return;
      const listBoards = port.listBoards.bind(port);
      const seq = ++boardSeq.current;
      void act(async () => {
        const page = await listBoards({ text, status, cursor: boardCursor, limit: DEFAULT_PAGE });
        if (seq !== boardSeq.current) return;
        setBoards(previous => [...previous, ...page.rows]);
        setBoardCursor(page.cursor);
      });
    },
    setStep: (step, on) => setSteps(previous => ({ ...previous, [step]: on })),
    startScan: () => {
      if (port === null) return;
      const skipFolders = port.capabilities?.skipFolders === true ? [...skippedFolders] : undefined;
      moveScan('start', () => port.startScan({ rootIds: roots.map(root => root.rootId), steps: normalized.steps, skipFolders }));
    },
    pauseScan: () => { if (port !== null) moveScan('pause', () => port.pauseScan()); },
    resumeScan: () => { if (port !== null) moveScan('resume', () => port.resumeScan()); },
    cancelScan: () => { if (port !== null) moveScan('cancel', () => port.cancelScan()); },
    skipStep: step => {
      if (port === null) return;
      void act(async () => {
        try {
          await port.skipStep(step);
        } catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
          // Nothing is running any more (or the step cannot be skipped now): say so, do not claim a skip.
          if (code === 'no-scan' || code === 'invalid-request') return unavailableSkip;
          throw error;
        }
        return undefined;
      });
    },
    setDraft: patch => setDraft(previous => ({ ...previous, ...patch })),
    saveCorrection: () => {
      // The correction names the board by its anchor id, which the detail carries (the list id is not the anchor).
      const anchor = detail?.row.boardAnchorId;
      if (port === null || anchor === undefined) return;
      const built = buildCorrection(anchor, draft, port.platform);
      if (!built.ok) {
        setFeedback({ tone: 'error', key: built.reason === 'needsFile' ? 'libraryDevices.correction.chooseFile' : 'libraryDevices.correction.invalid' });
        return;
      }
      void act(async () => {
        let result: { missingTarget?: boolean; quarantine?: { name: string; entries: number } };
        try {
          result = await port.saveCorrection(built.correction);
        } catch (error) {
          const code = codeOf(error);
          // A stale file id (after a restart or a root removal): the lists are read again and the file is chosen again.
          if (code === 'unknown-file') { setVersion(value => value + 1); return unknownFileFeedback; }
          if (code === 'invalid-request') return invalidRequestFeedback;
          throw error;
        }
        setDraft(previous => ({ ...previous, value: '' }));
        setVersion(value => value + 1);
        // Refused entries the store set aside: the count and the base name of the file that holds them, never a path.
        if (result.quarantine !== undefined) return { tone: 'warn', key: 'libraryDevices.correction.quarantined', params: { count: result.quarantine.entries, name: result.quarantine.name } };
        if (result.missingTarget === undefined) return { tone: 'warn', key: 'libraryDevices.correction.missingTargetUnknown' };
        return result.missingTarget
          ? { tone: 'warn', key: 'libraryDevices.correction.missingTarget' }
          : { tone: 'ok', key: 'libraryDevices.correction.saved' };
      });
    },
    undoCorrection: () => {
      if (port === null) return;
      void act(() => undoFeedback(() => port.undoLastCorrection(), () => setVersion(value => value + 1)));
    },
    confirmRole: file => {
      if (port === null || file.fileId === undefined) return;
      void act(async () => {
        await port.saveCorrection({ op: 'role', fileId: file.fileId ?? '', role: file.role });
        setVersion(value => value + 1);
        return { tone: 'ok', key: 'libraryDevices.correction.saved' };
      });
    },
  };

  const state: DevicesViewState = {
    available: port !== null,
    platform: port?.platform ?? 'linux',
    roots,
    rows,
    folderNotes,
    focusKey,
    text,
    status,
    boards,
    boardTotal,
    hasMore: boardCursor !== undefined,
    selectedAnchor,
    detail,
    phase,
    progress,
    steps,
    feedback,
    draft,
    busy,
    rejections,
    capabilities: port?.capabilities,
    skippedFolders,
  };

  return <DevicesPanel t={t} state={state} handlers={handlers} />;
}
