import type { DuplicateSet, GroupEvidence, LibraryGroup, LibraryRevision } from '../../lib/library/model';
import { atomic, get, jsonIds, run, type Ctx } from './context';
import type { SuggestionWrite } from './types';

const contentRowId = (ctx: Ctx, publicId: string): number | undefined => get<{ id: number }>(ctx, 'SELECT id FROM content WHERE public_id = ?', publicId)?.id;
const fileRowId = (ctx: Ctx, publicId: string): number | undefined => get<{ id: number }>(ctx, 'SELECT id FROM file WHERE public_id = ?', publicId)?.id;

export const evidenceJson = (evidence: readonly GroupEvidence[]): string => JSON.stringify(evidence.slice(0, 256));

/** Inserts or replaces a group and its members. Members that name an unknown content are skipped; returns how many were stored. */
export function putGroup(ctx: Ctx, group: LibraryGroup): number {
  return atomic(ctx, () => {
    run(ctx, `INSERT INTO grp(id, label, vendor, model, board_number, device_type, updated, tags) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, vendor = excluded.vendor, model = excluded.model, board_number = excluded.board_number,
        device_type = excluded.device_type, updated = excluded.updated, tags = excluded.tags`,
    group.id, group.label, group.vendor ?? null, group.model ?? null, group.boardNumber ?? null, group.deviceType ?? null, Math.trunc(group.updated), JSON.stringify(group.tags));
    run(ctx, 'DELETE FROM member WHERE group_id = ?', group.id);
    let stored = 0;
    for (const m of group.members) {
      const contentId = contentRowId(ctx, m.contentId);
      if (contentId === undefined) continue;
      run(ctx, 'INSERT OR REPLACE INTO member(group_id, content_id, role, revision, tier, evidence) VALUES(?, ?, ?, ?, ?, ?)', group.id, contentId, m.role, m.revision ?? null, m.tier, evidenceJson(m.evidence));
      stored++;
    }
    return stored;
  });
}

export function removeGroup(ctx: Ctx, groupId: string): boolean {
  return atomic(ctx, () => run(ctx, 'DELETE FROM grp WHERE id = ?', groupId).changes) > 0;
}

export function putRevisions(ctx: Ctx, groupId: string, revisions: readonly LibraryRevision[]): number {
  return atomic(ctx, () => {
    run(ctx, 'DELETE FROM revision WHERE group_id = ?', groupId);
    let stored = 0;
    for (const r of revisions) {
      const contentId = contentRowId(ctx, r.contentId);
      if (contentId === undefined || get(ctx, 'SELECT 1 AS x FROM grp WHERE id = ?', groupId) === undefined) continue;
      run(ctx, 'INSERT OR REPLACE INTO revision(group_id, content_id, label, scheme, ordinal, basis, added_parts, removed_parts, changed_values) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
        groupId, contentId, r.label, r.scheme, r.order ?? null, r.basis, r.addedParts ?? null, r.removedParts ?? null, r.changedValues ?? null);
      stored++;
    }
    return stored;
  });
}

export function putDuplicateSet(ctx: Ctx, set: DuplicateSet): void {
  atomic(ctx, () => {
    run(ctx, `INSERT INTO duplicate_set(id, kind, evidence) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, evidence = excluded.evidence`, set.id, set.kind, evidenceJson(set.evidence));
    run(ctx, 'DELETE FROM duplicate_file WHERE set_id = ?', set.id);
    run(ctx, 'DELETE FROM duplicate_content WHERE set_id = ?', set.id);
    for (const f of set.fileIds) { const id = fileRowId(ctx, f); if (id !== undefined) run(ctx, 'INSERT OR IGNORE INTO duplicate_file(set_id, file_id) VALUES(?, ?)', set.id, id); }
    for (const c of set.contentIds) { const id = contentRowId(ctx, c); if (id !== undefined) run(ctx, 'INSERT OR IGNORE INTO duplicate_content(set_id, content_id) VALUES(?, ?)', set.id, id); }
  });
}

export function removeDuplicateSets(ctx: Ctx, ids: readonly string[]): number {
  return atomic(ctx, () => run(ctx, 'DELETE FROM duplicate_set WHERE id IN (SELECT value FROM json_each(?))', jsonIds(ids)).changes);
}

/** Pair suggestions are stored with a < b (the pair is unordered). Unknown contents are skipped. */
export function putSuggestions(ctx: Ctx, suggestions: readonly SuggestionWrite[]): number {
  return atomic(ctx, () => {
    let stored = 0;
    for (const s of suggestions) {
      const a = contentRowId(ctx, s.a), b = contentRowId(ctx, s.b);
      if (a === undefined || b === undefined || a === b) continue;
      run(ctx, 'INSERT OR REPLACE INTO suggestion(a, b, kind, score, evidence) VALUES(?, ?, ?, ?, ?)', Math.min(a, b), Math.max(a, b), s.kind, s.score, evidenceJson(s.evidence));
      stored++;
    }
    return stored;
  });
}

export function removeSuggestionsFor(ctx: Ctx, contentPublicId: string): number {
  const id = contentRowId(ctx, contentPublicId);
  return id === undefined ? 0 : atomic(ctx, () => run(ctx, 'DELETE FROM suggestion WHERE a = ? OR b = ?', id, id).changes);
}
