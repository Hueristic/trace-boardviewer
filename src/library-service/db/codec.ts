/**
 * Binary encodings of the Library database. Every decoder is total on its own output and bounded on hostile input:
 * it returns `undefined` (or an empty list) instead of throwing, and never allocates more than a fixed cap.
 */
import { deflateSync } from 'fflate';
import { inflateRawSync } from 'node:zlib';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export const LIMITS = Object.freeze({ refs: 250_000, refBytes: 256 * 4, minhash: 128, pages: 2_000, pageHashes: 2_000, jsonBytes: 16 * 1024 * 1024, inflated: 64 * 1024 * 1024 });

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

export function hexToBytes(hex: string): Uint8Array | undefined {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The workspace fingerprint is `fp<version>:<64 hex>`; a bare 64-digit value is accepted. Stored as the 32 raw bytes plus the version. */
export function packFingerprint(fingerprint: string): { bytes: Uint8Array; version?: number } | undefined {
  const match = /^(?:fp(\d{1,9}):)?([0-9a-f]{64})$/.exec(fingerprint);
  if (!match) return undefined;
  return { bytes: hexToBytes(match[2])!, ...(match[1] ? { version: Number(match[1]) } : {}) };
}
export function unpackFingerprint(bytes: Uint8Array | null | undefined, version: number | null | undefined): string | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return undefined;
  return `fp${version ?? 1}:${bytesToHex(bytes)}`;
}

/** MinHash: exactly 128 little-endian u32 values (512 bytes). */
export function packMinhash(values: readonly number[]): Uint8Array | undefined {
  if (values.length !== LIMITS.minhash) return undefined;
  const out = new Uint8Array(LIMITS.minhash * 4), view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return undefined;
    view.setUint32(i * 4, v, true);
  }
  return out;
}
export function unpackMinhash(bytes: Uint8Array | null | undefined): number[] | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length !== LIMITS.minhash * 4) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out: number[] = [];
  for (let i = 0; i < LIMITS.minhash; i++) out.push(view.getUint32(i * 4, true));
  return out;
}

/** Packed 32-byte SHA-256 values for the per-page text hashes of a document. */
export function packHashes(hashes: readonly string[]): Uint8Array | undefined {
  if (hashes.length > LIMITS.pageHashes) return undefined;
  const out = new Uint8Array(hashes.length * 32);
  for (let i = 0; i < hashes.length; i++) {
    const bytes = hashes[i].length === 64 ? hexToBytes(hashes[i]) : undefined;
    if (!bytes) return undefined;
    out.set(bytes, i * 32);
  }
  return out;
}
export function unpackHashes(bytes: Uint8Array | null | undefined): string[] {
  if (!(bytes instanceof Uint8Array) || bytes.length % 32 !== 0 || bytes.length > LIMITS.pageHashes * 32) return [];
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) out.push(bytesToHex(bytes.subarray(i, i + 32)));
  return out;
}

function writeVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}
/** Reads an unsigned LEB128 value; returns the next offset, or -1 when the input ends or the value is too large. */
function readVarint(bytes: Uint8Array, at: number, sink: { value: number }): number {
  let result = 0, scale = 1;
  for (let i = 0; i < 7; i++) {
    if (at + i >= bytes.length) return -1;
    const b = bytes[at + i];
    result += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) { sink.value = result; return at + i + 1; }
    scale *= 128;
  }
  return -1;
}

/** Page numbers of a posting: sorted distinct, delta-coded varints. Empty input gives `null` (no blob at all). */
export function packPages(pages: readonly number[]): Uint8Array | null {
  if (pages.length === 0) return null;
  const sorted = [...new Set(pages)].filter(p => Number.isInteger(p) && p >= 1 && p <= LIMITS.pages).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const out: number[] = [];
  let previous = 0;
  for (const page of sorted) { writeVarint(out, page - previous); previous = page; }
  return Uint8Array.from(out);
}
export function unpackPages(bytes: Uint8Array | null | undefined): number[] {
  if (!(bytes instanceof Uint8Array)) return [];
  const out: number[] = [], sink = { value: 0 };
  let at = 0, page = 0;
  while (at < bytes.length && out.length < LIMITS.pages) {
    at = readVarint(bytes, at, sink);
    if (at < 0) return out;
    page += sink.value;
    if (page > LIMITS.pages) return out;
    out.push(page);
  }
  return out;
}

/** Inflates a versioned blob (the first byte is the version, already checked by the caller); refuses output beyond the cap. */
function safeInflate(blob: Uint8Array, maxOutputLength = LIMITS.inflated): Uint8Array | undefined {
  try {
    return inflateRawSync(blob.subarray(1), { maxOutputLength });
  } catch { return undefined; }
}

const REFS_VERSION = 1;
/**
 * Reference designators of one file: sorted distinct strings, front-coded (shared prefix length + suffix) and deflated.
 * The service compresses after validating the indexer's raw list; it never inflates a blob supplied by a parser.
 */
export function packRefs(refs: readonly string[]): Uint8Array {
  const sorted = [...new Set(refs)].sort();
  const raw: number[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  for (const ref of sorted) {
    const bytes = encoder.encode(ref);
    let shared = 0;
    const limit = Math.min(previous.length, bytes.length, 255);
    while (shared < limit && previous[shared] === bytes[shared]) shared++;
    writeVarint(raw, shared);
    writeVarint(raw, bytes.length - shared);
    for (let i = shared; i < bytes.length; i++) raw.push(bytes[i]);
    previous = bytes;
  }
  const packed = deflateSync(Uint8Array.from(raw), { level: 6 });
  const out = new Uint8Array(packed.length + 1);
  out[0] = REFS_VERSION;
  out.set(packed, 1);
  return out;
}
export function unpackRefs(blob: Uint8Array | null | undefined): string[] {
  if (!(blob instanceof Uint8Array) || blob.length < 2 || blob[0] !== REFS_VERSION) return [];
  const raw = safeInflate(blob);
  if (!raw) return [];
  const out: string[] = [], sink = { value: 0 };
  let at = 0, previous: Uint8Array = new Uint8Array(0);
  while (at < raw.length && out.length < LIMITS.refs) {
    at = readVarint(raw, at, sink);
    if (at < 0) return out;
    const shared = sink.value;
    at = readVarint(raw, at, sink);
    if (at < 0) return out;
    const rest = sink.value;
    if (shared > previous.length || at + rest > raw.length || shared + rest > LIMITS.refBytes) return out;
    const bytes = new Uint8Array(shared + rest);
    bytes.set(previous.subarray(0, shared), 0);
    bytes.set(raw.subarray(at, at + rest), shared);
    at += rest;
    out.push(decoder.decode(bytes));
    previous = bytes;
  }
  return out;
}

const JSON_VERSION = 1;
/** Compact versioned blob for the component and passive summaries: one version byte and deflated JSON. */
export function packJson(value: unknown): Uint8Array {
  const text = JSON.stringify(value);
  const packed = deflateSync(encoder.encode(text), { level: 6 });
  const out = new Uint8Array(packed.length + 1);
  out[0] = JSON_VERSION;
  out.set(packed, 1);
  return out;
}
export function unpackJson<T>(blob: Uint8Array | null | undefined, check: (value: unknown) => value is T, fallback: T): T {
  if (!(blob instanceof Uint8Array) || blob.length < 2 || blob[0] !== JSON_VERSION) return fallback;
  const raw = safeInflate(blob, LIMITS.jsonBytes);
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(decoder.decode(raw));
    return check(value) ? value : fallback;
  } catch { return fallback; }
}

/** Posting tiers, most reliable first. The SQL `tier` column holds the number. */
export const POSTING_TIERS = ['known', 'board-confirmed', 'near-ref', 'text'] as const;
export const postingTierCode = (tier: typeof POSTING_TIERS[number]): number => POSTING_TIERS.indexOf(tier);
export const postingTierName = (code: number): typeof POSTING_TIERS[number] => POSTING_TIERS[Math.min(Math.max(Math.trunc(code) || 0, 0), POSTING_TIERS.length - 1)];

export function utf8Length(text: string): number { return encoder.encode(text).length; }
