import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import importLimits from '../../../shared/import-limits.json';
import { DEFAULT_LIMITS } from './adapter';
import allegroAdapter from './adapters/allegro-brd';
import { makeAllegro } from './allegro-fixture';
import { MAX_IMPORT_BYTES, MAX_NATIVE_ALLEGRO_IMPORT_BYTES, MAX_NATIVE_ALLEGRO_RECORDS } from './common';
import { importLimitFor, mebibytes } from './import-limits';
import { BOARD_ADAPTERS } from './registry';

const MiB = 1024 * 1024;
const repoFile = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

describe('import size limits', () => {
  it('keeps one source of truth: the shared JSON, the exported constants and the packaged file list agree', () => {
    expect(importLimits).toEqual({ maxImportBytes: 64 * MiB, maxNativeAllegroImportBytes: 240 * MiB, maxNativeAllegroRecords: 4_000_000 });
    expect(MAX_IMPORT_BYTES).toBe(importLimits.maxImportBytes);
    expect(MAX_NATIVE_ALLEGRO_IMPORT_BYTES).toBe(importLimits.maxNativeAllegroImportBytes);
    expect(MAX_NATIVE_ALLEGRO_RECORDS).toBe(importLimits.maxNativeAllegroRecords);
    expect(MAX_NATIVE_ALLEGRO_IMPORT_BYTES).toBeGreaterThan(MAX_IMPORT_BYTES);
    expect(JSON.parse(repoFile('package.json')).build.files).toContain('shared/import-limits.json');
  });

  it('gives every board adapter the general limit except the native Allegro database', () => {
    expect(DEFAULT_LIMITS.maxInputBytes).toBe(MAX_IMPORT_BYTES);
    expect(allegroAdapter.limits).toMatchObject({ maxInputBytes: MAX_NATIVE_ALLEGRO_IMPORT_BYTES, maxTotalBytes: MAX_NATIVE_ALLEGRO_IMPORT_BYTES });
    for (const adapter of BOARD_ADAPTERS) if (adapter.id !== 'allegro-brd') expect(adapter.limits.maxInputBytes, adapter.id).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
  });

  it('states the native limits in the adapter note and in the Allegro documentation', () => {
    const note = allegroAdapter.capability.notes.join(' ');
    expect(note).toContain(`${mebibytes(MAX_NATIVE_ALLEGRO_IMPORT_BYTES)} MiB`);
    expect(note).toContain(`${MAX_NATIVE_ALLEGRO_RECORDS / 1_000_000} million declared objects`);
    const doc = repoFile('docs/ALLEGRO-BRD.md');
    expect(doc).toContain(`${mebibytes(MAX_NATIVE_ALLEGRO_IMPORT_BYTES)} MiB`);
    expect(doc).toContain(MAX_NATIVE_ALLEGRO_RECORDS.toLocaleString('en-US'));
  });

  it('localizes the native refusals in all eight languages (catalog keys with the {max} parameter)', () => {
    for (const language of ['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk']) {
      const catalog = JSON.parse(repoFile(`electron/locales/${language}/formats.json`));
      expect(catalog['parse.error.nativeByteLimit'], language).toContain('{max}');
      expect(catalog['parse.error.nativeRecordLimit'], language).toContain('{max}');
    }
  });

  it('lets the desktop main process read a board above the general bound only when its header carries the Allegro marker', () => {
    const main = repoFile('electron/main.cjs');
    expect(main).toContain("require('../shared/import-limits.json')");
    expect(main).toContain('const MAX_NATIVE_BOARD_BYTES = importLimits.maxNativeAllegroImportBytes;');
    expect(main).toContain('async function boardByteLimit(handle, size)');
    expect(main).toContain('head[0xf8] === 0x61 && head[0xf9] === 0x6c && head[0xfa] === 0x6c');
  });

  it('classifies an input by its header, not by its name or its size alone', () => {
    expect(importLimitFor(makeAllegro().data)).toBe(MAX_NATIVE_ALLEGRO_IMPORT_BYTES);
    expect(importLimitFor(new Uint8Array(MAX_IMPORT_BYTES + 1))).toBe(MAX_IMPORT_BYTES);
    const unmarked = makeAllegro().data.slice();
    unmarked[0xf8] = 0;
    expect(importLimitFor(unmarked)).toBe(MAX_IMPORT_BYTES);
  });
});
