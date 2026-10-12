import type { DiagnosticReport } from './diagnostics/report';
import type { Language, ParseIssue } from './i18n';
import type { DocumentKind, DocumentLocateRequest, DocumentLocateResult, DocumentPayload, WorkspaceExportRequest, WorkspaceExportResult, WorkspaceManifest } from './documents';
import type { AppendResult, FamilyListEntry, RawFamilySnapshot, ReadingsExportRequest, ReadingsExportResult, ReadingsImportFile } from './readings/model';
import type { RepairEvent } from './readings/schema';
import type { Correction, CorrectionDocument } from './library/devices/corrections';
import type { StepName } from './library/devices/catalogue';

export type { Language, ParseIssue };
export type BoardSide = 'top' | 'bottom' | 'both';
export type ViewSide = 'top' | 'bottom';
export interface Point { x: number; y: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface BoardPin extends Point {
  /** Session-local handle (numbered by the parser); never persist it. Notes use the (reference, pin number) keys of note-keys.ts. */
  id: string;
  componentId: string;
  number: string;
  /** True when the file gives this pad no number and `number` is a placeholder made by the importer; such a number is not an identity. */
  numberGenerated?: true;
  name: string;
  net: string;
  side: BoardSide;
  radius: number;
  shape: 'round' | 'rect' | 'square';
  width?: number;
  height?: number;
  /** Counter-clockwise degrees in canonical Y-up coordinates; dimensions remain local. */
  rotation?: number;
}
export interface BoardComponent {
  /** Session-local handle (numbered by the parser); never persist it. Notes use the reference keys of note-keys.ts. */
  id: string;
  ref: string;
  /** True when the file gives this component no reference designator and `ref` is a placeholder made by the importer; such a reference is not an identity. */
  refGenerated?: true;
  value: string;
  package: string;
  side: BoardSide;
  bounds: Bounds;
  position: Point;
  rotation: number;
  pinIds: string[];
  outline: Point[];
}
export interface BoardNet { id: string; name: string; pinIds: string[] }
export interface Board {
  name: string;
  format: string;
  units: 'mm';
  components: BoardComponent[];
  pins: BoardPin[];
  nets: BoardNet[];
  outline: Point[];
  bounds: Bounds;
  /** Structured, so the info dialog is rendered in the language active at that moment. */
  warnings: ParseIssue[];
  /** Present only when shortened BDV or ASC component/pin headers can change the earlier reader's positional component/pin ids. */
  legacyPositionalNotesUnsafe?: true;
  /** Copper and drill data (ODB++ only today). Absent when the file has none; drawn by the board view (board-copper.ts). Same mm frame as components and pins. */
  copper?: BoardCopper;
}
/** Copper pads, track lines and arcs of the top and bottom copper layers, and drilled holes. Pours and text are not read. */
export interface BoardCopper {
  pads: CopperPad[];
  lines: CopperLine[];
  arcs: CopperArc[];
  holes: DrillHole[];
}
export type CopperSide = 'top' | 'bottom';
export interface CopperPad {
  side: CopperSide;
  x: number;
  y: number;
  shape: 'round' | 'square' | 'rect' | 'oval';
  /** Size along the pad's own axes before rotation, mm (a round pad has equal width and height: its diameter). */
  width: number;
  height: number;
  /**
   * Counter-clockwise degrees in canonical Y-up coordinates (the pin convention). The file's angle is clockwise and its mirror is applied
   * after the turn; the parser folds both in (odbpp-copper.ts traceAngle) and does not rotate or mirror the shape itself.
   */
  rotation: number;
  /** The file marks the pad as mirrored (ODB++ orientation code 9). */
  mirrored: boolean;
}
export interface CopperLine { side: CopperSide; x1: number; y1: number; x2: number; y2: number; width: number }
export interface CopperArc { side: CopperSide; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; width: number; clockwise: boolean }
export interface DrillHole {
  x: number;
  y: number;
  shape: 'round' | 'oval';
  /** Diameter (round) or slot width and length (oval), mm. */
  width: number;
  height: number;
  /** Counter-clockwise degrees, as CopperPad.rotation (slots only; a round hole does not turn). */
  rotation: number;
  /** From the tools file: plated, non-plated, via (a plated via), or unknown when the tools of this size disagree or none matches. */
  plating: 'plated' | 'non-plated' | 'via' | 'unknown';
}
/** Original bytes of the chosen file; the parser (never the transport) decides the format. */
export interface FilePayload {
  name: string;
  path: string;
  data: Uint8Array;
  /** Fixed companion files from the same directory, keyed by lowercase basename. */
  companions?: Record<string, Uint8Array>;
  /** SHA-256 hex of the ORIGINAL bytes of the primary file: the notes identity. */
  key: string;
  startupSource?: 'argument' | 'recent';
}
/** Session-only keys for encrypted boardviews; never persisted. */
export type ImportOptions = import('./formats/common').ParseOptions;
/** A recognized-but-unreadable file, as the parser dispatcher reports it: English text, and a catalog message when there is one. */
export interface FormatFailure { message: string; code: string; format?: string; keyKind?: 'fz' | 'xzz'; issue?: ParseIssue }
export interface RecentFile { name: string; path: string; openedAt: string }
/** A place on the board in millimetres (rounded to 1 µm) plus the side it is on: the explicit fallback identity of an object the file does not name uniquely. */
export interface NoteAnchor { side: BoardSide; x: number; y: number }
/**
 * What a note is about, independent of how any parser numbers its records (grammar and rules: src/lib/note-keys.ts).
 * A part is `ref` (its normalized reference designator) and a pin is `ref` plus `pin` (its normalized pin number); the optional anchors apply
 * only where the file does not name the object uniquely: `at` tells apart parts that share a reference (or have none), `pinAt` names a pad
 * without a number. At least one of `ref` and `at` is present; `pin` and `pinAt` never both.
 */
export interface NoteKey { ref?: string; at?: NoteAnchor; pin?: string; pinAt?: NoteAnchor }
/** Why a note is not attached to a part or pin of the open board. The notes themselves are always kept. */
export type NoteProblem =
  | 'component-missing' | 'component-ambiguous' | 'pin-missing' | 'pin-ambiguous'
  | 'legacy-id-missing' | 'legacy-indistinguishable' | 'legacy-order-unknown' | 'duplicate-target';
interface NoteBase {
  id: string;
  text: string;
  /** Free-text values the technician measured, as typed ("1.8 V", "0.4 Ω"). */
  measurements?: { voltage?: string; resistance?: string; other?: string };
  updatedAt: string;
}
/** Technician-entered record, never an inferred measurement. One note per target: a part (`ref`) or one of its pins (`ref` + `pin`). */
export interface KeyedNote extends NoteBase { target: NoteKey }
/**
 * A note written before notes had keys: it names the importer's positional ids (`part:12`, `pin:341`). It is read, never created. Opening the
 * board turns it into a KeyedNote once (the id is looked up in this board as the current importer reads it); what cannot be resolved stays
 * here with `unresolved` filled in, so it is listed instead of being guessed or dropped.
 */
export interface LegacyNote extends NoteBase {
  componentId: string;
  /** BoardPin.id when the note belonged to a single pin of the component. */
  pinId?: string;
  unresolved?: { reason: NoteProblem; at: string };
}
export type BoardNote = KeyedNote | LegacyNote;
export interface AppSettings {
  language: Language;
  theme: 'dark' | 'light' | 'system';
  layout: 'workshop' | 'focus';
  motion: boolean;
  showLabels: boolean;
  showConnections: boolean;
  /** Ask GitHub once per launch whether a newer release exists (a notification only, nothing is installed). Off by default; profiles saved before this setting existed get false. */
  updateCheck: boolean;
  /** The first-start question about updateCheck has been answered or skipped. Asked once, never again. */
  updateCheckAsked: boolean;
}
/** What the main process reports about the latest release (see electron/updates.cjs); no tag, no URL, no server text. */
export type UpdateCheckResult = { status: 'available'; version: string } | { status: 'current' } | { status: 'unavailable' };
/** A network feature as the main process lists it (electron/net/egress.cjs): its hosts, the setting that switches it on (null: none) and whether it is on now. */
export interface NetworkFeature { id: string; hosts: string[]; optIn: string | null; enabled: boolean }
/** One line of the in-memory network log. `outcome` pending: still running; refused: blocked by policy before anything was sent; error: failed after sending. `error` is a class from a fixed list, never a message. */
export interface NetworkActivityEntry {
  id: number; time: string; kind: 'request' | 'download'; feature: string; method: string; host: string; path: string;
  outcome: 'pending' | 'ok' | 'refused' | 'error'; status: number | null; bytes: number; durationMs: number | null; error: string | null;
}
export interface NetworkActivityReport { features: NetworkFeature[]; entries: NetworkActivityEntry[]; dropped: number; limit: number }

/** The Linux "Do not ask again" answer: `applicable` is false where TRACE is never asked (Windows, macOS); `saved` is the stored answer. */
export interface NoSandboxConsent { applicable: boolean; saved: boolean }
export interface CanvasStatus {
  zoom: number;
  x: number;
  y: number;
  rotation: number;
  measurement: number | null;
}
export interface ViewCommand {
  type: 'fit' | 'zoom-in' | 'zoom-out' | 'center-selection' | 'rotate';
  nonce: number;
}
/**
 * Native rejections arrive with a stable machine code as a "[CODE] text" message prefix (see nativeErrorCode in workspace.ts). Quit-time codes:
 * STORE_CLOSING (a write after the quit intent), EXPORT_CLOSING (export after the quit intent), BOARD_CLOSING (open-board chooser after the quit intent),
 * DOCUMENT_CLOSING (document chooser after the quit intent). All are permanent for the current process: do not retry them.
 */
/**
 * What the main process hands over for a format diagnostic report: the bytes of the file the user chose under a neutral name (an extension only, or the fixed role name of a
 * companion-set member; never the real name or folder), its companions, the operating system family and the dedupe code (an HMAC under a secret that stays in the main process).
 */
export interface DiagnosticFilePayload { name: string; data: Uint8Array; companions?: Record<string, Uint8Array>; os: 'win32' | 'darwin' | 'linux' | 'other'; dedupe: string }
export interface SupportStatus { status: 'inactive' | 'verified' | 'pending' | 'unavailable'; expiresAt: number | null; available: boolean }

export interface TraceDesktop {
  /** True only in a packaged QA build started with the device-database QA switch (electron/device-switch.cjs); false otherwise. */
  readonly qaDeviceDatabase?: boolean;
  openBoard(): Promise<FilePayload | null>;
  readBoard(path: string): Promise<FilePayload>;
  acceptBoard(path: string, key: string): Promise<void>;
  initialBoard(): Promise<FilePayload | null>;
  recentBoards(): Promise<RecentFile[]>;
  /** The language saved in the settings, known before the first paint (null when none is saved). The renderer starts in it (TB-041). */
  readonly initialLanguage?: string | null;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  getNotes(boardKey: string): Promise<BoardNote[]>;
  saveNotes(boardKey: string, notes: BoardNote[]): Promise<void>;
  minimize(): void;
  maximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximized(listener: (value: boolean) => void): () => void;
  /** The settings file was locked and is readable again: the saved settings are read again (main.cjs rereadLockedConfig). */
  onSettingsChanged?(listener: () => void): () => void;
  /** The settings file state (main.cjs configState; the notice is ConfigNotice). */
  getConfigState?(): Promise<{ state: ConfigState }>;
  onConfigStateChanged?(listener: (state: ConfigState) => void): () => void;
  droppedFilePath(file: File): string;
  onOpenBoard(listener: (payload: FilePayload) => void): () => void;
  /** An external open that the main process could not read (its message, already in the application's language). Optional: an older preload lacks it. */
  onOpenFailed?(listener: (message: string) => void): () => void;
  /** Main process asks the renderer to write its pending (debounced) state before the window closes or the app quits; the bridge answers when every listener settled. Optional: an older preload or the browser build lacks it. */
  onFlushRequest?(listener: () => Promise<void> | void): () => void;
  /** Persisted workspace manifest of one board (null when none was saved); validated natively, bounded, never attached to another board. */
  loadWorkspace(boardKey: string): Promise<WorkspaceManifest | null>;
  /** Queued atomic write; rejected once the application is quitting. */
  saveWorkspace(boardKey: string, manifest: WorkspaceManifest): Promise<void>;
  /** Native multi-select dialog for documents; every file is sniffed, size-bounded and hashed. Cancel resolves []. */
  pickDocuments(options?: { kinds?: DocumentKind[]; multiple?: boolean }): Promise<DocumentPayload[]>;
  /** Reads one absolute path (restore after restart, relink); content must match an allowed kind. */
  readDocument(path: string, options?: { kinds?: DocumentKind[] }): Promise<DocumentPayload>;
  /** Re-finds remembered documents by absolute path, then by path relative to the board's directory, and verifies SHA-256. */
  locateDocuments(boardPath: string, requests: DocumentLocateRequest[]): Promise<DocumentLocateResult[]>;
  /** Save dialog + zip bundle of ONLY the documents (and optionally board/notes) the user selected. Cancel resolves null. */
  exportWorkspace(request: WorkspaceExportRequest): Promise<WorkspaceExportResult | null>;
  /** Format diagnostic report (Help): main opens the file dialog (any file) and reads the file with its companions. Cancel resolves null. Optional: an older preload lacks it. */
  pickDiagnosticFile?(): Promise<DiagnosticFilePayload | null>;
  /** Format diagnostic report: main validates the report against the closed schema again, opens the save dialog and writes the canonical text. Cancel resolves null; rejects with a DIAGNOSTIC_* code. Optional: an older preload lacks it. */
  saveDiagnosticReport?(report: DiagnosticReport): Promise<{ bytes: number } | null>;
  /** Prepare an immutable local report preview. No network request is made. Optional for older or browser bridges. */
  prepareBugReport?(request: BugReportInput): Promise<BugReportPrepareResult>;
  /** Explicitly send only the report identified by a current main-process preview handle. Optional for older bridges. */
  sendBugReport?(request: { prepareId: string }): Promise<BugReportSendResult>;
  /** Cancel the current send for this preview. A cancellation after transmission is uncertain. Optional for older bridges. */
  cancelBugReport?(request: { prepareId: string }): Promise<BugReportCancelResult>;
  /** Read the optional local draft and exact pending retry payload. Never sends. Optional for older bridges. */
  getBugReportDraft?(): Promise<BugReportDraftResult>;
  /** Save a bounded local draft. Never sends. Optional for older bridges. */
  saveBugReportDraft?(request: BugReportInput): Promise<{ status: 'saved' } | BugReportErrorResult>;
  /** Discard the local draft and pending retry journal, including an uncertain attempted report. This only removes local data; it does not delete a report remotely. Optional for older bridges. */
  discardBugReportDraft?(): Promise<{ status: 'discarded' } | BugReportErrorResult>;
  /** Support notice and top bar: asks the main process to open one of three fixed links (Stripe, Ko-fi, or the support page) in the system browser. The renderer sends an id, never a URL; any other id is rejected. Optional: an older preload lacks it. */
  openSupportLink?(id: 'stripe' | 'kofi' | 'support'): Promise<void>;
  getSupportStatus?(): Promise<SupportStatus>;
  prepareSupport?(): Promise<SupportStatus & { code: string }>;
  /** Support Verify button only: `userAction: true` marks the explicit press. Without it the main process makes no receipt request while the support opt-in is off. */
  checkSupport?(request?: { userAction?: boolean }): Promise<SupportStatus>;
  /** Startup update check: main enforces the saved updateCheck setting. Never rejects for network reasons. Optional: an older preload lacks it. */
  checkForStartupUpdates?(): Promise<UpdateCheckResult>;
  /** Manual Settings update check: one request from the main process to the fixed releases API, even when automatic checks are off. Never rejects for network reasons. Optional: an older preload lacks it. */
  checkForUpdates?(): Promise<UpdateCheckResult>;
  /** Opens the release page of the version the last check reported, in the system browser. Takes no argument: the main process remembers the validated tag, the renderer never sends a URL. Rejects when no update was found. Optional: an older preload lacks it. */
  openUpdatePage?(): Promise<void>;
  /** Network activity (Settings > Network): the network features and the in-memory log of every request the main process made, as plain data (see src/lib/network-activity.ts). Takes no argument. Optional: an older preload lacks it. */
  getNetworkActivity?(): Promise<NetworkActivityReport>;
  /** Empties that log. Takes no argument; the log is read-only otherwise. Optional: an older preload lacks it. */
  clearNetworkActivity?(): Promise<void>;
  /** Linux "Do not ask again" (Settings): whether this platform is asked at all, and whether the answer is stored. Optional: an older preload lacks it. */
  getNoSandboxConsent?(): Promise<NoSandboxConsent>;
  /** Takes the stored answer back: the question comes again at the next start without the sandbox. Rejects when the setting cannot be saved. */
  revokeNoSandboxConsent?(): Promise<NoSandboxConsent>;
  /** Readings (src/lib/readings, docs/READINGS_FORMAT.md): every board family of the repair store, without its readings. Optional: an older preload lacks it. */
  listReadingFamilies?(): Promise<FamilyListEntry[]>;
  /** One family (null when it does not exist); the readings come as the text of one JSON array, see parseFamilySnapshot. */
  readReadings?(familyId: string, options?: { headerOnly?: boolean }): Promise<RawFamilySnapshot | null>;
  /** Appends the events of one call (all or nothing), validated natively; rejects with a READINGS_* code. */
  appendReadings?(familyId: string, events: RepairEvent[]): Promise<AppendResult>;
  /** Native open dialog for a readings file (pack, CSV, OpenBoardData text): its base name and text. Cancel resolves null. */
  importReadings?(): Promise<ReadingsImportFile | null>;
  /** Native save dialog, then writes the pack (validated natively) as a pack file or CSV. Cancel resolves null. */
  exportReadings?(request: ReadingsExportRequest): Promise<ReadingsExportResult | null>;
  /** Library device catalogue: native folder chooser (main window). Resolves the opaque root id and the folder's own name, or null when cancelled. The path never reaches the renderer. Optional: an older preload lacks it. */
  libraryPickRoot?(): Promise<{ rootId: string; label: string } | null>;
  /** The persisted root list: opaque id, the folder's own name, whether its path is reachable now (measured), the network flag ('unknown': not measured) and the last scan's coverage ('unknown' when not scanned). */
  libraryListRoots?(): Promise<LibraryRootList>;
  /** Removes a root from the list. The files are never touched; corrections that name it stay. */
  libraryRemoveRoot?(request: { rootId: string }): Promise<{ removed: true }>;
  /** Read-only scan of recorded roots. Optional skipFolders are folder ids from libraryListFolders. Resolves counts only; rejects with a LIBRARY_* code (LIBRARY_CANCELLED when cancelled). */
  libraryScan?(request: { rootIds: string[]; steps?: Partial<Record<StepName, boolean>>; skipFolders?: string[]; scanId?: string }): Promise<LibraryScanSummary>;
  /** Aborts the running scan. Resolves whether a scan was running. */
  libraryCancelScan?(): Promise<{ cancelled: boolean }>;
  /** Switches one step of the running scan off before it starts. scanId is the id the scan was started with (the renderer may choose it). The result of that scan is incomplete. */
  libraryScanSkipStep?(request: { scanId: string; step: StepName }): Promise<{ scanId: string; step: StepName; accepted: true; complete: false }>;
  /** One level of the folder tree of a scanned root (parentId omitted: the top level). Paged by cursor. Counts and opaque ids only. */
  libraryListFolders?(request: { rootId: string; parentId?: string; cursor?: string; limit?: number }): Promise<LibraryFolderPage>;
  /** The boards that have files under a scanned root. Paged by cursor. Counts and opaque ids only. */
  libraryListBoards?(request: { rootId: string; cursor?: string; limit?: number }): Promise<LibraryBoardPage>;
  /** One board: its boardview and BIOS presence ('confirmed' | 'candidate' | 'none' | 'unknown'), board code and revision, and its files (opaque ids, roles, states). */
  libraryBoardDetail?(request: { boardId: string }): Promise<LibraryBoardDetail>;
  /** The durable corrections (userData). status is the store's verdict ('quarantined' after a damaged file was moved aside, with no file name); document is null when the file cannot be used. */
  libraryLoadCorrections?(): Promise<{ status: string; document: LibraryCorrectionDocument | null; dropped: number; rejections: LibraryRejection[] }>;
  /** Saves the corrections of this platform atomically. 'refused' writes nothing and names each refused entry; rejects with a LIBRARY_* code. */
  librarySaveCorrections?(document: LibraryCorrectionDocument): Promise<{ status: 'saved'; bytes: number; quarantine?: string; quarantinedEntries?: number } | { status: 'refused'; rejections: LibraryRejection[] }>;
}
/** A measured value, or 'unknown' when the scan did not measure it. Never false by default. */
export type LibraryMeasure = number | 'unknown';
export type LibraryPresence = 'confirmed' | 'candidate' | 'none' | 'unknown';
export interface LibraryRootList {
  roots: Array<{ rootId: string; label: string; online: boolean; network: 'unknown'; scanned: boolean; complete: boolean | 'unknown' }>;
  total: number;
}
export interface LibraryScanSummary {
  steps: Record<StepName, 'ran' | 'skipped'>;
  complete: boolean;
  scanId: string;
  /** The steps switched off during the run by libraryScanSkipStep. */
  skippedByRequest: StepName[];
  roots: Array<{ rootId: string; complete: boolean; scanned: boolean; folderCount: number; fileCount: number; skippedCount: number }>;
  fileCount: number;
  associationCount: number;
  anchorCount: number;
  missingTargetCount: LibraryMeasure;
  excludedFirmwareCount: number;
  collisionCount: number;
  /** Items the user must confirm by hand (darwin case-collisions of corrections); the count only, never a path. */
  needsManualCount: number;
  /** Files that need a manual role classification; the count only. */
  manualClassificationCount: number;
  stats: { folders: number; files: number; entries: number; match: { files: number; candidates: number; judgments: number; linkSteps: number } };
  correctionsStatus: string;
}
/** A refused correction entry: the closed reason and the localisation key of its text (no internal message). */
/** A correction as the renderer names it: files and boards by opaque id, never by path. */
export interface LibraryCorrectionById { op: string; fileId?: string; boardAnchorId?: string; [key: string]: unknown }
export interface LibraryCorrectionDocument { version: number; platform: string; corrections: LibraryCorrectionById[] }
export interface LibraryRejection {
  index: number;
  reason: 'invalid-entry' | 'unknown-role' | 'path-too-long' | 'too-many';
  messageKey: string;
}
export interface LibraryFolderPage {
  generation: number;
  scanned: boolean;
  complete: boolean;
  skippedCount: number;
  /** Folder rows: the folder's own name (basename only, never a full path), its read state (`code` only for an unreadable folder) and an opaque id. */
  folders: Array<{
    folderId: string;
    name: string;
    readState: 'pending' | 'listed' | 'unreadable' | 'skipped';
    code?: string;
    folderCount: number;
    fileCount: number;
    bytes: number;
    childFolderCount: number;
  }>;
  total: number;
  nextCursor?: string;
  /** The files directly in the listed folder (the top level when parentId is omitted): opaque id, basename and role (null when unknown). */
  files: Array<{ fileId: string; name: string; role: string | null }>;
  fileTotal: number;
  filesTruncated: boolean;
}
export interface LibraryBoardPage {
  generation: number;
  scanned: boolean;
  complete: boolean;
  indexedFileCount: number;
  manualClassificationCount: number;
  missingTargetCount: LibraryMeasure;
  collisionCount: number;
  boards: Array<{ boardId: string; boardAnchorId: string; fileCount: number; confirmed: number; probable: number; review: number; boardview: LibraryPresence; bios: LibraryPresence }>;
  total: number;
  nextCursor?: string;
}
export interface LibraryBoardDetail {
  generation: number;
  boardId: string;
  boardAnchorId: string;
  boardCode: string | null;
  revision: string | null;
  boardview: LibraryPresence;
  bios: LibraryPresence;
  complete: boolean;
  /** `online` is set for a file whose content is not on this computer (a cloud placeholder); it is never read. */
  files: Array<{ fileId: string; name: string | null; rootId: string; role: string; state: 'confirmed' | 'probable' | 'review'; online?: true }>;
  filesTruncated: boolean;
}


export type BugReportLastImport = {
  outcome: 'reading' | 'processing' | 'opened' | 'failed' | 'cancelled' | 'key-required' | 'timeout' | 'worker-failed';
  stage: 'read' | 'detect' | 'unpack' | 'parse' | 'done' | 'unknown';
  formatId: string | null; extensionClass: string; errorCode: string | null;
} | null;
export type BugReportDiagnostics = {
  app: { version: string; platform: 'windows' | 'macos' | 'linux' | 'other'; arch: 'x64' | 'arm64' | 'other' };
  locale: 'hu' | 'en' | 'de' | 'fr' | 'it' | 'sk' | 'pl' | 'uk';
  surface: 'welcome' | 'board' | 'documents' | 'schematic' | 'settings' | 'other'; lastImport: BugReportLastImport;
} | null;
export type BugReport = { schema: 'trace-bug-report/1'; reportId: string; description: string; diagnostics: BugReportDiagnostics };
export type BugReportInput = { description: string; includeDiagnostics: boolean; context: { surface: 'welcome' | 'board' | 'documents' | 'schematic' | 'settings' | 'other'; lastImport: BugReportLastImport } | null };
export type BugReportError = 'offline' | 'timeout' | 'cancelled' | 'invalid' | 'too-large' | 'rate-limited' | 'unavailable' | 'storage' | 'conflict' | 'busy' | 'stale-preview' | 'unknown';
export type BugReportErrorResult = { status: 'error'; error: BugReportError; retryAfterSeconds?: number };
export type BugReportPrepareResult = { status: 'prepared'; prepareId: string; report: BugReport; canonicalText: string; payloadHash: string } | BugReportErrorResult;
/** A cancelled send has the same shape as the cancel reply: `uncertain` is true only after the request may have left the machine. */
export type BugReportSendResult = { status: 'received'; reportId: string; payloadHash: string } | BugReportCancelResult;
export type BugReportCancelResult = { status: 'cancelled'; uncertain: boolean } | BugReportErrorResult;
export type BugReportDraftResult = { status: 'empty' } | { status: 'available'; draft: BugReportInput | null; pending: { report: BugReport; canonicalText: string; payloadHash: string } | null } | BugReportErrorResult;
declare global { interface Window { traceDesktop?: TraceDesktop } }

/** The state of config.json as the main process reports it: ok, locked by another program, unreadable (damaged or another version), or read-only. */
export type ConfigState = 'ok' | 'locked' | 'unreadable' | 'readonly';
