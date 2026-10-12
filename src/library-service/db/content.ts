import { LIBRARY_STAGES, type FileState, type Identifier, type LibraryErrorCode, type LibraryKind, type LibraryStage } from '../../lib/library/model';
import { all, atomic, get, int, jsonIds, run, text, type Ctx } from './context';
import { bytesToHex, hexToBytes } from './codec';
import { purgeFullTextRows, purgeUnconsentedFullText } from './roots';
import { forgetContents } from './temp';
import type { AttemptDecision, ContentLink, ContentLinkResult, PendingContent, SniffOutcome, StageUpdate } from './types';

/** A content whose reader crashed this many times is never dispatched again automatically. */
export const MAX_ATTEMPTS = 2;
const SUMMARY_KINDS = ['board', 'board-archive', 'schematic', 'pdf', 'image'];
/** Kinds classified by their head only: once sniffed there is nothing more to read. */
const CLASSIFIED_ONLY = new Set<string>(['archive', 'spreadsheet', 'firmware', 'text']);
/** File states derived from the content. The walker's own states (link, no-access, locked) and `missing` are never overwritten from here. */
export const CONTENT_DERIVED_STATES: readonly FileState[] = ['identified', 'pending', 'indexed', 'unknown', 'unsupported', 'encrypted', 'damaged', 'skipped'];

export interface ContentRow { id: number; public_id: string; quick: Uint8Array; sha256: Uint8Array | null; size: number; kind: string | null; format: string | null; variant: string | null; confidence: number | null; needs_key: string | null; problem: string | null; attempts: number }

export const contentByPublicId = (ctx: Ctx, publicId: string): ContentRow | undefined => get<ContentRow>(ctx, 'SELECT * FROM content WHERE public_id = ?', publicId);

/** The state a file takes from its content: needs-key and problems first, then the classification, then whether the summary stage is done. */
export function fileStateFor(content: { kind: string | null; needs_key: string | null; problem: string | null }, summaryDone: boolean): FileState {
  if (content.needs_key) return 'encrypted';
  switch (content.problem) {
    case null: case undefined: break;
    case 'damaged': return 'damaged';
    case 'unsupported-format': return 'unsupported';
    case 'unknown-format': return 'unknown';
    case 'encrypted': return 'encrypted';
    default: return 'skipped';
  }
  if (content.kind === null) return 'identified';
  if (content.kind === 'unknown') return 'unknown';
  if (CLASSIFIED_ONLY.has(content.kind) || summaryDone) return 'indexed';
  return 'identified';
}

export function deriveStateForContent(ctx: Ctx, contentId: number): FileState {
  const content = get<{ kind: string | null; needs_key: string | null; problem: string | null }>(ctx, 'SELECT kind, needs_key, problem FROM content WHERE id = ?', contentId);
  if (!content) return 'pending';
  const done = get(ctx, "SELECT 1 AS x FROM stage WHERE content_id = ? AND stage = 'summary' AND state = 'done'", contentId);
  return fileStateFor(content, done !== undefined);
}

/** Recomputes the content-derived state of every file that points at the content. */
export function refreshFileStates(ctx: Ctx, contentId: number): number {
  const state = deriveStateForContent(ctx, contentId);
  const marks = CONTENT_DERIVED_STATES.map(() => '?').join(',');
  return run(ctx, `UPDATE file SET state = ? WHERE content_id = ? AND state IN (${marks}) AND state <> ?`, state, contentId, ...CONTENT_DERIVED_STATES, state).changes;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Links files to content rows. A content is shared between files only after a full SHA-256 confirmed it: two files that merely agree on
 * size and quick key keep separate content rows until `confirmHash` settles them. Returns one result per link, in order.
 */
export function linkContent(ctx: Ctx, links: readonly ContentLink[]): ContentLinkResult[] {
  const results: ContentLinkResult[] = [];
  try {
    for (const link of links) results.push(ctx.writer.run(1, () => linkOne(ctx, link)));
    ctx.writer.commit();
  } catch (error) { ctx.writer.rollback(); throw error; }
  return results;
}

function linkOne(ctx: Ctx, link: ContentLink): ContentLinkResult {
  const none: ContentLinkResult = { contentId: null, created: false };
  const file = get<{ id: number; content_id: number | null }>(ctx, 'SELECT id, content_id FROM file WHERE public_id = ?', link.fileId);
  if (!file || !(link.quick instanceof Uint8Array) || link.quick.length !== 16 || !Number.isSafeInteger(link.size) || link.size < 0) return none;
  const sha = link.sha256 === undefined ? null : link.sha256.length === 64 ? hexToBytes(link.sha256) ?? null : null;
  if (link.sha256 !== undefined && !sha) return none;
  const current = file.content_id === null ? undefined : get<ContentRow>(ctx, 'SELECT * FROM content WHERE id = ?', file.content_id);
  const publicOf = (id: number): string => text(get<{ public_id: string }>(ctx, 'SELECT public_id FROM content WHERE id = ?', id)?.public_id);
  const attach = (id: number, created: boolean): ContentLinkResult => {
    if (file.content_id !== id) {
      run(ctx, 'UPDATE file SET content_id = ?, state = CASE WHEN state IN (\'pending\', \'identified\') THEN \'identified\' ELSE state END WHERE id = ?', id, file.id);
      if (file.content_id !== null) purgeUnconsentedFullText(ctx, [file.content_id]);
      refreshFileStates(ctx, id);
    }
    return { contentId: publicOf(id), created };
  };
  if (sha) {
    const target = get<{ id: number }>(ctx, 'SELECT id FROM content WHERE sha256 = ?', sha);
    if (target) return attach(target.id, false);
    if (current && current.sha256 === null && current.size === link.size && sameBytes(current.quick, link.quick)) {
      run(ctx, 'UPDATE content SET sha256 = ? WHERE id = ?', sha, current.id);
      return { contentId: current.public_id, created: false };
    }
  } else if (current && current.size === link.size && sameBytes(current.quick, link.quick)) {
    return { contentId: current.public_id, created: false };
  }
  const id = ctx.ids.next('c');
  const rowid = run(ctx, 'INSERT INTO content(public_id, quick, sha256, size) VALUES(?, ?, ?, ?)', id, link.quick, sha, link.size).lastInsertRowid;
  return attach(rowid, true);
}

/** Merges `drop` into `keep`: files, group membership, revisions and duplicate relations follow; everything else of `drop` is derived and goes. */
export function mergeContents(ctx: Ctx, keep: number, drop: number): void {
  if (keep === drop) return;
  run(ctx, 'UPDATE file SET content_id = ? WHERE content_id = ?', keep, drop);
  run(ctx, 'UPDATE OR IGNORE member SET content_id = ? WHERE content_id = ?', keep, drop);
  run(ctx, 'UPDATE OR IGNORE revision SET content_id = ? WHERE content_id = ?', keep, drop);
  run(ctx, 'UPDATE OR IGNORE duplicate_content SET content_id = ? WHERE content_id = ?', keep, drop);
  purgeFullTextRows(ctx, [drop]);
  forgetContents(ctx, [drop]);
  run(ctx, 'DELETE FROM content WHERE id = ?', drop);
  refreshFileStates(ctx, keep);
}

/**
 * Records the full SHA-256 of a content. When another content already carries that hash the two are the same bytes: they merge, keeping the
 * one that already has its summary.
 */
export function confirmHash(ctx: Ctx, contentPublicId: string, sha256: string): { contentId: string; merged: boolean } | undefined {
  const sha = sha256.length === 64 ? hexToBytes(sha256) : undefined;
  const content = contentByPublicId(ctx, contentPublicId);
  if (!sha || !content) return undefined;
  return atomic(ctx, () => {
    const other = get<{ id: number; public_id: string }>(ctx, 'SELECT id, public_id FROM content WHERE sha256 = ? AND id <> ?', sha, content.id);
    if (!other) { run(ctx, 'UPDATE content SET sha256 = ? WHERE id = ?', sha, content.id); return { contentId: content.public_id, merged: false }; }
    const hasSummary = (id: number): boolean => get(ctx, "SELECT 1 AS x FROM stage WHERE content_id = ? AND stage = 'summary' AND state = 'done'", id) !== undefined;
    if (hasSummary(content.id) && !hasSummary(other.id)) {
      mergeContents(ctx, content.id, other.id);
      run(ctx, 'UPDATE content SET sha256 = ? WHERE id = ?', sha, content.id);
      return { contentId: content.public_id, merged: true };
    }
    mergeContents(ctx, other.id, content.id);
    return { contentId: other.public_id, merged: true };
  });
}

/** Contents that share size and quick key but have no confirmed hash yet: the scanner hashes these to settle duplicates. */
export function unconfirmedDuplicates(ctx: Ctx, limit = 200): { size: number; contentIds: string[] }[] {
  const groups = all<{ size: number; ids: string }>(ctx, `SELECT size, group_concat(public_id) AS ids FROM content
    WHERE sha256 IS NULL AND EXISTS (SELECT 1 FROM content o WHERE o.quick = content.quick AND o.size = content.size AND o.id <> content.id)
    GROUP BY quick, size LIMIT ?`, Math.min(Math.max(limit, 1), 1000));
  return groups.map(g => ({ size: int(g.size), contentIds: text(g.ids).split(',') }));
}

export function setSniff(ctx: Ctx, contentPublicId: string, outcome: SniffOutcome, version = 1): boolean {
  const content = contentByPublicId(ctx, contentPublicId);
  if (!content) return false;
  const confidence = outcome.confidence === undefined ? null : Math.min(100, Math.max(0, Math.trunc(outcome.confidence)));
  atomic(ctx, () => {
    run(ctx, 'UPDATE content SET kind = ?, format = ?, variant = ?, confidence = ?, needs_key = ?, problem = ? WHERE id = ?',
      outcome.kind, outcome.format ?? null, outcome.variant ?? null, confidence, outcome.needsKey ?? null, outcome.problem ?? null, content.id);
    writeStage(ctx, content.id, { stage: 'sniff', version, state: 'done' });
    refreshFileStates(ctx, content.id);
  });
  return true;
}

export function writeStage(ctx: Ctx, contentId: number, update: StageUpdate): void {
  if (!(LIBRARY_STAGES as readonly string[]).includes(update.stage)) return;
  run(ctx, `INSERT INTO stage(content_id, stage, version, state, error, at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_id, stage) DO UPDATE SET version = excluded.version, state = excluded.state, error = excluded.error, at = excluded.at`,
  contentId, update.stage, Math.trunc(update.version), update.state, update.error ?? null, ctx.now());
}

export function setStages(ctx: Ctx, contentPublicId: string, updates: readonly StageUpdate[]): boolean {
  const content = contentByPublicId(ctx, contentPublicId);
  if (!content) return false;
  atomic(ctx, () => { for (const update of updates) writeStage(ctx, content.id, update); refreshFileStates(ctx, content.id); });
  return true;
}

/**
 * Contents that still need `stage` at `version`: no stage row, an older version, or an explicit `pending` row. Contents with a problem,
 * a missing key or too many crashes are not offered. `ocr` and `full-text` are only offered when a row asks for them (pending).
 */
export function listPending(ctx: Ctx, stage: LibraryStage, version: number, limit = 200, afterContentId = 0): PendingContent[] {
  const explicitOnly = stage === 'ocr' || stage === 'full-text';
  const kinds = stage === 'sniff' || stage === 'enumerate' || stage === 'identity' || stage === 'name' ? '' : `AND c.kind IN (${SUMMARY_KINDS.map(k => `'${k}'`).join(',')})`;
  // Placeholders, in order: stage, after, attempts, [version], limit.
  const need = explicitOnly ? "s.state = 'pending'" : "(s.content_id IS NULL OR s.version < ? OR s.state = 'pending')";
  const params: (string | number)[] = [stage, Math.max(0, Math.trunc(afterContentId)), MAX_ATTEMPTS];
  if (!explicitOnly) params.push(Math.trunc(version));
  params.push(Math.min(Math.max(Math.trunc(limit), 1), 1000));
  return all<ContentRow>(ctx, `SELECT c.* FROM content c LEFT JOIN stage s ON s.content_id = c.id AND s.stage = ?
    WHERE c.id > ? AND c.problem IS NULL AND c.needs_key IS NULL AND c.attempts < ? ${kinds} AND ${need} ORDER BY c.id LIMIT ?`, ...params).map(row => ({
    contentId: row.public_id, kind: (row.kind as LibraryKind | null) ?? null, format: row.format, size: int(row.size), attempts: int(row.attempts),
  }));
}

/**
 * Poison-file guard. Call before a job leaves for a reader: the attempt counter is incremented and committed first. A content that has
 * already used up its attempts gets `problem = 'reader-crash'` and is not dispatched.
 */
export function beginAttempt(ctx: Ctx, contentPublicId: string): AttemptDecision {
  const content = contentByPublicId(ctx, contentPublicId);
  if (!content) return { allowed: false, attempts: 0 };
  return atomic(ctx, () => {
    if (content.attempts >= MAX_ATTEMPTS) {
      run(ctx, "UPDATE content SET problem = 'reader-crash' WHERE id = ? AND problem IS NULL", content.id);
      writeStage(ctx, content.id, { stage: 'summary', version: 0, state: 'failed', error: 'reader-crash' });
      refreshFileStates(ctx, content.id);
      return { allowed: false, attempts: content.attempts };
    }
    run(ctx, 'UPDATE content SET attempts = attempts + 1 WHERE id = ?', content.id);
    return { allowed: true, attempts: content.attempts + 1 };
  });
}

/** Success (or an orderly error code from the reader): the attempt did not crash the reader. */
export function endAttempt(ctx: Ctx, contentPublicId: string): void {
  atomic(ctx, () => run(ctx, 'UPDATE content SET attempts = 0 WHERE public_id = ?', contentPublicId));
}

/** Replaces the name- and folder-derived identifiers of one file (stage S3). */
export function setNameIdentifiers(ctx: Ctx, filePublicId: string, identifiers: readonly Identifier[]): boolean {
  const file = get<{ id: number }>(ctx, 'SELECT id FROM file WHERE public_id = ?', filePublicId);
  if (!file) return false;
  atomic(ctx, () => {
    run(ctx, 'DELETE FROM identifier WHERE file_id = ?', file.id);
    for (const i of identifiers.slice(0, 256)) {
      run(ctx, 'INSERT INTO identifier(file_id, kind, norm, raw, source, confidence, page, pattern) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
        file.id, i.kind, i.norm, i.raw, i.source, Math.min(100, Math.max(0, Math.trunc(i.confidence))), i.page ?? null, i.pattern ?? null);
    }
  });
  return true;
}

export function contentQuickHex(ctx: Ctx, contentId: number): string | undefined {
  const row = get<{ quick: Uint8Array }>(ctx, 'SELECT quick FROM content WHERE id = ?', contentId);
  return row ? bytesToHex(row.quick) : undefined;
}

export const errorOf = (code: string | null): LibraryErrorCode | undefined => (code ? (code as LibraryErrorCode) : undefined);
export { jsonIds };
