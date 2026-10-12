import { createHash, randomBytes } from 'node:crypto';
import { FILE_ROLES, FILE_STATES, LIBRARY_KINDS, type FileRole, type FileState, type LibraryKind } from '../../lib/library/model';
import type { QueryPage, QueryRow, SearchMatch } from '../../lib/library/protocol';
import { QUERY_MODES, QUERY_SORTS, parseQuery, type PartMatch, type QueryFilters, type QueryRequest, type QueryTerm } from '../../lib/library/query';
import { all, dynamicAll, dynamicRun, get, int, jsonIds, run, text, type Bind, type Ctx } from './context';
import { unpackPages } from './codec';
import { dirPather, joinPath } from './files';
import { epoch } from './meta';
import { loadRefs } from './summary';
import type { QueryResult } from './types';

/** More terms than this are ignored (the first ones win): each term costs a hit set. */
export const MAX_QUERY_TERMS = 8;
const NAME_HIT_RANK = 17;
const NO_HIT = 99;
/** Most rows a short, literal file-name substring (under three characters, which a trigram index cannot answer) may produce. */
const SHORT_NAME_LIMIT = 5000;
const FULL_TEXT_LIMIT = 50_000;
const PROBLEM_STATES: readonly FileState[] = ['unknown', 'unsupported', 'encrypted', 'damaged', 'skipped', 'link', 'no-access', 'locked', 'missing'];
const DOCUMENT_ROLES = ['board-pdf', 'datasheet', 'service-manual', 'bom', 'other'];
const TIERS = ['exact', 'base', 'prefix', 'family', 'text'] as const;

export class InvalidCursorError extends Error { readonly code = 'invalid-request' as const; constructor() { super('The cursor is not valid for this request'); } }

type Mode = typeof QUERY_MODES[number];
type Sort = typeof QUERY_SORTS[number];

const strings = (value: unknown, allowed?: readonly string[]): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && (!allowed || allowed.includes(v))).slice(0, 128);
  return out.length ? [...new Set(out)] : undefined;
};

interface Filters { roots?: string[]; kinds?: string[]; roles?: string[]; states?: string[]; formats?: string[]; vendors?: string[]; deviceTypes?: string[]; has?: string[]; groupId?: string }

function sanitizeFilters(input: QueryFilters | undefined): Filters {
  const f = (input ?? {}) as Record<string, unknown>;
  const out: Filters = {};
  const roots = strings(f.roots), kinds = strings(f.kinds, LIBRARY_KINDS), roles = strings(f.roles, FILE_ROLES), states = strings(f.states, FILE_STATES), formats = strings(f.formats);
  const vendors = strings(f.vendors), deviceTypes = strings(f.deviceTypes), has = strings(f.has, ['board', 'schematic', 'documents']);
  if (roots) out.roots = roots; if (kinds) out.kinds = kinds; if (roles) out.roles = roles; if (states) out.states = states; if (formats) out.formats = formats;
  if (vendors) out.vendors = vendors; if (deviceTypes) out.deviceTypes = deviceTypes; if (has) out.has = has;
  if (typeof f.groupId === 'string' && f.groupId.length > 0 && f.groupId.length <= 64) out.groupId = f.groupId;
  return out;
}

const canonicalFilters = (f: Filters): string => JSON.stringify(Object.keys(f).sort().map(k => [k, Array.isArray((f as Record<string, unknown>)[k]) ? [...((f as Record<string, string[]>)[k])].sort() : (f as Record<string, unknown>)[k]]));

/** Query-side normalisation of a part number: NFKC, upper case, unicode dashes to a hyphen. */
export const normalizeQueryPart = (value: string): string => value.normalize('NFKC').trim().toUpperCase().replace(/[‐-―−]/g, '-').replace(/\u0000/g, '');

const ftsPhrase = (value: string): string => `"${value.replace(/\u0000/g, '').replace(/"/g, '""')}"`;
const codePoints = (value: string): number => [...value].length;

interface Builder { sql: string[]; params: Bind[]; add(fragment: string, ...values: Bind[]): void }
const builder = (): Builder => { const b: Builder = { sql: [], params: [], add(fragment, ...values) { b.sql.push(fragment); b.params.push(...values); } }; return b; };

interface TermInfo { term: QueryTerm; index: number; hasContentHits: boolean; hasNameHits: boolean; groupText: string | undefined }

/** Inserts the hit sets of one term: contents with a rank (q_hits) and files whose name matched (q_nhits). */
function fillTermHits(ctx: Ctx, index: number, term: QueryTerm, filters: Filters, hasFullText: boolean): TermInfo {
  const info: TermInfo = { term, index, hasContentHits: false, hasNameHits: false, groupText: undefined };
  const hits = 'INSERT INTO q_hits(term, content_id, mrank, ptier, source, refs, extra, pages, page)';
  const insertPostings = (where: string, rank: number, ...params: Bind[]): void => {
    dynamicRun(ctx, `${hits} SELECT ${index}, p.content_id, CASE WHEN p.tier = 3 THEN 4 ELSE ${rank} END, p.tier, p.source, p.refs, p.additional_refs, p.pages, NULL
      FROM term t JOIN posting p ON p.term_id = t.id WHERE ${where}`, params);
    info.hasContentHits = true;
  };
  const nameHits = (value: string, nameOnly: boolean): void => {
    info.hasNameHits = true;
    const folded = value.normalize('NFKC');
    if (codePoints(folded) >= 3) {
      dynamicRun(ctx, `INSERT INTO q_nhits(term, file_id, content_id) SELECT ${index}, f.id, f.content_id FROM file f WHERE f.id IN (SELECT rowid FROM name_fts WHERE name_fts MATCH ?)`, [`${nameOnly ? 'name : ' : ''}${ftsPhrase(folded)}`]);
    } else {
      dynamicRun(ctx, `INSERT INTO q_nhits(term, file_id, content_id) SELECT ${index}, f.id, f.content_id FROM file f WHERE instr(library_fold(f.name), ?) > 0 LIMIT ${SHORT_NAME_LIMIT}`, [folded.toLowerCase()]);
    }
  };
  const partMatch = (value: string, match: PartMatch): void => {
    const v = normalizeQueryPart(value);
    if (match === 'exact') insertPostings("t.kind = 'part' AND t.norm = ?", 0, v);
    else if (match === 'base') insertPostings("t.kind = 'part' AND (t.base = ? OR (t.base IS NULL AND t.norm = ?))", 1, v, v);
    else if (match === 'prefix') insertPostings("t.kind = 'part' AND t.norm >= ? AND t.norm < ?", 2, v, `${v}\u{10FFFF}`);
    else insertPostings("t.kind = 'part' AND t.family IN (?, ?)", 3, value.trim(), value.trim().toLowerCase());
  };
  const boardNumbers = (value: string, rank: number): void => {
    const v = normalizeQueryPart(value);
    dynamicRun(ctx, `${hits} SELECT ${index}, i.content_id, ${rank}, 0, i.source, NULL, 0, NULL, i.page FROM identifier i WHERE i.kind = 'board-number' AND i.norm = ? AND i.content_id IS NOT NULL`, [v]);
    dynamicRun(ctx, `${hits} SELECT ${index}, f.content_id, ${rank}, 0, i.source, NULL, 0, NULL, i.page FROM identifier i JOIN file f ON f.id = i.file_id WHERE i.kind = 'board-number' AND i.norm = ? AND f.content_id IS NOT NULL`, [v]);
    info.hasContentHits = true;
  };
  const rails = (value: string): void => {
    insertPostings("t.kind = 'rail' AND t.norm = ?", 0, value.normalize('NFKC').trim().toUpperCase());
  };
  switch (term.field) {
    case 'part': partMatch(term.value, term.match ?? 'exact'); break;
    case 'board': boardNumbers(term.value, 0); break;
    case 'rail': rails(term.value); break;
    case 'file': nameHits(term.value, true); break;
    case 'ref': {
      if (!filters.groupId) break;
      const wanted = term.value.normalize('NFKC').trim().toUpperCase();
      const members = all<{ id: number }>(ctx, 'SELECT m.content_id AS id FROM member m WHERE m.group_id = ?', filters.groupId);
      for (const m of members) {
        const found = loadRefs(ctx, m.id).find(r => r.toUpperCase() === wanted);
        if (found !== undefined) run(ctx, `${hits} VALUES(?, ?, 0, 0, 'refs', ?, 0, NULL, NULL)`, index, m.id, found);
      }
      info.hasContentHits = true;
      break;
    }
    default: {
      const v = normalizeQueryPart(term.value);
      insertPostings("t.kind = 'part' AND t.norm = ?", 0, v);
      insertPostings("t.kind = 'part' AND t.base = ? AND t.norm <> ?", 1, v, v);
      boardNumbers(term.value, 0);
      rails(term.value);
      nameHits(term.value, false);
      info.groupText = term.value.normalize('NFKC').toLowerCase();
      if (hasFullText) {
        const scope = filters.roots ? ' AND r.public_id IN (SELECT value FROM json_each(?))' : '';
        const params: Bind[] = [ftsPhrase(term.value.normalize('NFKC'))];
        if (filters.roots) params.push(jsonIds(filters.roots));
        dynamicRun(ctx, `${hits} SELECT ${index}, rowid / 4096, 4, 3, 'text', NULL, 0, NULL, rowid % 4096 FROM text_fts WHERE text_fts MATCH ?
          AND rowid / 4096 IN (SELECT f.content_id FROM file f JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id WHERE json_extract(r.options, '$.fullText') = 1${scope}) LIMIT ${FULL_TEXT_LIMIT}`, params);
      }
    }
  }
  return info;
}

const hitContents = (i: number): string => `SELECT content_id FROM q_hits WHERE term = ${i}`;
const hitNames = (i: number): string => `SELECT content_id FROM q_nhits WHERE term = ${i} AND content_id IS NOT NULL`;
const hitFiles = (i: number): string => `SELECT file_id FROM q_nhits WHERE term = ${i}`;

function termPredicate(mode: Mode, info: TermInfo, b: Builder): string {
  const i = info.index;
  const contentMatch = (column: string, fileColumn?: string, rootOptions?: string): string => {
    const parts: string[] = [];
    if (info.hasContentHits) parts.push(rootOptions ? `EXISTS (SELECT 1 FROM q_hits th WHERE th.term = ${i} AND th.content_id = ${column}
      AND (th.source <> 'text' OR json_extract(${rootOptions}, '$.fullText') = 1))` : `${column} IN (${hitContents(i)})`);
    if (info.hasNameHits) parts.push(fileColumn ? `${fileColumn} IN (${hitFiles(i)})` : `${column} IN (${hitNames(i)})`);
    return parts.length ? parts.join(' OR ') : '0';
  };
  if (mode === 'boards') {
    const base = `EXISTS (SELECT 1 FROM member tm JOIN file tf ON tf.content_id = tm.content_id JOIN dir td ON td.id = tf.dir_id JOIN root tr ON tr.id = td.root_id
      WHERE tm.group_id = g.id AND tf.state <> 'missing' AND tr.state <> 'removing'
      AND NOT EXISTS (SELECT 1 FROM hidden_file hf WHERE hf.file_id = tf.id) AND NOT EXISTS (SELECT 1 FROM hidden_content hc WHERE hc.content_id = tf.content_id)
      AND (${contentMatch('tm.content_id', 'tf.id', 'tr.options')}))`;
    if (info.groupText === undefined) return base;
    b.params.push(info.groupText);
    return `(${base} OR instr(lower(coalesce(g.label, '') || ' ' || coalesce(g.vendor, '') || ' ' || coalesce(g.model, '') || ' ' || coalesce(g.board_number, '')), ?) > 0)`;
  }
  if (mode === 'duplicates') {
    return `EXISTS (SELECT 1 FROM file tf JOIN dir td ON td.id = tf.dir_id JOIN root tr ON tr.id = td.root_id
      WHERE (tf.id IN (SELECT file_id FROM duplicate_file WHERE set_id = s.id) OR tf.content_id IN (SELECT content_id FROM duplicate_content WHERE set_id = s.id))
      AND tr.state <> 'removing' AND NOT EXISTS (SELECT 1 FROM hidden_file hf WHERE hf.file_id = tf.id)
      AND NOT EXISTS (SELECT 1 FROM hidden_content hc WHERE hc.content_id = tf.content_id) AND (${contentMatch('tf.content_id', 'tf.id', 'tr.options')}))`;
  }
  return `(${contentMatch('f.content_id', 'f.id', 'r.options')})`;
}

const ROLE_FILE = `COALESCE(ro.role, (SELECT m.role FROM member m WHERE m.content_id = f.content_id LIMIT 1), doc.doc_type,
  CASE c.kind WHEN 'board' THEN 'board' WHEN 'board-archive' THEN 'board' WHEN 'schematic' THEN 'schematic' WHEN 'image' THEN 'photo' WHEN 'firmware' THEN 'firmware' ELSE 'other' END)`;
const FILE_JOINS = `JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id LEFT JOIN content c ON c.id = f.content_id
  LEFT JOIN document doc ON doc.content_id = f.content_id LEFT JOIN role_override ro ON ro.content_id = f.content_id`;
const NOT_HIDDEN = 'NOT EXISTS (SELECT 1 FROM hidden_file hf WHERE hf.file_id = f.id) AND (f.content_id IS NULL OR NOT EXISTS (SELECT 1 FROM hidden_content hc WHERE hc.content_id = f.content_id))';

function groupFilters(filters: Filters, b: Builder, alias = 'g'): string[] {
  const out: string[] = [];
  if (filters.groupId) { out.push(`${alias}.id = ?`); b.params.push(filters.groupId); }
  if (filters.vendors) { out.push(`${alias}.vendor IN (SELECT value FROM json_each(?))`); b.params.push(jsonIds(filters.vendors)); }
  if (filters.deviceTypes) { out.push(`${alias}.device_type IN (SELECT value FROM json_each(?))`); b.params.push(jsonIds(filters.deviceTypes)); }
  for (const want of filters.has ?? []) {
    out.push(`EXISTS (SELECT 1 FROM member hm WHERE hm.group_id = ${alias}.id AND ${want === 'board' ? "hm.role = 'board'" : want === 'schematic' ? "hm.role = 'schematic'" : `hm.role IN (${DOCUMENT_ROLES.map(r => `'${r}'`).join(',')})`})`);
  }
  return out;
}

/** Row-level filters of the file modes: they look at the group (or groups) a file's content belongs to. */
function fileRowFilters(filters: Filters, b: Builder): string[] {
  const out: string[] = [];
  if (filters.groupId) { out.push('f.content_id IN (SELECT gm.content_id FROM member gm WHERE gm.group_id = ?)'); b.params.push(filters.groupId); }
  if (filters.vendors) { out.push('EXISTS (SELECT 1 FROM member vm JOIN grp vg ON vg.id = vm.group_id WHERE vm.content_id = f.content_id AND vg.vendor IN (SELECT value FROM json_each(?)))'); b.params.push(jsonIds(filters.vendors)); }
  if (filters.deviceTypes) { out.push('EXISTS (SELECT 1 FROM member dm JOIN grp dg ON dg.id = dm.group_id WHERE dm.content_id = f.content_id AND dg.device_type IN (SELECT value FROM json_each(?)))'); b.params.push(jsonIds(filters.deviceTypes)); }
  for (const want of filters.has ?? []) {
    out.push(`EXISTS (SELECT 1 FROM member hm JOIN member hm2 ON hm2.group_id = hm.group_id WHERE hm.content_id = f.content_id AND ${want === 'board' ? "hm2.role = 'board'" : want === 'schematic' ? "hm2.role = 'schematic'" : `hm2.role IN (${DOCUMENT_ROLES.map(r => `'${r}'`).join(',')})`})`);
  }
  return out;
}

function fillPairs(ctx: Ctx, mode: Mode, filters: Filters, infos: TermInfo[]): void {
  const b = builder();
  b.add('INSERT INTO q_pairs(row_id, file_id, kind, role, format, root, state) ');
  const where: string[] = [];
  if (mode === 'boards') {
    b.add(`SELECT g.id, f.id, c.kind, COALESCE(ro.role, m.role), c.format, r.public_id, f.state FROM grp g
      LEFT JOIN member m ON m.group_id = g.id LEFT JOIN content c ON c.id = m.content_id
      LEFT JOIN file f ON f.content_id = m.content_id AND f.state <> 'missing' AND ${NOT_HIDDEN}
      LEFT JOIN dir d ON d.id = f.dir_id LEFT JOIN root r ON r.id = d.root_id AND r.state <> 'removing'
      LEFT JOIN role_override ro ON ro.content_id = m.content_id`);
    const gf = builder();
    where.push(...groupFilters(filters, gf));
    b.params.push(...gf.params);
    // Term predicates are written against `g` and may add parameters in textual order, after the filters above.
    const preds = builder();
    for (const info of infos) preds.sql.push(termPredicate(mode, info, preds));
    where.push(...preds.sql);
    b.params.push(...preds.params);
  } else if (mode === 'duplicates') {
    b.add(`SELECT s.id, f.id, c.kind, ${ROLE_FILE}, c.format, r.public_id, f.state FROM duplicate_set s
      LEFT JOIN (SELECT set_id, file_id FROM duplicate_file UNION SELECT dc.set_id, f2.id FROM duplicate_content dc JOIN file f2 ON f2.content_id = dc.content_id) x ON x.set_id = s.id
      LEFT JOIN file f ON f.id = x.file_id AND ${NOT_HIDDEN}
      LEFT JOIN dir d ON d.id = f.dir_id LEFT JOIN root r ON r.id = d.root_id LEFT JOIN content c ON c.id = f.content_id
      LEFT JOIN document doc ON doc.content_id = f.content_id LEFT JOIN role_override ro ON ro.content_id = f.content_id`);
    if (filters.groupId) { where.push('EXISTS (SELECT 1 FROM duplicate_content gdc JOIN member gm ON gm.content_id = gdc.content_id WHERE gdc.set_id = s.id AND gm.group_id = ?)'); b.params.push(filters.groupId); }
    const preds = builder();
    for (const info of infos) preds.sql.push(termPredicate(mode, info, preds));
    where.push(...preds.sql);
    b.params.push(...preds.params);
  } else {
    b.add(`SELECT f.id, f.id, c.kind, ${ROLE_FILE}, c.format, r.public_id, f.state FROM file f ${FILE_JOINS}`);
    where.push("r.state <> 'removing'", NOT_HIDDEN);
    if (mode === 'problems') where.push(`f.state IN (${PROBLEM_STATES.map(s => `'${s}'`).join(',')})`);
    if (mode === 'unsorted') where.push("f.state IN ('identified', 'pending', 'indexed')", 'NOT EXISTS (SELECT 1 FROM member um WHERE um.content_id = f.content_id)');
    const rf = builder();
    where.push(...fileRowFilters(filters, rf));
    b.params.push(...rf.params);
    const preds = builder();
    for (const info of infos) preds.sql.push(termPredicate(mode, info, preds));
    where.push(...preds.sql);
    b.params.push(...preds.params);
  }
  b.add(where.length ? ` WHERE ${where.join(' AND ')}` : '');
  dynamicRun(ctx, b.sql.join(''), b.params);
}

/** File-level conditions over q_pairs; `skip` leaves one dimension out (its own facet). */
function pairConditions(filters: Filters, skip?: 'kinds' | 'roles' | 'formats' | 'roots'): { sql: string; params: Bind[] } {
  const parts: string[] = [], params: Bind[] = [];
  const add = (column: string, key: 'roots' | 'kinds' | 'roles' | 'states' | 'formats', values: string[] | undefined): void => {
    if (!values || key === skip) return;
    parts.push(`${column} IN (SELECT value FROM json_each(?))`);
    params.push(jsonIds(values));
  };
  add('root', 'roots', filters.roots); add('kind', 'kinds', filters.kinds); add('role', 'roles', filters.roles); add('state', 'states', filters.states); add('format', 'formats', filters.formats);
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}

function facet(ctx: Ctx, column: 'kind' | 'role' | 'format' | 'root', skip: 'kinds' | 'roles' | 'formats' | 'roots', filters: Filters): { value: string; count: number }[] {
  const cond = pairConditions(filters, skip);
  return dynamicAll<{ value: string; n: number }>(ctx, `SELECT ${column} AS value, count(DISTINCT row_id) AS n FROM q_pairs WHERE ${column} IS NOT NULL AND ${cond.sql} GROUP BY ${column} ORDER BY n DESC, value LIMIT 128`, cond.params)
    .map(r => ({ value: text(r.value), count: int(r.n) }));
}

interface Keyed { k: string | number; l: string; id: string | number }
const cursors = new WeakMap<Ctx, Map<string, { epoch: number; bind: string; last: Keyed }>>();
const MAX_CURSORS = 2048;
function encodeCursor(ctx: Ctx, bind: string, last: Keyed): string {
  let issued = cursors.get(ctx);
  if (!issued) { issued = new Map(); cursors.set(ctx, issued); }
  if (issued.size >= MAX_CURSORS) issued.delete(issued.keys().next().value!);
  const token = `${randomBytes(16).toString('base64url')}.${randomBytes(8).toString('base64url')}`;
  issued.set(token, { epoch: epoch(ctx), bind, last });
  return token;
}
function decodeCursor(ctx: Ctx, bind: string, cursor: string): Keyed {
  const issued = typeof cursor === 'string' && cursor.length <= 512 ? cursors.get(ctx)?.get(cursor) : undefined;
  if (!issued || issued.epoch !== epoch(ctx) || issued.bind !== bind) throw new InvalidCursorError();
  return issued.last;
}

/** Higher is better: 100 minus the best (lowest) rank among the content hits and the file-name hit of the row. */
const relevanceExpr = (contentCond: string, nameCond: string, terms: boolean): string => {
  if (!terms) return '0';
  return `(100 - MIN(COALESCE((SELECT MIN(h.mrank * 4 + h.ptier) FROM q_hits h WHERE ${contentCond}), ${NO_HIT}), CASE WHEN ${nameCond} THEN ${NAME_HIT_RANK} ELSE ${NO_HIT} END))`;
};

interface PageRow { id: string | number; k: string | number; l: string; [column: string]: unknown }

function fetchRows(ctx: Ctx, mode: Mode, sort: Sort, direction: 'asc' | 'desc', filters: Filters, hasTerms: boolean, after: Keyed | undefined, limit: number): PageRow[] {
  const cond = pairConditions(filters);
  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  const cmp = direction === 'desc' ? '<' : '>';
  const params: Bind[] = [];
  let inner: string;
  if (mode === 'boards') {
    const keys: Record<Sort, string> = {
      relevance: relevanceExpr('h.content_id IN (SELECT mm.content_id FROM member mm WHERE mm.group_id = g.id)', 'EXISTS (SELECT 1 FROM q_nhits n WHERE n.content_id IN (SELECT mm2.content_id FROM member mm2 WHERE mm2.group_id = g.id))', hasTerms),
      label: 'lower(coalesce(g.label, \'\'))', 'board-number': "coalesce(g.board_number, '')", vendor: "lower(coalesce(g.vendor, ''))",
      recent: 'coalesce(g.updated, 0)', documents: 'coalesce(a.docs, 0)', completeness: 'coalesce(a.comp, 0)',
    };
    const join = sort === 'documents' || sort === 'completeness'
      ? `LEFT JOIN (SELECT group_id, SUM(CASE WHEN role NOT IN ('board', 'firmware', 'photo', 'thermal') THEN 1 ELSE 0 END) AS docs,
          (MAX(role = 'board') + MAX(role = 'schematic') + MAX(role IN (${DOCUMENT_ROLES.map(r => `'${r}'`).join(',')}))) AS comp FROM member GROUP BY group_id) a ON a.group_id = g.id` : '';
    inner = `SELECT g.id AS id, g.label AS label, g.board_number AS board_number, ${keys[sort]} AS k, lower(coalesce(g.label, '')) AS l,
      (SELECT count(DISTINCT p.file_id) FROM q_pairs p WHERE p.row_id = g.id AND p.file_id IS NOT NULL) AS file_count FROM grp g ${join}
      WHERE g.id IN (SELECT row_id FROM q_pairs WHERE ${cond.sql})`;
  } else if (mode === 'duplicates') {
    const label = '(SELECT min(df.name) FROM q_pairs p JOIN file df ON df.id = p.file_id WHERE p.row_id = s.id)';
    const l = `lower(coalesce(${label}, s.kind))`;
    const keys: Record<Sort, string> = {
      relevance: relevanceExpr('h.content_id IN (SELECT dc.content_id FROM duplicate_content dc WHERE dc.set_id = s.id UNION SELECT df2.content_id FROM duplicate_file dff JOIN file df2 ON df2.id = dff.file_id WHERE dff.set_id = s.id)', 'EXISTS (SELECT 1 FROM q_nhits n JOIN duplicate_file dn ON dn.file_id = n.file_id WHERE dn.set_id = s.id)', hasTerms),
      label: l, 'board-number': l, vendor: l, recent: l, documents: '(SELECT count(*) FROM duplicate_file x WHERE x.set_id = s.id)', completeness: l,
    };
    inner = `SELECT s.id AS id, coalesce(${label}, s.kind) AS label, s.kind AS dup_kind, ${keys[sort]} AS k, ${l} AS l,
      (SELECT count(DISTINCT p.file_id) FROM q_pairs p WHERE p.row_id = s.id AND p.file_id IS NOT NULL) AS file_count FROM duplicate_set s
      WHERE s.id IN (SELECT row_id FROM q_pairs WHERE ${cond.sql})`;
  } else {
    const l = 'lower(f.name)';
    const keys: Record<Sort, string> = {
      relevance: relevanceExpr('h.content_id = f.content_id', 'f.id IN (SELECT file_id FROM q_nhits)', hasTerms), label: l, 'board-number': l, vendor: l, recent: 'coalesce(f.mtime_ms, 0)', documents: l, completeness: l,
    };
    inner = `SELECT f.id AS id, f.public_id AS public_id, f.name AS label, f.dir_id AS dir_id, f.container_id AS container_id, f.content_id AS content_id, r.label AS root_label, ${keys[sort]} AS k, ${l} AS l
      FROM file f JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id WHERE f.id IN (SELECT row_id FROM q_pairs WHERE ${cond.sql})`;
  }
  params.push(...cond.params);
  let outer = `SELECT * FROM (${inner})`;
  if (after) { outer += ` WHERE (k, l, id) ${cmp} (?, ?, ?)`; params.push(after.k, after.l, after.id); }
  outer += ` ORDER BY k ${dir}, l ${dir}, id ${dir} LIMIT ?`;
  params.push(limit);
  return dynamicAll<PageRow>(ctx, outer, params);
}

function matchesFor(ctx: Ctx, terms: readonly QueryTerm[], rowContents: Map<string | number, number[]>, rowFiles: Map<string | number, number[]>): Map<string | number, SearchMatch[]> {
  const out = new Map<string | number, SearchMatch[]>();
  const contentRows = new Map<number, (string | number)[]>(), fileRows = new Map<number, (string | number)[]>();
  for (const [row, ids] of rowContents) for (const id of ids) { const list = contentRows.get(id) ?? []; list.push(row); contentRows.set(id, list); }
  for (const [row, ids] of rowFiles) for (const id of ids) { const list = fileRows.get(id) ?? []; list.push(row); fileRows.set(id, list); }
  const contentIds = [...contentRows.keys()], fileIds = [...fileRows.keys()];
  const publicContent = new Map<number, string>();
  if (contentIds.length) for (const r of all<{ id: number; public_id: string }>(ctx, 'SELECT id, public_id FROM content WHERE id IN (SELECT value FROM json_each(?))', jsonIds(contentIds))) publicContent.set(r.id, r.public_id);
  interface Acc { rank: number; match: SearchMatch }
  const merged = new Map<string | number, Map<string, Acc>>();
  const put = (row: string | number, key: string, rank: number, make: () => SearchMatch, pages?: number[]): void => {
    let rows = merged.get(row); if (!rows) { rows = new Map(); merged.set(row, rows); }
    const hit = rows.get(key);
    if (!hit) { rows.set(key, { rank, match: make() }); return; }
    if (pages && pages.length) hit.match.pages = [...new Set([...hit.match.pages, ...pages])].sort((a, b) => a - b).slice(0, 2000);
    if (rank < hit.rank) { hit.rank = rank; hit.match.tier = TIERS[Math.min(rank, 4)]; }
  };
  if (contentIds.length) {
    const rows = all<{ term: number; content_id: number; mrank: number; ptier: number; source: string; refs: string | null; extra: number; pages: Uint8Array | null; page: number | null }>(ctx,
      'SELECT term, content_id, mrank, ptier, source, refs, extra, pages, page FROM q_hits WHERE content_id IN (SELECT value FROM json_each(?)) ORDER BY term, mrank, ptier', jsonIds(contentIds));
    for (const h of rows) {
      const term = terms[h.term];
      const pid = publicContent.get(h.content_id);
      if (!term || !pid) continue;
      const pages = h.page !== null ? [int(h.page)] : unpackPages(h.pages);
      for (const row of contentRows.get(h.content_id) ?? []) {
        put(row, `${h.term}|${h.content_id}|${h.source}`, h.mrank, () => ({ term, tier: TIERS[Math.min(h.mrank, 4)], contentId: pid, source: h.source || 'index', refs: h.refs ? h.refs.split('\u001f').slice(0, 8) : [], pages }), pages);
      }
    }
  }
  const names = all<{ term: number; file_id: number; content_id: number | null; public_id: string; cpid: string | null }>(ctx,
    `SELECT n.term, n.file_id, n.content_id, f.public_id, c.public_id AS cpid FROM q_nhits n JOIN file f ON f.id = n.file_id LEFT JOIN content c ON c.id = n.content_id
     WHERE n.file_id IN (SELECT value FROM json_each(?)) OR n.content_id IN (SELECT value FROM json_each(?))`, jsonIds(fileIds), jsonIds(contentIds));
  for (const n of names) {
    const term = terms[n.term];
    if (!term) continue;
    const rows = new Set<string | number>([...(fileRows.get(n.file_id) ?? []), ...(n.content_id !== null ? contentRows.get(n.content_id) ?? [] : [])]);
    for (const row of rows) put(row, `${n.term}|f${n.file_id}|name`, term.field === 'file' ? 0 : 4, () => ({ term, tier: term.field === 'file' ? 'exact' : 'text', contentId: n.cpid ?? n.public_id, source: 'name', refs: [], pages: [] }));
  }
  for (const [row, rows] of merged) out.set(row, [...rows.values()].sort((a, b) => a.rank - b.rank).slice(0, 128).map(x => x.match));
  return out;
}

const emptyPage = (): QueryPage => ({ rows: [], total: 0, facets: { kinds: [], roles: [], formats: [], roots: [] } });

/**
 * Runs one query request. Search text is parsed by the shared grammar; every value reaches SQL as a bound parameter or as a quoted FTS
 * phrase. Paging is keyset-based on (sort key, label key, stable id), with opaque cursors bound to this request and the index epoch.
 */
export function runQuery(ctx: Ctx, request: QueryRequest): QueryResult {
  const mode: Mode = (QUERY_MODES as readonly string[]).includes(request.mode) ? request.mode : 'boards';
  const sort: Sort = (QUERY_SORTS as readonly string[]).includes(request.sort) ? request.sort : 'label';
  const direction = request.direction === 'desc' ? 'desc' : 'asc';
  const limit = Number.isInteger(request.limit) ? Math.min(200, Math.max(1, request.limit)) : 50;
  const filters = sanitizeFilters(request.filters);
  const raw = typeof request.text === 'string' ? request.text : '';
  const parsed = parseQuery(raw, filters.groupId);
  const terms = parsed.terms.slice(0, MAX_QUERY_TERMS);
  if (parsed.issues.includes('too-long') || (raw.trim() !== '' && terms.length === 0)) return { ...emptyPage(), issues: parsed.issues };
  const bind = createHash('sha256').update(JSON.stringify([mode, raw, canonicalFilters(filters), sort, direction])).digest().subarray(0, 8).toString('base64url');
  const after = request.cursor === undefined ? undefined : decodeCursor(ctx, bind, request.cursor);
  ctx.db.exec('DELETE FROM q_hits; DELETE FROM q_nhits; DELETE FROM q_pairs');
  const hasFullText = get(ctx, "SELECT 1 AS x FROM root WHERE json_extract(options, '$.fullText') = 1 AND state <> 'removing' LIMIT 1") !== undefined;
  const infos = terms.map((term, i) => fillTermHits(ctx, i, term, filters, hasFullText));
  fillPairs(ctx, mode, filters, infos);
  const cond = pairConditions(filters);
  const total = int(dynamicAll<{ n: number }>(ctx, `SELECT count(DISTINCT row_id) AS n FROM q_pairs WHERE ${cond.sql}`, cond.params)[0]?.n);
  const rows = fetchRows(ctx, mode, sort, direction, filters, terms.length > 0, after, limit + 1);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  // Match details and file locations for the rows of this page only.
  const rowContents = new Map<string | number, number[]>(), rowFiles = new Map<string | number, number[]>();
  const ids = page.map(r => r.id);
  if (mode === 'boards') {
    for (const r of dynamicAll<{ g: string; c: number }>(ctx, 'SELECT group_id AS g, content_id AS c FROM member WHERE group_id IN (SELECT value FROM json_each(?))', [jsonIds(ids)])) { const l = rowContents.get(r.g) ?? []; l.push(r.c); rowContents.set(r.g, l); }
  } else if (mode === 'duplicates') {
    for (const r of dynamicAll<{ g: string; c: number }>(ctx, 'SELECT set_id AS g, content_id AS c FROM duplicate_content WHERE set_id IN (SELECT value FROM json_each(?))', [jsonIds(ids)])) { const l = rowContents.get(r.g) ?? []; l.push(r.c); rowContents.set(r.g, l); }
    for (const r of dynamicAll<{ g: string; f: number; c: number | null }>(ctx, 'SELECT p.row_id AS g, p.file_id AS f, x.content_id AS c FROM q_pairs p JOIN file x ON x.id = p.file_id WHERE p.row_id IN (SELECT value FROM json_each(?))', [jsonIds(ids)])) {
      const l = rowFiles.get(r.g) ?? []; l.push(r.f); rowFiles.set(r.g, l);
      if (r.c !== null) { const cl = rowContents.get(r.g) ?? []; cl.push(r.c); rowContents.set(r.g, cl); }
    }
  } else {
    for (const r of page) { rowFiles.set(r.id, [Number(r.id)]); if (r.content_id !== null && r.content_id !== undefined) rowContents.set(r.id, [Number(r.content_id)]); }
  }
  const matches = terms.length ? matchesFor(ctx, terms, rowContents, rowFiles) : new Map<string | number, SearchMatch[]>();
  const pather = dirPather(ctx);
  const out: QueryRow[] = page.map(r => {
    const rowMatches = matches.get(r.id) ?? [];
    if (mode === 'boards') return { id: String(r.id), label: text(r.label).slice(0, 256), kind: 'group', fileCount: int(r.file_count), matches: rowMatches };
    if (mode === 'duplicates') return { id: String(r.id), label: text(r.label).slice(0, 256), kind: 'duplicate', fileCount: int(r.file_count), matches: rowMatches };
    const containerId = r.container_id as number | null | undefined;
    const location = containerId === null || containerId === undefined ? joinPath(pather(int(r.dir_id)), text(r.label)) : fileLocation(ctx, containerId, pather);
    return { id: text(r.public_id), label: text(r.label).slice(0, 256), kind: 'file', fileCount: 1, matches: rowMatches, rootLabel: text(r.root_label).slice(0, 64), relativePath: location };
  });
  const last = more ? page[page.length - 1] : undefined;
  return {
    rows: out, total,
    ...(last ? { cursor: encodeCursor(ctx, bind, { k: last.k, l: last.l, id: last.id }) } : {}),
    facets: { kinds: facet(ctx, 'kind', 'kinds', filters), roles: facet(ctx, 'role', 'roles', filters), formats: facet(ctx, 'format', 'formats', filters), roots: facet(ctx, 'root', 'roots', filters) },
    issues: parsed.issues,
  };
}

function fileLocation(ctx: Ctx, containerRowId: number, pather: (id: number) => string): string {
  const c = get<{ dir_id: number; name: string }>(ctx, 'SELECT dir_id, name FROM file WHERE id = ?', containerRowId);
  return c ? joinPath(pather(c.dir_id), c.name) : '';
}

export type { FileRole, LibraryKind };
