/**
 * The renderer side of the device port: DeviceDatabasePort on top of the window bridge (electron/library/devices-bridge.cjs,
 * exposed by electron/preload.cjs). The core channels are pickRoot, scan, cancel, and the corrections load and save. The
 * optional channels are the persisted root list, root removal, the folder tree, the board list and one board's detail; a
 * port without one of them simply leaves that part out (see capabilities and the optional members of the port).
 *
 *  - Roots: the persisted list (listRoots) is the source of truth; labels are the folder's own names. Counts come from the
 *    last finished scan of this window.
 *  - Scan: runs in the background, so the view can show progress and Cancel. Cancel asks the main process to stop; the run
 *    ends as "cancelled" only when the scan has really ended, and its result is then not applied. Pause, resume and skipping a
 *    step during a run have no channel and are not offered. Folders can be left out of the next scan (skipFolders).
 *  - Folder tree: one level per call, paged by the bridge's cursor; folder ids are opaque and stand in for the paths.
 *  - Board list: boards of every scanned root, paged by a cursor that names the root and the bridge cursor. The text filter
 *    cannot be applied (the bridge sends no names), and the status filter is applied to the page only.
 *  - Corrections: the stored document is read again for each change, and the store's refusals are shown as closed reasons.
 *
 * No path is ever built or read here. Files and folders are named by opaque ids and root-relative paths only.
 */
import type { LibraryBoardDetail, LibraryBoardPage, LibraryFolderPage, LibraryRootList, LibraryScanSummary, TraceDesktop } from '../../types';
import { CORRECTIONS_VERSION, FILE_ROLES, type RejectReason } from './corrections';
import type { FileRole } from './identity';
import type { DevicePlatform } from './paths';
import type { StepName } from './catalogue';
import { boardStatus } from './ui-model';
import {
  MAX_PAGE, type BoardDetail, type BoardFile, type BoardPage, type BoardQuery, type BoardRow, type DeviceCapabilities, type DeviceDatabasePort,
  type DeviceEvent, type FolderPage, type FolderSummary, type PickedRoot, type PortCorrection, type RootCoverageView, type RootSummary, type ScanProgressView, type ScanResultView,
} from './ui-port';

/** The stored document as the renderer sees it: corrections by id only. */
interface PortDocument { version: number; platform: string; corrections: PortCorrection[] }

/** The store's answer to a written document. A quarantine name is a base name only; a path is never reported. */
type SavedResult = { status: 'saved'; bytes: number; quarantine?: string; quarantinedEntries?: number };

function quarantineOf(saved: SavedResult): { name: string; entries: number } | undefined {
  if (saved.quarantine === undefined || saved.quarantinedEntries === undefined) return undefined;
  return { name: saved.quarantine.split(/[\\/]/).pop() ?? '', entries: saved.quarantinedEntries };
}

/** The window bridge members this adapter uses. Each is optional on the window object (an older preload lacks it). */
export type LibraryBridge = Pick<TraceDesktop,
  'libraryPickRoot' | 'libraryScan' | 'libraryCancelScan' | 'libraryLoadCorrections' | 'librarySaveCorrections'
  | 'libraryListRoots' | 'libraryRemoveRoot' | 'libraryListFolders' | 'libraryListBoards' | 'libraryBoardDetail' | 'libraryScanSkipStep'>;

/** Stable failure codes of the adapter. They are never shown to the user; the view shows one generic message. */
export type BridgePortErrorCode = 'busy' | 'unsupported' | 'corrections-unusable' | 'refused' | 'no-roots' | 'no-scan' | 'invalid-request' | 'unknown-file';

export class BridgePortError extends Error {
  readonly code: BridgePortErrorCode;
  constructor(code: BridgePortErrorCode) {
    super(`device port: ${code}`);
    this.name = 'BridgePortError';
    this.code = code;
  }
}

const UNDO_LIMIT = 50;
const MAX_FOLDER_PAGES = 500;
const REJECTION_CODES: readonly RejectReason[] = ['invalid-entry', 'unknown-role', 'path-too-long', 'invalid-relative-path', 'too-many'];
const isRejectReason = (value: unknown): value is RejectReason => (REJECTION_CODES as readonly unknown[]).includes(value);

/** The platform of the running window, from the navigator. Used only to check correction values against the path rules. */
export interface PlatformSource { platform?: string; userAgentData?: { platform?: string } }

export function devicePlatformOf(source: PlatformSource | undefined): DevicePlatform {
  const label = (source?.userAgentData?.platform || source?.platform || '').toLowerCase();
  // The Apple test comes first: "darwin" contains "win", so the Windows test would otherwise match a darwin label.
  if (label.includes('mac') || label.includes('darwin')) return 'darwin';
  if (label.includes('win')) return 'win32';
  return 'linux';
}

/** Coverage of one root after a scan. A root the scan did not map has not been examined: it is 'pending', never a partial result. */
export function coverageOf(scanned: boolean, complete: boolean): RootCoverageView {
  if (!scanned) return 'pending';
  return complete ? 'complete' : 'partial';
}

/** Coverage of a root of the persisted list: not scanned, offline, complete, or partly scanned (also when completeness is unknown). */
export function coverageOfListed(root: LibraryRootList['roots'][number]): RootCoverageView {
  if (!root.scanned) return 'pending';
  if (!root.online) return 'offline';
  return root.complete === true ? 'complete' : 'partial';
}

/** Steps the scan did not run, in catalogue order. */
export function skippedStepsOf(summary: LibraryScanSummary): StepName[] {
  return (Object.keys(summary.steps) as StepName[]).filter(step => summary.steps[step] === 'skipped');
}

export function resultOf(summary: LibraryScanSummary): ScanResultView {
  return {
    fileCount: summary.fileCount,
    associationCount: summary.associationCount,
    missingTargetCount: typeof summary.missingTargetCount === 'number' ? summary.missingTargetCount : undefined,
    excludedFirmwareCount: summary.excludedFirmwareCount,
    collisionCount: summary.collisionCount,
    needsManualCount: summary.needsManualCount,
    notRead: summary.roots.reduce((total, root) => total + root.skippedCount, 0),
    complete: summary.complete,
    correctionsStatus: summary.correctionsStatus,
  };
}

/** A bridge role name as a catalogue file role; anything else is 'other', never a guessed role. */
function roleOf(role: string): FileRole {
  return (FILE_ROLES as readonly string[]).includes(role) ? (role as FileRole) : 'other';
}

function rowOfBoard(board: LibraryBoardPage['boards'][number], complete: boolean): BoardRow {
  return {
    anchorId: board.boardId,
    boardAnchorId: board.boardAnchorId,
    names: [],
    models: [],
    boardview: { presence: board.boardview, complete },
    schematic: { presence: 'unknown', complete },
    bios: { presence: board.bios, complete },
  };
}

/** The board-list cursor names the root (by its index in the scanned order) and the bridge's cursor inside that root. */
function decodeBoardCursor(value: string | undefined): { index: number; cursor: string | undefined } {
  if (value === undefined) return { index: 0, cursor: undefined };
  const bar = value.indexOf('|');
  const index = bar < 0 ? Number.NaN : Number(value.slice(0, bar));
  if (!Number.isSafeInteger(index) || index < 0) return { index: 0, cursor: undefined };
  const rest = value.slice(bar + 1);
  return { index, cursor: rest === '' ? undefined : rest };
}

function encodeBoardCursor(index: number, cursor: string | undefined): string {
  return `${index}|${cursor ?? ''}`;
}

interface SessionRoot { label: string; coverage: RootCoverageView; folderCount: number; fileCount: number }

/** A scan id the renderer chooses; the bridge refuses a skip for any other id. */
function newScanId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The port over the bridge, or null when one of the core members is missing (the view then reports the service as
 * unavailable). The window keeps only what it has seen: labels and counts. The state of the scan lives in the closure.
 */
export function createBridgeDevicePort(bridge: LibraryBridge | undefined, platform: DevicePlatform): DeviceDatabasePort | null {
  const pick = bridge?.libraryPickRoot;
  const scan = bridge?.libraryScan;
  const load = bridge?.libraryLoadCorrections;
  const save = bridge?.librarySaveCorrections;
  const cancelBridge = bridge?.libraryCancelScan;
  const listRootsBridge = bridge?.libraryListRoots;
  const removeRootBridge = bridge?.libraryRemoveRoot;
  const listFoldersBridge = bridge?.libraryListFolders;
  const listBoardsBridge = bridge?.libraryListBoards;
  const boardDetailBridge = bridge?.libraryBoardDetail;
  const skipStepBridge = bridge?.libraryScanSkipStep;
  if (!pick || !scan || !load || !save) return null;

  // Roots this window has seen (used when the persisted list is not on the bridge), and the roots the last scans covered.
  const sessionRoots = new Map<string, SessionRoot>();
  const scannedRoots = new Set<string>();
  const listeners = new Set<(event: DeviceEvent) => void>();
  let generation = 0;
  let progress: ScanProgressView = { phase: 'idle', fraction: 0, files: 0, skipped: [] };
  // The run the user still watches. Null once it has ended.
  let current: { cancelRequested: boolean } | null = null;
  // True while the main process has a scan in flight, including one that is being stopped.
  let mainBusy = false;
  // The id of the scan the window started last: a step can only be skipped in the scan with this id.
  let runScanId: string | null = null;
  // The platform of the stored document as the store last reported it. The document itself is read again for every change.
  let documentPlatform: string = platform;
  // The reasons of the last load of the stored document (the bridge sends codes only).
  let rejectionReasons: RejectReason[] = [];
  const undoStack: PortCorrection[][] = [];

  const emit = (event: DeviceEvent) => { for (const listener of [...listeners]) listener(event); };
  const setProgress = (next: ScanProgressView) => { progress = next; emit({ type: 'progress', progress: next }); };

  // Arrow functions, not declarations: the narrowing of pick, scan, load and save above carries into a const closure only.
  const loadDocument = async (): Promise<PortDocument> => {
    const loaded = await load();
    rejectionReasons = [...new Set((loaded.rejections ?? []).map(entry => entry.reason).filter(isRejectReason))];
    if (loaded.document === null) throw new BridgePortError('corrections-unusable');
    documentPlatform = loaded.document.platform;
    return { version: CORRECTIONS_VERSION, platform: loaded.document.platform, corrections: [...loaded.document.corrections] as PortCorrection[] };
  };

  // 'refused' means the store wrote nothing; the stored document stays as it was.
  const persist = async (next: PortDocument): Promise<SavedResult> => {
    let result: Awaited<ReturnType<typeof save>>;
    try {
      result = await save({ version: CORRECTIONS_VERSION, platform: next.platform, corrections: next.corrections });
    } catch (error) {
      // A stale file id or a malformed request is refused by the bridge and nothing is written.
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
      if (code === 'LIBRARY_UNKNOWN_FILE') throw new BridgePortError('unknown-file');
      if (code === 'LIBRARY_INVALID_REQUEST') throw new BridgePortError('invalid-request');
      throw error;
    }
    if (result.status === 'refused') throw new BridgePortError('refused');
    return result;
  };

  const countsOf = (rootId: string) => {
    const root = sessionRoots.get(rootId);
    return { folderCount: root?.folderCount ?? 0, fileCount: root?.fileCount ?? 0 };
  };

  const listRoots = async (): Promise<RootSummary[]> => {
    if (listRootsBridge === undefined) {
      return [...sessionRoots].map(([rootId, root]) => ({ rootId, label: root.label, coverage: root.coverage, ...countsOf(rootId) }));
    }
    const list = await listRootsBridge();
    scannedRoots.clear();
    return list.roots.map(root => {
      if (root.scanned) scannedRoots.add(root.rootId);
      const previous = sessionRoots.get(root.rootId);
      const coverage = coverageOfListed(root);
      sessionRoots.set(root.rootId, { label: root.label, coverage, folderCount: previous?.folderCount ?? 0, fileCount: previous?.fileCount ?? 0 });
      return { rootId: root.rootId, label: root.label, coverage, ...countsOf(root.rootId) };
    });
  };

  const listFolders = listFoldersBridge === undefined ? undefined : async (rootId: string, parentKey: string): Promise<FolderPage> => {
    // A root that no scan has covered has no tree yet; asking the bridge would only be refused.
    if (!scannedRoots.has(rootId)) return { folders: [], notRead: 0, complete: false };
    const folders: FolderSummary[] = [];
    let cursor: string | undefined;
    let complete = true;
    let notRead = 0;
    for (let pageNo = 0; pageNo < MAX_FOLDER_PAGES; pageNo++) {
      const page: LibraryFolderPage = await listFoldersBridge({
        rootId,
        ...(parentKey === '' ? {} : { parentId: parentKey }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: MAX_PAGE,
      });
      if (!page.scanned) return { folders: [], notRead: 0, complete: false };
      notRead = page.skippedCount;
      complete = complete && page.complete;
      for (const folder of page.folders) {
        folders.push({
          path: folder.folderId,
          name: folder.name,
          readState: folder.readState,
          ...(folder.code === undefined ? {} : { code: folder.code }),
          folderCount: folder.childFolderCount,
          fileCount: folder.fileCount,
          bytes: folder.bytes,
        });
      }
      if (page.nextCursor === undefined) return { folders, notRead, complete };
      cursor = page.nextCursor;
    }
    // Too many pages: the tree is cut here and is not complete.
    return { folders, notRead, complete: false };
  };

  // The board list has no text parameter: a text is matched against the board's code, revision and file names (basenames),
  // read from the board's detail. Only the rows of the page are read, so the filter applies per page.
  const textMatch = boardDetailBridge === undefined ? undefined : async (boardId: string, text: string): Promise<boolean> => {
    const detail = await boardDetailBridge({ boardId });
    const needle = text.trim().toLowerCase();
    const haystack = [detail.boardCode, detail.revision, ...detail.files.map(file => file.name)];
    return haystack.some(value => value !== null && value.toLowerCase().includes(needle));
  };
  const listBoards = listBoardsBridge === undefined ? undefined : async (query: BoardQuery): Promise<BoardPage> => {
    const ids = [...scannedRoots];
    let total = 0;
    for (const rootId of ids) total += (await listBoardsBridge({ rootId, limit: 1 })).total;
    const start = decodeBoardCursor(query.cursor);
    const rows: BoardRow[] = [];
    let index = start.index;
    let cursor = start.cursor;
    let next: string | undefined;
    let pageGeneration = generation;
    while (index < ids.length) {
      if (rows.length >= query.limit) { next = encodeBoardCursor(index, cursor); break; }
      const page: LibraryBoardPage = await listBoardsBridge({ rootId: ids[index], ...(cursor === undefined ? {} : { cursor }), limit: query.limit - rows.length });
      pageGeneration = page.generation;
      for (const board of page.boards) {
        const row = rowOfBoard(board, page.complete);
        if (query.status !== 'all' && boardStatus(row) !== query.status) continue;
        if (query.text.trim() !== '' && textMatch !== undefined && !(await textMatch(row.anchorId, query.text))) continue;
        rows.push(row);
      }
      if (page.nextCursor !== undefined) { next = encodeBoardCursor(index, page.nextCursor); break; }
      index++;
      cursor = undefined;
    }
    return { rows, total, generation: pageGeneration, ...(next === undefined ? {} : { cursor: next }) };
  };

  const boardDetail = boardDetailBridge === undefined ? undefined : async (anchorId: string): Promise<BoardDetail> => {
    const detail: LibraryBoardDetail = await boardDetailBridge({ boardId: anchorId });
    return {
      row: {
        anchorId,
        boardAnchorId: detail.boardAnchorId,
        boardCode: detail.boardCode ?? undefined,
        revision: detail.revision ?? undefined,
        names: [],
        models: [],
        boardview: { presence: detail.boardview, complete: detail.complete },
        schematic: { presence: 'unknown', complete: detail.complete },
        bios: { presence: detail.bios, complete: detail.complete },
      },
      // No path crosses the bridge for a board's files: the path stays empty, and the role and state are the bridge's.
      files: detail.files.map((file): BoardFile => ({
        fileId: file.fileId,
        rootId: file.rootId,
        path: '',
        ...(file.name === null ? {} : { name: file.name }),
        role: roleOf(file.role),
        confidence: file.state,
        ...(file.online === true ? { online: true as const } : {}),
      })),
      filesTruncated: detail.filesTruncated,
    };
  };

  const capabilities: DeviceCapabilities = {
    pauseScan: false,
    skipStep: skipStepBridge !== undefined,
    removeRoot: removeRootBridge !== undefined,
    skipFolders: listFoldersBridge !== undefined,
  };

  return {
    platform,
    capabilities,

    async pickRoot(): Promise<PickedRoot | null> {
      const picked = await pick();
      if (picked === null) return null;
      const previous = sessionRoots.get(picked.rootId);
      sessionRoots.set(picked.rootId, { label: picked.label, coverage: previous?.coverage ?? 'pending', folderCount: previous?.folderCount ?? 0, fileCount: previous?.fileCount ?? 0 });
      return { rootId: picked.rootId, label: picked.label };
    },

    listRoots,

    async removeRoot(rootId: string): Promise<void> {
      if (removeRootBridge === undefined) throw new BridgePortError('unsupported');
      await removeRootBridge({ rootId });
      sessionRoots.delete(rootId);
      scannedRoots.delete(rootId);
    },

    async correctionRejections(): Promise<readonly RejectReason[]> {
      try {
        await loadDocument();
      } catch {
        // An unusable document has nothing to explain entry by entry; the reasons stay empty.
        return [];
      }
      return [...rejectionReasons];
    },

    async saveCorrection(correction: PortCorrection): Promise<{ missingTarget?: boolean; quarantine?: { name: string; entries: number } }> {
      const before = await loadDocument();
      // Appended, not compacted: the store applies the later entry for a target when it reads the document.
      const next: PortDocument = {
        version: CORRECTIONS_VERSION,
        platform: before.platform,
        corrections: [...before.corrections, correction],
      };
      const saved = await persist(next);
      undoStack.push(before.corrections);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      // The bridge does not say per correction whether its file is in the scan: the answer is unknown, not false.
      // Entries the store set aside on this save are reported by quarantine file name and count.
      return { quarantine: quarantineOf(saved) };
    },

    async undoLastCorrection(): Promise<boolean> {
      const previous = undoStack[undoStack.length - 1];
      if (previous === undefined) return false;
      const restored: PortDocument = { version: CORRECTIONS_VERSION, platform: documentPlatform, corrections: previous };
      // Removed by identity, after the save has settled: a save that started meanwhile pushed a newer snapshot above this one, and
      // removing by position would take that newer snapshot instead.
      const dropPrevious = () => {
        const index = undoStack.lastIndexOf(previous);
        if (index >= 0) undoStack.splice(index, 1);
      };
      try {
        await persist(restored);
      } catch (error) {
        // A snapshot the bridge can never write is dropped, or every later undo would fail on it. That is a snapshot that names a file id
        // no longer known (its root was removed after the snapshot was taken), and one the bridge refuses as an invalid request. The
        // bridge wrote nothing in either case. A refused write may succeed on a later try, so that snapshot stays.
        if (error instanceof BridgePortError && (error.code === 'unknown-file' || error.code === 'invalid-request')) dropPrevious();
        throw error;
      }
      dropPrevious();
      return true;
    },

    async startScan(request): Promise<void> {
      if (mainBusy) throw new BridgePortError('busy');
      if (request.rootIds.length === 0) throw new BridgePortError('no-roots');
      const run = { cancelRequested: false };
      current = run;
      mainBusy = true;
      setProgress({ phase: 'running', fraction: 0, files: 0, skipped: [] });
      const rootIds = [...request.rootIds];
      const steps = { ...request.steps };
      const skipFolders = request.skipFolders === undefined ? undefined : [...request.skipFolders];
      const scanId = newScanId();
      runScanId = scanId;
      // A call that throws synchronously must release the busy flag too; otherwise every later scan is refused.
      let started: Promise<LibraryScanSummary>;
      try {
        started = scan({ rootIds, steps, skipFolders, scanId });
      } catch {
        mainBusy = false;
        current = null;
        setProgress({ phase: 'idle', fraction: 0, files: 0, skipped: [] });
        emit({ type: 'failed' });
        return;
      }
      // A run that was asked to stop ends as cancelled whatever the bridge answers: its result is not applied.
      const finishCancelled = () => {
        mainBusy = false;
        current = null;
        setProgress({ phase: 'cancelled', fraction: 0, files: 0, skipped: [] });
      };
      void started.then(
        summary => {
          mainBusy = false;
          if (run.cancelRequested) return finishCancelled();
          current = null;
          for (const entry of summary.roots) {
            const previous = sessionRoots.get(entry.rootId);
            if (previous === undefined) continue;
            sessionRoots.set(entry.rootId, {
              ...previous,
              coverage: coverageOf(entry.scanned, entry.complete),
              folderCount: entry.folderCount,
              fileCount: entry.fileCount,
            });
            if (entry.scanned) scannedRoots.add(entry.rootId); else scannedRoots.delete(entry.rootId);
          }
          generation++;
          const skipped = [...new Set([...skippedStepsOf(summary), ...summary.skippedByRequest])];
          setProgress({ phase: 'done', fraction: 1, files: summary.fileCount, skipped, result: resultOf(summary) });
          emit({ type: 'changed', generation });
        },
        () => {
          if (run.cancelRequested) return finishCancelled();
          mainBusy = false;
          current = null;
          setProgress({ phase: 'idle', fraction: 0, files: 0, skipped: [] });
          emit({ type: 'failed' });
        },
      );
    },

    async pauseScan(): Promise<void> {
      throw new BridgePortError('unsupported');
    },

    async resumeScan(): Promise<void> {
      throw new BridgePortError('unsupported');
    },

    // Cancel asks the main process to stop. The view shows "stopping" until the scan has really ended; Start stays off until then.
    async cancelScan(): Promise<void> {
      const run = current;
      if (run === null) return;
      if (cancelBridge === undefined) throw new BridgePortError('unsupported');
      run.cancelRequested = true;
      setProgress({ ...progress, phase: 'stopping' });
      await cancelBridge();
    },

    // Switches one step off in the running scan, before the step starts. The bridge refuses it when no scan with this id runs.
    async skipStep(step: StepName): Promise<void> {
      if (current === null || runScanId === null) throw new BridgePortError('no-scan');
      if (skipStepBridge === undefined) throw new BridgePortError('unsupported');
      try {
        await skipStepBridge({ scanId: runScanId, step });
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
        if (code === 'LIBRARY_NO_SCAN') throw new BridgePortError('no-scan');
        if (code === 'LIBRARY_INVALID_REQUEST') throw new BridgePortError('invalid-request');
        throw error;
      }
    },

    ...(listFolders === undefined ? {} : { listFolders }),
    ...(listBoards === undefined ? {} : { listBoards }),
    ...(boardDetail === undefined ? {} : { boardDetail }),

    subscribe(listener: (event: DeviceEvent) => void): () => void {
      listeners.add(listener);
      // A view opened during a scan starts from the current state, not from idle.
      listener({ type: 'progress', progress });
      return () => { listeners.delete(listener); };
    },
  };
}

/** The port over the window bridge of this window, or null when the bridge is not there (tests, browsers). */
export function windowDevicePort(desktop: LibraryBridge | undefined, source?: PlatformSource): DeviceDatabasePort | null {
  const navigatorSource = source ?? (typeof navigator === 'undefined' ? undefined : navigator);
  return createBridgeDevicePort(desktop, devicePlatformOf(navigatorSource));
}
