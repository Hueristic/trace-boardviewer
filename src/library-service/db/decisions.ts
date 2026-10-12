import { existsSync, readFileSync, statSync } from 'node:fs';
import type { DecisionTarget, LibraryDecision, LibraryId, StoredDecision } from '../../lib/library/model';
import { validateLibraryDecision } from '../../lib/library/validate';
import { all, atomic, get, jsonIds, run, text, type Ctx } from './context';
import { bytesToHex, hexToBytes } from './codec';
import { dirPather, joinPath } from './files';
import { rootByPublicId } from './roots';

export const DECISIONS_FILE_VERSION = 1;
const MAX_DECISIONS = 200_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** What the grouping stage has to honour; contents are public content ids that exist in the current index. */
export type GroupingConstraint =
  | { kind: 'same' | 'different'; a: LibraryId; b: LibraryId }
  | { kind: 'merge'; contents: LibraryId[] }
  | { kind: 'split'; contents: LibraryId[] };

export interface ApplyReport {
  /** Decisions that took effect in this pass (label, tag, role, hide) or yielded a grouping constraint. */
  applied: number;
  /** Decisions whose targets do not exist (yet): they stay in the decisions file and are tried again after the next scan. */
  unresolved: number;
  grouping: GroupingConstraint[];
}

const validTarget = (target: unknown): boolean => validateLibraryDecision({ kind: 'role', target, role: 'other' });

/** Validates one stored decision; the decision itself goes through the shared transport validator. */
export function isStoredDecision(value: unknown): value is StoredDecision {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => k === 'id' || k === 'at' || k === 'decision' || k === 'targets') &&
    typeof v.id === 'string' && idPattern.test(v.id) && typeof v.at === 'number' && Number.isSafeInteger(v.at) && v.at >= 0 &&
    validateLibraryDecision(v.decision) && Array.isArray(v.targets) && v.targets.length <= 256 && v.targets.every(validTarget);
}

/** Parses the text of `library-decisions.json`. Entries that fail validation are dropped and counted; nothing throws. */
export function parseDecisionFile(raw: string): { decisions: StoredDecision[]; dropped: number } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { decisions: [], dropped: 0 }; }
  const list = value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { version?: unknown }).version === DECISIONS_FILE_VERSION ? (value as { decisions?: unknown }).decisions : undefined;
  if (!Array.isArray(list)) return { decisions: [], dropped: 0 };
  const decisions: StoredDecision[] = [];
  let dropped = 0;
  for (const entry of list.slice(0, MAX_DECISIONS)) { if (isStoredDecision(entry)) decisions.push(entry); else dropped++; }
  return { decisions, dropped: dropped + Math.max(0, list.length - MAX_DECISIONS) };
}

/** Reads the decisions file read-only. A missing, oversized or unreadable file gives no decisions. */
export function readDecisionFile(path: string): { decisions: StoredDecision[]; dropped: number; found: boolean } {
  try {
    if (!existsSync(path)) return { decisions: [], dropped: 0, found: false };
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { decisions: [], dropped: 0, found: true };
    return { ...parseDecisionFile(readFileSync(path, 'utf8')), found: true };
  } catch { return { decisions: [], dropped: 0, found: false }; }
}

interface Resolved { contentId?: number; fileId?: number }

/** Finds the content (and file) a durable target names in the current index. */
export function resolveTarget(ctx: Ctx, target: DecisionTarget): Resolved | undefined {
  if (target.kind === 'content') {
    const sha = hexToBytes(target.sha256);
    const row = sha ? get<{ id: number }>(ctx, 'SELECT id FROM content WHERE sha256 = ?', sha) : undefined;
    return row ? { contentId: row.id } : undefined;
  }
  const root = rootByPublicId(ctx, target.rootId);
  if (!root) return undefined;
  const segments = target.relativePath.split('/');
  const name = segments.pop()!;
  let dir = get<{ id: number }>(ctx, 'SELECT id FROM dir WHERE root_id = ? AND parent_id IS NULL', root.id)?.id;
  for (const segment of segments) {
    if (dir === undefined) return undefined;
    dir = get<{ id: number }>(ctx, 'SELECT id FROM dir WHERE root_id = ? AND parent_id = ? AND name = ?', root.id, dir, segment)?.id;
  }
  if (dir === undefined) return undefined;
  const loose = get<{ id: number; content_id: number | null }>(ctx, 'SELECT id, content_id FROM file WHERE dir_id = ? AND name = ? AND container_id IS NULL', dir, name);
  if (!loose) return undefined;
  if (target.entryPath === undefined) return { fileId: loose.id, ...(loose.content_id === null ? {} : { contentId: loose.content_id }) };
  const entry = get<{ id: number; content_id: number | null }>(ctx, 'SELECT id, content_id FROM file WHERE container_id = ? AND entry_path = ?', loose.id, target.entryPath);
  return entry ? { fileId: entry.id, ...(entry.content_id === null ? {} : { contentId: entry.content_id }) } : undefined;
}

/** The durable target of a content: its full hash when known, else the location of one of its files. */
export function targetOfContent(ctx: Ctx, contentId: number): DecisionTarget | undefined {
  const content = get<{ sha256: Uint8Array | null }>(ctx, 'SELECT sha256 FROM content WHERE id = ?', contentId);
  if (!content) return undefined;
  if (content.sha256) return { kind: 'content', sha256: bytesToHex(content.sha256) };
  const file = get<{ id: number; dir_id: number; name: string; container_id: number | null; entry_path: string | null; root: string }>(ctx,
    `SELECT f.id, f.dir_id, f.name, f.container_id, f.entry_path, r.public_id AS root FROM file f JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id
     WHERE f.content_id = ? ORDER BY f.id LIMIT 1`, contentId);
  if (!file) return undefined;
  const pather = dirPather(ctx);
  if (file.container_id === null) return { kind: 'file', rootId: file.root, relativePath: joinPath(pather(file.dir_id), file.name) };
  const container = get<{ dir_id: number; name: string }>(ctx, 'SELECT dir_id, name FROM file WHERE id = ?', file.container_id);
  return container && file.entry_path ? { kind: 'file', rootId: file.root, relativePath: joinPath(pather(container.dir_id), container.name), entryPath: file.entry_path } : undefined;
}

/** Up to eight member targets of a group, board files first: enough to find the group again after a rebuild. */
function groupTargets(ctx: Ctx, groupId: string): DecisionTarget[] | undefined {
  if (get(ctx, 'SELECT 1 AS x FROM grp WHERE id = ?', groupId) === undefined) return undefined;
  const members = all<{ content_id: number }>(ctx, "SELECT content_id FROM member WHERE group_id = ? ORDER BY (role = 'board') DESC, (role = 'schematic') DESC, content_id LIMIT 8", groupId);
  const targets = members.map(m => targetOfContent(ctx, m.content_id)).filter((t): t is DecisionTarget => t !== undefined);
  return targets.length ? targets : undefined;
}

/**
 * Turns a decision that names current group or content ids into the durable targets main stores next to it. Pair, role and hide
 * decisions already carry targets. Returns undefined when an id is unknown (the decision must not be persisted).
 */
export function resolveDecisionTargets(ctx: Ctx, decision: LibraryDecision): DecisionTarget[] | undefined {
  switch (decision.kind) {
    case 'same': case 'different': return [decision.a, decision.b];
    case 'role': case 'hide': return [decision.target];
    case 'label': case 'tag': return groupTargets(ctx, decision.groupId);
    case 'merge': {
      const targets: DecisionTarget[] = [];
      for (const id of decision.groups) { const t = groupTargets(ctx, id)?.[0]; if (!t) return undefined; targets.push(t); }
      return targets;
    }
    case 'split': {
      const targets: DecisionTarget[] = [];
      for (const id of decision.contents) {
        const row = get<{ id: number }>(ctx, 'SELECT id FROM content WHERE public_id = ?', id);
        const t = row ? targetOfContent(ctx, row.id) : undefined;
        if (!t) return undefined;
        targets.push(t);
      }
      return targets;
    }
  }
}

const publicContent = (ctx: Ctx, id: number): string | undefined => get<{ public_id: string }>(ctx, 'SELECT public_id FROM content WHERE id = ?', id)?.public_id;

/**
 * Replays stored decisions on the current index, in order (a later decision overrides an earlier one). Hide flags and role overrides
 * go to connection-local tables that are rebuilt from scratch each time; label and tag edit the groups; pair, merge and split
 * decisions are returned as constraints for the grouping stage. Idempotent; call it after a rebuild, after each scan and after grouping.
 */
export function applyDecisions(ctx: Ctx, decisions: readonly StoredDecision[]): ApplyReport {
  const report: ApplyReport = { applied: 0, unresolved: 0, grouping: [] };
  atomic(ctx, () => {
    run(ctx, 'DELETE FROM hidden_file');
    run(ctx, 'DELETE FROM hidden_content');
    run(ctx, 'DELETE FROM role_override');
    for (const stored of decisions) {
      const d = stored.decision;
      const targets = (stored.targets.length ? stored.targets : resolveInline(d)).map(t => resolveTarget(ctx, t));
      const resolved = targets.filter((t): t is Resolved => t !== undefined);
      const contents = [...new Set(resolved.map(t => t.contentId).filter((id): id is number => id !== undefined))];
      if (resolved.length === 0 || (d.kind !== 'label' && d.kind !== 'tag' && resolved.length < targets.length)) { report.unresolved++; continue; }
      switch (d.kind) {
        case 'hide': {
          const t = resolved[0];
          const table = t.fileId !== undefined && d.target.kind === 'file' ? 'file' : 'content';
          if (table === 'file') { if (d.hidden) run(ctx, 'INSERT OR IGNORE INTO hidden_file(file_id) VALUES(?)', t.fileId!); else run(ctx, 'DELETE FROM hidden_file WHERE file_id = ?', t.fileId!); }
          else if (t.contentId !== undefined) { if (d.hidden) run(ctx, 'INSERT OR IGNORE INTO hidden_content(content_id) VALUES(?)', t.contentId); else run(ctx, 'DELETE FROM hidden_content WHERE content_id = ?', t.contentId); }
          else { report.unresolved++; continue; }
          report.applied++;
          break;
        }
        case 'role':
          if (resolved[0].contentId === undefined) { report.unresolved++; continue; }
          run(ctx, 'INSERT INTO role_override(content_id, role) VALUES(?, ?) ON CONFLICT(content_id) DO UPDATE SET role = excluded.role', resolved[0].contentId, d.role);
          report.applied++;
          break;
        case 'label': case 'tag': {
          const group = contents.length ? get<{ group_id: string }>(ctx, `SELECT group_id FROM member WHERE content_id IN (SELECT value FROM json_each(?))
            GROUP BY group_id ORDER BY count(*) DESC, group_id LIMIT 1`, jsonIds(contents)) : undefined;
          if (!group) { report.unresolved++; continue; }
          if (d.kind === 'label') run(ctx, 'UPDATE grp SET label = ? WHERE id = ?', d.label, group.group_id);
          else {
            const row = get<{ tags: string | null }>(ctx, 'SELECT tags FROM grp WHERE id = ?', group.group_id);
            let tags: string[] = [];
            try { const parsed: unknown = JSON.parse(text(row?.tags) || '[]'); if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string'); } catch { /* start from no tags */ }
            const next = d.enabled ? [...new Set([...tags, d.tag])] : tags.filter(x => x !== d.tag);
            run(ctx, 'UPDATE grp SET tags = ? WHERE id = ?', JSON.stringify(next), group.group_id);
          }
          report.applied++;
          break;
        }
        case 'same': case 'different': {
          const a = resolved[0].contentId, b = resolved[1]?.contentId;
          const pa = a === undefined ? undefined : publicContent(ctx, a), pb = b === undefined ? undefined : publicContent(ctx, b);
          if (!pa || !pb) { report.unresolved++; continue; }
          report.grouping.push({ kind: d.kind, a: pa, b: pb });
          report.applied++;
          break;
        }
        case 'merge': case 'split': {
          const ids = contents.map(c => publicContent(ctx, c)).filter((x): x is string => x !== undefined);
          if (ids.length === 0) { report.unresolved++; continue; }
          report.grouping.push({ kind: d.kind, contents: ids });
          report.applied++;
          break;
        }
      }
    }
  });
  return report;
}

/** Pair, role and hide decisions carry their own targets; this covers a stored record whose `targets` list is empty. */
function resolveInline(d: LibraryDecision): DecisionTarget[] {
  switch (d.kind) {
    case 'same': case 'different': return [d.a, d.b];
    case 'role': case 'hide': return [d.target];
    default: return [];
  }
}

/** Rewrites location targets after a confirmed move so that decisions follow the file. Content (hash) targets are untouched. */
export function retargetDecisions(decisions: readonly StoredDecision[], from: { rootId: string; relativePath: string; entryPath?: string }, to: { rootId: string; relativePath: string; entryPath?: string }): StoredDecision[] {
  const same = (t: DecisionTarget): boolean => t.kind === 'file' && t.rootId === from.rootId && t.relativePath === from.relativePath && t.entryPath === from.entryPath;
  const swap = (t: DecisionTarget): DecisionTarget => (same(t) ? { kind: 'file', rootId: to.rootId, relativePath: to.relativePath, ...(to.entryPath === undefined ? {} : { entryPath: to.entryPath }) } : t);
  return decisions.map(s => {
    const d = s.decision;
    const decision: LibraryDecision = d.kind === 'same' || d.kind === 'different' ? { ...d, a: swap(d.a), b: swap(d.b) } : d.kind === 'role' || d.kind === 'hide' ? { ...d, target: swap(d.target) } : d;
    return { ...s, decision, targets: s.targets.map(swap) };
  });
}
