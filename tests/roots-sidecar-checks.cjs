'use strict';

// TB-030 (REL-12): on darwin, a library root recorded by this release lives in roots-exact.json. The earlier release (1.3.1) accepts
// only the lower-cased darwin id in roots.json and rewrites that file without any other entry, so a root recorded in roots.json with
// the exact-path id would be lost on a downgrade. The sidecar is written first and roots.json only keeps the ids that the earlier release
// reads, so a downgrade cannot drop a root, and this release lists the sidecar again after an upgrade.
// Covered: where each id is written, the downgrade round trip, the move of a roots.json written with exact ids, a legacy id that stays in
// roots.json, a removal, win32 and linux keep the single file, a damaged sidecar is set aside with its bytes, and a failed sidecar write
// leaves roots.json as it was. Temporary folders only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDeviceBridge, stableRootId, legacyDarwinRootId, BRIDGE_CODES } = require('../electron/library/devices-bridge.cjs');
const core = require('../electron/library/devices-core.cjs');
const { DIRECTORY_SEGMENTS } = require('../electron/library/corrections-store.cjs');

const tempDir = async (name) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `roots-sidecar-${name}-`)));
const folder = async (name) => {
  const dir = path.join(await tempDir('chosen'), name);
  await fs.mkdir(dir);
  return fs.realpath(dir);
};
function layout(userData) {
  const directory = path.join(userData, ...DIRECTORY_SEGMENTS);
  return { directory, roots: path.join(directory, 'roots.json'), exact: path.join(directory, 'roots-exact.json'), key: path.join(directory, 'root-key.bin') };
}
const readRoots = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')).roots;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};
const writeRoots = async (file, roots) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, roots }));
};
const idsOf = (roots) => roots.map((entry) => entry.rootId).sort();
const keyOf = async (userData) => fs.readFile(layout(userData).key);
const bridgeFor = (userData, chosen, platform, fsOverride) => createDeviceBridge({
  core,
  chooseDirectory: async () => chosen,
  userDataDirectory: userData,
  platform,
  ...(fsOverride ? { fs: fsOverride } : {}),
});

test('darwin: a root recorded by this release is kept in roots-exact.json, and roots.json keeps only the ids the earlier release reads', async () => {
  const userData = await tempDir('userdata');
  const chosen = await folder('Library A');
  const { rootId } = await bridgeFor(userData, chosen, 'darwin').pickRoot();
  const files = layout(userData);
  assert.equal(rootId, stableRootId(await keyOf(userData), chosen, 'darwin'), 'the id of this release is the exact-path id');
  assert.deepEqual(idsOf(await readRoots(files.exact)), [rootId]);
  assert.deepEqual(await readRoots(files.roots), []);
});

test('a downgrade keeps the exact roots: the earlier release rewrites roots.json with its own ids, and this release lists every root again', async () => {
  const userData = await tempDir('userdata');
  const a = await folder('Exact A');
  const b = await folder('Legacy B');
  const { rootId: exact } = await bridgeFor(userData, a, 'darwin').pickRoot();
  const files = layout(userData);
  const legacy = legacyDarwinRootId(await keyOf(userData), b);
  await writeRoots(files.roots, [{ rootId: legacy, realPath: b, label: 'Legacy B' }]); // what the earlier release leaves in roots.json
  const { roots: rows } = await bridgeFor(userData, a, 'darwin').listRoots();
  assert.deepEqual(rows.map((row) => row.rootId).sort(), [exact, legacy].sort());
  assert.deepEqual(idsOf(await readRoots(files.exact)), [exact], 'the downgrade never touched the sidecar');
});

test('a roots.json written with exact ids by the previous release moves to roots-exact.json at the next change', async () => {
  const userData = await tempDir('userdata');
  const key = await folder('Key only');
  const old = await folder('Old');
  const next = await folder('Next');
  await bridgeFor(userData, key, 'linux').pickRoot(); // creates the root key of this install
  const files = layout(userData);
  const oldExact = stableRootId(await keyOf(userData), old, 'darwin');
  await fs.rm(files.roots, { force: true });
  await writeRoots(files.roots, [{ rootId: oldExact, realPath: old, label: 'Old' }]);
  const { rootId: nextId } = await bridgeFor(userData, next, 'darwin').pickRoot();
  assert.deepEqual(idsOf(await readRoots(files.exact)), [oldExact, nextId].sort());
  assert.deepEqual(await readRoots(files.roots), []);
});

test('a legacy darwin id stays in roots.json, which the earlier release reads; a new darwin root goes to roots-exact.json', async () => {
  const userData = await tempDir('userdata');
  const key = await folder('Key only');
  const legacyFolder = await folder('Legacy');
  const next = await folder('Next');
  await bridgeFor(userData, key, 'linux').pickRoot();
  const files = layout(userData);
  const legacy = legacyDarwinRootId(await keyOf(userData), legacyFolder);
  await fs.rm(files.roots, { force: true });
  await writeRoots(files.roots, [{ rootId: legacy, realPath: legacyFolder, label: 'Legacy' }]);
  const { rootId: nextId } = await bridgeFor(userData, next, 'darwin').pickRoot();
  assert.deepEqual(idsOf(await readRoots(files.roots)), [legacy]);
  assert.deepEqual(idsOf(await readRoots(files.exact)), [nextId]);
});

test('removing an exact root rewrites roots-exact.json without it', async () => {
  const userData = await tempDir('userdata');
  const a = await folder('Remove A');
  const b = await folder('Keep B');
  let chosen = a;
  const bridge = createDeviceBridge({ core, chooseDirectory: async () => chosen, userDataDirectory: userData, platform: 'darwin' });
  const { rootId: removed } = await bridge.pickRoot();
  chosen = b;
  const { rootId: kept } = await bridge.pickRoot(); // one instance, as in the app, records both roots
  await bridge.removeRoot({ rootId: removed });
  const files = layout(userData);
  assert.deepEqual(idsOf(await readRoots(files.exact)), [kept]);
  assert.deepEqual(await readRoots(files.roots), []);
});

test('win32 and linux keep the single roots.json: no roots-exact.json is written', async () => {
  for (const platform of ['win32', 'linux']) {
    const userData = await tempDir(platform);
    const chosen = await folder(`Library ${platform}`);
    const { rootId } = await bridgeFor(userData, chosen, platform).pickRoot();
    const files = layout(userData);
    assert.deepEqual(idsOf(await readRoots(files.roots)), [rootId], platform);
    await assert.rejects(fs.access(files.exact), { code: 'ENOENT' }, platform);
  }
});

test('a damaged roots-exact.json is set aside with its bytes, and the roots of roots.json still load', async () => {
  const userData = await tempDir('userdata');
  const a = await folder('Exact A');
  const b = await folder('Legacy B');
  await bridgeFor(userData, a, 'darwin').pickRoot();
  const files = layout(userData);
  const legacy = legacyDarwinRootId(await keyOf(userData), b);
  await writeRoots(files.roots, [{ rootId: legacy, realPath: b, label: 'Legacy B' }]);
  await fs.writeFile(files.exact, 'not json');
  const { roots: rows } = await bridgeFor(userData, a, 'darwin').listRoots();
  assert.deepEqual(rows.map((row) => row.rootId), [legacy]);
  const names = await fs.readdir(files.directory);
  assert.ok(names.some((name) => /^roots-exact\.damaged-.*\.json$/.test(name)), 'the damaged file is kept aside, not deleted');
  await assert.rejects(fs.access(files.exact), { code: 'ENOENT' });
});

test('a failed write of roots-exact.json leaves roots.json as it was, and the failed root is not recorded', async () => {
  const userData = await tempDir('userdata');
  const b = await folder('Legacy B');
  const a = await folder('Exact A');
  await bridgeFor(userData, b, 'linux').pickRoot(); // creates the root key
  const files = layout(userData);
  const legacy = legacyDarwinRootId(await keyOf(userData), b);
  await fs.rm(files.roots, { force: true });
  await writeRoots(files.roots, [{ rootId: legacy, realPath: b, label: 'Legacy B' }]);
  const before = await fs.readFile(files.roots, 'utf8');
  const failing = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(to) === 'roots-exact.json') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.rename(from, to);
    },
  };
  await assert.rejects(bridgeFor(userData, a, 'darwin', failing).pickRoot(), { code: BRIDGE_CODES.ROOTS_UNAVAILABLE });
  assert.equal(await fs.readFile(files.roots, 'utf8'), before, 'roots.json is written only after the sidecar succeeded');
  assert.deepEqual(idsOf((await bridgeFor(userData, a, 'darwin').listRoots()).roots), [legacy]);
});

test('roots-exact.json belongs to darwin: win32 and linux never write it, so its bytes stay as they were', async () => {
  for (const platform of ['win32', 'linux']) {
    const userData = await tempDir(platform);
    const darwinFolder = await folder(`Darwin for ${platform}`);
    await bridgeFor(userData, darwinFolder, 'darwin').pickRoot();
    const files = layout(userData);
    const before = await fs.readFile(files.exact, 'utf8');
    await bridgeFor(userData, await folder(`Other for ${platform}`), platform).pickRoot();
    assert.equal(await fs.readFile(files.exact, 'utf8'), before, platform);
  }
});
