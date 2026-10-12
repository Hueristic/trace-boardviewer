import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDeviceCatalogue, type CatalogueResult } from './catalogue';
import type { Correction } from './corrections';
import type { DirEntry, DirectoryPort } from './folder-map';
import { extractIdentity } from './identity';
import { matchFiles, pairKey, type BoardAnchor, type FileRecord, type MatchCounters } from './match';

/** Deterministic pseudo-random numbers, so every run sees the same synthetic corpus. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Synthetic library: families of boards, each board folder holds a boardview, a BIOS candidate, a schematic and notes. */
function syntheticLibrary(boards: number, perBoard: number): { tree: Record<string, DirEntry[]>; anchors: BoardAnchor[] } {
  const families = 50;
  const tree: Record<string, DirEntry[]> = {};
  const anchors: BoardAnchor[] = [];
  const familyLists: DirEntry[][] = Array.from({ length: families }, () => []);
  for (let board = 0; board < boards; board++) {
    const family = board % families;
    const code = `MB-Q${board}`;
    familyLists[family].push({ name: code, kind: 'dir' });
    const names: DirEntry[] = [{ name: `${code}_rev${1 + (board % 3)}.brd`, kind: 'file', size: 4096 }, { name: `${code}_BIOS.bin`, kind: 'file', size: 2048 }, { name: `schematic_${board}.pdf`, kind: 'file', size: 1024 }];
    for (let index = 3; index < perBoard; index++) names.push({ name: `note-${board}-${index}.txt`, kind: 'file', size: 64 });
    tree[`Family${family}/${code}`] = names;
    anchors.push({ id: `g${board}`, boardCode: code, aliases: [] });
  }
  tree[''] = Array.from({ length: families }, (_value, family) => ({ name: `Family${family}`, kind: 'dir' as const }));
  for (let family = 0; family < families; family++) tree[`Family${family}`] = familyLists[family];
  return { tree, anchors };
}

function countingPort(tree: Record<string, DirEntry[]>): { port: DirectoryPort; calls: () => number } {
  let calls = 0;
  return {
    port: {
      async readDir(segments) {
        calls++;
        const listing = tree[segments.join('/')];
        if (listing === undefined) throw new Error('ENOENT synthetic');
        return listing;
      },
    },
    calls: () => calls,
  };
}

async function runPipeline(boards: number, perBoard: number, linkCount: number): Promise<{ result: CatalogueResult; readDirCalls: number; ms: number }> {
  const { tree, anchors } = syntheticLibrary(boards, perBoard);
  const counted = countingPort(tree);
  const corrections: Correction[] = [];
  const random = generator(7);
  for (let index = 0; index < linkCount; index++) {
    const board = Math.floor(random() * boards);
    corrections.push({ op: 'link', file: { rootId: 'r1', path: `Family${board % 50}/MB-Q${board}/note-${board}-3.txt` }, anchorId: `g${(board + 1) % boards}` });
  }
  const started = performance.now();
  const result = await buildDeviceCatalogue({ platform: 'linux', roots: [{ rootId: 'r1', port: counted.port }], anchors, corrections });
  return { result, readDirCalls: counted.calls(), ms: performance.now() - started };
}

describe('user links are matched through an index', () => {
  it('probes each file only for its own links, not once per anchor', () => {
    const anchors: BoardAnchor[] = Array.from({ length: 500 }, (_value, index) => ({ id: `g${index}`, boardCode: `MB-${1000 + index}`, aliases: [] }));
    const records: FileRecord[] = Array.from({ length: 2000 }, (_value, index) => ({ path: `r1\u0000misc/part${index}.bin`, identity: extractIdentity(`misc/part${index}.bin`, { platform: 'linux' }) }));
    const links = new Set(records.slice(0, 20).map((record, index) => pairKey(record.path, `g${index}`)));
    const counters: MatchCounters = { files: 0, candidates: 0, judgments: 0, linkSteps: 0 };
    const out = matchFiles(anchors, records, { userLinks: links }, counters);
    expect(out.map(item => item.state)).toEqual(Array.from({ length: 20 }, () => 'confirmed'));
    expect(counters.files).toBe(2000);
    expect(counters.linkSteps).toBeLessThanOrEqual(links.size + counters.files);
  });

  it('keeps the matching output identical to the recorded baseline on a seeded corpus', () => {
    const random = generator(20261009);
    const anchors: BoardAnchor[] = Array.from({ length: 300 }, (_value, index) => ({ id: `a${index}`, boardCode: `MB-Q${index}`, aliases: [`fam${index % 17}`] }));
    const records: FileRecord[] = [];
    const links = new Set<string>();
    const detached = new Set<string>();
    for (let index = 0; index < 20_000; index++) {
      const board = Math.floor(random() * 320);
      const name = random() < 0.5 ? `fam${board % 17}/MB-Q${board}_rev${1 + (board % 4)}.brd` : `misc/part${index}.bin`;
      const path = `r${index % 3}\u0000${name}`;
      records.push({ path, identity: extractIdentity(name, { platform: 'linux' }), ...(random() < 0.1 ? { contentCode: { code: `MB-Q${board}`, unique: random() < 0.8 } } : {}) });
      if (random() < 0.02) links.add(pairKey(path, `a${Math.floor(random() * 300)}`));
      if (random() < 0.01) detached.add(pairKey(path, `a${board}`));
    }
    const out = matchFiles(anchors, records, { userLinks: links, detached });
    expect(out.length).toBeGreaterThan(1000);
    // Recorded from the matcher before the user-link index was introduced (same corpus, same decisions, same output).
    expect(digest(out)).toBe('a6ac4aa20e6d087d8237831d4200230985f71e13c839381054ceb92107b311e1');
  });
});

describe('scale of the device catalogue', () => {
  it('does one pass over the entries, and its work grows in proportion to the files', async () => {
    const smallRuns = [await runPipeline(500, 20, 100), await runPipeline(500, 20, 100)];
    const large = await runPipeline(5000, 20, 1000);
    expect(large.result.files.length).toBe(100_000);
    expect(large.result.stats.entries).toBe(100_000 + 5050);
    expect(large.result.stats.match.files).toBe(100_000);
    expect(large.result.stats.match.judgments).toBeLessThanOrEqual(2 * 100_000);
    expect(large.result.stats.match.linkSteps).toBeLessThanOrEqual(1000 + 100_000);
    expect(large.readDirCalls).toBe(5051);
    // Linear work gives a time ratio near 10 for 10x the files; quadratic work gives about 100. The bound is generous on purpose.
    const smallMs = Math.min(...smallRuns.map(run => run.ms));
    console.info(
      JSON.stringify({
        measured: 'device-catalogue-synthetic',
        small: { files: 10_000, ms: Math.round(smallMs), stats: smallRuns[0].result.stats },
        large: { files: 100_000, ms: Math.round(large.ms), readDirCalls: large.readDirCalls, stats: large.result.stats, heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1048576) },
        timeRatio: Number((large.ms / smallMs).toFixed(2)),
      }),
    );
    expect(large.ms / smallMs).toBeLessThan(30);
  }, 300_000);
});
