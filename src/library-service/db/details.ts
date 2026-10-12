import { FILE_ROLES, LIBRARY_ERRORS, LIBRARY_KINDS, type DuplicateSet, type FileRole, type FileState, type GroupEvidence, type GroupMember, type LibraryErrorCode, type LibraryFile, type LibraryGroup, type LibraryKind, type LibraryRevision } from '../../lib/library/model';
import type { GroupDetail, SimilarGroup } from '../../lib/library/protocol';
import { all, get, int, jsonIds, text, type Ctx } from './context';
import { bytesToHex } from './codec';
import { dirPather, joinPath } from './files';
import { loadBoardSummary, loadDocumentSummary } from './summary';

const MAX_FILES = 2000;
const MAX_SUMMARIES = 200;

interface FileJoin {
  id: number; public_id: string; dir_id: number; name: string; container_id: number | null; entry_path: string | null; size: number; mtime_ms: number | null; file_key: string | null;
  content_id: number | null; state: string; seen_scan: number; missing_since: number | null;
  root_public: string; c_public: string | null; quick: Uint8Array | null; sha256: Uint8Array | null; kind: string | null; format: string | null; problem: string | null;
  override_role: string | null; member_role: string | null; doc_type: string | null; container_public: string | null;
}

const FILE_SELECT = `SELECT f.id, f.public_id, f.dir_id, f.name, f.container_id, f.entry_path, f.size, f.mtime_ms, f.file_key, f.content_id, f.state, f.seen_scan, f.missing_since,
    r.public_id AS root_public, c.public_id AS c_public, c.quick, c.sha256, c.kind, c.format, c.problem,
    ro.role AS override_role, (SELECT m.role FROM member m WHERE m.content_id = f.content_id LIMIT 1) AS member_role, doc.doc_type, cf.public_id AS container_public
  FROM file f JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id LEFT JOIN content c ON c.id = f.content_id
  LEFT JOIN role_override ro ON ro.content_id = f.content_id LEFT JOIN document doc ON doc.content_id = f.content_id LEFT JOIN file cf ON cf.id = f.container_id`;

const KIND_ROLE: Record<string, FileRole> = { board: 'board', 'board-archive': 'board', schematic: 'schematic', image: 'photo', firmware: 'firmware' };

/** The role shown for a file: a user override, then the group membership, then the document type, then the kind. */
export function roleOf(kind: string | null, overrideRole: string | null, memberRole: string | null, docType: string | null): FileRole {
  for (const candidate of [overrideRole, memberRole, docType]) if (candidate && (FILE_ROLES as readonly string[]).includes(candidate)) return candidate as FileRole;
  return (kind && KIND_ROLE[kind]) || 'other';
}

function toFile(ctx: Ctx, row: FileJoin, pather: (id: number) => string): LibraryFile {
  const dir = pather(row.dir_id);
  let relativePath: string;
  if (row.container_id === null) relativePath = joinPath(dir, row.name);
  else {
    const container = get<{ dir_id: number; name: string }>(ctx, 'SELECT dir_id, name FROM file WHERE id = ?', row.container_id);
    relativePath = container ? joinPath(pather(container.dir_id), container.name) : '';
  }
  const kind: LibraryKind = row.kind && (LIBRARY_KINDS as readonly string[]).includes(row.kind) ? row.kind as LibraryKind : 'unknown';
  const problem = row.problem && (LIBRARY_ERRORS as readonly string[]).includes(row.problem) ? row.problem as LibraryErrorCode : undefined;
  return {
    id: row.public_id, rootId: row.root_public, relativePath, size: int(row.size),
    ...(row.mtime_ms === null ? {} : { mtimeMs: int(row.mtime_ms) }), ...(row.file_key === null ? {} : { fileKey: row.file_key }),
    ...(row.quick ? { quickKey: bytesToHex(row.quick) } : {}), ...(row.sha256 ? { sha256: bytesToHex(row.sha256) } : {}),
    ...(row.c_public ? { contentId: row.c_public } : {}), ...(row.container_public ? { containerId: row.container_public } : {}), ...(row.entry_path ? { entryPath: row.entry_path } : {}),
    state: row.state as FileState, kind, ...(row.format ? { format: row.format } : {}), role: roleOf(row.kind, row.override_role, row.member_role, row.doc_type),
    ...(problem ? { problem } : {}), ...(row.missing_since === null ? {} : { missingSince: int(row.missing_since) }), seenScan: String(int(row.seen_scan)),
  };
}

export function getFile(ctx: Ctx, publicId: string): LibraryFile | undefined {
  const row = get<FileJoin>(ctx, `${FILE_SELECT} WHERE f.public_id = ?`, publicId);
  return row ? toFile(ctx, row, dirPather(ctx)) : undefined;
}

function parseJson<T>(raw: unknown, fallback: T): T { try { return typeof raw === 'string' ? JSON.parse(raw) as T : fallback; } catch { return fallback; } }
const evidenceList = (raw: unknown): GroupEvidence[] => { const v = parseJson<unknown>(raw, []); return Array.isArray(v) ? v.filter((e): e is GroupEvidence => e !== null && typeof e === 'object') : []; };

export function getGroup(ctx: Ctx, id: string): GroupDetail | undefined {
  const g = get<{ id: string; label: string | null; vendor: string | null; model: string | null; board_number: string | null; device_type: string | null; updated: number | null; tags: string | null }>(ctx, 'SELECT * FROM grp WHERE id = ?', id);
  if (!g) return undefined;
  const memberRows = all<{ content_id: number; public_id: string; role: string; revision: string | null; tier: string; evidence: string }>(ctx,
    'SELECT m.content_id, c.public_id, m.role, m.revision, m.tier, m.evidence FROM member m JOIN content c ON c.id = m.content_id WHERE m.group_id = ? ORDER BY m.content_id LIMIT ?', id, MAX_FILES);
  const members: GroupMember[] = memberRows.map(m => ({ contentId: m.public_id, role: m.role as FileRole, ...(m.revision ? { revision: m.revision } : {}), tier: m.tier as GroupMember['tier'], evidence: evidenceList(m.evidence) }));
  const tags = parseJson<unknown>(g.tags, []);
  const group: LibraryGroup = {
    id: g.id, label: text(g.label), ...(g.board_number ? { boardNumber: g.board_number } : {}), ...(g.vendor ? { vendor: g.vendor } : {}), ...(g.model ? { model: g.model } : {}), ...(g.device_type ? { deviceType: g.device_type } : {}),
    updated: int(g.updated), members, tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
  };
  const contentIds = memberRows.map(m => m.content_id);
  const list = jsonIds(contentIds);
  const pather = dirPather(ctx);
  const files = all<FileJoin>(ctx, `${FILE_SELECT} WHERE f.content_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM hidden_file hf WHERE hf.file_id = f.id) AND NOT EXISTS (SELECT 1 FROM hidden_content hc WHERE hc.content_id = f.content_id) ORDER BY f.id LIMIT ?`, list, MAX_FILES).map(r => toFile(ctx, r, pather));
  const revisions: LibraryRevision[] = all<{ public_id: string; label: string; scheme: string; ordinal: number | null; basis: string; added_parts: number | null; removed_parts: number | null; changed_values: number | null }>(ctx,
    'SELECT c.public_id, r.label, r.scheme, r.ordinal, r.basis, r.added_parts, r.removed_parts, r.changed_values FROM revision r JOIN content c ON c.id = r.content_id WHERE r.group_id = ? ORDER BY r.ordinal, r.content_id', id).map(r => ({
    contentId: r.public_id, label: r.label, scheme: r.scheme, ...(r.ordinal === null ? {} : { order: int(r.ordinal) }), basis: r.basis as LibraryRevision['basis'],
    ...(r.added_parts === null ? {} : { addedParts: int(r.added_parts) }), ...(r.removed_parts === null ? {} : { removedParts: int(r.removed_parts) }), ...(r.changed_values === null ? {} : { changedValues: int(r.changed_values) }),
  }));
  const setIds = all<{ set_id: string }>(ctx, `SELECT set_id FROM duplicate_content WHERE content_id IN (SELECT value FROM json_each(?))
    UNION SELECT df.set_id FROM duplicate_file df JOIN file f ON f.id = df.file_id WHERE f.content_id IN (SELECT value FROM json_each(?)) LIMIT ?`, list, list, MAX_FILES).map(r => r.set_id);
  const duplicates: DuplicateSet[] = setIds.map(setId => {
    const s = get<{ id: string; kind: string; evidence: string }>(ctx, 'SELECT * FROM duplicate_set WHERE id = ?', setId)!;
    return {
      id: s.id, kind: s.kind as DuplicateSet['kind'],
      fileIds: all<{ public_id: string }>(ctx, 'SELECT f.public_id FROM duplicate_file x JOIN file f ON f.id = x.file_id WHERE x.set_id = ? ORDER BY f.id LIMIT ?', setId, MAX_FILES).map(r => r.public_id),
      contentIds: all<{ public_id: string }>(ctx, 'SELECT c.public_id FROM duplicate_content x JOIN content c ON c.id = x.content_id WHERE x.set_id = ? ORDER BY c.id LIMIT ?', setId, MAX_FILES).map(r => r.public_id),
      evidence: evidenceList(s.evidence),
    };
  });
  const boards = contentIds.slice(0, MAX_SUMMARIES * 4).map(c => loadBoardSummary(ctx, c)).filter((b): b is NonNullable<typeof b> => b !== undefined).slice(0, MAX_SUMMARIES);
  const documents = contentIds.slice(0, MAX_SUMMARIES * 4).map(c => loadDocumentSummary(ctx, c)).filter((d): d is NonNullable<typeof d> => d !== undefined).slice(0, MAX_SUMMARIES);
  return { group, files, revisions, duplicates, boards, documents };
}

const SIMILAR_LIMIT = 50;
const RARE_TERM_GROUPS = 50;
const MAX_REFERENCE_TERMS = 500;

/**
 * Other groups that look like this one. `layout` follows the stored pair suggestions of the grouping stage; `parts` weighs the part numbers
 * (known or board-confirmed) the two groups share by how rare each is, as a share of the weight of this group's own parts.
 */
export function similarGroups(ctx: Ctx, groupId: string, basis: 'layout' | 'parts'): SimilarGroup[] {
  if (get(ctx, 'SELECT 1 AS x FROM grp WHERE id = ?', groupId) === undefined) return [];
  if (basis === 'layout') {
    return all<{ gid: string; score: number }>(ctx, `SELECT o.group_id AS gid, MAX(s.score) AS score FROM member m
      JOIN suggestion s ON (s.a = m.content_id OR s.b = m.content_id) AND s.kind IN ('layout-similar', 'layout-related')
      JOIN member o ON o.content_id = CASE WHEN s.a = m.content_id THEN s.b ELSE s.a END
      WHERE m.group_id = ? AND o.group_id <> ? GROUP BY o.group_id ORDER BY score DESC, gid LIMIT ?`, groupId, groupId, SIMILAR_LIMIT)
      .map(r => ({ groupId: r.gid, score: Math.min(1, Math.max(0, Number(r.score))), basis: 'layout' as const }));
  }
  const mine = all<{ term_id: number }>(ctx, `SELECT DISTINCT p.term_id FROM posting p JOIN term t ON t.id = p.term_id JOIN member m ON m.content_id = p.content_id
    WHERE m.group_id = ? AND t.kind = 'part' AND p.tier IN (0, 1) LIMIT ?`, groupId, MAX_REFERENCE_TERMS).map(r => r.term_id);
  if (mine.length === 0) return [];
  const list = jsonIds(mine);
  const frequency = new Map<number, number>();
  for (const r of all<{ term_id: number; n: number }>(ctx, `SELECT p.term_id, count(DISTINCT m.group_id) AS n FROM posting p JOIN member m ON m.content_id = p.content_id
    WHERE p.term_id IN (SELECT value FROM json_each(?)) GROUP BY p.term_id`, list)) frequency.set(r.term_id, int(r.n));
  const rare = mine.filter(t => (frequency.get(t) ?? 0) > 0 && (frequency.get(t) ?? 0) <= RARE_TERM_GROUPS);
  const weight = (t: number): number => 1 / Math.max(1, frequency.get(t) ?? 1);
  const total = rare.reduce((sum, t) => sum + weight(t), 0);
  if (total === 0) return [];
  const shared = new Map<string, number>();
  for (const r of all<{ gid: string; term_id: number }>(ctx, `SELECT DISTINCT m.group_id AS gid, p.term_id FROM posting p JOIN member m ON m.content_id = p.content_id
    WHERE p.term_id IN (SELECT value FROM json_each(?)) AND m.group_id <> ?`, jsonIds(rare), groupId)) shared.set(r.gid, (shared.get(r.gid) ?? 0) + weight(r.term_id));
  return [...shared].map(([gid, w]) => ({ groupId: gid, score: Math.min(1, w / total), basis: 'parts' as const })).sort((a, b) => b.score - a.score || a.groupId.localeCompare(b.groupId)).slice(0, SIMILAR_LIMIT);
}
