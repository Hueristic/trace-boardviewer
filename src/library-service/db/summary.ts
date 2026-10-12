import type { BoardSummary, DocumentSummary, FileRole, Identifier, ImageSummary, LibraryComponent, MetadataSource, PartTerm, PassiveHistogramRow, SummaryBase } from '../../lib/library/model';
import { FILE_ROLES } from '../../lib/library/model';
import { all, atomic, get, int, run, text, opt, type Ctx } from './context';
import { LIMITS, packFingerprint, packHashes, packJson, packMinhash, packPages, packRefs, postingTierCode, postingTierName, unpackFingerprint, unpackHashes, unpackJson, unpackMinhash, unpackPages, unpackRefs } from './codec';
import { contentByPublicId, endAttempt, refreshFileStates, writeStage } from './content';
import { purgeFullTextRows } from './roots';
import type { SummaryCommit, SummaryCommitResult } from './types';

const REF_SEPARATOR = '\u001f';
const MAX_POSTING_REFS = 8;
/** Upper bound of a content id inside a page-text row id (`content * 4096 + page`) so that the product stays an exact integer. */
export const MAX_FULL_TEXT_CONTENT_ID = Math.floor(Number.MAX_SAFE_INTEGER / 4096) - 1;

const normPart = (value: string): string => value.normalize('NFKC').trim();
export const normRail = (value: string): string => value.normalize('NFKC').trim().toUpperCase();

interface PostingDraft { kind: 'part' | 'rail'; norm: string; base?: string; family?: string; category?: string; source: MetadataSource; tier: number; refs: string[]; additional: number; pages: number[] }

function mergeDrafts(drafts: PostingDraft[]): PostingDraft[] {
  const merged = new Map<string, PostingDraft>();
  for (const d of drafts) {
    const key = `${d.kind}\u0000${d.norm}\u0000${d.source}`;
    const hit = merged.get(key);
    if (!hit) { merged.set(key, { ...d, refs: [...d.refs] }); continue; }
    hit.tier = Math.min(hit.tier, d.tier);
    hit.base ??= d.base; hit.family ??= d.family; hit.category ??= d.category;
    const refs = new Set(hit.refs);
    let extra = hit.additional + d.additional;
    for (const r of d.refs) { if (!refs.has(r)) { if (refs.size < MAX_POSTING_REFS) refs.add(r); else extra++; } }
    hit.refs = [...refs]; hit.additional = extra;
    hit.pages = [...new Set([...hit.pages, ...d.pages])];
  }
  return [...merged.values()];
}

function draftsOf(summary: BoardSummary | DocumentSummary): PostingDraft[] {
  const drafts: PostingDraft[] = [];
  for (const t of summary.terms) {
    const refs = t.refs.slice(0, MAX_POSTING_REFS);
    drafts.push({ kind: 'part', norm: normPart(t.norm), ...(t.base ? { base: normPart(t.base) } : {}), ...(t.family ? { family: t.family } : {}), ...(t.category ? { category: t.category } : {}), source: t.source, tier: postingTierCode(t.tier), refs, additional: Math.max(0, t.additionalRefs) + (t.refs.length - refs.length), pages: t.pages });
  }
  const railSource: MetadataSource = summary.kind === 'board' ? 'header' : 'schematic';
  for (const rail of summary.rails) drafts.push({ kind: 'rail', norm: normRail(rail), source: railSource, tier: 0, refs: [], additional: 0, pages: [] });
  return mergeDrafts(drafts.filter(d => d.norm.length > 0));
}

function termId(ctx: Ctx, cache: Map<string, number>, d: PostingDraft): number {
  const key = `${d.kind}\u0000${d.norm}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const existing = get<{ id: number; base: string | null; family: string | null; category: string | null }>(ctx, 'SELECT id, base, family, category FROM term WHERE kind = ? AND norm = ?', d.kind, d.norm);
  let id: number;
  if (existing) {
    id = existing.id;
    if ((d.base && existing.base !== d.base) || (d.family && existing.family !== d.family) || (d.category && existing.category !== d.category)) {
      run(ctx, 'UPDATE term SET base = COALESCE(?, base), family = COALESCE(?, family), category = COALESCE(?, category) WHERE id = ?', d.base ?? null, d.family ?? null, d.category ?? null, id);
    }
  } else {
    id = run(ctx, 'INSERT INTO term(kind, norm, base, family, category) VALUES(?, ?, ?, ?, ?)', d.kind, d.norm, d.base ?? null, d.family ?? null, d.category ?? null).lastInsertRowid;
  }
  cache.set(key, id);
  return id;
}

/** Whether any root the content is reachable from opted into full text. */
export function fullTextAllowed(ctx: Ctx, contentId: number): boolean {
  if (contentId > MAX_FULL_TEXT_CONTENT_ID) return false;
  return get(ctx, `SELECT 1 AS x FROM file f JOIN dir d ON d.id = f.dir_id JOIN root r ON r.id = d.root_id
    WHERE f.content_id = ? AND r.state <> 'removing' AND json_extract(r.options, '$.fullText') = 1 LIMIT 1`, contentId) !== undefined;
}

function insertIdentifiers(ctx: Ctx, contentId: number, identifiers: readonly Identifier[]): number {
  let n = 0;
  for (const i of identifiers.slice(0, 256)) {
    run(ctx, 'INSERT INTO identifier(content_id, kind, norm, raw, source, confidence, page, pattern) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      contentId, i.kind, i.norm, i.raw, i.source, Math.min(100, Math.max(0, Math.trunc(i.confidence))), i.page ?? null, i.pattern ?? null);
    n++;
  }
  return n;
}

function clearOutputs(ctx: Ctx, contentId: number): void {
  run(ctx, 'DELETE FROM board WHERE content_id = ?', contentId);
  run(ctx, 'DELETE FROM document WHERE content_id = ?', contentId);
  run(ctx, 'DELETE FROM image WHERE content_id = ?', contentId);
  run(ctx, 'DELETE FROM posting WHERE content_id = ?', contentId);
  run(ctx, 'DELETE FROM identifier WHERE content_id = ?', contentId);
}

const truncatedJson = (value: readonly string[] | undefined, extra: boolean): string | null => {
  const set = new Set(value ?? []);
  if (extra) set.add('terms');
  return set.size ? JSON.stringify([...set]) : null;
};

/**
 * Stores one extractor result and its stage state in a single transaction: the summary row, identifiers, terms and postings, the page text
 * (only when a root the content belongs to has full text on), the stage rows and the file states. Previous outputs of the content are
 * replaced. When a content would exceed the posting limit the most reliable tiers are kept and the summary is marked as truncated.
 */
export function commitSummary(ctx: Ctx, commit: SummaryCommit): SummaryCommitResult {
  const empty: SummaryCommitResult = { ok: false, postings: 0, terms: 0, identifiers: 0, fullTextPages: 0, fullText: 'none', droppedPostings: 0 };
  const content = contentByPublicId(ctx, commit.contentId);
  if (!content) return { ...empty, reason: 'unknown-content' };
  const summary = commit.summary;
  let fingerprint: ReturnType<typeof packFingerprint> | undefined, minhash: Uint8Array | undefined, hashes: Uint8Array | undefined;
  if (summary.kind === 'board') {
    fingerprint = packFingerprint(summary.fingerprint);
    minhash = packMinhash(summary.minhash);
    if (!fingerprint || !minhash) return { ...empty, reason: 'invalid-summary' };
  } else if (summary.kind === 'document') {
    hashes = packHashes(summary.pageHashes);
    if (!hashes || !(FILE_ROLES as readonly string[]).includes(summary.role)) return { ...empty, reason: 'invalid-summary' };
  }
  return atomic(ctx, () => {
    const result: SummaryCommitResult = { ...empty, ok: true };
    clearOutputs(ctx, content.id);
    if (summary.kind === 'image') {
      run(ctx, 'INSERT INTO image(content_id, width, height) VALUES(?, ?, ?)', content.id, summary.width, summary.height);
    } else {
      let drafts = draftsOf(summary);
      let dropped = 0;
      if (drafts.length > ctx.policy.maxPostingsPerContent) {
        drafts = drafts.map((d, i) => ({ d, i })).sort((a, b) => a.d.tier - b.d.tier || a.i - b.i).slice(0, ctx.policy.maxPostingsPerContent).map(x => x.d);
        dropped = draftsOf(summary).length - drafts.length;
      }
      const base: SummaryBase = summary;
      const flags = truncatedJson(base.truncated, dropped > 0);
      const refs = packRefs(summary.refs);
      if (summary.kind === 'board') {
        run(ctx, `INSERT INTO board(content_id, adapter, variant, parts, pins, nets, sides, fingerprint, fp_version, minhash, refs, title, revision, drawing, company, date, width_mm, height_mm, components, passives, truncated)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        content.id, summary.adapter, summary.variant ?? null, summary.parts, summary.pins, summary.nets, summary.sides.join(','), fingerprint!.bytes, summary.fingerprintVersion, minhash!, refs,
        summary.identity.title ?? null, summary.identity.revision ?? null, summary.identity.drawing ?? null, summary.identity.company ?? null, summary.identity.date ?? null,
        summary.widthMm ?? null, summary.heightMm ?? null, packJson(summary.components), packJson(summary.passives), flags);
      } else {
        run(ctx, `INSERT INTO document(content_id, format, doc_type, pages, text_layer, ocr, title, producer, refs, refs_minhash, page_hashes, truncated)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        content.id, summary.format, summary.role, summary.pages, summary.textLayer, summary.ocr, summary.title ?? null, summary.producer ?? null, refs, hashes!.length ? hashes! : null, flags);
      }
      result.identifiers = insertIdentifiers(ctx, content.id, summary.identity.identifiers);
      const cache = new Map<string, number>();
      for (const d of drafts) {
        const id = termId(ctx, cache, d);
        run(ctx, 'INSERT INTO posting(term_id, content_id, source, tier, refs, additional_refs, pages) VALUES(?, ?, ?, ?, ?, ?, ?)',
          id, content.id, d.source, d.tier, d.refs.length ? d.refs.join(REF_SEPARATOR) : null, d.additional, packPages(d.pages));
      }
      result.postings = drafts.length;
      result.terms = cache.size;
      result.droppedPostings = dropped;
      if (summary.kind === 'document') {
        if (summary.fullText && summary.fullText.length) {
          if (fullTextAllowed(ctx, content.id)) {
            purgeFullTextRows(ctx, [content.id]);
            for (const page of summary.fullText.slice(0, LIMITS.pages)) {
              if (!Number.isInteger(page.page) || page.page < 1 || page.page > LIMITS.pages) continue;
              run(ctx, 'INSERT INTO text_fts(rowid, body) VALUES(? * 4096 + ?, ?)', content.id, page.page, page.body);
              result.fullTextPages++;
            }
            writeStage(ctx, content.id, { stage: 'full-text', version: commit.extractorVersion, state: 'done' });
            result.fullText = 'stored';
          } else {
            writeStage(ctx, content.id, { stage: 'full-text', version: commit.extractorVersion, state: 'skipped' });
            result.fullText = 'not-allowed';
          }
        } else result.fullText = 'not-requested';
      }
    }
    for (const stage of commit.stages ?? [{ stage: 'summary' as const, version: commit.extractorVersion, state: 'done' as const }]) writeStage(ctx, content.id, stage);
    endAttempt(ctx, commit.contentId);
    refreshFileStates(ctx, content.id);
    return result;
  });
}

const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const isComponents = (v: unknown): v is LibraryComponent[] => Array.isArray(v) && v.every(x => x !== null && typeof x === 'object' && typeof (x as { ref?: unknown }).ref === 'string');
const isPassives = (v: unknown): v is PassiveHistogramRow[] => Array.isArray(v) && v.every(x => x !== null && typeof x === 'object' && typeof (x as { kind?: unknown }).kind === 'string');

function readTruncated(raw: unknown): SummaryBase['truncated'] {
  if (typeof raw !== 'string') return undefined;
  try { const value: unknown = JSON.parse(raw); return stringArray(value) && value.length ? (value as SummaryBase['truncated']) : undefined; } catch { return undefined; }
}

function readIdentifiers(ctx: Ctx, contentId: number): Identifier[] {
  return all<{ kind: Identifier['kind']; norm: string; raw: string | null; source: MetadataSource; confidence: number; page: number | null; pattern: string | null }>(ctx,
    'SELECT kind, norm, raw, source, confidence, page, pattern FROM identifier WHERE content_id = ? ORDER BY id', contentId).map(r => ({
    kind: r.kind, raw: text(r.raw), norm: r.norm, source: r.source, confidence: int(r.confidence), ...(r.page === null ? {} : { page: int(r.page) }), ...(r.pattern === null ? {} : { pattern: r.pattern }),
  }));
}

function readTerms(ctx: Ctx, contentId: number): PartTerm[] {
  return all<{ norm: string; base: string | null; family: string | null; category: string | null; source: MetadataSource; tier: number; refs: string | null; additional_refs: number; pages: Uint8Array | null }>(ctx,
    `SELECT t.norm, t.base, t.family, t.category, p.source, p.tier, p.refs, p.additional_refs, p.pages FROM posting p JOIN term t ON t.id = p.term_id
     WHERE p.content_id = ? AND t.kind = 'part' ORDER BY t.norm, p.source`, contentId).map(r => ({
    norm: r.norm, ...(r.base ? { base: r.base } : {}), ...(r.family ? { family: r.family } : {}), ...(r.category ? { category: r.category } : {}),
    tier: postingTierName(r.tier), source: r.source, refs: r.refs ? r.refs.split(REF_SEPARATOR) : [], additionalRefs: int(r.additional_refs), pages: unpackPages(r.pages),
  }));
}

const readRails = (ctx: Ctx, contentId: number): string[] => all<{ norm: string }>(ctx,
  "SELECT DISTINCT t.norm FROM posting p JOIN term t ON t.id = p.term_id WHERE p.content_id = ? AND t.kind = 'rail' ORDER BY t.norm", contentId).map(r => r.norm);

export function loadBoardSummary(ctx: Ctx, contentId: number): BoardSummary | undefined {
  const r = get<{ adapter: string; variant: string | null; parts: number; pins: number; nets: number; sides: string; fingerprint: Uint8Array; fp_version: number; minhash: Uint8Array; refs: Uint8Array; title: string | null; revision: string | null; drawing: string | null; company: string | null; date: string | null; width_mm: number | null; height_mm: number | null; components: Uint8Array; passives: Uint8Array; truncated: string | null }>(ctx, 'SELECT * FROM board WHERE content_id = ?', contentId);
  if (!r) return undefined;
  const fingerprint = unpackFingerprint(r.fingerprint, r.fp_version);
  const minhash = unpackMinhash(r.minhash);
  if (!fingerprint || !minhash) return undefined;
  const truncated = readTruncated(r.truncated);
  const identity: BoardSummary['identity'] = { identifiers: readIdentifiers(ctx, contentId), ...(r.title === null ? {} : { title: r.title }), ...(r.revision === null ? {} : { revision: r.revision }), ...(r.drawing === null ? {} : { drawing: r.drawing }), ...(r.company === null ? {} : { company: r.company }), ...(r.date === null ? {} : { date: r.date }) };
  return {
    kind: 'board', identity, refs: unpackRefs(r.refs), rails: readRails(ctx, contentId), terms: readTerms(ctx, contentId), ...(truncated ? { truncated } : {}),
    adapter: r.adapter, ...(r.variant === null ? {} : { variant: r.variant }), parts: int(r.parts), pins: int(r.pins), nets: int(r.nets), sides: (r.sides ? r.sides.split(',') : []) as BoardSummary['sides'],
    ...(r.width_mm === null ? {} : { widthMm: r.width_mm }), ...(r.height_mm === null ? {} : { heightMm: r.height_mm }),
    fingerprint, fingerprintVersion: int(r.fp_version), minhash, components: unpackJson(r.components, isComponents, []), passives: unpackJson(r.passives, isPassives, []),
  };
}

export function loadDocumentSummary(ctx: Ctx, contentId: number): DocumentSummary | undefined {
  const r = get<{ format: string; doc_type: string; pages: number; text_layer: string; ocr: string; title: string | null; producer: string | null; refs: Uint8Array | null; page_hashes: Uint8Array | null; truncated: string | null }>(ctx, 'SELECT * FROM document WHERE content_id = ?', contentId);
  if (!r) return undefined;
  const truncated = readTruncated(r.truncated);
  return {
    kind: 'document', identity: { identifiers: readIdentifiers(ctx, contentId) }, refs: unpackRefs(r.refs), rails: readRails(ctx, contentId), terms: readTerms(ctx, contentId), ...(truncated ? { truncated } : {}),
    format: r.format, role: ((FILE_ROLES as readonly string[]).includes(r.doc_type) ? r.doc_type : 'other') as FileRole, pages: int(r.pages),
    textLayer: r.text_layer as DocumentSummary['textLayer'], ocr: r.ocr as DocumentSummary['ocr'], ...(r.title === null ? {} : { title: r.title }), ...(r.producer === null ? {} : { producer: r.producer }), pageHashes: unpackHashes(r.page_hashes),
  };
}

export function loadImageSummary(ctx: Ctx, contentId: number): ImageSummary | undefined {
  const r = get<{ width: number; height: number }>(ctx, 'SELECT width, height FROM image WHERE content_id = ?', contentId);
  return r ? { kind: 'image', width: int(r.width), height: int(r.height) } : undefined;
}

/** Group-level pairing needs the front-coded reference set of a content (board or document) without the rest of the summary. */
export function loadRefs(ctx: Ctx, contentId: number): string[] {
  const row = get<{ refs: Uint8Array | null }>(ctx, 'SELECT refs FROM board WHERE content_id = ? UNION ALL SELECT refs FROM document WHERE content_id = ?', contentId, contentId);
  return unpackRefs(opt(row?.refs));
}

export function setDocumentMinhash(ctx: Ctx, contentPublicId: string, minhash: readonly number[]): boolean {
  const packed = packMinhash(minhash);
  const content = contentByPublicId(ctx, contentPublicId);
  if (!packed || !content) return false;
  return atomic(ctx, () => run(ctx, 'UPDATE document SET refs_minhash = ? WHERE content_id = ?', packed, content.id).changes) > 0;
}
