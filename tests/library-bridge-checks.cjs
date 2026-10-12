'use strict';

// Native checks for electron/library/devices-bridge.cjs with the real main-process bundle (electron/library/devices-core.cjs).
// Everything runs on a synthetic folder tree under the canonical temp root, created and removed by this file. No Electron,
// no network. Covered: opaque root ids (no path crosses the bridge), the reserved data folder, the closed request schemas,
// read-only scans, one scan at a time, fixed error codes without file-system text, and the corrections round trip with no
// write into a Library root.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDeviceBridge, stableRootId, legacyDarwinRootId, rootIdFollows, BRIDGE_CODES } = require('../electron/library/devices-bridge.cjs');
const { createDirectoryPort, ADAPTER_CODES } = require('../electron/library/directory-adapter.cjs');
const core = require('../electron/library/devices-core.cjs');
const { makeTempDir } = require('./canonical-temp.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

async function synthetic(name) {
  const root = await makeTempDir(`library-bridge-${name}-`);
  const userData = await makeTempDir(`library-bridge-userdata-${name}-`);
  await fs.mkdir(path.join(root, 'Birchfield', 'Kestrel-14-R2'), { recursive: true });
  await fs.writeFile(path.join(root, 'Birchfield', 'Kestrel-14-R2', 'KESTREL 14 R2.brd'), '');
  return { root, userData };
}

function bridgeFor(userData, chosen, extra = {}) {
  return createDeviceBridge({
    core,
    chooseDirectory: async () => chosen.value,
    userDataDirectory: userData,
    ...extra,
  });
}

async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code && error.message.startsWith(`[${code}] `), `expected ${code}`);
}

test('pickRoot returns an opaque id and the folder name; the path never crosses the bridge', async () => {
  const { root, userData } = await synthetic('pick');
  const chosen = { value: root };
  const bridge = bridgeFor(userData, chosen);
  const picked = await bridge.pickRoot();
  assert.match(picked.rootId, UUID);
  assert.equal(picked.label, path.basename(root));
  assert.deepEqual(Object.keys(picked).sort(), ['label', 'rootId']);
  assert.equal(JSON.stringify(picked).includes(root), false, 'the result holds no path');
  assert.equal((await bridge.pickRoot()).rootId, picked.rootId, 'the same folder keeps its id');
  chosen.value = null;
  assert.equal(await bridge.pickRoot(), null, 'a cancelled chooser resolves null');
  chosen.value = 'relative/folder';
  assert.equal(await bridge.pickRoot(), null, 'a non-absolute answer is ignored');
});

test('pickRoot refuses the application data folder, its parents and its children', async () => {
  const { root, userData } = await synthetic('reserved');
  const inside = path.join(userData, 'library');
  await fs.mkdir(inside, { recursive: true });
  for (const candidate of [userData, inside]) {
    const bridge = bridgeFor(userData, { value: candidate });
    await assertCode(bridge.pickRoot(), BRIDGE_CODES.RESERVED_ROOT);
  }
  const parent = path.dirname(userData);
  await assertCode(bridgeFor(userData, { value: parent }).pickRoot(), BRIDGE_CODES.RESERVED_ROOT);
  // An unrelated Library folder is accepted.
  assert.match((await bridgeFor(userData, { value: root }).pickRoot()).rootId, UUID);
});

test('scan requests use a closed schema and only recorded ids', async () => {
  const { root, userData } = await synthetic('schema');
  const chosen = { value: root };
  const bridge = bridgeFor(userData, chosen);
  const { rootId } = await bridge.pickRoot();
  const bad = [
    null,
    [],
    { rootIds: [] },
    { rootIds: 'x' },
    { rootIds: [root] },
    { rootIds: ['relative/path'] },
    { rootIds: [rootId, rootId] },
    { rootIds: [rootId], extra: true },
    { rootIds: [rootId], steps: { folderMap: 'yes' } },
    { rootIds: [rootId], steps: { unknownStep: true } },
    { rootIds: [rootId], steps: [] },
    { rootIds: Array.from({ length: 17 }, () => rootId) },
  ];
  for (const request of bad) await assertCode(bridge.scan(request), BRIDGE_CODES.INVALID_REQUEST);
  await assertCode(bridge.scan({ rootIds: [UNKNOWN_ID] }), BRIDGE_CODES.UNKNOWN_ROOT);
});

test('a scan of a recorded root is read-only and returns counts without paths or file names', async () => {
  const { root, userData } = await synthetic('scan');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  const before = await fs.readdir(path.join(root, 'Birchfield', 'Kestrel-14-R2'));
  const summary = await bridge.scan({ rootIds: [rootId] });
  assert.equal(summary.roots.length, 1);
  assert.equal(summary.roots[0].rootId, rootId);
  assert.equal(summary.roots[0].scanned, true);
  assert.equal(summary.roots[0].complete, true);
  assert.equal(summary.fileCount, 1);
  assert.equal(summary.correctionsStatus, 'empty');
  const text = JSON.stringify(summary);
  assert.equal(text.includes(root), false, 'no root path in the summary');
  assert.equal(/KESTREL|Birchfield/i.test(text), false, 'no file or folder name in the summary');
  assert.deepEqual(await fs.readdir(path.join(root, 'Birchfield', 'Kestrel-14-R2')), before, 'the scanned folder is unchanged');
  const skipped = await bridge.scan({ rootIds: [rootId], steps: { folderMap: false } });
  assert.equal(skipped.steps.folderMap, 'skipped');
  assert.equal(skipped.roots[0].scanned, false);
});

test('a recorded root that disappeared is refused, not followed', async () => {
  const { root, userData } = await synthetic('gone');
  const doomed = await makeTempDir('library-bridge-doomed-');
  const chosen = { value: doomed };
  const bridge = bridgeFor(userData, chosen);
  const { rootId } = await bridge.pickRoot();
  await fs.rm(doomed, { recursive: true, force: true });
  await assertCode(bridge.scan({ rootIds: [rootId] }), BRIDGE_CODES.ROOT_UNAVAILABLE);
  chosen.value = root;
  assert.match((await bridge.pickRoot()).rootId, UUID, 'other roots still work');
});

test('one scan runs at a time; a failing catalogue reports a fixed code without its message', async () => {
  const { root, userData } = await synthetic('busy');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = {
    ...core,
    buildDeviceCatalogue: async () => {
      await gate;
      return { steps: {}, maps: [], files: [], associations: [], missingTargets: [], excludedFirmwareCount: 0, collisions: [], needsManual: [], stats: { folders: 0, files: 0, entries: 0, match: { files: 0, candidates: 0, judgments: 0, linkSteps: 0 } } };
    },
  };
  const bridge = bridgeFor(userData, { value: root }, { core: fake });
  const { rootId } = await bridge.pickRoot();
  const first = bridge.scan({ rootIds: [rootId] });
  await assertCode(bridge.scan({ rootIds: [rootId] }), BRIDGE_CODES.BUSY);
  release();
  assert.equal((await first).fileCount, 0);

  const failing = bridgeFor(userData, { value: root }, { core: { ...core, buildDeviceCatalogue: async () => { throw new Error('secret text C:\\private\\folder'); } } });
  const id = (await failing.pickRoot()).rootId;
  await assert.rejects(failing.scan({ rootIds: [id] }), (error) => error.code === BRIDGE_CODES.SCAN_FAILED && !/secret|private/.test(error.message));
});

test('corrections: empty load, closed save, reload, and no write into the Library root', async () => {
  const { root, userData } = await synthetic('corr');
  const bridge = bridgeFor(userData, { value: root });
  const beforeRoot = await fs.readdir(root, { recursive: true });
  const empty = await bridge.loadCorrections();
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.document.corrections, []);

  const document = { version: 1, platform: process.platform, corrections: [{ op: 'board-code', boardAnchorId: 'anchor-1', code: 'K14' }] };
  const saved = await bridge.saveCorrections(document);
  assert.equal(saved.status, 'saved');
  assert.ok(saved.bytes > 0);

  const reloaded = await bridge.loadCorrections();
  assert.equal(reloaded.status, 'ok');
  assert.deepEqual(reloaded.document.corrections, document.corrections);

  const stored = await fs.readFile(path.join(userData, 'library', 'devices', 'corrections.json'), 'utf8');
  assert.equal(stored.includes(root), false, 'no absolute path is stored');
  assert.deepEqual(await fs.readdir(root, { recursive: true }), beforeRoot, 'nothing was written into the Library root');

  const other = process.platform === 'win32' ? 'linux' : 'win32';
  const bad = [
    { version: 1, platform: other, corrections: [] },
    { version: 2, platform: process.platform, corrections: [] },
    { version: 1, platform: process.platform, corrections: 'none' },
    { version: 1, platform: process.platform, corrections: [], path: root },
    { version: 1, platform: process.platform },
    [],
    null,
  ];
  for (const request of bad) await assertCode(bridge.saveCorrections(request), BRIDGE_CODES.INVALID_REQUEST);
  assert.equal((await bridge.loadCorrections()).document.corrections.length, 1, 'refused saves leave the file as it was');
});

test('root ids are stable across sessions and differ between installs; the key is 32 bytes and stays in userData', async () => {
  const { root, userData } = await synthetic('stable');
  const first = await bridgeFor(userData, { value: root }).pickRoot();
  const nextSession = await bridgeFor(userData, { value: root }).pickRoot();
  assert.equal(nextSession.rootId, first.rootId, 'a new bridge instance gives the same id for the same folder');
  const otherInstall = await makeTempDir('library-bridge-install-');
  assert.notEqual((await bridgeFor(otherInstall, { value: root }).pickRoot()).rootId, first.rootId, 'another install derives other ids');
  const key = await fs.readFile(path.join(userData, 'library', 'devices', 'root-key.bin'));
  assert.equal(key.length, 32);
  assert.equal(JSON.stringify(first).includes(key.toString('hex')), false);
});

test('a damaged root key is refused and never replaced', async () => {
  const { root, userData } = await synthetic('key');
  const keyDirectory = path.join(userData, 'library', 'devices');
  await fs.mkdir(keyDirectory, { recursive: true });
  await fs.writeFile(path.join(keyDirectory, 'root-key.bin'), Buffer.alloc(5));
  await assertCode(bridgeFor(userData, { value: root }).pickRoot(), BRIDGE_CODES.KEY_UNAVAILABLE);
  assert.equal((await fs.readFile(path.join(keyDirectory, 'root-key.bin'))).length, 5, 'the damaged key is left as it was');
});

test('corrections keep their target across sessions: a saved file id names the same file after a restart', async () => {
  const { root, userData } = await synthetic('persist');
  const first = bridgeFor(userData, { value: root });
  const { rootId } = await first.pickRoot();
  await first.scan({ rootIds: [rootId] });
  const fileId = await findFileId(first, rootId, 'KESTREL 14 R2.brd');
  assert.match(fileId, UUID);
  assert.equal((await first.saveCorrections({ version: 1, platform: process.platform, corrections: [{ op: 'unlink', fileId, boardAnchorId: 'anchor-1' }] })).status, 'saved');
  const nextSession = bridgeFor(userData, { value: root });
  assert.equal((await nextSession.pickRoot()).rootId, rootId);
  const summary = await nextSession.scan({ rootIds: [rootId] });
  assert.equal(summary.correctionsStatus, 'ok');
  assert.equal(summary.missingTargetCount, 0, 'the corrected file is found under the same root id');
  const loaded = await nextSession.loadCorrections();
  assert.equal(loaded.document.corrections.length, 1);
  assert.match(loaded.document.corrections[0].fileId, UUID);
  assert.equal(loaded.document.corrections[0].boardAnchorId, 'anchor-1');
});

test('a damaged corrections file is moved aside with its bytes kept; the status holds until a save, and no file name is returned', async () => {
  const { root, userData } = await synthetic('quarantine');
  const bridge = bridgeFor(userData, { value: root });
  const directory = path.join(userData, 'library', 'devices');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'corrections.json'), '{ not json', 'utf8');
  const first = await bridge.loadCorrections();
  assert.equal(first.status, 'quarantined');
  assert.equal(Object.hasOwn(first, 'quarantine'), false);
  assert.equal(JSON.stringify(first).includes('corrections.quarantine'), false, 'the moved file name never crosses the bridge');
  const moved = (await fs.readdir(directory)).filter((name) => /^corrections\.quarantine-.*\.json$/.test(name));
  assert.equal(moved.length, 1);
  assert.equal(await fs.readFile(path.join(directory, moved[0]), 'utf8'), '{ not json');
  assert.equal((await bridge.loadCorrections()).status, 'quarantined', 'the status holds for the session');
  await bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [] });
  assert.equal((await bridge.loadCorrections()).status, 'ok');
});

test('list channels: closed schema, refused unknown or unscanned roots, counts and opaque ids only after a scan', async () => {
  const { root, userData } = await synthetic('lists');
  await withBoardCode(root);
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await assertCode(bridge.listFolders({ rootId }), BRIDGE_CODES.NOT_SCANNED);
  await assertCode(bridge.listBoards({ rootId }), BRIDGE_CODES.NOT_SCANNED);
  await assertCode(bridge.listFolders({ rootId: UNKNOWN_ID }), BRIDGE_CODES.UNKNOWN_ROOT);
  for (const bad of [null, [], {}, { rootId: 'x' }, { rootId, path: root }, { rootId: root }]) {
    await assertCode(bridge.listFolders(bad), BRIDGE_CODES.INVALID_REQUEST);
    await assertCode(bridge.listBoards(bad), BRIDGE_CODES.INVALID_REQUEST);
  }
  await bridge.scan({ rootIds: [rootId] });
  const folders = await bridge.listFolders({ rootId });
  assert.equal(folders.scanned, true);
  assert.equal(folders.total, 2, 'Birchfield and the board folder at the top level');
  assert.match(folders.folders[0].folderId, UUID);
  // The folder rows carry the basename, the read state, the code of an unreadable folder only, and an opaque id; never a full path.
  assert.deepEqual(Object.keys(folders.folders[0]).sort(), ['bytes', 'childFolderCount', 'fileCount', 'folderCount', 'folderId', 'name', 'readState']);
  assert.equal(folders.folders[0].name, 'Birchfield', 'the folder shows its own name only');
  const boards = await bridge.listBoards({ rootId });
  assert.equal(boards.boards.length, 1, 'the boardview of the synthetic tree derives one board');
  assert.notEqual(boards.boards[0].boardview, 'unknown', 'a complete scan measures the boardview presence');
  assert.notEqual(boards.boards[0].boardview, 'none', 'the boardview is present');
  const text = JSON.stringify([folders, await bridge.listBoards({ rootId })]);
  assert.equal(/Kestrel|\.brd/i.test(text), false, 'no file name or nested folder name in the answers');
  assert.equal(text.includes(root), false, 'no path in the answers');
});

test('a manual document role is marked in the scan, not guessed into another role', async () => {
  const { root, userData } = await synthetic('manual');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const fileId = await findFileId(bridge, rootId, 'KESTREL 14 R2.brd');
  assert.equal((await bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [{ op: 'role', fileId, role: 'document' }] })).status, 'saved');
  const summary = await bridge.scan({ rootIds: [rootId] });
  assert.equal(summary.manualClassificationCount, 1);
  assert.equal((await bridge.listBoards({ rootId })).manualClassificationCount, 1);
});

test('a save with refused entries writes nothing and names each refusal by a closed reason and a key', async () => {
  const { root, userData } = await synthetic('refuse');
  const bridge = bridgeFor(userData, { value: root });
  const directory = path.join(userData, 'library', 'devices');
  const refused = await bridge.saveCorrections({
    version: 1,
    platform: process.platform,
    corrections: [
      { op: 'board-code', boardAnchorId: 'anchor-1', code: 'K14' },
      { op: 'board-code', boardAnchorId: 'anchor-1', code: '!!' },
    ],
  });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.rejections.length, 1);
  assert.deepEqual(Object.keys(refused.rejections[0]).sort(), ['index', 'messageKey', 'reason']);
  assert.equal(refused.rejections[0].index, 1);
  assert.equal(refused.rejections[0].reason, 'invalid-entry');
  assert.equal(refused.rejections[0].messageKey, 'library.corrections.rejected.invalidEntry');
  assert.equal(JSON.stringify(refused).includes('!!'), false, 'the refused value is not echoed');
  await assert.rejects(fs.stat(path.join(directory, 'corrections.json')), (error) => error.code === 'ENOENT', 'nothing was written');
});

test('a stored invalid entry is reported on load with its reason; the rest of the file is kept', async () => {
  const { root, userData } = await synthetic('stored-rejects');
  const bridge = bridgeFor(userData, { value: root });
  const directory = path.join(userData, 'library', 'devices');
  await fs.mkdir(directory, { recursive: true });
  const stored = { version: 1, platform: process.platform, corrections: [{ op: 'board-code', anchorId: 'anchor-1', code: 'K14' }, { op: 'board-code', anchorId: 'anchor-2', code: '!!' }] };
  await fs.writeFile(path.join(directory, 'corrections.json'), JSON.stringify(stored), 'utf8');
  const loaded = await bridge.loadCorrections();
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.dropped, 1);
  assert.deepEqual(loaded.rejections, [{ index: 1, reason: 'invalid-entry', messageKey: 'library.corrections.rejected.invalidEntry' }]);
  assert.equal(loaded.document.corrections.length, 1);
});

test('a save round-trips losslessly: what is saved is what loads back', async () => {
  const { root, userData } = await synthetic('lossless');
  const bridge = bridgeFor(userData, { value: root });
  const corrections = [
    { op: 'board-code', boardAnchorId: 'anchor-1', code: 'K14' },
    { op: 'revision', boardAnchorId: 'anchor-1', revision: 'REV A' },
    // Aliases are stored in their search form (lower case), so the input is already in that form.
    { op: 'alias', boardAnchorId: 'anchor-1', alias: 'kestrel', remove: false },
  ];
  assert.equal((await bridge.saveCorrections({ version: 1, platform: process.platform, corrections })).status, 'saved');
  const loaded = await bridgeFor(userData, { value: root }).loadCorrections();
  assert.deepEqual(loaded.document.corrections, corrections);
  assert.equal(loaded.dropped, 0);
});

test('a newer-schema corrections file blocks saves and is left byte for byte as it was', async () => {
  const { root, userData } = await synthetic('newer');
  const bridge = bridgeFor(userData, { value: root });
  const directory = path.join(userData, 'library', 'devices');
  await fs.mkdir(directory, { recursive: true });
  const future = '{"version":2,"platform":"' + process.platform + '","corrections":[],"futureField":true}';
  await fs.writeFile(path.join(directory, 'corrections.json'), future, 'utf8');
  const loaded = await bridge.loadCorrections();
  assert.equal(loaded.status, 'newer-schema');
  await assertCode(bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [] }), BRIDGE_CODES.CORRECTIONS_BLOCKED);
  assert.equal(await fs.readFile(path.join(directory, 'corrections.json'), 'utf8'), future, 'the newer file was not overwritten');
});

// ---- Tree paging, skips, cancel, the persisted root list, board presence, tri-state values, per-platform ids -----------------------

// A board file whose name carries a board code: only such a boardview derives a board anchor.
async function withBoardCode(root) {
  await fs.mkdir(path.join(root, 'Board'), { recursive: true });
  await fs.writeFile(path.join(root, 'Board', 'MB-Q731_rev2.brd'), '');
}

// Finds the opaque id of a file by its basename, walking the listings the way the renderer does.
async function findFileId(bridge, rootId, name, parentId) {
  const page = await bridge.listFolders(parentId === undefined ? { rootId } : { rootId, parentId });
  const hit = page.files.find((file) => file.name === name);
  if (hit !== undefined) return hit.fileId;
  for (const folder of page.folders) {
    const found = await findFileId(bridge, rootId, name, folder.folderId);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function deepSynthetic(name) {
  const { root, userData } = await synthetic(name);
  await fs.mkdir(path.join(root, 'Birchfield', 'Alder'), { recursive: true });
  await fs.mkdir(path.join(root, 'Birchfield', 'Kestrel-14-R2', 'Sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'Birchfield', 'Alder', 'ALDER.bin'), '');
  return { root, userData };
}

test('listFolders walks the tree one level at a time, pages with cursors, and refuses stale or foreign cursors and ids', async () => {
  const { root, userData } = await deepSynthetic('tree');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const top = await bridge.listFolders({ rootId });
  assert.equal(top.total, 1);
  const birchfield = top.folders[0].folderId;
  const children = await bridge.listFolders({ rootId, parentId: birchfield });
  assert.equal(children.total, 2, 'Alder and Kestrel-14-R2 under Birchfield');
  const first = await bridge.listFolders({ rootId, parentId: birchfield, limit: 1 });
  assert.equal(first.folders.length, 1);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await bridge.listFolders({ rootId, parentId: birchfield, limit: 1, cursor: first.nextCursor });
  assert.equal(second.folders.length, 1);
  assert.notEqual(second.folders[0].folderId, first.folders[0].folderId);
  assert.equal(second.nextCursor, undefined, 'the last page has no cursor');
  const kestrel = children.folders.find((row) => row.childFolderCount === 1);
  assert.ok(kestrel, 'Kestrel-14-R2 has one subfolder');
  const inKestrel = await bridge.listFolders({ rootId, parentId: kestrel.folderId });
  assert.equal(inKestrel.files.length, 1);
  assert.match(inKestrel.files[0].fileId, UUID);
  assert.equal(inKestrel.files[0].name, 'KESTREL 14 R2.brd', 'the file shows its basename');
  assert.equal(inKestrel.folders[0].name, 'Sub', 'the nested folder shows its own name');
  await assertCode(bridge.listFolders({ rootId, parentId: kestrel.folderId, cursor: first.nextCursor }), BRIDGE_CODES.STALE_CURSOR);
  await assertCode(bridge.listFolders({ rootId, parentId: birchfield, cursor: 'not a cursor!' }), BRIDGE_CODES.INVALID_REQUEST);
  await assertCode(bridge.listFolders({ rootId, parentId: UNKNOWN_ID }), BRIDGE_CODES.UNKNOWN_FOLDER);
  await assertCode(bridge.listFolders({ rootId, limit: 0 }), BRIDGE_CODES.INVALID_REQUEST);
  await assertCode(bridge.listFolders({ rootId, limit: 201 }), BRIDGE_CODES.INVALID_REQUEST);
  await bridge.scan({ rootIds: [rootId] });
  // A folder id of an earlier scan is not known any more, so the parent check refuses it before the cursor is looked at.
  await assertCode(bridge.listFolders({ rootId, parentId: birchfield, cursor: first.nextCursor }), BRIDGE_CODES.UNKNOWN_FOLDER);
  const fresh = (await bridge.listFolders({ rootId })).folders[0].folderId;
  await assertCode(bridge.listFolders({ rootId, parentId: fresh, cursor: first.nextCursor }), BRIDGE_CODES.STALE_CURSOR);
});

test('user skips: a skipped folder is not read, the scan is incomplete, and an unknown folder id is refused', async () => {
  const { root, userData } = await deepSynthetic('skip');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const top = await bridge.listFolders({ rootId });
  const under = await bridge.listFolders({ rootId, parentId: top.folders[0].folderId });
  const alder = under.folders.find((row) => row.childFolderCount === 0 && row.fileCount === 1);
  assert.ok(alder, 'Alder holds one file');
  const summary = await bridge.scan({ rootIds: [rootId], skipFolders: [alder.folderId] });
  assert.equal(summary.complete, false, 'a partial result is never complete');
  assert.equal(summary.roots[0].complete, false);
  const freshTop = (await bridge.listFolders({ rootId })).folders[0].folderId;
  const after = await bridge.listFolders({ rootId, parentId: freshTop });
  assert.equal(after.total, 1, 'the skipped folder is not in the rescanned tree');
  await assertCode(bridge.scan({ rootIds: [rootId], skipFolders: [UNKNOWN_ID] }), BRIDGE_CODES.UNKNOWN_FOLDER);
  await assertCode(bridge.scan({ rootIds: [rootId], skipFolders: 'x' }), BRIDGE_CODES.INVALID_REQUEST);
});

test('cancel stops a running scan through the signal; cancel with nothing running reports so', async () => {
  const { root, userData } = await synthetic('cancel');
  const fake = {
    ...core,
    buildDeviceCatalogue: ({ signal }) => new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'CANCELLED' }));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    }),
  };
  const bridge = bridgeFor(userData, { value: root }, { core: fake });
  const { rootId } = await bridge.pickRoot();
  assert.deepEqual(await bridge.cancelScan(), { cancelled: false });
  const running = bridge.scan({ rootIds: [rootId] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await bridge.cancelScan(), { cancelled: true });
  await assertCode(running, BRIDGE_CODES.CANCELLED);
  assert.deepEqual(await bridge.cancelScan(), { cancelled: false }, 'the scan is no longer running');
});

test('the root list persists under userData: a new session lists the root, scans it without a new pick, and removes it', async () => {
  const { root, userData } = await synthetic('roots');
  const { rootId } = await bridgeFor(userData, { value: root }).pickRoot();
  const nextSession = bridgeFor(userData, { value: root });
  const listed = await nextSession.listRoots();
  assert.equal(listed.total, 1);
  assert.equal(listed.roots[0].rootId, rootId);
  assert.equal(listed.roots[0].online, true, 'the recorded path is reachable now');
  assert.equal(listed.roots[0].network, 'unknown', 'network is not measured');
  assert.equal(listed.roots[0].scanned, false);
  assert.equal(listed.roots[0].complete, 'unknown');
  assert.equal(JSON.stringify(listed).includes(root), false, 'the path never crosses the bridge');
  assert.equal((await nextSession.scan({ rootIds: [rootId] })).roots[0].scanned, true, 'the persisted root scans without a new pick');
  assert.equal((await nextSession.listRoots()).roots[0].complete, true);
  await assertCode(nextSession.removeRoot({ rootId: UNKNOWN_ID }), BRIDGE_CODES.UNKNOWN_ROOT);
  assert.deepEqual(await nextSession.removeRoot({ rootId }), { removed: true });
  assert.equal((await bridgeFor(userData, { value: root }).listRoots()).total, 0, 'removal is persistent');
  await fs.access(root);
});

test('contract (E-23): a correction of a removed root stays stored, is shown with a fresh id, and applies again when the folder is added back', async () => {
  const { root, userData } = await synthetic('orphan-correction');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const fileId = await findFileId(bridge, rootId, 'KESTREL 14 R2.brd');
  assert.equal((await bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [{ op: 'role', fileId, role: 'document' }] })).status, 'saved');
  assert.deepEqual(await bridge.removeRoot({ rootId }), { removed: true });
  const orphaned = (await bridge.loadCorrections()).document.corrections;
  assert.equal(orphaned.length, 1, 'the correction stays in the store');
  assert.notEqual(orphaned[0].fileId, fileId, 'it is shown with a fresh id');
  const edited = await bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [{ op: 'role', fileId: orphaned[0].fileId, role: 'document' }] });
  assert.equal(edited.status, 'saved', 'an edit through that id is stored under the removed root');
  const again = bridgeFor(userData, { value: root });
  assert.equal((await again.pickRoot()).rootId, rootId, 'the same folder gets the same root id');
  assert.equal((await again.scan({ rootIds: [rootId] })).manualClassificationCount, 1, 'the stored correction applies again');
});

test('a tampered root entry is dropped, and a damaged root list is moved aside, never overwritten', async () => {
  const { root, userData } = await synthetic('roots-damage');
  await bridgeFor(userData, { value: root }).pickRoot();
  const directory = path.join(userData, 'library', 'devices');
  const file = path.join(directory, 'roots.json');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.roots[0].rootId = UNKNOWN_ID;
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  assert.equal((await bridgeFor(userData, { value: root }).listRoots()).total, 0, 'an id that does not follow from the path is dropped');
  await fs.writeFile(file, '{ broken', 'utf8');
  assert.equal((await bridgeFor(userData, { value: root }).listRoots()).total, 0);
  const moved = (await fs.readdir(directory)).filter((name) => /^roots\.damaged-.*\.json$/.test(name));
  assert.equal(moved.length, 1, 'the damaged list is kept aside');
  assert.equal(await fs.readFile(path.join(directory, moved[0]), 'utf8'), '{ broken');
});

test('board presence: a complete scan measures the boardview, an incomplete one cannot prove a missing BIOS; the detail names files by role only', async () => {
  const { root, userData } = await synthetic('boards');
  await withBoardCode(root);
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const { boards } = await bridge.listBoards({ rootId });
  assert.equal(boards.length, 1);
  const detail = await bridge.boardDetail({ boardId: boards[0].boardId });
  assert.equal(detail.complete, true);
  assert.equal(typeof detail.boardCode, 'string');
  assert.ok(detail.files.some((file) => file.role === 'boardview'), 'the boardview file is listed by role');
  assert.deepEqual(Object.keys(detail.files[0]).sort(), ['fileId', 'name', 'role', 'rootId', 'state']);
  assert.match(boards[0].boardAnchorId, /^board:/, 'the board carries its anchor id');
  assert.equal(detail.boardAnchorId, boards[0].boardAnchorId);
  assert.ok(detail.files.every((file) => typeof file.fileId === 'string' && typeof file.name === 'string' && !file.name.includes('/')), 'files carry an id and a basename only');
  assert.equal(JSON.stringify(detail).includes('KESTREL'), false, 'no file name in the detail');
  assert.equal(detail.bios, 'none', 'a complete scan with no firmware file measures the BIOS as absent');
  assert.equal(detail.boardview, 'confirmed', 'a boardview of the board is present in the scanned roots');
  await assertCode(bridge.boardDetail({ boardId: UNKNOWN_ID }), BRIDGE_CODES.UNKNOWN_BOARD);
  const partial = bridgeFor(userData, { value: root });
  await partial.scan({ rootIds: [rootId], steps: { biosCandidates: false } });
  const partialBoard = (await partial.listBoards({ rootId })).boards[0];
  assert.equal(partialBoard.bios, 'unknown', 'with the BIOS step off the absence is not proven');
  assert.notEqual(partialBoard.boardview, 'none');
});

test('missing targets and other measures are unknown unless measured: an incomplete root gives unknown, never zero', async () => {
  const { root, userData } = await deepSynthetic('measure');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const top = await bridge.listFolders({ rootId });
  const alder = (await bridge.listFolders({ rootId, parentId: top.folders[0].folderId })).folders.find((row) => row.fileCount === 1 && row.childFolderCount === 0);
  const summary = await bridge.scan({ rootIds: [rootId], skipFolders: [alder.folderId] });
  assert.equal(summary.missingTargetCount, 'unknown');
  assert.equal((await bridge.listBoards({ rootId })).missingTargetCount, 'unknown');
  const complete = await bridge.scan({ rootIds: [rootId] });
  assert.equal(complete.missingTargetCount, 0);
});

test('root ids follow the platform: only win32 folds case; darwin and linux keep it', () => {
  const key = Buffer.alloc(32, 7);
  assert.equal(stableRootId(key, 'C:\\Lib\\Folder', 'win32'), stableRootId(key, 'c:\\lib\\folder', 'win32'));
  assert.notEqual(stableRootId(key, '/Users/Lib/Folder', 'darwin'), stableRootId(key, '/users/lib/folder', 'darwin'), 'darwin names that differ by case are two roots');
  assert.notEqual(stableRootId(key, '/home/Lib/Folder', 'linux'), stableRootId(key, '/home/lib/folder', 'linux'));
  assert.match(stableRootId(key, '/home/Lib', 'linux'), UUID);
  assert.match(stableRootId(key, '/Users/Lib', 'darwin'), UUID);
  assert.notEqual(stableRootId(key, '/home/Lib', 'linux'), stableRootId(Buffer.alloc(32, 8), '/home/Lib', 'linux'), 'another install gets other ids');
});

test('an id recorded by an earlier darwin release is still accepted; no darwin id of a new root equals a lower-cased one', () => {
  const key = Buffer.alloc(32, 7);
  const legacy = legacyDarwinRootId(key, '/Users/Lib/Folder');
  assert.equal(legacy, legacyDarwinRootId(key, '/users/lib/folder'), 'the earlier id folded the case');
  assert.equal(rootIdFollows(key, '/Users/Lib/Folder', legacy, 'darwin'), true);
  assert.equal(rootIdFollows(key, '/Users/Lib/Folder', stableRootId(key, '/Users/Lib/Folder', 'darwin'), 'darwin'), true);
  assert.equal(rootIdFollows(key, '/users/lib/folder', stableRootId(key, '/Users/Lib/Folder', 'darwin'), 'darwin'), false, 'a darwin id belongs to its exact spelling');
  assert.equal(rootIdFollows(key, '/Users/Lib/Folder', legacy, 'linux'), false, 'the earlier darwin id is valid on darwin only');
  assert.notEqual(stableRootId(key, '/users/lib/folder', 'darwin'), legacyDarwinRootId(key, '/users/lib/folder'), 'the prefix keeps a new id apart from every earlier one');
});

// A simulated volume for the darwin checks. Every folder is an object with an inode, and the spelling it was created with is its name.
// A case-sensitive volume keeps names that differ only by case apart. A case-insensitive one finds a folder by any spelling; its realpath
// answers the creation spelling (canonical: true) or the spelling it was asked for (canonical: false), as the native call may do.
const VOLUME = path.resolve('/Volumes/Work');
const BOARDS = path.join(VOLUME, 'Boards');
const BOARDS_LOWER = path.join(VOLUME, 'boards');

function simulatedVolume({ caseSensitive, canonical = true }) {
  const folders = new Map();
  let nextIno = 100;
  const lookup = (value) => (caseSensitive ? value : value.toLowerCase());
  const missing = (value) => Object.assign(new Error(`no such folder: ${value}`), { code: 'ENOENT' });
  const find = (value) => {
    const folder = folders.get(lookup(value));
    if (folder === undefined) throw missing(value);
    return folder;
  };
  const stat = async (value) => ({ dev: 1, ino: find(value).ino, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false });
  return {
    isSimulated: (value) => String(value).startsWith(VOLUME),
    add(value) {
      folders.set(lookup(value), { spelling: value, ino: nextIno++ });
    },
    remove(value) {
      folders.delete(lookup(value));
    },
    async realpath(value) {
      const folder = find(value);
      return canonical ? folder.spelling : value;
    },
    stat,
    lstat: stat,
  };
}

// The bridge's file-system object: the simulated volume for its folders, the real file system for everything else (the data folder).
function volumeFs(volume) {
  return Object.assign({}, fs, {
    stat: async (value) => (volume.isSimulated(value) ? volume.stat(value) : fs.stat(value)),
    lstat: async (value) => (volume.isSimulated(value) ? volume.lstat(value) : fs.lstat(value)),
  });
}

function darwinBridge(userData, chosen, volume, extra = {}) {
  return createDeviceBridge({
    core,
    chooseDirectory: async () => chosen.value,
    userDataDirectory: userData,
    platform: 'darwin',
    fs: volumeFs(volume),
    realpath: async (value) => (volume.isSimulated(value) ? volume.realpath(value) : fs.realpath(value)),
    ...extra,
  });
}

async function rootListPath(userData) {
  return path.join(userData, 'library', 'devices', 'roots.json');
}
// The darwin roots recorded under the exact-path id live in this file (TB-030); roots.json holds the ids release 1.3.1 reads.
async function exactListPath(userData) {
  return path.join(userData, 'library', 'devices', 'roots-exact.json');
}

test('darwin: names that differ only by case are two roots on a case-sensitive volume, each with its own id', async () => {
  const userData = await makeTempDir('library-bridge-darwin-pair-');
  const volume = simulatedVolume({ caseSensitive: true });
  volume.add(BOARDS);
  volume.add(BOARDS_LOWER);
  const chosen = { value: BOARDS };
  const bridge = darwinBridge(userData, chosen, volume);
  const upper = await bridge.pickRoot();
  chosen.value = BOARDS_LOWER;
  const lower = await bridge.pickRoot();
  assert.notEqual(lower.rootId, upper.rootId, 'the second folder is not merged into the first');
  const key = await fs.readFile(path.join(userData, 'library', 'devices', 'root-key.bin'));
  assert.equal(upper.rootId, stableRootId(key, BOARDS, 'darwin'), 'a new darwin root is identified by its exact path');
  assert.equal(lower.rootId, stableRootId(key, BOARDS_LOWER, 'darwin'));
  const restarted = darwinBridge(userData, chosen, volume);
  const listed = await restarted.listRoots();
  assert.deepEqual(listed.roots.map((row) => row.rootId).sort(), [upper.rootId, lower.rootId].sort(), 'both roots survive a restart');
  assert.deepEqual(listed.roots.map((row) => row.online), [true, true]);
  chosen.value = BOARDS;
  assert.equal((await restarted.pickRoot()).rootId, upper.rootId, 'the first spelling keeps its id');
  chosen.value = BOARDS_LOWER;
  assert.equal((await restarted.pickRoot()).rootId, lower.rootId, 'the second spelling keeps its own id');
  volume.remove(BOARDS);
  const afterRemoval = new Map((await restarted.listRoots()).roots.map((row) => [row.rootId, row.online]));
  assert.equal(afterRemoval.get(upper.rootId), false, 'a missing root is offline, even though a case-only sibling exists');
  assert.equal(afterRemoval.get(lower.rootId), true);
});

test('darwin: a root list written by an earlier release loads and its folder keeps the saved id', async () => {
  const userData = await makeTempDir('library-bridge-darwin-legacy-');
  const volume = simulatedVolume({ caseSensitive: true });
  volume.add(BOARDS);
  volume.add(BOARDS_LOWER);
  const chosen = { value: BOARDS };
  const first = await darwinBridge(userData, chosen, volume).pickRoot();
  const key = await fs.readFile(path.join(userData, 'library', 'devices', 'root-key.bin'));
  const saved = legacyDarwinRootId(key, BOARDS);
  const file = await rootListPath(userData);
  // The root list as release 1.3.1 wrote it: roots.json only, with the lower-cased id (roots-exact.json did not exist then).
  await fs.rm(await exactListPath(userData), { force: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, roots: [{ rootId: saved, realPath: BOARDS, label: first.label }] }), 'utf8');
  const next = darwinBridge(userData, chosen, volume);
  const listed = await next.listRoots();
  assert.deepEqual(listed.roots.map((row) => row.rootId), [saved], 'the saved id loads');
  assert.equal(listed.roots[0].online, true);
  assert.equal((await next.pickRoot()).rootId, saved, 'the same spelling keeps the saved id');
  chosen.value = BOARDS_LOWER;
  const sibling = await next.pickRoot();
  assert.notEqual(sibling.rootId, saved, 'a case-only sibling is a second root and does not take the saved id');
  assert.equal((await next.listRoots()).total, 2);
});

test('darwin: an id that follows from another spelling is dropped from the root list', async () => {
  const userData = await makeTempDir('library-bridge-darwin-tamper-');
  const volume = simulatedVolume({ caseSensitive: true });
  volume.add(BOARDS);
  const chosen = { value: BOARDS };
  await darwinBridge(userData, chosen, volume).pickRoot();
  const key = await fs.readFile(path.join(userData, 'library', 'devices', 'root-key.bin'));
  const file = await exactListPath(userData);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.roots[0].rootId = stableRootId(key, BOARDS_LOWER, 'darwin');
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  assert.equal((await darwinBridge(userData, chosen, volume).listRoots()).total, 0, 'the id belongs to another spelling');
});

test('darwin: on a case-insensitive volume the two spellings name one folder with one id, whatever the realpath answers', async () => {
  for (const canonical of [true, false]) {
    const userData = await makeTempDir('library-bridge-darwin-insensitive-');
    const volume = simulatedVolume({ caseSensitive: false, canonical });
    volume.add(BOARDS);
    const chosen = { value: BOARDS };
    const bridge = darwinBridge(userData, chosen, volume);
    const first = await bridge.pickRoot();
    chosen.value = BOARDS_LOWER;
    assert.equal((await bridge.pickRoot()).rootId, first.rootId, `one folder, one id (realpath canonical: ${canonical})`);
    assert.equal((await darwinBridge(userData, chosen, volume).listRoots()).total, 1);
  }
});

test('darwin: a root recorded under an old spelling stays online after a case-only rename; a removed folder does not', async () => {
  const userData = await makeTempDir('library-bridge-darwin-rename-');
  const volume = simulatedVolume({ caseSensitive: false, canonical: true });
  volume.add(BOARDS);
  const chosen = { value: BOARDS };
  await darwinBridge(userData, chosen, volume).pickRoot();
  const key = await fs.readFile(path.join(userData, 'library', 'devices', 'root-key.bin'));
  const file = await rootListPath(userData);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.roots[0] = { rootId: legacyDarwinRootId(key, BOARDS_LOWER), realPath: BOARDS_LOWER, label: 'boards' };
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  const listed = await darwinBridge(userData, chosen, volume).listRoots();
  assert.equal(listed.roots[0].online, true, 'the folder is the same object under its new spelling');
  volume.remove(BOARDS);
  assert.equal((await darwinBridge(userData, chosen, volume).listRoots()).roots[0].online, false, 'a removed folder is offline');
});

test('the directory port on darwin refuses a folder that resolves to its case-only sibling; win32 folds case as before', async () => {
  const root = path.resolve('/Volumes/Work/Boards');
  const sibling = path.join(root, 'Sub');
  const fake = {
    readdir: async (directory) => (directory === root ? ['Sub', 'sub'] : []),
    lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }),
    realpath: async (value) => (value === path.join(root, 'sub') ? sibling : value),
  };
  const darwin = await createDirectoryPort({ root, platform: 'darwin', fs: fake });
  await assert.rejects(darwin.readDir(['sub']), (error) => error.code === ADAPTER_CODES.ESCAPES_ROOT);
  const linux = await createDirectoryPort({ root, platform: 'linux', fs: fake });
  await assert.rejects(linux.readDir(['sub']), (error) => error.code === ADAPTER_CODES.ESCAPES_ROOT);
  const win32 = await createDirectoryPort({ root, platform: 'win32', fs: fake });
  assert.deepEqual(await win32.readDir(['sub']), [], 'win32 keeps its case-folding check');
});

// The folder tree of a simulated darwin volume, for the directory port of a scan: the names of each folder and the size of each file.
function simulatedFolderTree(root) {
  const nodes = new Map([
    [root, { kind: 'dir', names: ['Birchfield'] }],
    [path.join(root, 'Birchfield'), { kind: 'dir', names: ['Kestrel-14-R2'] }],
    [path.join(root, 'Birchfield', 'Kestrel-14-R2'), { kind: 'dir', names: ['KESTREL 14 R2.brd'] }],
    [path.join(root, 'Birchfield', 'Kestrel-14-R2', 'KESTREL 14 R2.brd'), { kind: 'file', size: 0 }],
  ]);
  const entry = (value) => {
    const node = nodes.get(value);
    if (node === undefined) throw Object.assign(new Error('no such entry'), { code: 'ENOENT' });
    return node;
  };
  return {
    realpath: async (value) => {
      entry(value);
      return value;
    },
    lstat: async (value) => {
      const node = entry(value);
      return { isDirectory: () => node.kind === 'dir', isFile: () => node.kind === 'file', isSymbolicLink: () => false, size: node.size ?? 0 };
    },
    readdir: async (value) => {
      const node = entry(value);
      if (node.kind !== 'dir') throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return [...node.names];
    },
  };
}

test('darwin: a legacy root removed and added again gets a new id, and its old corrections are not inherited', async () => {
  const userData = await makeTempDir('library-bridge-darwin-readd-');
  const volume = simulatedVolume({ caseSensitive: true });
  volume.add(BOARDS);
  const options = { adapterFs: simulatedFolderTree(BOARDS) };
  const chosen = { value: BOARDS };
  const first = await darwinBridge(userData, chosen, volume, options).pickRoot();
  const key = await fs.readFile(path.join(userData, 'library', 'devices', 'root-key.bin'));
  // The root list as release 1.3.1 wrote it: roots.json only, with the lower-cased id (roots-exact.json did not exist then).
  const legacyId = legacyDarwinRootId(key, BOARDS);
  const rootsFile = path.join(userData, 'library', 'devices', 'roots.json');
  await fs.rm(await exactListPath(userData), { force: true });
  await fs.writeFile(rootsFile, JSON.stringify({ version: 1, roots: [{ rootId: legacyId, realPath: BOARDS, label: first.label }] }), 'utf8');

  const bridge = darwinBridge(userData, chosen, volume, options);
  assert.deepEqual((await bridge.listRoots()).roots.map((row) => row.rootId), [legacyId]);
  await bridge.scan({ rootIds: [legacyId] });
  const fileId = await findFileId(bridge, legacyId, 'KESTREL 14 R2.brd');
  assert.equal((await bridge.saveCorrections({ version: 1, platform: 'darwin', corrections: [{ op: 'role', fileId, role: 'document' }] })).status, 'saved');
  assert.equal((await bridge.scan({ rootIds: [legacyId] })).manualClassificationCount, 1, 'control: the correction applies while the legacy root is recorded');

  assert.deepEqual(await bridge.removeRoot({ rootId: legacyId }), { removed: true });
  const readded = await bridge.pickRoot();
  assert.equal(readded.rootId, stableRootId(key, BOARDS, 'darwin'), 'the re-added folder gets the id of its exact spelling');
  assert.notEqual(readded.rootId, legacyId, 'the removed legacy id is not issued again');
  assert.deepEqual((await bridge.listRoots()).roots.map((row) => row.rootId), [readded.rootId]);
  const summary = await bridge.scan({ rootIds: [readded.rootId] });
  assert.equal(summary.manualClassificationCount, 0, 'the old correction is not inherited by the re-added folder');
  assert.equal(summary.missingTargetCount, 1, 'the old correction names a file under a root that is not in this scan');

  const stored = JSON.parse(await fs.readFile(path.join(userData, 'library', 'devices', 'corrections.json'), 'utf8'));
  assert.equal(stored.corrections.length, 1, 'the correction stays in the corrections file');
  assert.equal(stored.corrections[0].file.rootId, legacyId);
});

test('a root list write that hits a transient lock is retried, not lost', async () => {
  const { root, userData } = await synthetic('rename-retry');
  let locked = false;
  const fsWithLock = Object.assign({}, fs, {
    rename: async (from, to) => {
      if (!locked && String(to).endsWith('roots.json')) {
        locked = true;
        throw Object.assign(new Error('locked by another process'), { code: 'EPERM' });
      }
      return fs.rename(from, to);
    },
  });
  const { rootId } = await bridgeFor(userData, { value: root }, { fs: fsWithLock }).pickRoot();
  assert.equal(locked, true, 'the first rename was refused');
  assert.equal((await bridgeFor(userData, { value: root }).listRoots()).roots[0].rootId, rootId, 'the root was persisted after the retry');
});

test('a cancel raised while the corrections are read stops the scan before the catalogue runs', async () => {
  const { root, userData } = await synthetic('cancel-load');
  let bridge;
  let catalogueCalled = false;
  const fsCancelling = Object.assign({}, fs, {
    open: async (file, ...rest) => {
      if (String(file).endsWith('corrections.json')) bridge.cancelScan();
      return fs.open(file, ...rest);
    },
  });
  const spy = { ...core, buildDeviceCatalogue: (input) => { catalogueCalled = true; return core.buildDeviceCatalogue(input); } };
  bridge = bridgeFor(userData, { value: root }, { fs: fsCancelling, core: spy });
  const { rootId } = await bridge.pickRoot();
  await assertCode(bridge.scan({ rootIds: [rootId] }), BRIDGE_CODES.CANCELLED);
  assert.equal(catalogueCalled, false, 'the catalogue was not started');
});

test('TB-037: a cancel releases a scan stuck reading the corrections at once, and the next scan can run', async () => {
  const { root, userData } = await synthetic('cancel-stuck');
  const hanging = Object.assign({}, fs, {
    open: async (file, ...rest) => {
      if (String(file).endsWith('corrections.json')) return new Promise(() => {}); // a read that never answers
      return fs.open(file, ...rest);
    },
  });
  const bridge = bridgeFor(userData, { value: root }, { fs: hanging, core });
  const { rootId } = await bridge.pickRoot();
  // The outcome is the error code, or 'still running' when the cancel did not release the scan within two seconds (the test never hangs).
  const outcomeOf = (promise) => Promise.race([promise.then(() => 'resolved', (error) => error.code), new Promise((resolve) => setTimeout(() => resolve('still running'), 2000))]);
  const running = bridge.scan({ rootIds: [rootId] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await bridge.cancelScan(), { cancelled: true });
  assert.equal(await outcomeOf(running), BRIDGE_CODES.CANCELLED, 'the cancel is answered without waiting for the stuck read');
  const again = bridge.scan({ rootIds: [rootId] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await bridge.cancelScan(), { cancelled: true }, 'the cancelled scan is no longer busy: the next scan runs');
  assert.equal(await outcomeOf(again), BRIDGE_CODES.CANCELLED);
});

test('removing a root drops its files from the boards and its folder ids without a rescan', async () => {
  const { root, userData } = await synthetic('forget');
  await withBoardCode(root);
  const other = await makeTempDir('library-bridge-other-');
  await withBoardCode(other);
  const chosen = { value: root };
  const bridge = bridgeFor(userData, chosen);
  const first = await bridge.pickRoot();
  chosen.value = other;
  const second = await bridge.pickRoot();
  await bridge.scan({ rootIds: [first.rootId, second.rootId] });
  const before = (await bridge.listBoards({ rootId: first.rootId })).boards[0];
  assert.equal((await bridge.boardDetail({ boardId: before.boardId })).files.filter((file) => file.rootId === second.rootId).length, 1);
  const folderOfOther = (await bridge.listFolders({ rootId: second.rootId })).folders[0].folderId;
  assert.deepEqual(await bridge.removeRoot({ rootId: second.rootId }), { removed: true });
  const after = (await bridge.listBoards({ rootId: first.rootId })).boards[0];
  const detail = await bridge.boardDetail({ boardId: after.boardId });
  assert.equal(detail.files.some((file) => file.rootId === second.rootId), false, 'no file of the removed root is counted');
  assert.equal(after.fileCount, 1, 'only the remaining root counts in the row');
  await assertCode(bridge.scan({ rootIds: [first.rootId], skipFolders: [folderOfOther] }), BRIDGE_CODES.UNKNOWN_FOLDER);
});

test('an injected board anchor source supplies the board metadata of a board; an invalid source is refused', async () => {
  const { root, userData } = await synthetic('anchor-port');
  await withBoardCode(root);
  const source = {
    anchorsFor: async ({ derived }) => derived,
    describe: async (anchorId) => (anchorId.startsWith('board:') ? { boardCode: 'DB-MB-Q731', revision: 'DB-REV' } : undefined),
  };
  const bridge = bridgeFor(userData, { value: root }, { anchorSource: source });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const { boards } = await bridge.listBoards({ rootId });
  assert.equal(boards.length, 1);
  const detail = await bridge.boardDetail({ boardId: boards[0].boardId });
  assert.equal(detail.boardCode, 'DB-MB-Q731', 'the source describes the board');
  assert.equal(detail.revision, 'DB-REV');
  assert.throws(() => bridgeFor(userData, { value: root }, { anchorSource: { anchorsFor: 1 } }), (error) => error.code === BRIDGE_CODES.INVALID_REQUEST);
});

test('the Library board store is the bridge board source: rows carry the code and revision of their board, and the record survives a restart', async () => {
  const { root, userData } = await synthetic('board-store');
  await withBoardCode(root);
  const { createBoardStore } = require('../electron/library/board-store.cjs');
  const chosen = { value: root };
  const bridge = bridgeFor(userData, chosen, { anchorSource: createBoardStore({ userDataDirectory: userData }) });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const { boards } = await bridge.listBoards({ rootId });
  const row = boards.find((board) => board.boardCode === 'MB-Q731');
  assert.ok(row, 'the board of the Board folder is listed with its code');
  assert.equal(row.revision, '2', 'and its revision');
  const restarted = bridgeFor(userData, chosen, { anchorSource: createBoardStore({ userDataDirectory: userData }) });
  assert.equal((await restarted.pickRoot()).rootId, rootId, 'the root keeps its id across the restart');
  await restarted.scan({ rootIds: [rootId] });
  const again = (await restarted.listBoards({ rootId })).boards.find((board) => board.boardCode === 'MB-Q731');
  assert.equal(again.revision, '2');
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'library', 'devices', 'boards.json'), 'utf8'));
  assert.ok(saved.boards.some((entry) => entry.boardCode === 'MB-Q731' && entry.revision === '2'), 'the board is recorded under userData');
});

test('a step switched off during a running scan is reported skipped, and the scan is incomplete', async () => {
  const { root, userData } = await synthetic('skip-step');
  await withBoardCode(root);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gated = { ...core, buildDeviceCatalogue: async (input) => { await gate; return core.buildDeviceCatalogue(input); } };
  const bridge = bridgeFor(userData, { value: root }, { core: gated });
  const { rootId } = await bridge.pickRoot();
  const scanId = '6f1d2c3a-4b5e-4f70-8a9b-0c1d2e3f4a5b';
  const running = bridge.scan({ rootIds: [rootId], scanId });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await bridge.skipScanStep({ scanId, step: 'matching' }), { scanId, step: 'matching', accepted: true, complete: false });
  await assertCode(bridge.skipScanStep({ scanId: UNKNOWN_ID, step: 'matching' }), BRIDGE_CODES.NO_SCAN);
  await assertCode(bridge.skipScanStep({ scanId, step: 'bogus' }), BRIDGE_CODES.INVALID_REQUEST);
  release();
  const summary = await running;
  assert.equal(summary.scanId, scanId, 'the scan keeps the id it was started with');
  assert.equal(summary.steps.matching, 'skipped');
  assert.deepEqual(summary.skippedByRequest, ['matching']);
  assert.equal(summary.complete, false);
  await assertCode(bridge.skipScanStep({ scanId, step: 'matching' }), BRIDGE_CODES.NO_SCAN);
});

test('a file id is saved and loaded back: the store keeps root and path, the answers carry only ids', async () => {
  const { root, userData } = await synthetic('file-id');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const fileId = await findFileId(bridge, rootId, 'KESTREL 14 R2.brd');
  assert.equal((await bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [{ op: 'unlink', fileId, boardAnchorId: 'anchor-1' }] })).status, 'saved');
  const stored = await fs.readFile(path.join(userData, 'library', 'devices', 'corrections.json'), 'utf8');
  assert.equal(stored.includes(rootId), true, 'the store keeps the root id');
  assert.equal(stored.includes('KESTREL 14 R2.brd'), true, 'the store keeps the relative path');
  assert.equal(stored.includes('"anchorId"'), true, 'the store keeps its own format');
  const loaded = await bridge.loadCorrections();
  assert.deepEqual(loaded.document.corrections, [{ op: 'unlink', fileId, boardAnchorId: 'anchor-1' }]);
  const answer = JSON.stringify(loaded);
  assert.equal(answer.includes(root), false, 'no absolute path in the answer');
  assert.equal(answer.includes('KESTREL'), false, 'no relative path in the answer');
  assert.equal(answer.includes(rootId), false, 'no root id in the answer');
});

test('an unknown, malformed or stale file id is refused with a closed code, and nothing is written', async () => {
  const { root, userData } = await synthetic('unknown-file');
  const bridge = bridgeFor(userData, { value: root });
  const { rootId } = await bridge.pickRoot();
  await bridge.scan({ rootIds: [rootId] });
  const fileId = await findFileId(bridge, rootId, 'KESTREL 14 R2.brd');
  const request = (id) => ({ version: 1, platform: process.platform, corrections: [{ op: 'unlink', fileId: id, boardAnchorId: 'anchor-1' }] });
  await assertCode(bridge.saveCorrections(request(UNKNOWN_ID)), BRIDGE_CODES.UNKNOWN_FILE);
  await assertCode(bridge.saveCorrections(request('not-an-id')), BRIDGE_CODES.INVALID_REQUEST);
  await assertCode(bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [{ op: 'unlink', file: { rootId, path: 'x' }, anchorId: 'anchor-1' }] }), BRIDGE_CODES.INVALID_REQUEST);
  await assertCode(bridge.saveCorrections({ version: 1, platform: process.platform, corrections: [{ op: 'unlink', fileId, boardAnchorId: 42 }] }), BRIDGE_CODES.INVALID_REQUEST);
  await assert.rejects(fs.stat(path.join(userData, 'library', 'devices', 'corrections.json')), (error) => error.code === 'ENOENT', 'nothing was written');
  assert.equal((await bridge.saveCorrections(request(fileId))).status, 'saved');
  assert.deepEqual(await bridge.removeRoot({ rootId }), { removed: true });
  await assertCode(bridge.saveCorrections(request(fileId)), BRIDGE_CODES.UNKNOWN_FILE);
});

test('the bridge codes are stable LIBRARY_ strings', () => {
  for (const code of Object.values(BRIDGE_CODES)) assert.match(code, /^LIBRARY_[A-Z_]+$/);
});
