import { describe, expect, it } from 'vitest';
import { LIMITS, bytesToHex, hexToBytes, packFingerprint, packHashes, packJson, packMinhash, packPages, packRefs, unpackFingerprint, unpackHashes, unpackJson, unpackMinhash, unpackPages, unpackRefs } from './codec';

const hex = (n: number): string => n.toString(16).padStart(64, '0');

describe('codec', () => {
  it('round-trips hex', () => {
    expect(bytesToHex(Uint8Array.from([0, 15, 16, 255]))).toBe('000f10ff');
    expect(Array.from(hexToBytes('000f10ff')!)).toEqual([0, 15, 16, 255]);
    for (const bad of ['0', 'zz', '0F', 5 as unknown as string]) expect(hexToBytes(bad)).toBeUndefined();
  });

  it('packs fingerprints with and without a version prefix', () => {
    const a = packFingerprint(`fp3:${hex(7)}`)!;
    expect(a.version).toBe(3);
    expect(unpackFingerprint(a.bytes, 3)).toBe(`fp3:${hex(7)}`);
    expect(packFingerprint(hex(9))!.version).toBeUndefined();
    for (const bad of ['', 'fp:abc', `fp1:${hex(1)}00`, 'x'.repeat(64)]) expect(packFingerprint(bad)).toBeUndefined();
    expect(unpackFingerprint(new Uint8Array(31), 1)).toBeUndefined();
  });

  it('keeps exactly 128 little-endian u32 for the minhash', () => {
    const values = Array.from({ length: 128 }, (_, i) => (i * 33_554_393) >>> 0);
    const packed = packMinhash(values)!;
    expect(packed.length).toBe(512);
    expect(unpackMinhash(packed)).toEqual(values);
    expect(packMinhash(values.slice(1))).toBeUndefined();
    expect(packMinhash([...values.slice(1), -1])).toBeUndefined();
    expect(packMinhash([...values.slice(1), 2 ** 32])).toBeUndefined();
    expect(unpackMinhash(new Uint8Array(511))).toBeUndefined();
  });

  it('packs page hashes as 32 raw bytes each', () => {
    const hashes = [hex(1), hex(2)];
    const packed = packHashes(hashes)!;
    expect(packed.length).toBe(64);
    expect(unpackHashes(packed)).toEqual(hashes);
    expect(packHashes(['abc'])).toBeUndefined();
    expect(unpackHashes(new Uint8Array(33))).toEqual([]);
    expect(packHashes([])!.length).toBe(0);
  });

  it('delta-codes page numbers as sorted distinct varints', () => {
    const pages = [1, 2, 3, 40, 41, 1999, 2000];
    const packed = packPages([2000, 3, 1, 2, 3, 40, 41, 1999, 1])!;
    expect(unpackPages(packed)).toEqual(pages);
    expect(packPages([])).toBeNull();
    expect(packPages([0, 2001, 1.5])).toBeNull();
    expect(unpackPages(Uint8Array.from([0x80]))).toEqual([]);
    expect(packed.length).toBeLessThan(pages.length * 2);
  });

  it('front-codes, deflates and restores sorted distinct references', () => {
    const refs = ['U7000', 'C1', 'C10', 'C100', 'R1', 'R2', 'C1', 'FB12', 'ü1'];
    expect(unpackRefs(packRefs(refs))).toEqual([...new Set(refs)].sort());
    expect(unpackRefs(packRefs([]))).toEqual([]);
  });

  it('is total on hostile reference blobs', () => {
    expect(unpackRefs(null)).toEqual([]);
    expect(unpackRefs(Uint8Array.from([1]))).toEqual([]);
    expect(unpackRefs(Uint8Array.from([9, 1, 2, 3]))).toEqual([]);
    expect(unpackRefs(Uint8Array.from([1, 255, 255, 255, 255]))).toEqual([]);
    let seed = 11;
    for (let n = 0; n < 300; n++) {
      const bytes = new Uint8Array(1 + (n % 120));
      bytes[0] = 1;
      for (let i = 1; i < bytes.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[i] = seed >>> 24; }
      expect(() => unpackRefs(bytes)).not.toThrow();
    }
  });

  it('round-trips the json blob and caps what it inflates', () => {
    const text = (v: unknown): v is string => typeof v === 'string';
    expect(unpackJson(packJson('a'.repeat(1000)), text, 'fallback')).toBe('a'.repeat(1000));
    expect(LIMITS.inflated).toBe(64 * 1024 * 1024);
  });

  it('versions the json blob and returns the fallback for anything else', () => {
    const isList = (v: unknown): v is number[] => Array.isArray(v) && v.every(x => typeof x === 'number');
    expect(unpackJson(packJson([1, 2, 3]), isList, [])).toEqual([1, 2, 3]);
    const wrong = packJson([1, 2, 3]);
    wrong[0] = 2;
    expect(unpackJson(wrong, isList, [9])).toEqual([9]);
    expect(unpackJson(packJson({ a: 1 }), isList, [9])).toEqual([9]);
    expect(unpackJson(null, isList, [9])).toEqual([9]);
    expect(unpackJson(Uint8Array.from([1, 2, 3, 4]), isList, [9])).toEqual([9]);
  });
});
