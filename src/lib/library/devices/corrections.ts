/**
 * User corrections of the device catalogue, kept as a durable JSON document in the user's local data folder (the caller passes the
 * text; this module never touches the disk and never touches a scanned file).
 *
 * A correction targets a file by (root id, identity key of its root-relative path) and a motherboard group by its id. Targets are
 * not generation ids, so a correction survives rescans and index rebuilds. A correction whose file is not in the current scan is
 * reported as a missing target and is never silently moved to another file.
 *
 * Document shape: { "version": 1, "platform": "win32"|"darwin"|"linux", "corrections": [ ... ] }. Unknown or invalid entries are
 * dropped and counted; the rest is kept. Later entries for the same target override earlier ones.
 */
import { bestRevision, parseRevisions } from '../knowledge/revision';
import type { FileRole as CanonicalFileRole } from '../model';
import type { BoardAnchor, MatchDecisions } from './match';
import { pairKey } from './match';
import type { FileRole, Revision } from './identity';
import { identityKey, searchKey, type DevicePlatform } from './paths';
import libraryLimits from '../../../../shared/library-limits.json';

export const CORRECTIONS_VERSION = 1;
export const MAX_CORRECTIONS = 50_000;
/** Limit for ids, aliases and revisions (UTF-16 units). Shared with the main process through shared/library-limits.json. */
const MAX_TEXT = libraryLimits.maxIdentifierUnits;
/**
 * Limit for a root-relative path (UTF-16 units), one value for every Library layer (shared/library-limits.json, TB-068). It is the Windows
 * extended-length limit (32767) applied to the relative part only: the codec does not know the root's absolute prefix, so a full path that
 * is near the limit is refused by the scanner when it opens the file, not here. The legacy 260-character MAX_PATH is not a limit for the
 * Library. A longer path is refused with an explicit reason ('path-too-long'), never truncated, and the knowledge layer never cuts a segment.
 */
export const MAX_PATH_TEXT = libraryLimits.maxRelativePathUnits;
/**
 * The catalogue's own file roles. Stored corrections use these names (format version 1, see "Stored names" below). The canonical
 * Library roles are in CANONICAL_ROLE_OF.
 */
export const FILE_ROLES: readonly FileRole[] = ['boardview', 'schematic', 'board-pdf', 'document', 'bios-candidate', 'ec-firmware', 'me-firmware', 'saved-dump', 'other'];
/** The result of a canonical mapping: a canonical Library role (model.ts FILE_ROLES), or 'unknown' when the file needs manual classification. */
export type CanonicalRoleResult = CanonicalFileRole | 'unknown';
/**
 * Explicit mapping from each catalogue file role to the canonical Library role (model.ts FILE_ROLES). Every catalogue role has its own
 * entry; nothing is guessed. Decisions:
 * - 'document' maps to 'unknown' (manual classification). The catalogue uses one generic document role, but the canonical schema
 *   separates 'datasheet' from 'service-manual'. Choosing either one would invent a classification the file does not have. A stored
 *   'document' correction is an explicit manual classification; the user or the root confirms the canonical role before it is used.
 * - The canonical roles 'datasheet', 'service-manual', 'bom', 'photo' and 'thermal' are not produced by any catalogue role yet.
 *
 * Stored names: the document keeps the catalogue names (version 1). Migration to canonical names is not part of this change; the
 * plan is in the report (version 2 would store canonical names, and version 1 names would stay readable through this table).
 */
export const CANONICAL_ROLE_OF: Readonly<Record<FileRole, CanonicalRoleResult>> = {
  boardview: 'board',
  schematic: 'schematic',
  'board-pdf': 'board-pdf',
  document: 'unknown',
  'bios-candidate': 'firmware',
  'ec-firmware': 'firmware',
  'me-firmware': 'firmware',
  'saved-dump': 'firmware',
  other: 'other',
};
const BOARD_CODE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

/**
 * Closed list of reasons an entry is refused. Entries are never rewritten to a different meaning. The store passes the reason on, and
 * the Library UI maps each code to localized text.
 * - invalid-entry: wrong shape, missing field or unknown operation
 * - unknown-role: a role name that is not a catalogue role
 * - path-too-long: a root-relative path longer than MAX_PATH_TEXT
 * - invalid-relative-path: absolute, drive-letter, UNC, '.', '..' or empty segment, a colon or a backslash
 * - too-many: an entry beyond MAX_CORRECTIONS
 */
export const REJECTION_REASONS = ['invalid-entry', 'unknown-role', 'path-too-long', 'invalid-relative-path', 'too-many'] as const;
export type RejectReason = typeof REJECTION_REASONS[number];
export interface Rejection { index: number; reason: RejectReason }

/** Windows device names, refused on every platform (with or without an extension; the check is case-insensitive). */
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
/** Characters Windows does not allow in a file name, plus the separators and control characters. Refused on every platform. */
const FORBIDDEN_CHARACTER = /[<>:"|?*\\\x00-\x1f]/;

function isValidSegment(part: string): boolean {
  if (part === '' || part === '.' || part === '..') return false;
  if (part.endsWith('.') || part.endsWith(' ')) return false;
  return !WINDOWS_RESERVED_NAME.test(part.split('.')[0]);
}

/**
 * True when `path` is a root-relative path with forward slashes only, and it is a valid name on Windows, macOS and Linux alike. Refused:
 * a leading slash (absolute or UNC), any forbidden character (colon, backslash, <>"|?*, control characters), an empty, '.' or '..'
 * segment, a segment ending in a dot or a space, and a Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) as the base name of
 * any segment, with or without an extension. The verdict does not depend on the platform of the document. The length is checked separately.
 */
export function isValidRelativeTarget(path: string): boolean {
  if (path.startsWith('/') || FORBIDDEN_CHARACTER.test(path)) return false;
  return path.split('/').every(isValidSegment);
}

export interface FileTarget { rootId: string; path: string }

export type Correction =
  | { op: 'link'; file: FileTarget; anchorId: string }
  | { op: 'unlink'; file: FileTarget; anchorId: string }
  | { op: 'role'; file: FileTarget; role: FileRole | null }
  | { op: 'alias'; anchorId: string; alias: string; remove: boolean }
  | { op: 'board-code'; anchorId: string; code: string | null }
  | { op: 'revision'; anchorId: string; revision: string | null };

export interface CorrectionDocument { version: number; platform: DevicePlatform; corrections: Correction[] }
export interface ParseResult { document: CorrectionDocument; dropped: number; rejections: Rejection[]; error?: 'not-json' | 'wrong-version' | 'bad-platform' }

/** The file reference used by matching: root id and identity key, joined. Stable across rescans of the same root. */
export function fileRefOf(target: { rootId: string; path: string }, platform: DevicePlatform): string {
  return `${target.rootId}\u0000${identityKey(target.path.split('/').filter(part => part !== ''), platform)}`;
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** A checked value, or the reason it was refused. Correction objects are never strings, so a string result is always a reason. */
type Checked<T> = T | RejectReason;

function target(value: unknown): Checked<FileTarget> {
  if (typeof value !== 'object' || value === null) return 'invalid-entry';
  const rootId = text((value as { rootId?: unknown }).rootId);
  const rawPath = (value as { path?: unknown }).path;
  if (typeof rawPath === 'string' && rawPath.length > MAX_PATH_TEXT) return 'path-too-long';
  const path = text(rawPath, MAX_PATH_TEXT);
  if (rootId === undefined || path === undefined) return 'invalid-entry';
  return isValidRelativeTarget(path) ? { rootId, path } : 'invalid-relative-path';
}

function validateCorrection(value: unknown): Checked<Correction> {
  if (typeof value !== 'object' || value === null) return 'invalid-entry';
  const v = value as Record<string, unknown>;
  switch (v.op) {
    case 'link':
    case 'unlink': {
      const file = target(v.file);
      const anchorId = text(v.anchorId);
      if (typeof file === 'string') return file;
      return anchorId !== undefined ? { op: v.op, file, anchorId } : 'invalid-entry';
    }
    case 'role': {
      const file = target(v.file);
      if (typeof file === 'string') return file;
      if (v.role === null) return { op: 'role', file, role: null };
      if (typeof v.role !== 'string') return 'invalid-entry';
      // An unknown role is refused, not mapped to a near name: 'board' is not 'boardview' and must not be rewritten to it.
      return (FILE_ROLES as readonly string[]).includes(v.role) ? { op: 'role', file, role: v.role as FileRole } : 'unknown-role';
    }
    case 'alias': {
      const anchorId = text(v.anchorId);
      const alias = typeof v.alias === 'string' ? searchKey(v.alias) : '';
      if (anchorId === undefined || alias.length < 2 || alias.length > 64 || typeof v.remove !== 'boolean') return 'invalid-entry';
      return { op: 'alias', anchorId, alias, remove: v.remove };
    }
    case 'board-code': {
      const anchorId = text(v.anchorId);
      if (anchorId === undefined) return 'invalid-entry';
      if (v.code === null) return { op: 'board-code', anchorId, code: null };
      const code = typeof v.code === 'string' ? v.code.toUpperCase() : '';
      return BOARD_CODE.test(code) ? { op: 'board-code', anchorId, code } : 'invalid-entry';
    }
    case 'revision': {
      const anchorId = text(v.anchorId);
      if (anchorId === undefined) return 'invalid-entry';
      if (v.revision === null) return { op: 'revision', anchorId, revision: null };
      const revision = text(v.revision);
      return revision !== undefined && bestRevision(parseRevisions(revision)) !== undefined ? { op: 'revision', anchorId, revision } : 'invalid-entry';
    }
    default:
      return 'invalid-entry';
  }
}

/** Parses the stored document. Invalid input yields an empty document plus an error; refused entries are counted in `dropped` and listed with a reason in `rejections`. */
export function parseCorrections(source: string): ParseResult {
  const empty = (error: ParseResult['error']): ParseResult => ({ document: { version: CORRECTIONS_VERSION, platform: 'linux', corrections: [] }, dropped: 0, rejections: [], error });
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return empty('not-json');
  }
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== CORRECTIONS_VERSION) return empty('wrong-version');
  const platform = (raw as { platform?: unknown }).platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return empty('bad-platform');
  const list = Array.isArray((raw as { corrections?: unknown }).corrections) ? ((raw as { corrections: unknown[] }).corrections) : [];
  const corrections: Correction[] = [];
  const rejections: Rejection[] = [];
  list.slice(0, MAX_CORRECTIONS).forEach((item, index) => {
    const checked = validateCorrection(item);
    if (typeof checked === 'string') rejections.push({ index, reason: checked });
    else corrections.push(checked);
  });
  for (let index = MAX_CORRECTIONS; index < list.length; index++) rejections.push({ index, reason: 'too-many' });
  return { document: { version: CORRECTIONS_VERSION, platform, corrections }, dropped: rejections.length, rejections };
}

/** The stored text of a document. Deterministic: the same corrections give the same bytes. */
export function serializeCorrections(document: CorrectionDocument): string {
  return `${JSON.stringify({ version: CORRECTIONS_VERSION, platform: document.platform, corrections: document.corrections.slice(0, MAX_CORRECTIONS) }, null, 2)}\n`;
}

/** The key a correction overrides earlier ones with: one per file role, file link, file/anchor pair, anchor field or alias. */
function supersedeKey(correction: Correction, platform: DevicePlatform): string {
  switch (correction.op) {
    case 'link':
    case 'unlink':
      // A link and an unlink of the same pair decide the same question, so the later one replaces the earlier one.
      return `pair|${fileRefOf(correction.file, platform)}|${correction.anchorId}`;
    case 'role':
      return `role|${fileRefOf(correction.file, platform)}`;
    case 'alias':
      return `alias|${correction.anchorId}|${correction.alias}`;
    case 'board-code':
      return `board-code|${correction.anchorId}`;
    case 'revision':
      return `revision|${correction.anchorId}`;
  }
}

/** Keeps the last correction for each target, in order of appearance. */
export function compactCorrections(corrections: readonly Correction[], platform: DevicePlatform): Correction[] {
  const last = new Map<string, Correction>();
  for (const correction of corrections) {
    const key = supersedeKey(correction, platform);
    last.delete(key);
    last.set(key, correction);
  }
  return [...last.values()];
}

export interface AnchorPatch { boardCode?: string | null; revision?: string | null; aliasAdd: string[]; aliasRemove: string[] }
export interface AppliedCorrections {
  decisions: MatchDecisions;
  /** Role overrides keyed by file reference. */
  roleOverrides: Map<string, FileRole | null>;
  anchorPatches: Map<string, AnchorPatch>;
  /** Corrections whose file reference is not in the present scan. They are kept, shown for review, and never redirected. */
  missingTargets: Correction[];
}

/**
 * Turns the compacted corrections into matcher input. `presentFileRefs` is the set of file references of the current scan
 * (complete or not). A file-targeted correction whose file is absent is listed in `missingTargets` and has no effect.
 */
export function applyCorrections(corrections: readonly Correction[], platform: DevicePlatform, presentFileRefs: ReadonlySet<string>): AppliedCorrections {
  const userLinks = new Set<string>();
  const detached = new Set<string>();
  const roleOverrides = new Map<string, FileRole | null>();
  const anchorPatches = new Map<string, AnchorPatch>();
  const missingTargets: Correction[] = [];
  const patchOf = (anchorId: string): AnchorPatch => {
    const existing = anchorPatches.get(anchorId);
    if (existing !== undefined) return existing;
    const created: AnchorPatch = { aliasAdd: [], aliasRemove: [] };
    anchorPatches.set(anchorId, created);
    return created;
  };
  for (const correction of compactCorrections(corrections, platform)) {
    if (correction.op === 'alias') {
      const patch = patchOf(correction.anchorId);
      if (correction.remove) patch.aliasRemove.push(correction.alias);
      else patch.aliasAdd.push(correction.alias);
      continue;
    }
    if (correction.op === 'board-code') {
      patchOf(correction.anchorId).boardCode = correction.code;
      continue;
    }
    if (correction.op === 'revision') {
      patchOf(correction.anchorId).revision = correction.revision;
      continue;
    }
    const ref = fileRefOf(correction.file, platform);
    if (!presentFileRefs.has(ref)) {
      missingTargets.push(correction);
      continue;
    }
    if (correction.op === 'link') userLinks.add(pairKey(ref, correction.anchorId));
    else if (correction.op === 'unlink') detached.add(pairKey(ref, correction.anchorId));
    else roleOverrides.set(ref, correction.role);
  }
  return { decisions: { userLinks, detached }, roleOverrides, anchorPatches, missingTargets };
}

/** Applies anchor patches (board code, revision, aliases) to a copy of the anchors. Input anchors are not changed. */
export function patchAnchors(anchors: readonly BoardAnchor[], patches: ReadonlyMap<string, AnchorPatch>): BoardAnchor[] {
  return anchors.map(anchor => {
    const patch = patches.get(anchor.id);
    if (patch === undefined) return anchor;
    const aliases = new Set(anchor.aliases);
    for (const alias of patch.aliasAdd) aliases.add(alias);
    for (const alias of patch.aliasRemove) aliases.delete(alias);
    const boardCode = patch.boardCode === undefined ? anchor.boardCode : patch.boardCode ?? undefined;
    let revision: Revision | undefined = anchor.revision;
    if (patch.revision !== undefined) {
      const best = patch.revision === null ? undefined : bestRevision(parseRevisions(patch.revision));
      revision = best === undefined ? undefined : { normalized: best.normalized, scheme: best.scheme, rank: [...best.rank] };
    }
    return { id: anchor.id, boardCode, revision, aliases: [...aliases].sort() };
  });
}

/**
 * Confirms a case-collision (decided D8): the stored file correction with the missing target is replaced by one that names the exact
 * candidate path, at the same place, and the compaction then removes any other entry for the same target. The input document is not
 * changed. A path that is not one of the candidates leaves the document as it is: nothing is guessed.
 */
/** JSON with object keys in sorted order at every depth, so two equal corrections compare equal whatever their key order. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function confirmCaseCollision(document: CorrectionDocument, item: { correction: Correction; candidatePaths: readonly string[] }, candidatePath: string): CorrectionDocument {
  // A candidate the codec would refuse is not stored: the store rejects the whole document on save, which would block every later save.
  if (!item.candidatePaths.includes(candidatePath) || !isValidRelativeTarget(candidatePath) || !('file' in item.correction)) return document;
  const wanted = sortedJson(item.correction);
  const replaced = document.corrections.map(correction => {
    if (sortedJson(correction) !== wanted || !('file' in correction)) return correction;
    return { ...correction, file: { rootId: correction.file.rootId, path: candidatePath } } as Correction;
  });
  return { ...document, corrections: compactCorrections(replaced, document.platform) };
}
