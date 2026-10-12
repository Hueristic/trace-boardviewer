/**
 * The port the device database view (src/components/library/DevicesView.tsx) talks to.
 *
 * The view never touches the file system, the database or IPC directly. It calls only this interface. The implementation is the
 * Library service side: a root picker on the native folder dialog (main process), the folder map and scan (L4 scanner), the
 * content summaries (L5), the groups and matching (L6 through devices/catalogue.ts) and the durable correction store (L3). Until
 * that wiring exists, the view is rendered with a port that reports the service as unavailable, and it is not reachable from the
 * application shell.
 *
 * Contract rules the implementation must keep:
 * - Every list is paged; `limit` is at most MAX_PAGE. A cursor is opaque and bound to its query and generation. A page from an
 *   older generation is rejected by the implementation, and the view drops any response that does not match its latest request.
 * - Paths in the view are root-relative canonical paths ('' is the root itself). A file is named by its root id and path only;
 *   absolute paths never cross this boundary.
 * - "Not found" (`SlotAvailability` not-found) is only returned when the scope is complete (see devices/availability.ts).
 * - A correction is durable and targets a file by root id and path (devices/corrections.ts). Saving never moves or changes a file.
 */
import type { SlotAvailability } from './availability';
import type { Association } from './match';
import type { Correction } from './corrections';
import type { FileRole } from './identity';
import type { DevicePlatform } from './paths';
import type { StepName, StepSwitches } from './catalogue';
import type { RejectReason } from './corrections';

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 100;

/** 'pending': the folder has not been part of a finished scan yet. */
export type RootCoverageView = 'pending' | 'complete' | 'partial' | 'paused' | 'cancelled' | 'offline' | 'denied' | 'skipped';

export interface RootSummary {
  rootId: string;
  /** The folder's own name, as the user chose it. Not translated. */
  label: string;
  coverage: RootCoverageView;
  /** Recursive totals below the root (folders and files), as the folder map counts them. */
  folderCount: number;
  fileCount: number;
  /** Undefined when the bridge does not say whether the folder is on the network (not claimed either way). */
  network?: boolean;
}

/** The read state of a folder node: not reached yet, read, unreadable (kept in the map) or not read (skipped). */
export type FolderReadState = 'pending' | 'listed' | 'unreadable' | 'skipped';

export interface FolderSummary {
  /** Root-relative canonical path, or the opaque folder id when the bridge sends ids. */
  path: string;
  readState?: FolderReadState;
  /** The closed diagnostic code of an unreadable folder. */
  code?: string;
  /** Recursive totals below this folder, as the folder map counts them. folderCount > 0 means it has subfolders. */
  name: string;
  folderCount: number;
  fileCount: number;
  bytes: number;
}

export interface FolderPage {
  folders: FolderSummary[];
  /** Entries that were not read (links, special files, unreadable or over-limit folders) in this folder. */
  notRead: number;
  /** False when a limit or an unreadable folder stopped the map below this folder. */
  complete: boolean;
}

export type BoardStatusFilter = 'all' | 'found' | 'notFound' | 'unknown';

export interface BoardQuery {
  /** Free text, matched by the implementation against board code, revision, names, model and file names. */
  text: string;
  status: BoardStatusFilter;
  cursor?: string;
  limit: number;
}

/** A motherboard group's status for one kind of file. */
export type BoardPresence = 'confirmed' | 'candidate' | 'none' | 'unknown';

export interface SlotInput {
  /** The folder-map answer for this kind (local scan). Absent when the bridge gives a presence answer instead. */
  availability?: SlotAvailability;
  /** The bridge's presence answer. 'none' means not found only when the scan is complete ('complete'). */
  presence?: BoardPresence;
  complete?: boolean;
  /** The best confidence among the candidates of this kind. Absent when there are no candidates. */
  bestState?: Association['state'];
  basis?: Association['basis'];
}

export interface BoardRow {
  anchorId: string;
  /** The board's anchor id: the target of a board-level correction. Set when the bridge sends it. */
  boardAnchorId?: string;
  boardCode?: string;
  revision?: string;
  /** Other search names of this motherboard (aliases), already limited by the implementation. */
  names: string[];
  /** Device models that use this motherboard. A board can have several; the rows are not merged. */
  models: string[];
  boardview: SlotInput;
  schematic: SlotInput;
  bios: SlotInput;
}

export interface BoardPage {
  rows: BoardRow[];
  total: number;
  cursor?: string;
  /** The scan generation this page belongs to. */
  generation: number;
}

export interface BoardFile {
  /** Opaque file id from the bridge; the correction target once the bridge translates it. */
  fileId?: string;
  /** The file's basename, when the bridge sends it. */
  name?: string;
  rootId: string;
  /** Root-relative path; empty when the bridge does not send one (no path crosses the bridge). */
  path: string;
  role: FileRole;
  association?: Association;
  /** The confidence the bridge gives this file, when it sends one. */
  confidence?: 'confirmed' | 'probable' | 'review';
  /** True for an online-only file (a cloud placeholder): listed by name and size, its content is not on this computer and is never read. */
  online?: true;
}

export interface BoardDetail {
  row: BoardRow;
  files: BoardFile[];
  /** True when the implementation has more files for this board than it sends; the view then says so. */
  filesTruncated: boolean;
}

export interface PickedRoot { rootId: string; label: string }

export interface ScanRequest {
  rootIds: readonly string[];
  steps: Partial<StepSwitches>;
  /** Folder ids (from listFolders) that the scan does not read. */
  skipFolders?: readonly string[];
}

/** Counts of a finished scan. No path and no file name: the view shows numbers only. */
export interface ScanResultView {
  fileCount: number;
  associationCount: number;
  /** Undefined when the scan did not measure it: shown as not known, never as zero. */
  missingTargetCount?: number;
  excludedFirmwareCount: number;
  collisionCount: number;
  /** Items to confirm by hand; counts only. */
  needsManualCount: number;
  /** Entries that were not read, summed over the roots. */
  notRead: number;
  /** False when the scan did not read every folder. Undefined when the bridge does not say. */
  complete?: boolean;
  /** The saved corrections' status after the scan; 'quarantined' when the store set the damaged file aside (TB-065). */
  correctionsStatus?: string;
}

export interface ScanProgressView {
  /** 'stopping': a cancel was asked and the main process has not ended the scan yet. */
  phase: 'idle' | 'running' | 'paused' | 'stopping' | 'cancelled' | 'done';
  /** The step that is running, when there is one. */
  step?: StepName;
  /** 0 to 1 over the whole scan. */
  fraction: number;
  files: number;
  skipped: StepName[];
  /** Present once a scan has finished. */
  result?: ScanResultView;
}

/** What the implementation can really do. A control the implementation cannot perform is hidden, not offered and then refused. */
export interface DeviceCapabilities {
  pauseScan: boolean;
  skipStep: boolean;
  removeRoot: boolean;
  /** A folder of the tree can be left out of the next scan. */
  skipFolders: boolean;
}

export type DeviceEvent =
  | { type: 'progress'; progress: ScanProgressView }
  | { type: 'changed'; generation: number }
  /** A background scan ended with an error; the message carries no detail. */
  | { type: 'failed' };

/** A correction as the view names it: the file by its opaque id and the board by its anchor id. Never a path. */
export type PortCorrection =
  | { op: 'link' | 'unlink'; fileId: string; boardAnchorId: string }
  | { op: 'role'; fileId: string; role: FileRole | null }
  | { op: 'alias'; boardAnchorId: string; alias: string; remove: boolean }
  | { op: 'board-code'; boardAnchorId: string; code: string | null }
  | { op: 'revision'; boardAnchorId: string; revision: string | null };

export interface DeviceDatabasePort {
  /** The platform the view runs on. Correction values are checked against its path rules. */
  readonly platform: DevicePlatform;
  /** Optional: a port without this object offers every optional control (the view's earlier behaviour). */
  readonly capabilities?: DeviceCapabilities;
  /** Opens the native folder chooser. Resolves null when the user cancels. */
  pickRoot(): Promise<PickedRoot | null>;
  listRoots(): Promise<RootSummary[]>;
  /** Removes the folder from the index. The files on disk are never touched. Its corrections stay stored: they apply again when the same folder is added back, and after the removal they are shown with fresh ids. */
  removeRoot(rootId: string): Promise<void>;
  /** Optional: needs the folder-map and board-list channels, which are not on the bridge yet. Without them the tree and list stay empty. */
  listFolders?(rootId: string, path: string): Promise<FolderPage>;
  /** Optional, see listFolders. */
  listBoards?(query: BoardQuery): Promise<BoardPage>;
  /** Optional, see listFolders. */
  boardDetail?(anchorId: string): Promise<BoardDetail>;
  /** missingTarget is undefined when the implementation cannot tell whether the file is in the current scan. */
  /** quarantine: the base name and count of the entries the store set aside on this save (none when it set none). */
  saveCorrection(correction: PortCorrection): Promise<{ missingTarget?: boolean; quarantine?: { name: string; entries: number } }>;
  /** Restores the stored corrections to the state before the most recent correction saved through this port: the whole earlier document is written back, so a correction written by another writer after that point is lost too. The files on disk are never touched. */
  undoLastCorrection(): Promise<boolean>;
  startScan(request: ScanRequest): Promise<void>;
  pauseScan(): Promise<void>;
  resumeScan(): Promise<void>;
  cancelScan(): Promise<void>;
  /** Skips one optional step of the running scan. Ignored for steps that are not running. */
  skipStep(step: StepName): Promise<void>;
  /** Optional: the closed reasons why the stored corrections left some entries out (one per distinct reason). */
  correctionRejections?(): Promise<readonly RejectReason[]>;
  subscribe(listener: (event: DeviceEvent) => void): () => void;
}
