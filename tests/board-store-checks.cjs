'use strict';

// Native checks for electron/library/board-store.cjs: the board records of the Library database (the BoardStore port of the device
// catalogue). No Electron, no network. Every test runs in its own temporary userData folder, removed afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { createBoardStore, FILE_NAME, VERSION } = require('../electron/library/board-store.cjs');
const { makeTempDir, isInsideTemp } = require('./canonical-temp.cjs');

const DIRECTORY = path.join('library', 'devices');
const board = (code, revision) => ({ id: `board:${code}|${revision}`, boardCode: code, revision: { normalized: revision, scheme: 'number', rank: [Number(revision)] }, aliases: [] });
const scan = (derived) => ({ files: [], derived });
const fileOf = (userData) => path.join(userData, DIRECTORY, FILE_NAME);

async function withUserData(name, body) {
  const userData = await makeTempDir(`board-store-${name}-`);
  try {
    await body(userData);
  } finally {
    if (await isInsideTemp(userData)) await fsPromises.rm(userData, { recursive: true, force: true });
  }
}

test('a scanned board is recorded, and a new store on the same userData knows its code and revision', async () => {
  await withUserData('restart', async (userData) => {
    const derived = [board('MB-Q731', '2')];
    const first = createBoardStore({ userDataDirectory: userData });
    assert.deepEqual(await first.anchorsFor(scan(derived)), derived, 'the scan\'s own anchors are answered unchanged');
    const saved = JSON.parse(await fsPromises.readFile(fileOf(userData), 'utf8'));
    assert.equal(saved.version, VERSION);
    assert.equal(saved.boards.length, 1);
    assert.deepEqual({ anchorId: saved.boards[0].anchorId, boardCode: saved.boards[0].boardCode, revision: saved.boards[0].revision }, { anchorId: 'board:MB-Q731|2', boardCode: 'MB-Q731', revision: '2' });
    const restarted = createBoardStore({ userDataDirectory: userData });
    assert.deepEqual(await restarted.describe('board:MB-Q731|2'), { boardCode: 'MB-Q731', revision: '2' });
    assert.equal(await restarted.describe('board:NOPE|'), undefined, 'an unknown board has no record');
  });
});

test('a scan that changes nothing writes nothing; a changed revision is written', async () => {
  await withUserData('writes', async (userData) => {
    let temporaryFiles = 0;
    const names = [];
    const counting = { ...fsPromises, open: async (name, ...rest) => { if (String(name).endsWith('.tmp')) { temporaryFiles++; names.push(path.basename(String(name))); } return fsPromises.open(name, ...rest); } };
    const store = createBoardStore({ userDataDirectory: userData, fs: counting });
    await store.anchorsFor(scan([board('MB-Q731', '2')]));
    assert.equal(temporaryFiles, 1, 'the first sighting is written');
    assert.match(names[0], /^boards\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/, 'the temporary carries the pid the start sweep reads');
    await store.anchorsFor(scan([board('MB-Q731', '2')]));
    assert.equal(temporaryFiles, 1, 'the same board again writes nothing');
    await store.anchorsFor(scan([board('MB-Q731', '3')]));
    assert.equal(temporaryFiles, 2, 'a board with a new revision is a new record');
    assert.equal(await store.describe('board:MB-Q731|3').then((meta) => meta.revision), '3');
  });
});

test('a damaged file is moved aside with its bytes kept; when it cannot be moved it is never overwritten', async () => {
  await withUserData('damaged', async (userData) => {
    await fsPromises.mkdir(path.dirname(fileOf(userData)), { recursive: true });
    await fsPromises.writeFile(fileOf(userData), 'not json');
    const store = createBoardStore({ userDataDirectory: userData });
    await store.anchorsFor(scan([board('MB-Q731', '2')]));
    const names = await fsPromises.readdir(path.dirname(fileOf(userData)));
    const moved = names.find((name) => name.startsWith('boards.damaged-') && name.endsWith('.json'));
    assert.ok(moved, 'the damaged file is kept under a new name');
    assert.equal(await fsPromises.readFile(path.join(path.dirname(fileOf(userData)), moved), 'utf8'), 'not json');
    assert.equal((await store.describe('board:MB-Q731|2')).boardCode, 'MB-Q731', 'the store works from the new records');
  });
  await withUserData('unmovable', async (userData) => {
    await fsPromises.mkdir(path.dirname(fileOf(userData)), { recursive: true });
    await fsPromises.writeFile(fileOf(userData), 'not json');
    const blocked = { ...fsPromises, rename: async () => { const error = new Error('locked'); error.code = 'EPERM'; throw error; } };
    const store = createBoardStore({ userDataDirectory: userData, fs: blocked, renameDelaysMs: [] });
    assert.deepEqual(await store.anchorsFor(scan([board('MB-Q731', '2')])), [board('MB-Q731', '2')], 'the scan is not failed');
    assert.equal(await fsPromises.readFile(fileOf(userData), 'utf8'), 'not json', 'the damaged file is untouched');
  });
});

test('entries that do not match the format are dropped, the valid ones are kept', async () => {
  await withUserData('entries', async (userData) => {
    const entries = [
      { anchorId: 'board:MB-Q731|2', boardCode: 'MB-Q731', revision: '2', firstSeen: '2026-10-11T00:00:00.000Z', lastChanged: '2026-10-11T00:00:00.000Z' },
      { anchorId: 'not-an-anchor', boardCode: 'X', revision: null },
      { anchorId: 'board:EMPTY|', boardCode: '', revision: null },
      { anchorId: 'board:LONG|', boardCode: 'A'.repeat(100), revision: null },
    ];
    await fsPromises.mkdir(path.dirname(fileOf(userData)), { recursive: true });
    await fsPromises.writeFile(fileOf(userData), `${JSON.stringify({ version: VERSION, boards: entries })}\n`);
    const store = createBoardStore({ userDataDirectory: userData });
    assert.deepEqual(await store.describe('board:MB-Q731|2'), { boardCode: 'MB-Q731', revision: '2' });
    assert.equal(await store.describe('not-an-anchor'), undefined);
    assert.equal(await store.describe('board:EMPTY|'), undefined);
    assert.equal(await store.describe('board:LONG|'), undefined);
  });
});

test('a write that fails does not fail the scan, and the records stay known for the session', async () => {
  await withUserData('refused', async (userData) => {
    const refusing = { ...fsPromises, open: async (name, ...rest) => { if (String(name).endsWith('.tmp')) { const error = new Error('denied'); error.code = 'EACCES'; throw error; } return fsPromises.open(name, ...rest); } };
    const store = createBoardStore({ userDataDirectory: userData, fs: refusing });
    assert.deepEqual(await store.anchorsFor(scan([board('MB-Q731', '2')])), [board('MB-Q731', '2')]);
    assert.equal((await store.describe('board:MB-Q731|2')).boardCode, 'MB-Q731');
    await assert.rejects(fsPromises.readFile(fileOf(userData)), { code: 'ENOENT' }, 'nothing was written');
  });
});

test('the user data directory must be an absolute path', () => {
  assert.throws(() => createBoardStore({ userDataDirectory: 'relative/userdata' }), TypeError);
  assert.throws(() => createBoardStore({}), TypeError);
});
