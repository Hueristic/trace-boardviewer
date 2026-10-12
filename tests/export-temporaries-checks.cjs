'use strict';

// The temporaries of a user-chosen export (electron/export-temporaries.cjs, electron/documents.cjs writeZipAtomically) and of the library's
// device folder (electron/store.cjs temporaryFolders). An export's temporary sits next to the destination, outside the profile: it is recorded
// in the profile before its file exists, forgotten once the file is renamed into place or removed, and swept at the next start only when its
// writer is gone. The same rules hold for win32 and posix paths: the temporary name is recognised by its shape, never by a separator or a drive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createJsonStore } = require('../electron/store.cjs');
const { createExportTemporaries } = require('../electron/export-temporaries.cjs');
const documents = require('../electron/documents.cjs');
const i18n = require('../electron/i18n.cjs');
const { isInsideTemp, makeTempDir } = require('./canonical-temp.cjs');

const UUID = '0b6f6a5e-3c2d-4e7f-9a1b-2c3d4e5f6a7b';
const DEAD = 4242; // a pid the sweep treats as gone, in the path-rule tests (no real process is consulted there)
const ALIVE = 4343; // a pid the sweep treats as running
const KEY = 'a'.repeat(64);
const NOW = '2026-03-04T05:06:07.000Z';
const PDF = Buffer.from('%PDF-1.4\n% export temporaries\n');
const tr = (key) => i18n.translate('en', key);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const t = (key) => key;

// A process id that is not running: a child that has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// A process that keeps running until it is stopped: its pid counts as live for the sweep.
async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return child;
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function sandbox(name, after) {
  const root = await makeTempDir(`trace-export-temporaries-${name}-`);
  after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return root;
}

// An in-memory stand-in for the profile store: the journal needs only read and write.
function memoryStore(value = []) {
  const state = { value };
  return { state, read: async () => state.value, write: async (_name, next) => { state.value = JSON.parse(JSON.stringify(next)); } };
}

test('the start sweep removes the recorded temporaries of writers that are gone, keeps the running writers, and never touches a file it did not record', async (t0) => {
  const root = await sandbox('sweep', t0.after.bind(t0));
  const profile = path.join(root, 'profile');
  const exportsFolder = path.join(root, 'Documents');
  await fs.mkdir(exportsFolder, { recursive: true });
  const store = createJsonStore({ directory: profile, t });
  const dead = deadPid();
  const live = await liveChild();
  try {
    const journal = createExportTemporaries({ store });
    const gone = path.join(exportsFolder, `report.zip.${dead}.${UUID}.tmp`);
    const running = path.join(exportsFolder, `other.zip.${live.pid}.${UUID}.tmp`);
    const missing = path.join(exportsFolder, `missing.zip.${dead}.${UUID}.tmp`);
    const unrecorded = path.join(exportsFolder, `stray.zip.${dead}.${UUID}.tmp`);
    for (const file of [gone, running, unrecorded]) await fs.writeFile(file, 'partial write');
    const runningEntry = { path: running, pid: live.pid, at: Date.now() };
    await store.write('export-temporaries.json', [{ path: gone, pid: dead, at: Date.now() }, runningEntry, { path: missing, pid: dead, at: Date.now() }]);

    const result = await journal.sweep();

    assert.equal(await exists(gone), false, 'the temporary of a gone writer is removed');
    assert.ok(result.removed.includes(gone));
    assert.equal(await exists(running), true, 'the temporary of a running writer is kept');
    assert.equal(await exists(unrecorded), true, 'a temporary nobody recorded is never touched');
    assert.deepEqual(await store.read('export-temporaries.json'), [runningEntry], 'the record keeps the running writer and drops the rest');
    assert.equal(result.kept, 1);

    const mine = path.join(exportsFolder, `mine.zip.${process.pid}.${UUID}.tmp`);
    await fs.writeFile(mine, 'in flight');
    await journal.record(mine);
    await journal.sweep();
    assert.equal(await exists(mine), true, 'a temporary recorded by this process is kept while it may be in flight');
    await journal.forget(mine);
    assert.equal((await store.read('export-temporaries.json')).some((entry) => entry.path === mine), false, 'forget removes the record');
  } finally {
    live.kill();
  }
});

test('the sweep names only recorded temporaries that keep the writer\'s shape, under the rules of the platform\'s own paths (win32 and posix)', async () => {
  const cases = [
    {
      name: 'win32', pathModule: path.win32,
      removable: [
        `C:\\Users\\u\\Documents\\report.zip.${DEAD}.${UUID}.tmp`,
        `\\\\server\\share\\Final report.zip.${DEAD}.${UUID}.tmp`,
        `D:\\Exports\\bundle.zip.${DEAD}.${UUID.replace(/-/g, '')}.tmp`,
      ],
      refused: [
        `report.zip.${DEAD}.${UUID}.tmp`, // relative: the export never writes one
        `C:\\Users\\u\\Documents\\report.zip`, // not a temporary
        `C:\\Users\\u\\Documents\\report.zip.${ALIVE}.${UUID}.tmp`, // the pid in the name is not the recorded one
      ],
    },
    {
      name: 'posix', pathModule: path.posix,
      removable: [
        `/Users/u/Documents/report.zip.${DEAD}.${UUID}.tmp`,
        `/home/u/Exports/Final report.zip.${DEAD}.${UUID}.tmp`,
      ],
      refused: [
        `Documents/report.zip.${DEAD}.${UUID}.tmp`, // relative
        `/Users/u/Documents/report.zip`, // not a temporary
        `/Users/u/Documents/report.zip.${ALIVE}.${UUID}.tmp`, // the pid in the name is not the recorded one
      ],
    },
  ];
  for (const c of cases) {
    const running = c.pathModule.join(c.name === 'win32' ? 'C:\\Exports' : '/exports', `live.zip.${ALIVE}.${UUID}.tmp`);
    const recorded = [
      ...c.removable.map((file) => ({ path: file, pid: DEAD, at: Date.now() })),
      ...c.refused.map((file) => ({ path: file, pid: DEAD, at: Date.now() })),
      { path: running, pid: ALIVE, at: Date.now() },
    ];
    const store = memoryStore(recorded);
    const unlinked = [];
    const journal = createExportTemporaries({
      store, fs: { unlink: async (file) => { unlinked.push(file); } }, pathModule: c.pathModule,
      isGone: (pid) => pid === DEAD, now: () => Date.now(),
    });
    const result = await journal.sweep();
    assert.deepEqual(unlinked, c.removable, `${c.name}: exactly the recorded temporaries of the gone writer are removed`);
    assert.deepEqual(result.removed, c.removable, `${c.name}: the result names the same paths`);
    assert.deepEqual(store.state.value, [{ path: running, pid: ALIVE, at: store.state.value[0].at }], `${c.name}: the refused entries are dropped, the running writer is kept`);
  }
});

test('the zip export records its temporary before the file exists, forgets it once renamed into place, and forgets a removed one only', async (t0) => {
  const root = await sandbox('zip', t0.after.bind(t0));
  const source = path.join(root, 'source.pdf');
  await fs.writeFile(source, PDF);
  const boardPath = path.join(root, 'Board.cad');
  const manifest = {
    version: 1,
    board: { key: KEY, name: 'Board.cad', path: boardPath, format: 'gencad' },
    documents: [{ id: 'd1', kind: 'pdf', name: 'source.pdf', path: source, relativePath: 'source.pdf', key: sha256(PDF), size: PDF.length, bookmarks: [], annotations: [], addedAt: NOW }],
    split: { enabled: false, ratio: 0.5, right: null },
    cameras: {},
  };
  const target = path.join(root, 'bundle.zip');
  // The operations on the export's temporary and on its destination are observed (the sources are read too, and are not part of the record);
  // `refuse` makes one of them fail with the given code.
  const observed = (events, refuse = {}) => new Proxy(fs, { get(source, property) {
    if (!['open', 'rename', 'unlink'].includes(property)) return source[property];
    return async (...args) => {
      const file = property === 'rename' ? String(args[1]) : String(args[0]);
      if (file.endsWith('.tmp') || file === target) events.push(`${property}:${file.endsWith('.tmp') ? 'temporary' : 'target'}`);
      if (refuse[property] && (file.endsWith('.tmp') || file === target)) refuse[property](file);
      return source[property](...args);
    };
  } });
  const refusing = (code, onlyTemporary) => (file) => {
    if (onlyTemporary !== undefined && file.endsWith('.tmp') !== onlyTemporary) return;
    throw Object.assign(new Error(`${code}: refused`), { code });
  };
  const journalOf = (events) => ({
    record: async () => { events.push('record'); return true; },
    forget: async () => { events.push('forget'); },
  });
  const exportWith = (events, fsUnderTest, journal) => documents.exportBundle({
    manifest, notes: null, documentIds: ['d1'], includeBoard: false, t: tr, fs: fsUnderTest, platform: process.platform, target,
    renameRetryDelaysMs: [0, 0, 0], temporaries: journal,
  });

  // Success: recorded, written, renamed into place, forgotten.
  let events = [];
  await exportWith(events, observed(events), journalOf(events));
  assert.deepEqual(events.filter((event) => event !== 'rename:target'), ['record', 'open:temporary', 'forget'], 'recorded before the temporary is created, forgotten after the rename');
  assert.equal(await exists(target), true);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [], 'no temporary is left behind');
  await fs.rm(target);

  // The temporary cannot be created: nothing to remove, so the record is dropped.
  events = [];
  await assert.rejects(exportWith(events, observed(events, { open: refusing('EPERM', true) }), journalOf(events)), { code: 'EXPORT_WRITE_FAILED' });
  assert.deepEqual(events.filter((event) => event !== 'rename:target'), ['record', 'open:temporary', 'unlink:temporary', 'forget'], 'a temporary that was never created is forgotten');

  // The rename over the destination fails: the temporary is removed, and so forgotten.
  events = [];
  await assert.rejects(exportWith(events, observed(events, { rename: refusing('EPERM', false) }), journalOf(events)), { code: 'EXPORT_WRITE_FAILED' });
  assert.equal(events.at(-1), 'forget', 'a temporary that was removed is forgotten');
  assert.equal(await exists(target), false, 'a failed export leaves no file at the destination');
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [], 'and no temporary either');

  // The rename fails and the temporary cannot be removed: it stays recorded, for the next start to sweep.
  events = [];
  await assert.rejects(exportWith(events, observed(events, { rename: refusing('EPERM', false), unlink: refusing('EACCES') }), journalOf(events)), { code: 'EXPORT_WRITE_FAILED' });
  assert.equal(events.includes('forget'), false, 'a temporary that could not be removed stays recorded');
  const stranded = (await fs.readdir(root)).filter((name) => name.endsWith('.tmp'));
  assert.equal(stranded.length, 1, 'the temporary is still on disk, for the sweep');
  await fs.rm(path.join(root, stranded[0]));

});

test('an export whose temporary cannot be recorded still succeeds, and the log says so (the journal is housekeeping, not a condition of the export)', async (t0) => {
  const root = await sandbox('unrecorded', t0.after.bind(t0));
  const source = path.join(root, 'source.pdf');
  await fs.writeFile(source, PDF);
  const boardPath = path.join(root, 'Board.cad');
  const manifest = {
    version: 1,
    board: { key: KEY, name: 'Board.cad', path: boardPath, format: 'gencad' },
    documents: [{ id: 'd1', kind: 'pdf', name: 'source.pdf', path: source, relativePath: 'source.pdf', key: sha256(PDF), size: PDF.length, bookmarks: [], annotations: [], addedAt: NOW }],
    split: { enabled: false, ratio: 0.5, right: null },
    cameras: {},
  };
  const target = path.join(root, 'bundle.zip');
  // The profile store: reads work, the write of the export record is refused (the profile is not writable).
  const readOnlyStore = { read: async () => [], write: async () => { throw Object.assign(new Error('EACCES: profile not writable'), { code: 'EACCES' }); } };
  const lines = [];
  const journal = createExportTemporaries({ store: readOnlyStore, fs, log: (message) => lines.push(message) });

  const bytes = await documents.exportBundle({
    manifest, notes: null, documentIds: ['d1'], includeBoard: false, t: tr, fs, platform: process.platform, target,
    renameRetryDelaysMs: [0, 0, 0], temporaries: journal,
  });
  assert.equal(bytes.path, target, 'the export succeeds');
  assert.equal(await exists(target), true, 'the file is at the destination');
  assert.equal(lines.length, 1, 'one log line names the unrecorded temporary');
  assert.match(lines[0], /^the export temporary bundle\.zip\.\d+\.[0-9a-f-]+\.tmp is not recorded \(EACCES\)/, 'the line names the temporary and the reason');
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [], 'no temporary is left behind');
});

test('the store sweeps the library\'s device folder when it is given as a temporary folder: a stale temporary of either writer is removed, the running and the other files are kept', async (t0) => {
  const root = await sandbox('library', t0.after.bind(t0));
  const profile = path.join(root, 'profile');
  const devices = path.join(profile, 'library', 'devices');
  const boards = path.join(profile, 'library', 'boards');
  const dead = deadPid();
  const live = await liveChild();
  try {
    const noDashes = '0b6f6a5e3c2d4e7f9a1b2c3d4e5f6a7b';
    const stale = [
      path.join(devices, `boards.json.${dead}.${UUID}.tmp`), // board-store writer (dashed uuid)
      path.join(devices, `corrections.json.${dead}.${noDashes}.tmp`), // corrections and device writers (uuid without dashes)
    ];
    const kept = [
      path.join(devices, `boards.json.${live.pid}.${UUID}.tmp`), // a running writer
      path.join(devices, 'boards.json'), // the file itself
      path.join(devices, `boards.json.${dead}.${'0C7A1B2D-3E4F-4A5B-8C6D-7E8F9A0B1C2D'}.tmp`), // another shape: upper case (a different uuid, so a case-folding file system keeps two names)
      path.join(boards, `boards.json.${dead}.${UUID}.tmp`), // a folder the store was not given
    ];
    for (const file of [...stale, ...kept]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'partial write');
    }
    // A relative folder is not swept (it is not resolved against the working directory); the absolute one is.
    const relative = createJsonStore({ directory: profile, t, temporaryFolders: ['library/devices'] });
    await relative.read('sweep-barrier.json');
    for (const file of stale) assert.equal(await exists(file), true, 'a relative temporary folder is not swept');
    const store = createJsonStore({ directory: profile, t, temporaryFolders: [devices] });
    await store.read('sweep-barrier.json');
    for (const file of stale) assert.equal(await exists(file), false, `${path.basename(file)} is removed at the next start`);
    for (const file of kept) assert.equal(await exists(file), true, `${path.relative(root, file)} is kept`);
  } finally {
    live.kill();
  }
});

test('the store\'s start sweep removes stale temporaries of the library\'s device folder with the same rules on each platform (path shape only)', async () => {
  // The sweep reads names, not separators: the same temporary name on win32 and posix paths gives the same decision.
  const names = [`boards.json.${DEAD}.${UUID}.tmp`, `corrections.json.${DEAD}.${UUID.replace(/-/g, '')}.tmp`];
  for (const platform of ['win32', 'darwin', 'linux']) {
    const pathModule = platform === 'win32' ? path.win32 : path.posix;
    const base = platform === 'win32' ? 'C:\\Users\\u\\AppData\\Roaming\\TRACE\\library\\devices' : '/home/u/.config/TRACE/library/devices';
    const recorded = names.map((name) => ({ path: pathModule.join(base, name), pid: DEAD, at: Date.now() }));
    const unlinked = [];
    const journal = createExportTemporaries({
      store: memoryStore(recorded), fs: { unlink: async (file) => { unlinked.push(file); } }, pathModule, isGone: (pid) => pid === DEAD,
    });
    await journal.sweep();
    assert.deepEqual(unlinked, recorded.map((entry) => entry.path), `${platform}: the recorded temporaries of a gone writer are removed`);
  }
});
