/**
 * Pure view-model of the device database view: folder tree rows and their keyboard moves, motherboard slot status, confidence and
 * reason lines, the scan state machine, step dependencies, and the building of a manual correction.
 *
 * No React, no DOM and no I/O here. Every text is a catalog key (DeviceKey), so the view only passes these keys to the translator.
 * The data comes from the port in ./ui-port.ts; the decisions (what is found, unknown or not found) come from ./availability.ts and
 * ./match.ts. This module only maps them to presentation.
 */
import type { MessageKey } from '../../i18n';
import type { SlotAvailability } from './availability';
import type { StepName, StepSwitches } from './catalogue';
import { CANONICAL_ROLE_OF, parseCorrections, serializeCorrections, type Correction, type RejectReason } from './corrections';
import type { Association, MatchState, Signal, Conflict } from './match';
import type { FileRole } from './identity';
import { searchKey, type DevicePlatform } from './paths';
import type { BoardPresence, BoardRow, BoardFile, FolderReadState, FolderSummary, RootCoverageView, RootSummary, ScanProgressView, SlotInput, BoardStatusFilter, PortCorrection } from './ui-port';

/** A catalog key of the device view. The translator accepts it because the key exists in the English catalog. */
export type DeviceKey = Extract<MessageKey, `libraryDevices.${string}`>;

// ---------------------------------------------------------------------------------------------------------------------
// Folder tree

/** One visible row of the folder tree. `parentIndex` is the row of the parent (-1 for a root row). */
export interface TreeRow {
  key: string;
  rootId: string;
  path: string;
  label: string;
  depth: number;
  parentIndex: number;
  expanded: boolean;
  /** Whether the folder has subfolders. A root row without loaded children counts as having them. */
  hasChildren: boolean;
  /** Expanded, but the children are not in the cache yet: the view loads them. */
  loading: boolean;
  folderCount: number;
  fileCount: number;
  /** The folder's read state: a folder that was not read is shown as such, never as an empty folder. */
  readState?: FolderReadState;
  code?: string;
}

export interface TreeInput {
  roots: readonly RootSummary[];
  /** Loaded children per folder key (see folderKey). A missing entry means "not loaded yet". */
  cache: ReadonlyMap<string, readonly FolderSummary[]>;
  /** The folder keys that are expanded. */
  expanded: ReadonlySet<string>;
}

/** The cache and expansion key of one folder. Root-relative paths only; '' is the root. */
export function folderKey(rootId: string, path: string): string {
  return `${rootId}\u0000${path}`;
}

/** The visible rows of the tree in display order. Linear in the number of visible rows. */
export function buildTreeRows(input: TreeInput): TreeRow[] {
  const rows: TreeRow[] = [];
  const addChildren = (rootId: string, parentPath: string, parentIndex: number, depth: number): void => {
    const key = folderKey(rootId, parentPath);
    const children = input.cache.get(key);
    if (children === undefined) return;
    for (const child of children) {
      const childKey = folderKey(rootId, child.path);
      const index = rows.length;
      const expanded = input.expanded.has(childKey) && child.folderCount > 0;
      rows.push({
        key: childKey, rootId, path: child.path, label: child.name, depth, parentIndex,
        expanded, hasChildren: child.folderCount > 0, loading: expanded && !input.cache.has(childKey),
        folderCount: child.folderCount, fileCount: child.fileCount, readState: child.readState, code: child.code,
      });
      if (expanded) addChildren(rootId, child.path, index, depth + 1);
    }
  };
  for (const root of input.roots) {
    const key = folderKey(root.rootId, '');
    const index = rows.length;
    const cached = input.cache.get(key);
    const expanded = input.expanded.has(key);
    rows.push({
      key, rootId: root.rootId, path: '', label: root.label, depth: 0, parentIndex: -1,
      expanded, hasChildren: root.folderCount > 0,
      loading: expanded && cached === undefined, folderCount: root.folderCount, fileCount: root.fileCount,
    });
    if (expanded) addChildren(root.rootId, '', index, 1);
  }
  return rows;
}

/** The folders whose children must be loaded before the tree can show them: expanded rows without a cache entry. */
export function pendingFolderLoads(rows: readonly TreeRow[]): Array<{ key: string; rootId: string; path: string }> {
  return rows.filter(row => row.loading).map(row => ({ key: row.key, rootId: row.rootId, path: row.path }));
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End' | 'Enter' | ' ';
export type TreeAction = { type: 'none' } | { type: 'focus'; index: number } | { type: 'toggle'; index: number; expand: boolean };

/**
 * The tree keys of the WAI-ARIA tree pattern: up and down move, right opens or steps into a child, left closes or steps to the
 * parent, Home and End go to the ends, Enter and Space toggle.
 */
export function treeKeyAction(rows: readonly TreeRow[], index: number, key: TreeKey): TreeAction {
  if (rows.length === 0 || index < 0 || index >= rows.length) return { type: 'none' };
  const row = rows[index];
  const last = rows.length - 1;
  switch (key) {
    case 'ArrowDown':
      return index < last ? { type: 'focus', index: index + 1 } : { type: 'none' };
    case 'ArrowUp':
      return index > 0 ? { type: 'focus', index: index - 1 } : { type: 'none' };
    case 'Home':
      return { type: 'focus', index: 0 };
    case 'End':
      return { type: 'focus', index: last };
    case 'ArrowRight':
      if (row.hasChildren && !row.expanded) return { type: 'toggle', index, expand: true };
      if (row.expanded && index < last && rows[index + 1].parentIndex === index) return { type: 'focus', index: index + 1 };
      return { type: 'none' };
    case 'ArrowLeft':
      if (row.expanded) return { type: 'toggle', index, expand: false };
      if (row.parentIndex >= 0) return { type: 'focus', index: row.parentIndex };
      return { type: 'none' };
    case 'Enter':
    case ' ':
      return row.hasChildren ? { type: 'toggle', index, expand: !row.expanded } : { type: 'none' };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Roots and coverage

export const COVERAGE_KEY: Record<RootCoverageView, DeviceKey> = {
  pending: 'libraryDevices.coverage.pending',
  complete: 'libraryDevices.coverage.complete',
  partial: 'libraryDevices.coverage.partial',
  paused: 'libraryDevices.coverage.paused',
  cancelled: 'libraryDevices.coverage.cancelled',
  offline: 'libraryDevices.coverage.offline',
  denied: 'libraryDevices.coverage.denied',
  skipped: 'libraryDevices.coverage.skipped',
};

// ---------------------------------------------------------------------------------------------------------------------
// Motherboard slots

export type Confidence = 'confirmed' | 'probable' | 'review';
export type SlotReason = 'noRoot' | 'stageSkipped' | 'incomplete' | 'offline' | 'denied' | 'stale' | 'notMeasured';

export type SlotView =
  | { kind: 'found'; count: number; confidence: Confidence; basis: Association['basis'] | undefined }
  | { kind: 'present'; presence: 'confirmed' | 'candidate' }
  | { kind: 'not-found' }
  | { kind: 'unknown'; reason: SlotReason; knownOffline: number };

type UnknownReason = Extract<SlotAvailability, { status: 'unknown' }>['reason'];
const SLOT_REASON_OF: Record<UnknownReason, SlotReason> = {
  'no-root': 'noRoot',
  'stage-skipped': 'stageSkipped',
  incomplete: 'incomplete',
  offline: 'offline',
  denied: 'denied',
  'stale-generation': 'stale',
};

/** Confidence of the best candidate. A candidate without an association state is shown as "needs review". */
export function confidenceOf(state: MatchState | undefined): Confidence {
  return state === 'confirmed' ? 'confirmed' : state === 'probable' ? 'probable' : 'review';
}

/** Maps the availability answer of one motherboard slot to the view. "Not found" is only shown when the answer says so. */
export function slotView(input: SlotInput): SlotView {
  if (input.presence !== undefined) return presenceView(input.presence, input.complete === true);
  if (input.availability === undefined) return { kind: 'unknown', reason: 'notMeasured', knownOffline: 0 };
  const availability = input.availability;
  switch (availability.status) {
    case 'found':
      return { kind: 'found', count: availability.count, confidence: confidenceOf(input.bestState), basis: input.basis };
    case 'not-found':
      return { kind: 'not-found' };
    case 'unknown':
      return { kind: 'unknown', reason: SLOT_REASON_OF[availability.reason], knownOffline: availability.knownOffline };
  }
}

/** The bridge's presence answer: confirmed or candidate is shown as present; none is not found only for a complete scan. */
function presenceView(presence: BoardPresence, complete: boolean): SlotView {
  if (presence === 'confirmed' || presence === 'candidate') return { kind: 'present', presence };
  if (presence === 'none') return complete ? { kind: 'not-found' } : { kind: 'unknown', reason: 'incomplete', knownOffline: 0 };
  return { kind: 'unknown', reason: 'notMeasured', knownOffline: 0 };
}

export const SLOT_REASON_KEY: Record<SlotReason, DeviceKey> = {
  notMeasured: 'libraryDevices.slot.reason.notMeasured',
  noRoot: 'libraryDevices.slot.reason.noRoot',
  stageSkipped: 'libraryDevices.slot.reason.stageSkipped',
  incomplete: 'libraryDevices.slot.reason.incomplete',
  offline: 'libraryDevices.slot.reason.offline',
  denied: 'libraryDevices.slot.reason.denied',
  stale: 'libraryDevices.slot.reason.stale',
};

export const CONFIDENCE_KEY: Record<Confidence, DeviceKey> = {
  confirmed: 'libraryDevices.confidence.confirmed',
  probable: 'libraryDevices.confidence.probable',
  review: 'libraryDevices.confidence.review',
};

export const BASIS_KEY: Record<Association['basis'], DeviceKey> = {
  user: 'libraryDevices.basis.user',
  content: 'libraryDevices.basis.content',
  names: 'libraryDevices.basis.names',
  alias: 'libraryDevices.basis.alias',
  conflict: 'libraryDevices.basis.conflict',
  ambiguous: 'libraryDevices.basis.ambiguous',
};

/** The motherboard's overall status: found when any of its three kinds is found; unknown when none is found but one is unknown; else not found. */
export function boardStatus(row: BoardRow): Exclude<BoardStatusFilter, 'all'> {
  const views = [row.boardview, row.schematic, row.bios].map(slotView);
  if (views.some(view => view.kind === 'found' || view.kind === 'present')) return 'found';
  if (views.some(view => view.kind === 'unknown')) return 'unknown';
  return 'notFound';
}

export function matchesStatus(row: BoardRow, filter: BoardStatusFilter): boolean {
  return filter === 'all' || boardStatus(row) === filter;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reasons of one file's link to a motherboard

export interface ReasonLine {
  key: DeviceKey;
  params: Record<string, string>;
  /** Missing evidence names, each a catalog key, joined by the view. */
  itemKeys: readonly DeviceKey[];
}

const SIGNAL_KEY: Record<Signal['signal'], DeviceKey> = {
  'code-name': 'libraryDevices.detail.signal.codeName',
  'code-content': 'libraryDevices.detail.signal.codeContent',
  'code-ambiguous': 'libraryDevices.detail.signal.codeAmbiguous',
  'revision-agree': 'libraryDevices.detail.signal.revision',
  alias: 'libraryDevices.detail.signal.alias',
};

const CONFLICT_KEY: Record<Conflict['field'], DeviceKey> = {
  'board-code': 'libraryDevices.detail.conflict.boardCode',
  revision: 'libraryDevices.detail.conflict.revision',
};

const MISSING_ITEM_KEY: Record<Association['missing'][number], DeviceKey> = {
  'content-identity': 'libraryDevices.detail.missingItem.contentIdentity',
  'file-revision': 'libraryDevices.detail.missingItem.fileRevision',
  'file-board-code': 'libraryDevices.detail.missingItem.fileBoardCode',
};

/** The explanation of one association: its signals, its conflicts (both values) and the evidence that is missing. */
export function reasonLines(association: Association): ReasonLine[] {
  const lines: ReasonLine[] = [];
  for (const signal of association.signals) {
    lines.push({ key: SIGNAL_KEY[signal.signal], params: { detail: signal.detail }, itemKeys: [] });
  }
  for (const conflict of association.conflicts) {
    lines.push({ key: CONFLICT_KEY[conflict.field], params: { fileValue: conflict.fileValue, anchorValue: conflict.anchorValue }, itemKeys: [] });
  }
  if (association.missing.length > 0) {
    lines.push({ key: 'libraryDevices.detail.missing', params: {}, itemKeys: association.missing.map(item => MISSING_ITEM_KEY[item]) });
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// File roles and the file list of a motherboard

export const ROLE_KEY: Record<FileRole, DeviceKey> = {
  boardview: 'libraryDevices.role.boardview',
  schematic: 'libraryDevices.role.schematic',
  'board-pdf': 'libraryDevices.role.boardPdf',
  document: 'libraryDevices.role.document',
  'bios-candidate': 'libraryDevices.role.biosCandidate',
  'ec-firmware': 'libraryDevices.role.ecFirmware',
  'me-firmware': 'libraryDevices.role.meFirmware',
  'saved-dump': 'libraryDevices.role.savedDump',
  other: 'libraryDevices.role.other',
};

const ROLE_ORDER: readonly FileRole[] = ['boardview', 'schematic', 'board-pdf', 'document', 'bios-candidate', 'ec-firmware', 'me-firmware', 'saved-dump', 'other'];

/** Files grouped by role in the fixed role order, then by path (code unit order). Returns a new array. */
export function sortBoardFiles(files: readonly BoardFile[]): BoardFile[] {
  const rank = new Map(ROLE_ORDER.map((role, index) => [role, index]));
  return [...files].sort((a, b) => {
    const byRole = (rank.get(a.role) ?? ROLE_ORDER.length) - (rank.get(b.role) ?? ROLE_ORDER.length);
    if (byRole !== 0) return byRole;
    if (a.rootId !== b.rootId) return a.rootId < b.rootId ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Scan state and steps

export type ScanPhase = ScanProgressView['phase'];
export type ScanEvent = 'start' | 'pause' | 'resume' | 'cancel' | 'finish';

const SCAN_TRANSITIONS: Record<ScanPhase, Partial<Record<ScanEvent, ScanPhase>>> = {
  idle: { start: 'running' },
  running: { pause: 'paused', cancel: 'stopping', finish: 'done' },
  paused: { resume: 'running', cancel: 'stopping' },
  stopping: {},
  cancelled: { start: 'running' },
  done: { start: 'running' },
};

/** The next phase, or undefined when the event is not allowed in this phase. */
export function nextScanPhase(phase: ScanPhase, event: ScanEvent): ScanPhase | undefined {
  return SCAN_TRANSITIONS[phase][event];
}

export const PHASE_KEY: Record<ScanPhase, DeviceKey> = {
  idle: 'libraryDevices.scan.idle',
  running: 'libraryDevices.scan.running',
  paused: 'libraryDevices.scan.paused',
  stopping: 'libraryDevices.scan.stopping',
  cancelled: 'libraryDevices.scan.cancelled',
  done: 'libraryDevices.scan.done',
};

export const STEP_KEY: Record<StepName, DeviceKey> = {
  folderMap: 'libraryDevices.step.folderMap',
  nameIdentity: 'libraryDevices.step.nameIdentity',
  biosCandidates: 'libraryDevices.step.biosCandidates',
  matching: 'libraryDevices.step.matching',
  corrections: 'libraryDevices.step.corrections',
};

/** The progress as the view shows it: a whole percentage, the phase and the running step. */
export function progressView(progress: ScanProgressView): { percent: number; phaseKey: DeviceKey; stepKey: DeviceKey | undefined; files: number } {
  const raw = Number.isFinite(progress.fraction) ? Math.round(progress.fraction * 100) : 0;
  return {
    percent: Math.min(100, Math.max(0, raw)),
    phaseKey: PHASE_KEY[progress.phase],
    stepKey: progress.step === undefined ? undefined : STEP_KEY[progress.step],
    files: Math.max(0, Math.floor(progress.files)),
  };
}

/**
 * Turns the step switches into the switches the catalogue runs. A step needs the steps before it: names need the folder
 * hierarchy, the BIOS candidates and matching need names. A step switched off by one of these is reported in `forcedOff`, so the
 * view can say why it stopped. Corrections depend on nothing and are not forced off.
 */
export function normalizeSteps(input: Partial<StepSwitches>): { steps: StepSwitches; forcedOff: StepName[] } {
  const wanted: StepSwitches = { folderMap: true, nameIdentity: true, biosCandidates: true, matching: true, corrections: true, ...input };
  const steps: StepSwitches = { ...wanted };
  const forcedOff: StepName[] = [];
  const force = (step: StepName, reason: boolean): void => {
    if (reason && steps[step]) {
      steps[step] = false;
      forcedOff.push(step);
    }
  };
  force('nameIdentity', !steps.folderMap);
  force('biosCandidates', !steps.nameIdentity);
  force('matching', !steps.nameIdentity);
  return { steps, forcedOff };
}

// ---------------------------------------------------------------------------------------------------------------------
// Correction drafts

export type CorrectionOp = 'link' | 'unlink' | 'role' | 'aliasAdd' | 'aliasRemove' | 'boardCode' | 'revision';

export const OP_KEY: Record<CorrectionOp, DeviceKey> = {
  link: 'libraryDevices.correction.op.link',
  unlink: 'libraryDevices.correction.op.unlink',
  role: 'libraryDevices.correction.op.role',
  aliasAdd: 'libraryDevices.correction.op.aliasAdd',
  aliasRemove: 'libraryDevices.correction.op.aliasRemove',
  boardCode: 'libraryDevices.correction.op.boardCode',
  revision: 'libraryDevices.correction.op.revision',
};

/** What the user typed in the correction form. `file` is the chosen file's opaque id; `value` is empty for "automatic" where that is allowed. */
export interface CorrectionDraft {
  op: CorrectionOp;
  file: string | undefined;
  value: string;
  role: FileRole | '';
}

export type CorrectionBuild =
  | { ok: true; correction: PortCorrection }
  | { ok: false; reason: 'needsFile' | 'needsValue' | 'invalid' };

/**
 * Builds one correction for the board `anchorId` (the board's anchor id) and checks its values with the store's parser. The path of
 * a file never reaches the renderer, so the check runs on a placeholder file; the correction that is sent names its file and its board
 * by id only. An empty role, board code or revision means "automatic" (the correction clears the value).
 */
export function buildCorrection(anchorId: string, draft: CorrectionDraft, platform: DevicePlatform): CorrectionBuild {
  const placeholder = { rootId: 'check', path: 'check' };
  let stored: Correction;
  switch (draft.op) {
    case 'link':
      if (draft.file === undefined) return { ok: false, reason: 'needsFile' };
      stored = { op: 'link', file: placeholder, anchorId };
      break;
    case 'unlink':
      if (draft.file === undefined) return { ok: false, reason: 'needsFile' };
      stored = { op: 'unlink', file: placeholder, anchorId };
      break;
    case 'role':
      if (draft.file === undefined) return { ok: false, reason: 'needsFile' };
      stored = { op: 'role', file: placeholder, role: draft.role === '' ? null : draft.role };
      break;
    case 'aliasAdd':
    case 'aliasRemove': {
      const alias = searchKey(draft.value);
      if (alias === '') return { ok: false, reason: 'needsValue' };
      stored = { op: 'alias', anchorId, alias, remove: draft.op === 'aliasRemove' };
      break;
    }
    case 'boardCode': {
      const code = draft.value.trim().toUpperCase();
      stored = { op: 'board-code', anchorId, code: code === '' ? null : code };
      break;
    }
    case 'revision': {
      const revision = draft.value.trim();
      stored = { op: 'revision', anchorId, revision: revision === '' ? null : revision };
      break;
    }
  }
  const checked = parseCorrections(serializeCorrections({ version: 1, platform, corrections: [stored] }));
  if (checked.error !== undefined || checked.dropped > 0 || checked.document.corrections.length !== 1) return { ok: false, reason: 'invalid' };
  const valid = checked.document.corrections[0];
  const fileId = draft.file ?? '';
  switch (valid.op) {
    case 'link':
    case 'unlink':
      return { ok: true, correction: { op: valid.op, fileId, boardAnchorId: anchorId } };
    case 'role':
      return { ok: true, correction: { op: 'role', fileId, role: valid.role } };
    case 'alias':
      return { ok: true, correction: { op: 'alias', boardAnchorId: anchorId, alias: valid.alias, remove: valid.remove } };
    case 'board-code':
      return { ok: true, correction: { op: 'board-code', boardAnchorId: anchorId, code: valid.code } };
    case 'revision':
      return { ok: true, correction: { op: 'revision', boardAnchorId: anchorId, revision: valid.revision } };
  }
}

/** The file-free correction operations, for forms that do not select a file. */
export function needsFile(op: CorrectionOp): boolean {
  return op === 'link' || op === 'unlink' || op === 'role';
}

// ---------------------------------------------------------------------------------------------------------------------
// Corrections: refused entries and files that need a manual classification

/** One line per refusal reason of the closed list (the store never sends anything else). No raw message is shown. */
export const REJECTION_KEY: Record<RejectReason, DeviceKey> = {
  'invalid-entry': 'libraryDevices.rejection.invalidEntry',
  'unknown-role': 'libraryDevices.rejection.unknownRole',
  'path-too-long': 'libraryDevices.rejection.pathTooLong',
  'invalid-relative-path': 'libraryDevices.rejection.invalidRelativePath',
  'too-many': 'libraryDevices.rejection.tooMany',
};

/**
 * True when the catalogue role has no canonical Library role yet: the file needs a manual classification, and the view must not
 * present a guessed label (for example a datasheet or a service manual). The user confirms the type or chooses one.
 */
export function needsClassification(role: FileRole): boolean {
  return CANONICAL_ROLE_OF[role] === 'unknown';
}

/** The distinct reasons in the closed order of REJECTION_KEY, ignoring anything else. */
export function rejectionLines(reasons: readonly string[]): DeviceKey[] {
  return rejectionEntries(reasons).map(entry => entry.key);
}

/** The same lines with the refusal code, so a refused correction is shown with its reason and never disappears silently. */
export function rejectionEntries(reasons: readonly string[]): Array<{ key: DeviceKey; reason: RejectReason }> {
  return (Object.keys(REJECTION_KEY) as RejectReason[]).filter(reason => reasons.includes(reason)).map(reason => ({ key: REJECTION_KEY[reason], reason }));
}
