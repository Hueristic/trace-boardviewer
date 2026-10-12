/**
 * Identity facts of one file, read from its relative path only (folders, file name, extension). Nothing is opened.
 *
 * Board codes and revisions come from the knowledge layer (analyzePath) and from a label-prefixed code rule ("MB-Q731"). Each fact
 * keeps the segment and source it came from, so every later decision can explain itself. Folder and file-name tokens are one
 * correlated name source family: the same word in both is not two independent pieces of evidence.
 *
 * The file role says what kind of file this is. Binary firmware extensions (.bin .rom .fd .cap .hex) only ever yield a candidate
 * role; they are never called a BIOS. The role can be overridden by a user correction.
 */
import { analyzePath } from '../knowledge/names';
import { compareRevisions, type RevisionScheme } from '../knowledge/revision';
import { canonicalPath, extensionOf, searchKey, type DevicePlatform } from './paths';

export type FileRole =
  | 'boardview'
  | 'schematic'
  | 'board-pdf'
  | 'document'
  | 'bios-candidate'
  | 'ec-firmware'
  | 'me-firmware'
  | 'saved-dump'
  | 'other';

export const FIRMWARE_EXTENSIONS: ReadonlySet<string> = new Set(['bin', 'rom', 'fd', 'cap', 'hex']);
/** Words that say nothing about a board on their own. They never become aliases and never confirm anything. */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  'board', 'boards', 'main', 'mainboard', 'bios', 'rev', 'revision', 'backup', 'laptop', 'schematic', 'boardview', 'file', 'copy',
  'final', 'new', 'old', 'misc', 'repair', 'pdf', 'bin', 'rom', 'fd', 'cap', 'hex', 'folder', 'download', 'downloads', 'data', 'tmp',
  'the', 'and', 'for', 'version', 'ver', 'fw', 'firmware', 'desktop', 'phone', 'tablet', 'device', 'logic', 'pcb', 'update', 'test',
  'bak', 'set', 'part', 'parts', 'unknown', 'other', 'docs', 'doc', 'manual', 'service', 'image', 'photo', 'dump', 'read',
  // Derived from the synthetic library (scripts/gen-synthetic-library.cjs --preset=small --seed=1, see generic-words.test.ts): a word shared by
  // two or more families that produces more false links (pairs of files of different families) than true links. Model names among them
  // (dunlin, edge, whimbrel...) are corpus-specific; the test records the numbers.
  'archive', 'assembly', 'bill', 'bom', 'brd', 'circuit', 'cobblestay', 'customers', 'datasheets', 'diagram', 'document', 'drive', 'dsc',
  'dunlin', 'edge', 'evt', 'files', 'gannet', 'img', 'kapcsolasi', 'layout', 'list', 'lists', 'maintenance', 'manuals', 'marshwick',
  'materials', 'mini', 'oakhollow', 'photos', 'pvt', 'pxl', 'rajz', 'ruff', 'schema', 'schematics', 'sch', 'shearwater', 'sort', 'stuff',
  'viewer', 'whimbrel', 'work',
]);
const REVISION_TOKEN = /^(rev|r|v|ver)\d*$/;
const LABELLED_CODE = /(?<![A-Za-z0-9])(MB|PCB|BD|LB)[-_ ]?([A-Z]{0,3}\d{2,5}[A-Z]?)(?![A-Za-z0-9])/gi;
const MAX_ALIASES = 16;
const MIN_BOARD_NUMBER_CONFIDENCE = 50;
const LABELLED_CODE_CONFIDENCE = 55;

export interface FactEvidence {
  field: 'board-code' | 'revision' | 'vendor' | 'device' | 'role' | 'alias';
  value: string;
  source: 'name' | 'folder' | 'label' | 'extension' | 'token' | 'correction';
  /** Index of the relative path segment (0 is the outermost folder). */
  segment: number;
  confidence: number;
}

export interface Revision { normalized: string; scheme: RevisionScheme; rank: number[] }

export interface FileIdentity {
  /** Canonical relative path this identity was read from. */
  path: string;
  role: FileRole;
  roleBasis: 'extension' | 'token' | 'analysis' | 'correction';
  boardCode?: string;
  boardCodeConfidence: number;
  /**
   * Two or more different board codes named in the file name itself ("MB-Q731 vs MB-Q732"). Such a file has no boardCode: the
   * identity is ambiguous, never confirmed by name, and only a user link can settle it. Sorted, unique, normalised. Absent otherwise.
   */
  ambiguousCodes?: string[];
  revision?: Revision;
  vendor?: string;
  device?: string;
  /** Search keys of non-generic name tokens, sorted and unique. */
  aliases: string[];
  evidence: FactEvidence[];
}

export interface IdentityOptions {
  platform: DevicePlatform;
  /** A user-chosen role; it wins over the role read from the name. */
  roleOverride?: FileRole;
}

const DOCUMENT_ROLE: Record<string, FileRole> = { board: 'boardview', schematic: 'schematic', 'board-pdf': 'board-pdf' };

function tokensOf(text: string): string[] {
  return searchKey(text).split(' ').filter(token => token !== '');
}

/** Reads the identity of a file from its canonical relative path. Total, linear in the path length. */
export function extractIdentity(path: string, options: IdentityOptions): FileIdentity {
  const segments = path.split('/').filter(part => part !== '');
  const name = segments[segments.length - 1] ?? '';
  const folders = segments.slice(0, -1);
  const extension = extensionOf(name);
  const stem = extension === '' ? name : name.slice(0, name.length - extension.length - 1);
  const analysis = analyzePath(canonicalPath(segments));
  const evidence: FactEvidence[] = [];

  // Board code: two or more codes in the file name are ambiguous (no code at all); otherwise the knowledge layer first, then a
  // label-prefixed code ("MB-Q731") in the file or folder names.
  let boardCode: string | undefined;
  let boardCodeConfidence = 0;
  const nameCodes = codesInFileName(analysis, stem, segments.length - 1);
  const ambiguousCodes = nameCodes.length >= 2 ? nameCodes : undefined;
  const bn = analysis.best.boardNumber;
  if (ambiguousCodes !== undefined) {
    evidence.push({ field: 'board-code', value: ambiguousCodes.join(', '), source: 'name', segment: segments.length - 1, confidence: 0 });
  } else if (bn !== undefined && bn.confidence >= MIN_BOARD_NUMBER_CONFIDENCE) {
    boardCode = bn.normalized;
    boardCodeConfidence = bn.confidence;
    evidence.push({ field: 'board-code', value: bn.normalized, source: bn.scope === 'folder' ? 'folder' : 'name', segment: segmentIndexOf(analysis, bn.normalized, segments), confidence: bn.confidence });
  } else {
    const labelled = findLabelledCode(stem, folders);
    if (labelled !== undefined) {
      boardCode = labelled.value;
      boardCodeConfidence = LABELLED_CODE_CONFIDENCE;
      evidence.push({ field: 'board-code', value: labelled.value, source: 'label', segment: labelled.segment, confidence: LABELLED_CODE_CONFIDENCE });
    }
  }

  // Revision: the strongest one of the knowledge layer; when it finds none, a standalone "R02" or "rev2" token of the names.
  let revision: Revision | undefined;
  const rv = analysis.best.revision;
  if (rv !== undefined) {
    revision = { normalized: rv.normalized, scheme: rv.scheme, rank: [...rv.rank] };
    evidence.push({ field: 'revision', value: rv.normalized, source: 'name', segment: segments.length - 1, confidence: rv.confidence });
  } else {
    const fallback = fallbackRevision(stem, folders);
    if (fallback !== undefined) {
      revision = fallback.revision;
      evidence.push({ field: 'revision', value: fallback.revision.normalized, source: 'token', segment: fallback.segment, confidence: FALLBACK_REVISION_CONFIDENCE });
    }
  }

  const vendor = analysis.best.vendor?.id;
  const device = analysis.best.device?.id;
  if (vendor !== undefined) evidence.push({ field: 'vendor', value: vendor, source: 'name', segment: segments.length - 1, confidence: analysis.best.vendor?.confidence ?? 0 });
  if (device !== undefined) evidence.push({ field: 'device', value: device, source: 'name', segment: segments.length - 1, confidence: analysis.best.device?.confidence ?? 0 });

  const { role, roleBasis } = roleOf(stem, extension, analysis);
  const finalRole = options.roleOverride ?? role;
  evidence.push({ field: 'role', value: finalRole, source: options.roleOverride !== undefined ? 'correction' : roleBasisSource(roleBasis), segment: segments.length - 1, confidence: options.roleOverride !== undefined ? 100 : 50 });

  const aliases = aliasesOf(stem, folders, ambiguousCodes ?? (boardCode === undefined ? [] : [boardCode]), revision);
  for (const alias of aliases) evidence.push({ field: 'alias', value: alias, source: 'token', segment: segments.length - 1, confidence: 20 });

  return {
    path: canonicalPath(segments),
    role: finalRole,
    roleBasis: options.roleOverride !== undefined ? 'correction' : roleBasis,
    boardCode,
    boardCodeConfidence,
    ambiguousCodes,
    revision,
    vendor,
    device,
    aliases,
    evidence,
  };
}

function segmentIndexOf(analysis: ReturnType<typeof analyzePath>, normalized: string, segments: readonly string[]): number {
  const hit = analysis.boardNumbers.find(item => item.value.normalized === normalized);
  if (hit === undefined) return segments.length - 1;
  return hit.segment;
}

const FALLBACK_REVISION = /^r(?:ev)?(\d{1,2})$/;
const FALLBACK_REVISION_CONFIDENCE = 45;

/** A standalone "r2", "rev02" or "R1" token: name first, then folders from the nearest. Numeric scheme, like the knowledge layer. */
function fallbackRevision(stem: string, folders: readonly string[]): { revision: Revision; segment: number } | undefined {
  const scan = (text: string): number | undefined => {
    for (const token of tokensOf(text)) {
      const match = FALLBACK_REVISION.exec(token);
      if (match !== null) return Number(match[1]);
    }
    return undefined;
  };
  const make = (value: number, segment: number) => ({ revision: { normalized: String(value), scheme: 'number' as const, rank: [value] }, segment });
  const inName = scan(stem);
  if (inName !== undefined) return make(inName, folders.length);
  for (let index = folders.length - 1; index >= 0; index--) {
    const inFolder = scan(folders[index]);
    if (inFolder !== undefined) return make(inFolder, index);
  }
  return undefined;
}

function findLabelledCode(stem: string, folders: readonly string[]): { value: string; segment: number } | undefined {
  const scan = (text: string): string | undefined => {
    LABELLED_CODE.lastIndex = 0;
    const match = LABELLED_CODE.exec(text);
    if (match === null) return undefined;
    return `${match[1].toUpperCase()}-${match[2].toUpperCase()}`;
  };
  const inName = scan(stem);
  if (inName !== undefined) return { value: inName, segment: folders.length };
  for (let index = folders.length - 1; index >= 0; index--) {
    const inFolder = scan(folders[index]);
    if (inFolder !== undefined) return { value: inFolder, segment: index };
  }
  return undefined;
}

function roleOf(stem: string, extension: string, analysis: ReturnType<typeof analyzePath>): { role: FileRole; roleBasis: FileIdentity['roleBasis'] } {
  const nameTokens = new Set(tokensOf(stem));
  if (FIRMWARE_EXTENSIONS.has(extension)) {
    // The name tokens decide between an EC, ME, saved readout and a plain candidate. Folder names are not used here, so a
    // "backup" folder alone never turns a file into a saved readout.
    if (nameTokens.has('ec') || nameTokens.has('embedded controller')) return { role: 'ec-firmware', roleBasis: 'token' };
    if (nameTokens.has('me') || nameTokens.has('ish') || nameTokens.has('management engine')) return { role: 'me-firmware', roleBasis: 'token' };
    if (nameTokens.has('dump') || nameTokens.has('readout') || nameTokens.has('mentett')) return { role: 'saved-dump', roleBasis: 'token' };
    return { role: 'bios-candidate', roleBasis: 'extension' };
  }
  const documents = analysis.best.documents;
  const first = documents[0];
  if (first !== undefined && DOCUMENT_ROLE[first.id] !== undefined) return { role: DOCUMENT_ROLE[first.id], roleBasis: 'analysis' };
  if (first !== undefined) return { role: 'document', roleBasis: 'analysis' };
  return { role: 'other', roleBasis: 'analysis' };
}

function roleBasisSource(basis: FileIdentity['roleBasis']): FactEvidence['source'] {
  if (basis === 'extension') return 'extension';
  if (basis === 'token') return 'token';
  return 'name';
}

/**
 * Every distinct board code named in the file name (its last segment, not the folders), sorted. Two or more mean an ambiguous name.
 * A code counts when the knowledge layer reads it with confidence, or when it has the label form ("MB-Q731").
 */
function codesInFileName(analysis: ReturnType<typeof analyzePath>, stem: string, nameIndex: number): string[] {
  const codes = new Set<string>();
  for (const item of analysis.boardNumbers) {
    if (item.segment === nameIndex && item.value.confidence >= MIN_BOARD_NUMBER_CONFIDENCE) codes.add(item.value.normalized);
  }
  // matchAll starts at the regex's lastIndex, which a previous exec in findLabelledCode leaves non-zero: reset it first.
  LABELLED_CODE.lastIndex = 0;
  for (const match of stem.matchAll(LABELLED_CODE)) codes.add(`${match[1].toUpperCase()}-${match[2].toUpperCase()}`);
  LABELLED_CODE.lastIndex = 0;
  return [...codes].sort();
}

function aliasesOf(stem: string, folders: readonly string[], codes: readonly string[], revision: Revision | undefined): string[] {
  const codeTokens = new Set(codes.flatMap(code => tokensOf(code)));
  const out = new Set<string>();
  for (const text of [stem, ...folders]) {
    for (const token of tokensOf(text)) {
      if (out.size >= MAX_ALIASES) break;
      // A letter of any script (Latin, Cyrillic, Polish...), so the rule is the same on every platform and for every locale.
      if (token.length < 3 || !/\p{L}/u.test(token)) continue;
      if (GENERIC_WORDS.has(token) || REVISION_TOKEN.test(token) || codeTokens.has(token)) continue;
      if (revision !== undefined && token === revision.normalized.toLowerCase()) continue;
      out.add(token);
    }
  }
  return [...out].sort();
}

/** Compares two revisions of the same scheme. undefined when either is missing or the schemes differ (no verdict). */
export function revisionsDiffer(a: Revision | undefined, b: Revision | undefined): boolean | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (a.scheme !== b.scheme) return undefined;
  const order = compareRevisions({ scheme: a.scheme, rank: a.rank }, { scheme: b.scheme, rank: b.rank });
  if (order === undefined) return undefined;
  return order !== 0;
}
