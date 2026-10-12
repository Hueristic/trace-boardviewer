import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERIC_WORDS } from './identity';
import { searchKey } from './paths';

/** The list before the TB-068 measurement (identity.ts). The words the measurement added are the rest of GENERIC_WORDS. */
const BASE_LIST = [
  'board', 'boards', 'main', 'mainboard', 'bios', 'rev', 'revision', 'backup', 'laptop', 'schematic', 'boardview', 'file', 'copy',
  'final', 'new', 'old', 'misc', 'repair', 'pdf', 'bin', 'rom', 'fd', 'cap', 'hex', 'folder', 'download', 'downloads', 'data', 'tmp',
  'the', 'and', 'for', 'version', 'ver', 'fw', 'firmware', 'desktop', 'phone', 'tablet', 'device', 'logic', 'pcb', 'update', 'test',
  'bak', 'set', 'part', 'parts', 'unknown', 'other', 'docs', 'doc', 'manual', 'service', 'image', 'photo', 'dump', 'read',
];

/** What the measurement on the synthetic library (seed 1, preset small) adds: shared by two or more families with more false than true links. */
const MEASURED_ADDITIONS = [
  'archive', 'assembly', 'bill', 'bom', 'brd', 'circuit', 'cobblestay', 'customers', 'datasheets', 'diagram', 'document', 'drive', 'dsc',
  'dunlin', 'edge', 'evt', 'files', 'gannet', 'img', 'kapcsolasi', 'layout', 'list', 'lists', 'maintenance', 'manuals', 'marshwick',
  'materials', 'mini', 'oakhollow', 'photos', 'pvt', 'pxl', 'rajz', 'ruff', 'schema', 'schematics', 'sch', 'shearwater', 'sort', 'stuff',
  'viewer', 'whimbrel', 'work',
];

/** The labelled-code prefixes of identity.ts (LABELLED_CODE), as the measurement reads them. */
const LABEL_PREFIXES = ['MB', 'PCB', 'BD', 'LB'];

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

interface Truth {
  items: Array<{ path: string; familyId: string | null }>;
  families: Array<{ id: string; boardNumber: string | null }>;
}

/** Generates the seed-1 small synthetic library into a temporary folder (outside the repository) and returns its ground truth. */
function syntheticTruth(): Truth {
  const folder = mkdtempSync(join(tmpdir(), 'trace-words-'));
  try {
    const out = join(folder, 'corpus');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-synthetic-library.cjs'), '--preset=small', '--seed=1', `--out=${out}`], { timeout: 110_000, stdio: 'pipe' });
    return JSON.parse(readFileSync(join(out, 'ground-truth.json'), 'utf8')) as Truth;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

interface TokenStats { token: string; families: number; files: number; truePairs: number; falsePairs: number }

/** Per token: the families and files it appears in, and the pairs of files that share it (same family = true link, else false link). */
function measureTokens(truth: Truth): TokenStats[] {
  const members = new Map<string, Map<string, number>>();
  for (const item of truth.items) {
    if (item.familyId === null) continue;
    const segments = item.path.split('/').filter(part => part !== '');
    const name = segments[segments.length - 1] ?? '';
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const seen = new Set<string>();
    for (const text of [stem, ...segments.slice(0, -1)]) {
      for (const token of searchKey(text).split(' ')) {
        if (token.length >= 3 && /\p{L}/u.test(token)) seen.add(token);
      }
    }
    for (const token of seen) {
      const byFamily = members.get(token) ?? new Map<string, number>();
      byFamily.set(item.familyId, (byFamily.get(item.familyId) ?? 0) + 1);
      members.set(token, byFamily);
    }
  }
  return [...members].map(([token, byFamily]) => {
    const counts = [...byFamily.values()];
    const files = counts.reduce((sum, count) => sum + count, 0);
    const allPairs = (files * (files - 1)) / 2;
    const truePairs = counts.reduce((sum, count) => sum + (count * (count - 1)) / 2, 0);
    return { token, families: byFamily.size, files, truePairs, falsePairs: allPairs - truePairs };
  }).sort((a, b) => a.token.localeCompare(b.token));
}

describe('GENERIC_WORDS, measured on the synthetic library (TB-068)', () => {
  const truth = syntheticTruth();
  const stats = measureTokens(truth);

  it('the list is the original list plus the words the measurement shows: shared by two or more families, more false than true links', () => {
    const derived = stats
      .filter(s => /^\p{L}+$/u.test(s.token) && s.families >= 2 && s.falsePairs > s.truePairs && !BASE_LIST.includes(s.token))
      .map(s => s.token);
    expect(derived).toEqual([...MEASURED_ADDITIONS].sort());
    expect([...GENERIC_WORDS].sort()).toEqual([...BASE_LIST, ...MEASURED_ADDITIONS].sort());
  });

  it('recall is kept: no word that identifies one family (several files, one family) is generic', () => {
    const identifying = stats.filter(s => s.families === 1 && s.files >= 2).map(s => s.token);
    expect(identifying.filter(token => GENERIC_WORDS.has(token))).toEqual([]);
  });

  it('the false links fall; the true links fall only by the links that generic words carried inside one family; what remains is digit-bearing code noise', () => {
    const linksWith = (list: ReadonlySet<string>) => stats
      .filter(s => !list.has(s.token))
      .reduce((total, s) => ({ true: total.true + s.truePairs, false: total.false + s.falsePairs }), { true: 0, false: 0 });
    const before = linksWith(new Set(BASE_LIST));
    const after = linksWith(GENERIC_WORDS);
    // Measured: false links 42,576 -> 26,921 (-37%); true links 7,832 -> about 5,700 (-27%). The true links removed are same-family pairs
    // that a generic folder name carried (archive, stuff, datasheets), not identity evidence; the pair count is only a proxy for recall.
    expect(after.false).toBeLessThan(before.false * 0.7);
    expect(after.true).toBeGreaterThanOrEqual(before.true * 0.7);
    // Every token still shared across families with more false than true links is digit-bearing code noise (the TB-068 proposal).
    const residual = stats.filter(s => !GENERIC_WORDS.has(s.token) && s.falsePairs > s.truePairs).map(s => s.token);
    expect(residual.filter(token => !/\d/.test(token))).toEqual([]);
    expect(residual.length).toBeGreaterThan(0);
  });

  it('the labelled-code prefixes: each prefix the corpus uses names the family of its own code', () => {
    const labelled = new RegExp(`(?<![A-Za-z0-9])(${LABEL_PREFIXES.join('|')})[-_ ]?([A-Z]{0,3}\\d{2,5}[A-Z]?)(?![A-Za-z0-9])`, 'gi');
    const familyCode = new Map(truth.families.map(f => [f.id, f.boardNumber?.toUpperCase() ?? '']));
    const precision = new Map<string, { total: number; right: number }>();
    for (const item of truth.items) {
      if (item.familyId === null) continue;
      const name = item.path.split('/').pop() ?? '';
      for (const match of name.matchAll(labelled)) {
        const prefix = match[1].toUpperCase();
        const entry = precision.get(prefix) ?? { total: 0, right: 0 };
        entry.total++;
        if (familyCode.get(item.familyId) === `${prefix}-${match[2].toUpperCase()}`) entry.right++;
        precision.set(prefix, entry);
      }
    }
    for (const [prefix, entry] of precision) expect(entry.right / entry.total, prefix).toBeGreaterThanOrEqual(0.9);
    expect(precision.get('MB')).toEqual({ total: 6, right: 6 });
  });
});
