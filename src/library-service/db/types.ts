import type { BoardSummary, DocumentSummary, DuplicateSet, FileRole, FileState, GroupEvidence, ImageSummary, LibraryErrorCode, LibraryFile, LibraryGroup, LibraryId, LibraryKind, LibraryRevision, LibraryStage, RegisteredRoot, RootOptions, RootSummary, StageState, StoredDecision } from '../../lib/library/model';
import type { GroupDetail, QueryPage, SimilarGroup } from '../../lib/library/protocol';
import type { ParsedQuery, QueryRequest } from '../../lib/library/query';
import type { WriterHooks } from './writer';

/** A file seen by the walker. Loose files carry `dir` + `name`; archive members name their container file and the path inside it. */
interface ObservationBase { size: number; mtimeMs?: number; fileKey?: string; state?: FileState }
export interface LooseFileObservation extends ObservationBase { dir: string; name: string }
export interface EntryObservation extends ObservationBase { containerId: LibraryId; entryPath: string }
export type FileObservation = LooseFileObservation | EntryObservation;
export interface FileUpsertResult {
  status: 'new' | 'unchanged' | 'changed' | 'rejected';
  id?: LibraryId;
  contentId?: LibraryId;
  /** True when the file still needs its identity (quick key, hash) computed. */
  needsIdentity?: boolean;
  reason?: 'unknown-root' | 'invalid-path' | 'invalid-entry' | 'unknown-container' | 'invalid-value';
}

export interface ContentLink { fileId: LibraryId; quick: Uint8Array; size: number; sha256?: string }
export interface ContentLinkResult { contentId: LibraryId | null; created: boolean }
export interface SniffOutcome { kind: LibraryKind; format?: string; variant?: string; confidence?: number; needsKey?: 'fz' | 'xzz'; problem?: LibraryErrorCode }
export interface StageUpdate { stage: LibraryStage; version: number; state: StageState['state']; error?: LibraryErrorCode }
export interface PendingContent { contentId: LibraryId; kind: LibraryKind | null; format: string | null; size: number; attempts: number }
export interface AttemptDecision { allowed: boolean; attempts: number }
export interface SummaryCommit {
  contentId: LibraryId;
  summary: BoardSummary | DocumentSummary | ImageSummary;
  /** Stage rows written in the same transaction. Defaults to `summary` done at `extractorVersion`. */
  stages?: StageUpdate[];
  extractorVersion: number;
}
export interface SummaryCommitResult { ok: boolean; reason?: 'unknown-content' | 'invalid-summary'; postings: number; terms: number; identifiers: number; fullTextPages: number; fullText: 'stored' | 'not-requested' | 'not-allowed' | 'none'; droppedPostings: number }
export interface MoveReport { removedFileId: LibraryId; keptFileId: LibraryId; contentId: LibraryId }
export interface RootSyncReport { added: LibraryId[]; updated: LibraryId[]; unchanged: LibraryId[]; unregistered: LibraryId[] }
export interface RootRemoval { files: number; contents: number; groups: number }
export interface FullTextChange { purgedContents: number; pendingContents: number }

export interface GroupWrite extends Omit<LibraryGroup, 'members'> { members: LibraryGroup['members'] }
export interface SuggestionWrite { a: LibraryId; b: LibraryId; kind: 'layout-similar' | 'layout-related' | 'doc-coverage' | 'id-name' | 'proximity' | 'structured-link' | 'id-content' | 'fingerprint'; score: number; evidence: GroupEvidence[] }

export type QueryResult = QueryPage & { issues: ParsedQuery['issues'] };

export interface TableSize { name: string; rows: number; bytes: number }
export interface SizeReport {
  /** Main database file, write-ahead log and shared-memory file, in bytes. */
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  freeBytes: number;
  /** Loose files: the unit of the budget. Archive members are counted in `entries` and their cost is part of their archive's share. */
  files: number;
  entries: number;
  contents: number;
  /** Bytes of the whole index (database, log and shared memory) without the opt-in page text, per loose file. */
  bytesPerFile: number;
  /** `bytesPerFile` times 100,000: the number compared with the hard budget. */
  projectedPer100kFiles: number;
  budgetPer100kFiles: number;
  withinBudget: boolean;
  /** Logical tables (FTS shadow tables are folded into their virtual table), largest first. */
  tables: TableSize[];
  /** Bytes of `text_fts` and its shadow tables: separate from the metadata budget. */
  fullTextBytes: number;
  /** Per-table sizes need the dbstat virtual table; false when the SQLite build lacks it (then `tables` is empty). */
  perTable: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  level: 'quick' | 'full';
  /** Messages of the failing checks (empty when ok). */
  problems: string[];
  /** Name index rows that point at no file, files without a name index row (both repairable), and the same for the page text index. */
  fts: { nameOrphans: number; nameMissing: number; textOrphans: number };
}

export type DbHooks = WriterHooks;

/** Why a database was replaced by an empty one. The derived index is rebuilt by scanning again; user decisions come back from their file. */
export interface Recovery { reason: 'unreadable' | 'integrity' | 'migration-failed'; /** Name of the damaged copy kept next to the new database (at most one is kept). */ damagedFile?: string; detail?: string }

export interface OpenReport {
  /** A new, empty database was created (first run, a deleted index, or a rebuild). */
  created: boolean;
  migratedFrom?: number;
  /** The previous run did not close the database in an orderly way. */
  uncleanShutdown: boolean;
  /** The quick check ran at open (after an unclean shutdown). */
  checked: boolean;
  recovery?: Recovery;
  /** Roots whose removal was interrupted: the caller finishes them with `finishPendingRemovals`. */
  pendingRemovals: string[];
  /** Result of replaying the decisions file at open, when the options name one. */
  decisions?: { applied: number; unresolved: number; dropped: number };
}

export interface LibraryDbOptions {
  /** A file path, or `:memory:` (tests). */
  path: string;
  now?: () => number;
  ids?: import('./ids').IdSource;
  hooks?: DbHooks;
  maxUnitsPerTransaction?: number;
  /** Where the single `library.db.v<N>.bak` copy goes before a migration. Defaults to next to the database file. */
  backupDirectory?: string;
  migrations?: readonly import('./migrations').Migration[];
  schemaTarget?: number;
  /** Run the quick check at open even after an orderly close (the settings' check at start-up). */
  verify?: boolean;
  /** `library-decisions.json` of the profile. Read only, never written: it is the only copy of the user's corrections. */
  decisionsPath?: string;
  /** Test seam: stop after the backup copy of a migration was made (default none). */
  onBackup?(file: string): void;
}

export type { BoardSummary, DocumentSummary, DuplicateSet, FileRole, FileState, GroupDetail, ImageSummary, LibraryFile, LibraryGroup, LibraryId, LibraryRevision, ParsedQuery, QueryPage, QueryRequest, RegisteredRoot, RootOptions, RootSummary, SimilarGroup, StoredDecision };
