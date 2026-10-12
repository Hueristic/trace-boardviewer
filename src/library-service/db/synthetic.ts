/**
 * Synthetic data for the Library database tests and its size measurement. Nothing here is derived from a user file: names, part numbers,
 * reference designators and hashes come from a seeded generator, so a run is reproducible and the numbers can be compared.
 */
import type { BoardSummary, DocumentSummary, FileRole, FileState, Identifier, ImageSummary, LibraryComponent, LibraryGroup, LibraryId, LibraryKind, PartTerm, PassiveHistogramRow, RegisteredRoot } from '../../lib/library/model';
import { DEFAULT_ROOT_OPTIONS } from '../../lib/library/model';
import type { LibraryDb } from './index';
import { bytesToHex } from './codec';
import type { SniffOutcome } from './types';

export interface Rng { next(): number; int(n: number): number; range(min: number, max: number): number; pick<T>(items: readonly T[]): T; chance(p: number): boolean }

/** mulberry32: small, fast, and the same sequence everywhere. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: n => Math.floor(next() * n), range: (min, max) => min + Math.floor(next() * (max - min + 1)), pick: items => items[Math.floor(next() * items.length)], chance: p => next() < p };
}

/** 16 deterministic bytes: the quick key of a synthetic file. */
export function quickKey(seed: number): Uint8Array {
  const rng = makeRng(seed * 2654435761 + 17), out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = rng.int(256);
  return out;
}
export function sha256Of(seed: number): string {
  const rng = makeRng(seed * 40503 + 99991), out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = rng.int(256);
  return bytesToHex(out);
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const letters = (rng: Rng, n: number): string => { let s = ''; for (let i = 0; i < n; i++) s += LETTERS[rng.int(26)]; return s; };
const VENDORS = ['Aurelia', 'Bexley', 'Corvane', 'Dunmore', 'Elbridge', 'Fenwick', 'Garrow', 'Halden', 'Ivory Peak', 'Juniper Lane', 'Kestrel', 'Lowell'];
const DEVICES = ['laptop', 'phone', 'tablet', 'console', 'monitor', 'router', 'printer', 'camera'];
const PACKAGES = ['0201', '0402', '0603', '0805', '1206', 'SOT-23', 'SOIC-8', 'QFN-16', 'QFN-32', 'BGA-256', 'LQFP-64', 'DFN-8'];
const FAMILIES = ['buck-ctl', 'ldo', 'mosfet-driver', 'charger', 'pmic', 'audio-codec', 'flash', 'sensor-hub', 'usb-pd', 'level-shifter'];
const CATEGORIES = ['power', 'memory', 'interface', 'analog', 'logic', 'connector'];
const REF_PREFIXES: readonly [string, number][] = [['C', 700], ['R', 600], ['L', 60], ['D', 40], ['Q', 40], ['U', 120], ['J', 20], ['FB', 30], ['TP', 120], ['Y', 4], ['SW', 6], ['F', 10], ['CN', 6], ['X', 4]];

/** Generates part numbers: new ones never repeat; `reuse` draws an earlier one, so a library has the shared parts a real one has. */
export class PartPool {
  private readonly rng: Rng;
  private readonly known: string[] = [];
  private counter = 0;
  constructor(rng: Rng) { this.rng = rng; }
  fresh(): string {
    const n = ++this.counter, rng = this.rng;
    const mpn = `${letters(rng, rng.range(2, 3))}${rng.range(1, 9)}${String(n).padStart(4, '0')}${rng.chance(0.6) ? letters(rng, rng.range(1, 3)) : ''}`;
    this.known.push(mpn);
    return mpn;
  }
  reuse(): string { return this.known.length ? this.known[this.rng.int(this.known.length)] : this.fresh(); }
  /** `fresh` with probability `newShare`, else an earlier part. */
  draw(newShare: number): string { return this.rng.chance(newShare) || this.known.length < 8 ? this.fresh() : this.reuse(); }
  get size(): number { return this.known.length; }
}

export const baseOf = (mpn: string): string => mpn.replace(/[A-Z]{1,3}$/, '');

export function makeRefs(rng: Rng, total: number): string[] {
  const weights = REF_PREFIXES.reduce((s, [, w]) => s + w, 0), refs = new Set<string>();
  let guard = 0;
  while (refs.size < total && guard++ < total * 20) {
    let pick = rng.int(weights), prefix = REF_PREFIXES[0][0];
    for (const [p, w] of REF_PREFIXES) { if (pick < w) { prefix = p; break; } pick -= w; }
    refs.add(`${prefix}${rng.range(1, prefix === 'C' || prefix === 'R' ? 9000 : 999)}`);
  }
  return [...refs].sort();
}

export function makeMinhash(rng: Rng): number[] { return Array.from({ length: 128 }, () => Math.floor(rng.next() * 4294967296)); }

export function makeIdentifiers(rng: Rng, count: number, source: Identifier['source'] = 'header'): Identifier[] {
  const kinds: Identifier['kind'][] = ['board-number', 'revision', 'vendor', 'model', 'device-type', 'title'];
  return Array.from({ length: count }, (_, i): Identifier => {
    const kind = kinds[i % kinds.length];
    const raw = kind === 'board-number' ? `${letters(rng, 2)}-${letters(rng, 1)}${rng.range(100, 999)}` : kind === 'revision' ? `REV ${rng.range(1, 3)}.${rng.range(0, 9)}` : kind === 'vendor' ? rng.pick(VENDORS) : kind === 'model' ? `${letters(rng, 3)}${rng.range(10, 99)}` : kind === 'device-type' ? rng.pick(DEVICES) : `${rng.pick(VENDORS)} ${letters(rng, 4)} main board`;
    return { kind, raw, norm: raw.toUpperCase().replace(/\s+/g, ' '), source, confidence: rng.range(60, 95), ...(i % 3 === 0 ? { pattern: 'p1' } : {}) };
  });
}

export interface TermPlan { parts: number; rails: number; newShare: number; maxRefsPerTerm?: number; pages?: number; withPages?: boolean }

export function makeTerms(rng: Rng, pool: PartPool, plan: TermPlan, source: PartTerm['source']): { terms: PartTerm[]; rails: string[] } {
  const seen = new Set<string>(), terms: PartTerm[] = [];
  const tiers: PartTerm['tier'][] = ['known', 'board-confirmed', 'near-ref', 'text'];
  while (terms.length < plan.parts) {
    const norm = pool.draw(plan.newShare);
    if (seen.has(norm)) { if (seen.size >= pool.size) break; continue; }
    seen.add(norm);
    const refCount = rng.range(0, plan.maxRefsPerTerm ?? 3);
    const pages = plan.withPages && plan.pages ? Array.from(new Set(Array.from({ length: rng.range(1, 3) }, () => rng.range(1, plan.pages!)))) : [];
    terms.push({
      norm, ...(rng.chance(0.7) ? { base: baseOf(norm) } : {}), ...(rng.chance(0.35) ? { family: rng.pick(FAMILIES) } : {}), ...(rng.chance(0.35) ? { category: rng.pick(CATEGORIES) } : {}),
      tier: tiers[rng.int(4)], source, refs: Array.from({ length: refCount }, () => `U${rng.range(1, 999)}`), additionalRefs: rng.chance(0.1) ? rng.range(1, 12) : 0, pages,
    });
  }
  const rails = Array.from({ length: plan.rails }, () => `${rng.chance(0.5) ? '+' : ''}${rng.range(1, 19)}V${rng.range(0, 9)}_${letters(rng, rng.range(2, 5))}`);
  return { terms, rails: [...new Set(rails)] };
}

export interface BoardSpec {
  seed: number; refs?: number; components?: number; passives?: number; parts?: number; rails?: number; newShare?: number; pool?: PartPool;
  title?: string; boardNumber?: string; fingerprint?: string; variant?: string; identifiers?: Identifier[]; terms?: PartTerm[]; railNames?: string[]; refList?: string[]; truncated?: BoardSummary['truncated'];
}

export function makeBoardSummary(spec: BoardSpec): BoardSummary {
  const rng = makeRng(spec.seed), pool = spec.pool ?? new PartPool(rng);
  const refs = spec.refList ?? makeRefs(rng, spec.refs ?? 1500);
  const planned = makeTerms(rng, pool, { parts: spec.parts ?? 150, rails: spec.rails ?? 25, newShare: spec.newShare ?? 0.16 }, 'header');
  const terms = spec.terms ?? planned.terms, rails = spec.railNames ?? planned.rails;
  const components: LibraryComponent[] = terms.slice(0, spec.components ?? 150).map((t, i): LibraryComponent => ({
    ref: refs[(i * 7) % refs.length] ?? `U${i + 1}`, value: t.norm, package: rng.pick(PACKAGES), pinCount: rng.pick([3, 5, 6, 8, 16, 24, 32, 48, 64, 100, 256]),
    exact: t.norm, ...(t.base ? { base: t.base } : {}), ...(t.family ? { family: t.family } : {}), ...(t.category ? { category: t.category } : {}), source: 'header',
  }));
  const passives: PassiveHistogramRow[] = Array.from({ length: spec.passives ?? 70 }, (): PassiveHistogramRow => ({
    kind: rng.pick(['resistor', 'capacitor', 'inductor', 'ferrite'] as const), valueSI: Number((rng.next() * 1e-5).toPrecision(3)), package: rng.pick(PACKAGES.slice(0, 5)), count: rng.range(1, 80),
  }));
  const board = Math.max(1, refs.length);
  return {
    kind: 'board', adapter: rng.pick(['genpcb', 'brd2', 'kicad']), ...(spec.variant ? { variant: spec.variant } : {}), parts: Math.round(board * 0.8), pins: board * 4, nets: Math.round(board * 1.4), sides: ['both'],
    widthMm: rng.range(60, 330), heightMm: rng.range(40, 240), fingerprint: spec.fingerprint ?? `fp1:${sha256Of(spec.seed)}`, fingerprintVersion: 1, minhash: makeMinhash(rng),
    identity: {
      identifiers: spec.identifiers ?? makeIdentifiers(rng, 5), title: spec.title ?? `${rng.pick(VENDORS)} ${letters(rng, 3)}${rng.range(10, 99)} main board`,
      ...(spec.boardNumber ? {} : {}), revision: `REV ${rng.range(1, 3)}.${rng.range(0, 9)}`,
    },
    refs, rails, terms, components, passives, ...(spec.truncated ? { truncated: spec.truncated } : {}),
  };
}

export interface DocumentSpec {
  seed: number; pages?: number; role?: FileRole; textLayer?: DocumentSummary['textLayer']; parts?: number; rails?: number; newShare?: number; pool?: PartPool; refs?: number;
  terms?: PartTerm[]; railNames?: string[]; identifiers?: Identifier[]; fullText?: { page: number; body: string }[]; refList?: string[]; title?: string; format?: string;
}

export function makeDocumentSummary(spec: DocumentSpec): DocumentSummary {
  const rng = makeRng(spec.seed), pool = spec.pool ?? new PartPool(rng), pages = spec.pages ?? 12;
  const scanned = spec.textLayer === 'no';
  const planned = scanned ? { terms: [] as PartTerm[], rails: [] as string[] } : makeTerms(rng, pool, { parts: spec.parts ?? 100, rails: spec.rails ?? 10, newShare: spec.newShare ?? 0.16, pages, withPages: true }, 'schematic');
  const refs = scanned ? [] : spec.refList ?? makeRefs(rng, spec.refs ?? (pages > 20 ? 600 : 60));
  return {
    kind: 'document', format: spec.format ?? 'pdf', role: spec.role ?? 'other', pages, textLayer: spec.textLayer ?? 'yes', ocr: scanned ? 'triage' : 'none', title: spec.title ?? `${rng.pick(VENDORS)} service document ${rng.range(1, 99)}`,
    producer: 'Synthetic Producer 1.0', pageHashes: Array.from({ length: Math.min(pages, 400) }, (_, i) => sha256Of(spec.seed * 1000 + i)),
    identity: { identifiers: spec.identifiers ?? makeIdentifiers(rng, scanned ? 2 : 4, scanned ? 'ocr' : 'pdf-metadata') }, refs, rails: spec.railNames ?? planned.rails, terms: spec.terms ?? planned.terms,
    ...(spec.fullText ? { fullText: spec.fullText } : {}),
  };
}

export const imageSummary = (rng: Rng): ImageSummary => ({ kind: 'image', width: rng.range(640, 6000), height: rng.range(480, 4000) });

export const formatFor = (kind: LibraryKind, rng: Rng): string | undefined => {
  switch (kind) {
    case 'board': return rng.pick(['genpcb', 'brd2', 'kicad-pcb', 'asc']);
    case 'pdf': return 'pdf';
    case 'schematic': return 'pdf';
    case 'image': return rng.pick(['jpeg', 'png']);
    case 'archive': return 'zip';
    case 'board-archive': return 'zip';
    default: return undefined;
  }
};

export function syntheticRoot(id: string, realpath: string, extra: Partial<RegisteredRoot> = {}): RegisteredRoot {
  return { id, label: `Synthetic ${id}`, state: 'online', network: false, options: { ...DEFAULT_ROOT_OPTIONS, exclusions: [] }, fileCount: 0, realpath, ...extra };
}

export interface IngestSpec {
  dir: string; name: string; size?: number; seed: number; kind: LibraryKind; format?: string; sha256?: boolean; mtimeMs?: number;
  summary?: BoardSummary | DocumentSummary | ImageSummary; sniff?: Partial<SniffOutcome>; walkerState?: FileState; extractorVersion?: number; stages?: boolean;
  /** Archive member: the container file's id and the path inside it. */
  container?: { fileId: LibraryId; entryPath: string };
}
export interface Ingested { fileId: LibraryId; contentId: LibraryId; created: boolean }

/** Walks one synthetic file through the same calls the scanner makes: observe, identify, sniff, summarise. */
export function ingest(db: LibraryDb, rootId: LibraryId, scan: number, spec: IngestSpec): Ingested {
  const observation = spec.container
    ? { containerId: spec.container.fileId, entryPath: spec.container.entryPath, size: spec.size ?? 1000 + spec.seed, ...(spec.mtimeMs !== undefined ? { mtimeMs: spec.mtimeMs } : {}) }
    : { dir: spec.dir, name: spec.name, size: spec.size ?? 1000 + spec.seed, mtimeMs: spec.mtimeMs ?? 1_700_000_000_000 + spec.seed, ...(spec.walkerState ? { state: spec.walkerState } : {}) };
  const [result] = db.upsertFiles(rootId, scan, [observation]);
  if (!result || result.status === 'rejected' || !result.id) throw new Error(`synthetic file rejected: ${result?.reason}`);
  const [link] = db.linkContent([{ fileId: result.id, quick: quickKey(spec.seed), size: observation.size, ...(spec.sha256 ? { sha256: sha256Of(spec.seed) } : {}) }]);
  if (!link.contentId) throw new Error('synthetic content not linked');
  if (link.created || spec.sniff) db.setSniff(link.contentId, { kind: spec.kind, ...(spec.format ?? formatFor(spec.kind, makeRng(spec.seed)) ? { format: spec.format ?? formatFor(spec.kind, makeRng(spec.seed)) } : {}), confidence: 95, ...spec.sniff });
  if (spec.summary && link.created) {
    const r = db.commitSummary({ contentId: link.contentId, summary: spec.summary, extractorVersion: spec.extractorVersion ?? 1, ...(spec.stages ? { stages: [{ stage: 'summary', version: spec.extractorVersion ?? 1, state: 'done' }, { stage: 'knowledge', version: 1, state: 'done' }, { stage: 'group', version: 1, state: 'done' }] } : {}) });
    if (!r.ok) throw new Error(`synthetic summary rejected: ${r.reason}`);
  }
  return { fileId: result.id, contentId: link.contentId, created: link.created };
}

export function groupOf(id: string, label: string, members: { contentId: LibraryId; role: FileRole }[], extra: Partial<LibraryGroup> = {}): LibraryGroup {
  return {
    id, label, updated: 1_700_000_000_000, tags: [], ...extra,
    members: members.map(m => ({ contentId: m.contentId, role: m.role, tier: 'automatic' as const, evidence: [{ kind: 'fingerprint' as const, a: members[0].contentId, b: m.contentId, strength: 'strong' as const, score: 0.95 }] })),
  };
}
