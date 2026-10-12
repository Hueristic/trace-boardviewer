import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as codec from './corrections';
import type { CorrectionDocument } from './corrections';

// The main-process store (electron/library/corrections-store.cjs) exercised with the real corrections.ts codec and synthetic data only.
// Fault injection replaces single fs operations; a separate child process is killed inside the rename to simulate a crash.
const store = require('../../../../electron/library/corrections-store.cjs') as {
  createCorrectionsStore(options: Record<string, unknown>): {
    directory: string; filePath: string;
    load(): Promise<{ status: string; document: CorrectionDocument | null; dropped: number; quarantine?: string; rejections?: Array<{ index: number; reason: string }> }>;
    save(document: CorrectionDocument): Promise<{ status: string; bytes: number }>;
  };
};
const STORE_PATH = path.resolve(__dirname, '../../../../electron/library/corrections-store.cjs');

const fs = fsp;
let scratch = '';
let counter = 0;
const fresh = async () => {
  const dir = path.join(scratch, `profile-${++counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};
const codecFor = codec as unknown as { parseCorrections: (s: string) => { document: CorrectionDocument; dropped: number; error?: string }; serializeCorrections: (d: CorrectionDocument) => string };

const SAMPLE: CorrectionDocument = {
  version: 1,
  platform: 'linux',
  corrections: [
    { op: 'link', file: { rootId: 'root-a', path: 'Birchfield/Birchfield_rev2.brd' }, anchorId: 'anchor-1' },
    { op: 'role', file: { rootId: 'root-a', path: 'Birchfield/notes.pdf' }, role: 'document' },
    { op: 'alias', anchorId: 'anchor-1', alias: 'birch fld', remove: false },
    { op: 'board-code', anchorId: 'anchor-1', code: 'MB-Q731' },
    { op: 'revision', anchorId: 'anchor-1', revision: 'REV B' },
  ],
};
const ALT: CorrectionDocument = { version: 1, platform: 'linux', corrections: [{ op: 'board-code', anchorId: 'anchor-2', code: 'KES-14' }] };

const storeFor = (dir: string, extra: Record<string, unknown> = {}) =>
  store.createCorrectionsStore({ userDataDirectory: dir, codec: codecFor, platform: 'linux', renameDelaysMs: [1, 1, 1], ...extra });

// A handle whose writeFile writes only the first half and then fails: a power cut in the middle of the temporary file.
function interruptedWrites(realFs: typeof fsp) {
  const wrap = async (handle: Awaited<ReturnType<typeof fsp.open>>) => ({
    writeFile: async (data: string) => {
      await handle.writeFile(Buffer.from(data, 'utf8').subarray(0, 10));
      throw new Error('simulated interruption');
    },
    sync: () => handle.sync(),
    close: () => handle.close(),
  });
  return Object.assign(Object.create(realFs), {
    open: async (file: string, flags: string, mode?: number) => {
      const handle = await realFs.open(file, flags, mode);
      return file.endsWith('.tmp') ? wrap(handle) : handle;
    },
  });
}

function faultyRename(realFs: typeof fsp, failures: number, code: string) {
  let remaining = failures;
  let calls = 0;
  const faulty = Object.assign(Object.create(realFs), {
    rename: async (from: string, to: string) => {
      calls++;
      if (remaining > 0) { remaining--; throw Object.assign(new Error('simulated'), { code }); }
      return realFs.rename(from, to);
    },
  });
  return { faulty, calls: () => calls };
}

async function bytesOf(file: string) { return fs.readFile(file); }
async function listing(dir: string) { try { return (await fs.readdir(dir)).sort(); } catch { return null; } }

beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'trace-corrections-'));
});
afterAll(async () => {
  if (scratch && path.basename(scratch).startsWith('trace-corrections-')) await fs.rm(scratch, { recursive: true, force: true });
});

describe('corrections store: location and round trip', () => {
  it('writes only under <userData>/library/devices and round-trips the document', async () => {
    const user = await fresh();
    const s = storeFor(user);
    expect(s.directory).toBe(path.join(user, 'library', 'devices'));
    expect(await s.load()).toMatchObject({ status: 'empty', dropped: 0 });
    await s.save(SAMPLE);
    const loaded = await s.load();
    expect(loaded.status).toBe('ok');
    expect(codec.serializeCorrections(loaded.document as CorrectionDocument)).toBe(codec.serializeCorrections(SAMPLE));
    expect(await listing(s.directory)).toEqual(['corrections.json']);
  });

  it('a later save replaces the earlier document, and the read-back equals the last save', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await s.save(SAMPLE);
    await s.save(ALT);
    const loaded = await s.load();
    expect(codec.serializeCorrections(loaded.document as CorrectionDocument)).toBe(codec.serializeCorrections(ALT));
  });

  it('serializes concurrent saves in submission order (FIFO), leaving the last one on disk and no temporary files', async () => {
    const user = await fresh();
    const s = storeFor(user);
    const docs = Array.from({ length: 6 }, (_, i) => ({ version: 1 as const, platform: 'linux' as const, corrections: [{ op: 'board-code' as const, anchorId: `a${i}`, code: `MB-${i}1` }] }));
    await Promise.all(docs.map(d => s.save(d)));
    const loaded = await s.load();
    expect(codec.serializeCorrections(loaded.document as CorrectionDocument)).toBe(codec.serializeCorrections(docs[5]));
    expect(await listing(s.directory)).toEqual(['corrections.json']);
  });

  it('refuses an invalid document before touching the disk', async () => {
    const user = await fresh();
    const s = storeFor(user);
    const bad = { version: 1, platform: 'linux', corrections: [{ op: 'bogus' }] } as unknown as CorrectionDocument;
    await expect(s.save(bad)).rejects.toMatchObject({ code: 'STORE_INVALID_DOCUMENT' });
    expect(await listing(s.directory)).toBeNull();
  });

  it('refuses a 40000-character path with STORE_INVALID_DOCUMENT before touching the disk', async () => {
    const user = await fresh();
    const s = storeFor(user);
    const tooLong: CorrectionDocument = { version: 1, platform: 'win32', corrections: [{ op: 'link', file: { rootId: 'root-a', path: 'n'.repeat(40_000) }, anchorId: 'anchor-1' }] };
    await expect(s.save(tooLong)).rejects.toMatchObject({ code: 'STORE_INVALID_DOCUMENT' });
    expect(await listing(s.directory)).toBeNull();
  });

  it('saves and reads back a 600-character path unchanged', async () => {
    const user = await fresh();
    const s = storeFor(user);
    const long: CorrectionDocument = { version: 1, platform: 'win32', corrections: [{ op: 'link', file: { rootId: 'root-a', path: `${'n'.repeat(596)}.brd` }, anchorId: 'anchor-1' }] };
    await s.save(long);
    const loaded = await s.load();
    expect(loaded.status).toBe('ok');
    expect(loaded.dropped).toBe(0);
    expect(loaded.document).toEqual(long);
  });

  it('passes the codec refusal reason on with STORE_INVALID_DOCUMENT, unchanged', async () => {
    const user = await fresh();
    const s = storeFor(user);
    const cases: Array<[CorrectionDocument, string]> = [
      [{ version: 1, platform: 'linux', corrections: [{ op: 'bogus' } as never] }, 'invalid-entry'],
      [{ version: 1, platform: 'linux', corrections: [{ op: 'link', file: { rootId: 'root-a', path: '../escape.brd' }, anchorId: 'anchor-1' }] } as CorrectionDocument, 'invalid-relative-path'],
      [{ version: 1, platform: 'linux', corrections: [{ op: 'link', file: { rootId: 'root-a', path: '/abs/escape.brd' }, anchorId: 'anchor-1' }] } as CorrectionDocument, 'invalid-relative-path'],
      [{ version: 1, platform: 'win32', corrections: [{ op: 'link', file: { rootId: 'root-a', path: 'n'.repeat(40_000) }, anchorId: 'anchor-1' }] } as CorrectionDocument, 'path-too-long'],
    ];
    for (const [document, reason] of cases) {
      await expect(s.save(document), reason).rejects.toMatchObject({ code: 'STORE_INVALID_DOCUMENT', reason });
    }
    expect(await listing(s.directory)).toBeNull();
  });

  it('refuses more than the cap with reason too-many and never saves a truncated list', async () => {
    const user = await fresh();
    const s = storeFor(user);
    const huge: CorrectionDocument = { version: 1, platform: 'linux', corrections: Array.from({ length: 50_001 }, (_, i) => ({ op: 'board-code' as const, anchorId: `a${i}`, code: 'MB-1' })) };
    await expect(s.save(huge)).rejects.toMatchObject({ code: 'STORE_INVALID_DOCUMENT', reason: 'too-many' });
    expect(await listing(s.directory)).toBeNull();
  });

  it('stores the exact cap and reads it back with the same length', async () => {
    const user = await fresh();
    const s = storeFor(user);
    const full: CorrectionDocument = { version: 1, platform: 'linux', corrections: Array.from({ length: 50_000 }, (_, i) => ({ op: 'board-code' as const, anchorId: `a${i}`, code: 'MB-1' })) };
    await s.save(full);
    const loaded = await s.load();
    expect(loaded.status).toBe('ok');
    expect(loaded.document?.corrections).toHaveLength(50_000);
    expect(loaded.dropped).toBe(0);
  });

  it('stores a document role under its catalogue name, explicitly, and never as an invented canonical role', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await s.save(SAMPLE);
    const text = (await bytesOf(s.filePath)).toString('utf8');
    expect(text).toContain('"role": "document"');
    expect(text).not.toMatch(/"role": "(datasheet|service-manual)"/);
    const loaded = await s.load();
    expect(loaded.document?.corrections).toContainEqual({ op: 'role', file: { rootId: 'root-a', path: 'Birchfield/notes.pdf' }, role: 'document' });
  });
});

describe('corrections store: atomic write and interrupted writes', () => {
  it('a write interrupted half-way leaves the previous document intact and no partial file in place', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await s.save(SAMPLE);
    const before = await bytesOf(s.filePath);
    const crashing = storeFor(user, { fs: interruptedWrites(fs) });
    await expect(crashing.save(ALT)).rejects.toMatchObject({ code: 'STORE_WRITE_FAILED' });
    expect(await bytesOf(s.filePath)).toEqual(before);
    expect(await listing(s.directory)).toEqual(['corrections.json']);
  });

  it('a rename that fails permanently keeps the old file byte-identical and removes the temporary file', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await s.save(SAMPLE);
    const before = await bytesOf(s.filePath);
    const { faulty } = faultyRename(fs, 99, 'EIO');
    await expect(storeFor(user, { fs: faulty }).save(ALT)).rejects.toMatchObject({ code: 'STORE_WRITE_FAILED' });
    expect(await bytesOf(s.filePath)).toEqual(before);
    expect(await listing(s.directory)).toEqual(['corrections.json']);
  });

  it('retries a transient EPERM/EACCES/EBUSY rename (antivirus or indexer holding the file) and then succeeds', async () => {
    const user = await fresh();
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const { faulty, calls } = faultyRename(fs, 2, code);
      await storeFor(user, { fs: faulty }).save(ALT);
      expect(calls()).toBe(3);
      const loaded = await storeFor(user).load();
      expect(codec.serializeCorrections(loaded.document as CorrectionDocument)).toBe(codec.serializeCorrections(ALT));
    }
  });

  it('simulated crash: a process killed inside the rename leaves the old document intact; the next load removes the stale temporary file', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await s.save(SAMPLE);
    const before = await bytesOf(s.filePath);
    const child = `
      const path = require('node:path');
      const fsp = require('node:fs/promises');
      const store = require(process.argv[1]);
      const codec = {
        serializeCorrections: d => JSON.stringify({ version: 1, platform: d.platform, corrections: d.corrections }, null, 2) + '\\n',
        parseCorrections: text => { const raw = JSON.parse(text); return { document: raw, dropped: 0 }; },
      };
      const killing = Object.assign(Object.create(fsp), { rename: async () => process.exit(7) });
      store.createCorrectionsStore({ userDataDirectory: process.argv[2], codec, platform: 'linux', fs: killing })
        .save({ version: 1, platform: 'linux', corrections: [{ op: 'board-code', anchorId: 'x', code: 'KILL-1' }] })
        .catch(() => process.exit(9));
    `;
    const result = spawnSync(process.execPath, ['-e', child, STORE_PATH, user], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    expect(await bytesOf(s.filePath)).toEqual(before);
    expect((await listing(s.directory))?.some(name => name.endsWith('.tmp'))).toBe(true);
    const loaded = await storeFor(user).load();
    expect(loaded.status).toBe('ok');
    expect(codec.serializeCorrections(loaded.document as CorrectionDocument)).toBe(codec.serializeCorrections(SAMPLE));
    expect(await listing(s.directory)).toEqual(['corrections.json']);
  });
});

describe('corrections store: damaged, newer and unreadable files', () => {
  const damagedSamples: Array<[string, Buffer]> = [
    ['truncated JSON', Buffer.from('{"version":1,"platform":"linux","corrections":[{"op":"lin', 'utf8')],
    ['binary garbage', Buffer.from([0, 255, 1, 2, 0, 0, 7])],
    ['wrong version', Buffer.from('{"version":0,"platform":"linux","corrections":[]}', 'utf8')],
    ['bad platform', Buffer.from('{"version":1,"platform":"plan9","corrections":[]}', 'utf8')],
    ['not an object', Buffer.from('[1,2,3]', 'utf8')],
  ];
  for (const [label, content] of damagedSamples) {
    it(`a ${label} file is set aside byte-for-byte, the load is empty and saves work again`, async () => {
      const user = await fresh();
      const s = storeFor(user);
      await fs.mkdir(s.directory, { recursive: true });
      await fs.writeFile(s.filePath, content);
      const loaded = await s.load();
      expect(loaded.status).toBe('quarantined');
      expect(loaded.document?.corrections).toEqual([]);
      expect(loaded.quarantine).toMatch(/^corrections\.quarantine-.*\.json$/);
      expect(await bytesOf(path.join(s.directory, loaded.quarantine as string))).toEqual(content);
      expect(await fs.access(s.filePath).then(() => true, () => false)).toBe(false);
      expect((await storeFor(user).load()).status).toBe('empty');
      await s.save(SAMPLE);
      expect((await s.load()).status).toBe('ok');
    });
  }

  it('a save keeps the entries the codec refused on load in a quarantine file, byte for byte, and names it in the result', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await fs.mkdir(s.directory, { recursive: true });
    const refused = { op: 'link', file: { rootId: 'root-a', path: '../escape.brd' }, anchorId: 'anchor-1' };
    const original = JSON.stringify({ version: 1, platform: 'linux', corrections: [...SAMPLE.corrections, refused] });
    await fs.writeFile(s.filePath, original);
    const loaded = await s.load();
    expect(loaded.rejections?.map((entry: { reason: string }) => entry.reason)).toEqual(['invalid-relative-path']);
    const saved = await s.save({ version: 1, platform: 'linux', corrections: SAMPLE.corrections }) as { status: string; quarantine?: string; quarantinedEntries?: number };
    expect(saved.quarantine).toMatch(/^corrections\.quarantine-.*\.json$/);
    expect(saved.quarantine).not.toContain(path.sep);
    expect(saved.quarantinedEntries).toBe(1);
    expect(await fs.readFile(path.join(s.directory, saved.quarantine as string), 'utf8')).toBe(original);
    const afterwards = await s.load();
    expect(afterwards.rejections ?? []).toEqual([]);
  });

  it('a save of a file without refused entries writes no quarantine file', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await s.save(SAMPLE);
    const saved = await s.save(ALT) as { quarantine?: string };
    expect(saved.quarantine).toBeUndefined();
  });

  it('invalid entries in a valid document are dropped and counted; the rest is kept', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await fs.mkdir(s.directory, { recursive: true });
    const text = JSON.stringify({ version: 1, platform: 'linux', corrections: [...SAMPLE.corrections, { op: 'bogus' }, { op: 'board-code' }] });
    await fs.writeFile(s.filePath, text);
    const loaded = await s.load();
    expect(loaded.status).toBe('ok');
    expect(loaded.dropped).toBe(2);
    expect(loaded.document?.corrections).toHaveLength(SAMPLE.corrections.length);
  });

  it('a file from a newer version is left untouched and blocks saves', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await fs.mkdir(s.directory, { recursive: true });
    const future = Buffer.from('{"version":2,"platform":"linux","corrections":[],"newField":true}', 'utf8');
    await fs.writeFile(s.filePath, future);
    expect((await s.load()).status).toBe('newer-schema');
    await expect(s.save(SAMPLE)).rejects.toMatchObject({ code: 'STORE_BLOCKED' });
    expect(await bytesOf(s.filePath)).toEqual(future);
    expect(await listing(s.directory)).toEqual(['corrections.json']);
  });

  it('an oversized file is left untouched and blocks saves', async () => {
    const user = await fresh();
    const s = storeFor(user, { maxBytes: 300 });
    await fs.mkdir(s.directory, { recursive: true });
    const big = Buffer.from(`{"version":1,"platform":"linux","corrections":[],"pad":"${'x'.repeat(400)}"}`, 'utf8');
    await fs.writeFile(s.filePath, big);
    expect((await s.load()).status).toBe('too-large');
    await expect(s.save(ALT)).rejects.toMatchObject({ code: 'STORE_BLOCKED' });
    expect(await bytesOf(s.filePath)).toEqual(big);
  });

  it('a target that cannot be read as a file is reported unreadable and never overwritten', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await fs.mkdir(s.filePath, { recursive: true });
    expect((await s.load()).status).toBe('unreadable');
    await expect(s.save(SAMPLE)).rejects.toMatchObject({ code: 'STORE_BLOCKED' });
    expect((await fs.stat(s.filePath)).isDirectory()).toBe(true);
  });

  it('a damaged file that cannot be moved aside is never overwritten (status unpreserved, saves blocked)', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await fs.mkdir(s.directory, { recursive: true });
    const damaged = Buffer.from('{not json', 'utf8');
    await fs.writeFile(s.filePath, damaged);
    const { faulty } = faultyRename(fs, 99, 'EACCES');
    const locked = storeFor(user, { fs: faulty });
    expect((await locked.load()).status).toBe('unpreserved');
    await expect(locked.save(SAMPLE)).rejects.toMatchObject({ code: 'STORE_BLOCKED' });
    expect(await bytesOf(s.filePath)).toEqual(damaged);
  });
});

describe('corrections store: Library roots and local paths', () => {
  it('refuses a data directory inside a Library root', async () => {
    const user = await fresh();
    expect(() => storeFor(user, { libraryRoots: [user] })).toThrowError(/Library root/);
    expect(() => storeFor(user, { libraryRoots: [path.join(user, 'library')] })).toThrowError(/Library root/);
    expect(() => storeFor(user, { libraryRoots: [path.join(scratch, 'elsewhere-root')] })).not.toThrow();
  });

  it('never writes into a Library root: the root tree is byte-identical after save and load', async () => {
    const user = await fresh();
    const root = path.join(scratch, `library-root-${++counter}`);
    await fs.mkdir(path.join(root, 'Birchfield'), { recursive: true });
    await fs.writeFile(path.join(root, 'Birchfield', 'Birchfield_rev2.brd'), 'SYNTHETIC BOARD');
    const snapshot = async () => (await fs.readdir(root, { recursive: true })).sort();
    const before = await snapshot();
    const s = storeFor(user, { libraryRoots: [root] });
    await s.save(SAMPLE);
    await s.load();
    expect(await snapshot()).toEqual(before);
    expect((await fs.readFile(path.join(root, 'Birchfield', 'Birchfield_rev2.brd'))).toString('utf8')).toBe('SYNTHETIC BOARD');
  });

  it('the stored text carries relative identity paths and opaque root ids only, never an absolute or local path', async () => {
    const user = await fresh();
    const s = storeFor(user);
    await s.save(SAMPLE);
    const text = (await bytesOf(s.filePath)).toString('utf8');
    expect(text).not.toContain(user);
    expect(text).not.toContain(scratch);
    expect(text).not.toMatch(/[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/|file:\/\//);
    expect(text).toContain('"rootId": "root-a"');
  });
});

describe('corrections store: platform rename behaviour (evidence is per platform)', () => {
  // Node's fs.rename replaces an existing file on Windows (MoveFileEx with MOVEFILE_REPLACE_EXISTING) and on POSIX (rename(2)).
  // This test proves the replacement on the platform that runs it; the other two platforms are not proven by this run.
  it('rename over an existing file replaces it on this platform', async () => {
    const dir = await fresh();
    const target = path.join(dir, 'target.json');
    const temporary = path.join(dir, 'target.json.1.tmp');
    await fs.writeFile(target, 'OLD');
    await fs.writeFile(temporary, 'NEW');
    await fs.rename(temporary, target);
    expect((await fs.readFile(target, 'utf8'))).toBe('NEW');
    expect(await listing(dir)).toEqual(['target.json']);
  });
});
