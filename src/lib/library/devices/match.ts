/**
 * Association of files (boardview, schematic, board PDF, BIOS candidate) with motherboard groups.
 *
 * Decision rules, in order:
 *  1. An explicit conflict vetoes automatic confirmation: two different board codes (even one character apart), or two revisions
 *     of the same scheme that differ. A conflict is shown with both values and yields state "review", also for a user link.
 *  2. A durable user link is "confirmed" when no conflict exists.
 *  3. A strong, unique content identity of the file (parser/L6 evidence) that equals the board code confirms the link.
 *  4. Name evidence only (board code in a file or folder name) gives "probable". A shared alias, a shared revision or a shared
 *     brand/device word never confirms, and alias-only evidence gives "review".
 *  4a. A file name that names two or more different codes ("MB-Q731 vs MB-Q732") is ambiguous: each named code is a "review"
 *     candidate with basis "ambiguous", and none is confirmed or probable by name. Only a user link settles it (rule 2).
 *  5. Without any usable evidence no association is produced.
 *
 * Every association lists its signals with weights and its conflicts, so the reason is always visible. Scores are explanation
 * numbers, not calibrated probabilities.
 *
 * Cost: the index structures are by board code, by alias and by user link (one map from file path to its linked anchors, built
 * once). Each file is looked up in the indexes only, so the work is linear in files plus links plus judged candidates. Candidates
 * from a shared alias can still be many; that is inherent to the output, which lists every alias-only review pair.
 */
import { revisionsDiffer, type FileIdentity, type FileRole } from './identity';

export const WEIGHT = {
  codeName: 40,
  codeContent: 60,
  revisionAgree: 15,
  aliasEach: 8,
  aliasMax: 24,
} as const;
export const MAX_SCORE = 100;

/** A motherboard group. `aliases` are search keys; user aliases are added to the group's own names. */
export interface BoardAnchor {
  id: string;
  boardCode?: string;
  revision?: FileIdentity['revision'];
  aliases: string[];
}

/** A file with its name identity and, when a parser or the group evidence read it, a content identity. */
export interface FileRecord {
  path: string;
  identity: FileIdentity;
  /** Strong board identity from file content. Only a unique one may confirm. */
  contentCode?: { code: string; unique: boolean };
}

export type MatchState = 'confirmed' | 'probable' | 'review';
export type MatchBasis = 'user' | 'content' | 'names' | 'alias' | 'conflict' | 'ambiguous';

export interface Signal { signal: 'code-name' | 'code-content' | 'code-ambiguous' | 'revision-agree' | 'alias'; weight: number; detail: string }
export interface Conflict { field: 'board-code' | 'revision'; fileValue: string; anchorValue: string }

export interface Association {
  anchorId: string;
  filePath: string;
  role: FileRole;
  state: MatchState;
  basis: MatchBasis;
  score: number;
  signals: Signal[];
  conflicts: Conflict[];
  /** Evidence that would have been needed for confirmation but is absent (for the review text). */
  missing: Array<'content-identity' | 'file-revision' | 'file-board-code'>;
}

/** Durable decisions the matcher must respect. Keys are `pairKey(filePath, anchorId)`. */
export interface MatchDecisions {
  userLinks?: ReadonlySet<string>;
  detached?: ReadonlySet<string>;
}

export function pairKey(filePath: string, anchorId: string): string {
  return `${filePath}\u0000${anchorId}`;
}

function normalizeCode(code: string): string {
  return code.toUpperCase();
}

/** Operation counts of one matching run. They show how much work was done, independently of the machine's speed. */
export interface MatchCounters {
  /** Files read. */
  files: number;
  /** Anchors proposed by the indexes (name code, content code, alias, user link) before judging. */
  candidates: number;
  /** Judgements made for proposed candidates. */
  judgments: number;
  /** Work spent on user links: index entries built and per-file lookups. Must grow with links plus files, not with files times anchors. */
  linkSteps: number;
}

/** Matches every file against the anchors. Deterministic: output is sorted by file path, then anchor id. */
export function matchFiles(anchors: readonly BoardAnchor[], files: readonly FileRecord[], decisions: MatchDecisions = {}, counters?: MatchCounters): Association[] {
  const byCode = new Map<string, BoardAnchor[]>();
  const byAlias = new Map<string, BoardAnchor[]>();
  for (const anchor of anchors) {
    if (anchor.boardCode !== undefined) {
      const key = normalizeCode(anchor.boardCode);
      const list = byCode.get(key) ?? [];
      list.push(anchor);
      byCode.set(key, list);
    }
    for (const alias of anchor.aliases) {
      const list = byAlias.get(alias) ?? [];
      list.push(anchor);
      byAlias.set(alias, list);
    }
  }

  // User links, indexed by file path once: a link key is "<file path>\0<anchor id>". A file path can contain NUL (references are
  // root-scoped), so every NUL position is tried as the separator. Each split whose anchor id exists is kept, which yields exactly
  // the (file, anchor) pairs whose key is in the set, in time linear in the links. The judge still tests the exact key.
  const anchorById = new Map<string, BoardAnchor>();
  for (const anchor of anchors) anchorById.set(anchor.id, anchor);
  const linkedByFile = new Map<string, string[]>();
  if (decisions.userLinks !== undefined) {
    for (const key of decisions.userLinks) {
      if (counters !== undefined) counters.linkSteps++;
      for (let at = key.indexOf('\u0000'); at >= 0; at = key.indexOf('\u0000', at + 1)) {
        const anchorId = key.slice(at + 1);
        if (!anchorById.has(anchorId)) continue;
        const filePath = key.slice(0, at);
        const list = linkedByFile.get(filePath);
        if (list === undefined) linkedByFile.set(filePath, [anchorId]);
        else list.push(anchorId);
      }
    }
  }

  const out: Association[] = [];
  for (const file of files) {
    const identity = file.identity;
    const fileCode = file.contentCode?.unique === true ? file.contentCode.code : identity.boardCode;
    // Candidates come only from the indexes; each anchor is considered once per file.
    const candidates = new Map<string, BoardAnchor>();
    if (identity.boardCode !== undefined) for (const anchor of byCode.get(normalizeCode(identity.boardCode)) ?? []) candidates.set(anchor.id, anchor);
    if (identity.ambiguousCodes !== undefined) for (const code of identity.ambiguousCodes) for (const anchor of byCode.get(normalizeCode(code)) ?? []) candidates.set(anchor.id, anchor);
    if (file.contentCode !== undefined) for (const anchor of byCode.get(normalizeCode(file.contentCode.code)) ?? []) candidates.set(anchor.id, anchor);
    for (const alias of identity.aliases) for (const anchor of byAlias.get(alias) ?? []) candidates.set(anchor.id, anchor);
    const linked = linkedByFile.get(file.path);
    if (counters !== undefined) counters.linkSteps++;
    if (linked !== undefined) for (const anchorId of linked) candidates.set(anchorId, anchorById.get(anchorId)!);
    if (counters !== undefined) {
      counters.files++;
      counters.candidates += candidates.size;
    }

    for (const anchor of candidates.values()) {
      const key = pairKey(file.path, anchor.id);
      if (decisions.detached?.has(key) === true) continue;
      if (counters !== undefined) counters.judgments++;
      const association = judge(file, fileCode, anchor, decisions.userLinks?.has(key) === true);
      if (association !== undefined) out.push(association);
    }
  }
  out.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0));
  return out;
}

function judge(file: FileRecord, fileCode: string | undefined, anchor: BoardAnchor, userLinked: boolean): Association | undefined {
  const identity = file.identity;
  const signals: Signal[] = [];
  const conflicts: Conflict[] = [];
  const missing: Association['missing'] = [];

  // Board code conflict: a strong content code, otherwise the name code, against the anchor code.
  if (fileCode !== undefined && anchor.boardCode !== undefined && normalizeCode(fileCode) !== normalizeCode(anchor.boardCode)) {
    conflicts.push({ field: 'board-code', fileValue: fileCode, anchorValue: anchor.boardCode });
  }
  const contentMatches = file.contentCode?.unique === true && anchor.boardCode !== undefined && normalizeCode(file.contentCode.code) === normalizeCode(anchor.boardCode);
  const nameMatches = !contentMatches && identity.boardCode !== undefined && anchor.boardCode !== undefined && normalizeCode(identity.boardCode) === normalizeCode(anchor.boardCode);
  if (identity.boardCode !== undefined && file.contentCode !== undefined && file.contentCode.unique && normalizeCode(identity.boardCode) !== normalizeCode(file.contentCode.code)) {
    conflicts.push({ field: 'board-code', fileValue: identity.boardCode, anchorValue: file.contentCode.code });
  }
  // An ambiguous name names this anchor's code among others: it is a review candidate, never a name match.
  const ambiguousNames = identity.ambiguousCodes;
  const ambiguousHit = !contentMatches && ambiguousNames !== undefined && anchor.boardCode !== undefined && ambiguousNames.includes(normalizeCode(anchor.boardCode));
  if (ambiguousHit) signals.push({ signal: 'code-ambiguous', weight: 0, detail: `names ${ambiguousNames.join(', ')}` });

  const revisionDiff = revisionsDiffer(identity.revision, anchor.revision);
  if (revisionDiff === true) {
    conflicts.push({ field: 'revision', fileValue: identity.revision?.normalized ?? '', anchorValue: anchor.revision?.normalized ?? '' });
  } else if (revisionDiff === false) {
    signals.push({ signal: 'revision-agree', weight: WEIGHT.revisionAgree, detail: `revision ${identity.revision?.normalized ?? ''}` });
  }

  const shared = identity.aliases.filter(alias => anchor.aliases.includes(alias));
  if (shared.length > 0) {
    const weight = Math.min(WEIGHT.aliasMax, shared.length * WEIGHT.aliasEach);
    signals.push({ signal: 'alias', weight, detail: shared.slice(0, 3).join(', ') });
  }
  if (contentMatches) {
    signals.push({ signal: 'code-content', weight: WEIGHT.codeContent, detail: `content ${file.contentCode?.code ?? ''}` });
  } else if (nameMatches) {
    signals.push({ signal: 'code-name', weight: WEIGHT.codeName, detail: `name ${identity.boardCode ?? ''}` });
  }

  if (file.contentCode === undefined) missing.push('content-identity');
  if (identity.revision === undefined) missing.push('file-revision');
  if (identity.boardCode === undefined) missing.push('file-board-code');

  const score = Math.min(MAX_SCORE, signals.reduce((sum, signal) => sum + signal.weight, 0));
  const hasCodeEvidence = contentMatches || nameMatches;
  const hasAlias = shared.length > 0;

  let state: MatchState;
  let basis: MatchBasis;
  if (conflicts.length > 0) {
    // A conflict is never confirmed, not even by a user link: the user has to resolve it.
    if (!hasCodeEvidence && !userLinked && !hasAlias) return undefined;
    state = 'review';
    basis = 'conflict';
  } else if (userLinked) {
    state = 'confirmed';
    basis = 'user';
  } else if (contentMatches) {
    state = 'confirmed';
    basis = 'content';
  } else if (nameMatches) {
    state = 'probable';
    basis = 'names';
  } else if (ambiguousHit) {
    state = 'review';
    basis = 'ambiguous';
  } else if (hasAlias) {
    state = 'review';
    basis = 'alias';
  } else {
    return undefined;
  }

  return { anchorId: anchor.id, filePath: file.path, role: identity.role, state, basis, score, signals, conflicts, missing };
}
