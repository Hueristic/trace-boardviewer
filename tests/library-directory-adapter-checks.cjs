'use strict';

// Native tests for electron/library/directory-adapter.cjs: a synthetic library tree on disk (created and removed by this
// file under the canonical temp root), a link that points outside the root, and an outside folder that must never be listed.
// Covered: classification by lstat, links never followed, root-bound checks before and after each listing, a folder or the
// root swapped for a link during its own listing, folder read errors (whole folder refused), a single entry whose lstat
// fails (kind 'unknown', siblings kept), segment validation, and that only readdir, lstat and realpath are ever touched.
// Links are created as junctions on win32 (no privilege needed) and as directory symlinks elsewhere; when the platform
// refuses link creation the link-dependent checks are skipped with the reason printed, not reported as passed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { createDirectoryPort, ADAPTER_CODES, MAX_SEGMENTS } = require('../electron/library/directory-adapter.cjs');
const { makeTempDir, isInsideTemp } = require('./canonical-temp.cjs');

const realFs = Object.freeze({ readdir: fs.readdir, lstat: fs.lstat, realpath: promisify(fsSync.realpath.native) });
const ALLOWED_FS_MEMBERS = new Set(['readdir', 'lstat', 'realpath']);

// Creates a directory link (junction on win32). Returns null on success or the error code when the platform refuses.
async function tryLink(target, link) {
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return null;
  } catch (error) {
    return error.code ?? 'UNKNOWN';
  }
}

// The outside folder of each synthetic library, removed together with that library.
const outsideFolders = new Map();

async function buildLibrary() {
  const root = await makeTempDir('dir-adapter-root-');
  const outside = await makeTempDir('dir-adapter-outside-');
  outsideFolders.set(root, outside);
  for (const folder of ['Birchfield/Kestrel-14-R2/board', 'Birchfield/Kestrel-14-R2/docs', 'Birchfield/Alder', 'Empty']) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'loose.txt'), 'x'.repeat(10));
  await fs.writeFile(path.join(root, 'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd'), Buffer.alloc(2048, 1));
  await fs.writeFile(path.join(root, 'Birchfield/Kestrel-14-R2/docs/Kestrel14_R02_schematic.pdf'), Buffer.alloc(4096, 2));
  await fs.writeFile(path.join(root, 'Birchfield/Alder/MB-Q731_rev2_BIOS.bin'), Buffer.alloc(1024, 3));
  await fs.writeFile(path.join(outside, 'secret.brd'), 'outside the root');
  return { root, outside };
}

async function removeTree(directory) {
  // Only paths strictly inside the canonical temp root may be removed. The library is removed first; the outside folder
  // is a separate temp folder that the library's link points at, removed afterwards.
  const outside = outsideFolders.get(directory);
  if (await isInsideTemp(directory)) await fs.rm(directory, { recursive: true, force: true });
  if (outside && await isInsideTemp(outside)) await fs.rm(outside, { recursive: true, force: true });
  outsideFolders.delete(directory);
}

// Breadth-first walk through the port, the same way the device folder map walks it. Errors are collected, not thrown.
async function walk(port) {
  const files = [];
  const links = [];
  const unknown = [];
  const errors = [];
  const queue = [[]];
  while (queue.length > 0) {
    const segments = queue.shift();
    let entries;
    try {
      entries = await port.readDir(segments);
    } catch (error) {
      errors.push({ at: segments.join('/'), code: error.code });
      continue;
    }
    for (const entry of entries) {
      const child = [...segments, entry.name];
      if (entry.kind === 'dir') queue.push(child);
      else if (entry.kind === 'file') files.push({ path: child.join('/'), size: entry.size });
      else if (entry.kind === 'link') links.push(child.join('/'));
      else if (entry.kind === 'unknown') unknown.push(child.join('/'));
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, links: links.sort(), unknown: unknown.sort(), errors };
}

// Everything the walk could change: names, kinds, sizes, times and content of files. Links are recorded, never followed.
async function snapshot(directory, relative = []) {
  const out = [];
  const entries = (await fs.readdir(path.join(directory, ...relative), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const segments = [...relative, entry.name];
    const stat = await fs.lstat(path.join(directory, ...segments));
    const record = { path: segments.join('/'), size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) {
      out.push({ ...record, kind: 'link' });
    } else if (stat.isDirectory()) {
      out.push({ ...record, kind: 'dir' }, ...(await snapshot(directory, segments)));
    } else {
      const bytes = await fs.readFile(path.join(directory, ...segments));
      out.push({ ...record, kind: 'file', sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return out;
}

test('classifies entries by lstat and lists each folder once with sizes', async () => {
  const { root, outside } = await buildLibrary();
  try {
    const port = await createDirectoryPort({ root, platform: process.platform, fs: realFs });
    // Listing order is the file system's; the walker sorts it, so the comparison is done on sorted names.
    const top = (await port.readDir([])).sort((a, b) => (a.name < b.name ? -1 : 1));
    assert.deepEqual(top.map(entry => [entry.name, entry.kind]), [['Birchfield', 'dir'], ['Empty', 'dir'], ['loose.txt', 'file']]);
    assert.equal(top.find(entry => entry.name === 'loose.txt').size, 10);

    const result = await walk(port);
    assert.deepEqual(result.files, [
      { path: 'Birchfield/Alder/MB-Q731_rev2_BIOS.bin', size: 1024 },
      { path: 'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', size: 2048 },
      { path: 'Birchfield/Kestrel-14-R2/docs/Kestrel14_R02_schematic.pdf', size: 4096 },
      { path: 'loose.txt', size: 10 },
    ]);
    assert.deepEqual(result.errors, []);
    assert.ok(!JSON.stringify(result).includes('secret.brd'), 'the outside folder must never be listed');
  } finally {
    await removeTree(root);
  }
});

test('a junction or symbolic link is reported as a link and its target is never listed', async (t) => {
  const { root, outside } = await buildLibrary();
  try {
    const refused = await tryLink(outside, path.join(root, 'Link'));
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    const port = await createDirectoryPort({ root, platform: process.platform, fs: realFs });
    const top = await port.readDir([]);
    assert.equal(top.find(entry => entry.name === 'Link').kind, 'link');
    await assert.rejects(port.readDir(['Link']), { code: ADAPTER_CODES.LINK });
    await assert.rejects(port.readDir(['Link', 'deeper']), { code: ADAPTER_CODES.LINK });
    const result = await walk(port);
    assert.deepEqual(result.links, ['Link']);
    assert.deepEqual(result.errors, []);
    assert.ok(!JSON.stringify(result).includes('secret.brd'));
  } finally {
    await removeTree(root);
  }
});

test('a link inside the root is refused even when its target stays inside the root', async (t) => {
  const { root } = await buildLibrary();
  try {
    const refused = await tryLink(path.join(root, 'Birchfield'), path.join(root, 'Alias'));
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    const port = await createDirectoryPort({ root, platform: process.platform, fs: realFs });
    await assert.rejects(port.readDir(['Alias']), { code: ADAPTER_CODES.LINK });
    await assert.rejects(port.readDir(['Alias', 'Kestrel-14-R2']), { code: ADAPTER_CODES.LINK });
    // The real folder is still listed through its real path.
    assert.ok((await port.readDir(['Birchfield'])).some(entry => entry.name === 'Alder'));
  } finally {
    await removeTree(root);
  }
});

test('a folder verified by an earlier listing and then replaced by a junction to the outside is refused as a link', async (t) => {
  const { root, outside } = await buildLibrary();
  try {
    const port = await createDirectoryPort({ root, platform: process.platform, fs: realFs });
    assert.ok((await port.readDir(['Birchfield'])).length > 0, 'the folder is verified first');
    // Replace the verified folder with a link to the outside folder (rename inside our own synthetic tree).
    await fs.rename(path.join(root, 'Birchfield'), path.join(root, 'Birchfield.moved'));
    const refused = await tryLink(outside, path.join(root, 'Birchfield'));
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    // No ancestor is cached any more, so the link is seen by lstat before anything is listed.
    await assert.rejects(port.readDir(['Birchfield']), { code: ADAPTER_CODES.LINK });
    await assert.rejects(port.readDir(['Birchfield', 'Alder']), { code: ADAPTER_CODES.LINK });
  } finally {
    if (await isLinkPath(path.join(root, 'Birchfield'))) await removeLink(path.join(root, 'Birchfield'));
    await removeTree(root);
  }
});

test('a verified folder replaced by a real junction to the same folder under another name is refused as a link', async (t) => {
  const { root } = await buildLibrary();
  try {
    const port = await createDirectoryPort({ root, platform: process.platform, fs: realFs });
    assert.ok((await port.readDir(['Birchfield', 'Alder'])).length > 0, 'the chain is verified first');
    // The real folder moves to another name; a junction takes its old name and points at it. realpath of the listing then
    // resolves to the moved name, so only the lstat of the ancestor can refuse it.
    await fs.rename(path.join(root, 'Birchfield'), path.join(root, 'Birchfield.moved'));
    const refused = await tryLink(path.join(root, 'Birchfield.moved'), path.join(root, 'Birchfield'));
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    await assert.rejects(port.readDir(['Birchfield', 'Alder']), { code: ADAPTER_CODES.LINK });
    await removeLink(path.join(root, 'Birchfield'));
    await fs.rename(path.join(root, 'Birchfield.moved'), path.join(root, 'Birchfield'));
  } finally {
    if (await isLinkPath(path.join(root, 'Birchfield'))) await removeLink(path.join(root, 'Birchfield'));
    await removeTree(root);
  }
});

test('ancestor swap with an injected fs: a verified folder that now reports as a link is refused even when realpath is unchanged', async () => {
  const { root } = await buildLibrary();
  try {
    const birchfield = path.join(root, 'Birchfield');
    // Simulates a swap that realpath does not expose: after it, lstat reports the ancestor as a link, while realpath still resolves the listed
    // folder to the expected place inside the root. Only the per-listing lstat chain can refuse it.
    let swapped = false;
    let alderReads = 0;
    const fake = {
      ...realFs,
      lstat: (target) => {
        if (swapped && target === birchfield) return Promise.resolve({ isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, size: 0 });
        return realFs.lstat(target);
      },
      readdir: (target, options) => {
        if (target === path.join(birchfield, 'Alder')) alderReads++;
        return realFs.readdir(target, options);
      },
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    assert.ok((await port.readDir(['Birchfield', 'Alder'])).length > 0, 'the folder is listed before the swap');
    swapped = true;
    await assert.rejects(port.readDir(['Birchfield', 'Alder']), { code: ADAPTER_CODES.LINK });
    assert.equal(alderReads, 1, 'the refused folder is not read after the swap');
  } finally {
    await removeTree(root);
  }
});

test('a folder swapped for a link while its own listing runs is refused with no entries, and its parent is re-checked', async (t) => {
  const { root, outside } = await buildLibrary();
  const kestrel = path.join(root, 'Birchfield', 'Kestrel-14-R2');
  const moved = `${kestrel}.moved`;
  try {
    const probe = path.join(outside, 'probe-link');
    const refused = await tryLink(outside, probe);
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    await removeLink(probe);
    let swapped = false;
    const swapping = { ...realFs, readdir: async (target, options) => {
      if (target === kestrel && !swapped) {
        swapped = true;
        await fs.rename(kestrel, moved);
        await fs.symlink(outside, kestrel, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return realFs.readdir(target, options);
    } };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: swapping });
    await assert.rejects(port.readDir(['Birchfield', 'Kestrel-14-R2']), { code: ADAPTER_CODES.ESCAPES_ROOT });
    assert.equal(swapped, true, 'the folder was replaced while its listing ran');
    // The next listing of the same folder sees the link in its own chain.
    await assert.rejects(port.readDir(['Birchfield', 'Kestrel-14-R2']), { code: ADAPTER_CODES.LINK });
  } finally {
    if (await isLinkPath(kestrel)) await removeLink(kestrel);
    if (await isInsideTemp(moved)) await fs.rm(moved, { recursive: true, force: true });
    await removeTree(root);
  }
});

test('every listing re-checks the whole chain: lstat and realpath calls per listing are counted, nothing is cached', async () => {
  const { root } = await buildLibrary();
  try {
    const counts = { lstat: 0, readdir: 0, realpath: 0 };
    const counting = {
      readdir: (...args) => { counts.readdir++; return realFs.readdir(...args); },
      lstat: (...args) => { counts.lstat++; return realFs.lstat(...args); },
      realpath: (...args) => { counts.realpath++; return realFs.realpath(...args); },
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: counting });
    const reset = () => { counts.lstat = 0; counts.readdir = 0; counts.realpath = 0; };
    const snapshotCounts = () => ({ ...counts });
    // Folder with depth 3 (root, Birchfield, Kestrel-14-R2, board) and one entry: chain 4 + entry 1 = 5 lstat; 2 realpath; 1 readdir.
    reset();
    await port.readDir(['Birchfield', 'Kestrel-14-R2', 'board']);
    assert.deepEqual(snapshotCounts(), { lstat: 5, readdir: 1, realpath: 2 });
    // The same folder again: the chain is walked again (no cached ancestor), so the count is identical.
    reset();
    await port.readDir(['Birchfield', 'Kestrel-14-R2', 'board']);
    assert.deepEqual(snapshotCounts(), { lstat: 5, readdir: 1, realpath: 2 });
  } finally {
    await removeTree(root);
  }
});

test('a folder whose realpath leaves the root is refused before any entry is returned', async () => {
  const { root, outside } = await buildLibrary();
  try {
    let resolvedCalls = 0;
    let listedCalls = 0;
    const fake = {
      ...realFs,
      realpath: async (target) => {
        if (target === path.join(root, 'Birchfield')) { resolvedCalls++; return outside; }
        return realFs.realpath(target);
      },
      readdir: (target, options) => {
        if (target === path.join(root, 'Birchfield')) listedCalls++;
        return realFs.readdir(target, options);
      },
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    await assert.rejects(port.readDir(['Birchfield']), { code: ADAPTER_CODES.ESCAPES_ROOT });
    assert.equal(resolvedCalls, 1);
    assert.equal(listedCalls, 0, 'a folder that resolves outside the root is never read');
  } finally {
    await removeTree(root);
  }
});

test('an unreadable folder is refused as a whole, and an unreadable entry is kept as unknown beside its readable siblings', async () => {
  const { root } = await buildLibrary();
  try {
    const deniedListing = { ...realFs, readdir: async (target, options) => {
      if (target === path.join(root, 'Birchfield', 'Alder')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return realFs.readdir(target, options);
    } };
    const port1 = await createDirectoryPort({ root, platform: process.platform, fs: deniedListing });
    await assert.rejects(port1.readDir(['Birchfield', 'Alder']), { code: 'EACCES' });
    const result = await walk(port1);
    assert.deepEqual(result.errors, [{ at: 'Birchfield/Alder', code: 'EACCES' }]);
    assert.equal(result.files.length, 3, 'the readable folders are still walked');

    // One entry of the root cannot be classified: only that entry is 'unknown'; its folder's other entries are kept.
    const deniedEntry = { ...realFs, lstat: async (target) => {
      if (target === path.join(root, 'loose.txt')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return realFs.lstat(target);
    } };
    const port2 = await createDirectoryPort({ root, platform: process.platform, fs: deniedEntry });
    const top = (await port2.readDir([])).sort((a, b) => (a.name < b.name ? -1 : 1));
    assert.deepEqual(top.map(entry => [entry.name, entry.kind]), [['Birchfield', 'dir'], ['Empty', 'dir'], ['loose.txt', 'unknown']]);
    assert.equal(top.find(entry => entry.name === 'loose.txt').size, undefined, 'an unknown entry carries no size');
    assert.equal(top.find(entry => entry.name === 'loose.txt').code, 'EPERM', 'an unknown entry carries the lstat error code');
    const walked = await walk(port2);
    assert.deepEqual(walked.unknown, ['loose.txt']);
    assert.deepEqual(walked.errors, [], 'the folder itself is still read');
    assert.equal(walked.files.length, 3, 'the siblings of the unknown entry are walked');
    assert.ok(walked.files.some(file => file.path === 'Birchfield/Alder/MB-Q731_rev2_BIOS.bin'));
    assert.ok(!walked.files.some(file => file.path === 'loose.txt'), 'an unknown entry is never reported as a file');
  } finally {
    await removeTree(root);
  }
});

// True when the path itself is a link (lstat, never followed).
async function isLinkPath(candidate) {
  try {
    return (await fs.lstat(candidate)).isSymbolicLink();
  } catch {
    return false;
  }
}

// Removes a link itself, never its target: rmdir for a junction on win32, unlink for a symbolic link elsewhere.
async function removeLink(candidate) {
  if (process.platform === 'win32') await fs.rmdir(candidate);
  else await fs.unlink(candidate);
}

test('Windows: Node reports a junction through lstat as a symbolic link, not a directory (checked natively on NTFS)', async (t) => {
  if (process.platform !== 'win32') { t.skip('junction behaviour is checked on win32 only'); return; }
  const { root, outside } = await buildLibrary();
  try {
    const refused = await tryLink(outside, path.join(root, 'Probe'));
    if (refused) { t.skip(`junction creation refused by the platform (${refused})`); return; }
    const stat = await fs.lstat(path.join(root, 'Probe'));
    // The adapter relies on these facts: a junction must not be taken for a directory, and must be refused as a link.
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(stat.isDirectory(), false);
    const port = await createDirectoryPort({ root, platform: process.platform, fs: realFs });
    await assert.rejects(port.readDir(['Probe']), { code: ADAPTER_CODES.LINK });
  } finally {
    if (await isLinkPath(path.join(root, 'Probe'))) await removeLink(path.join(root, 'Probe'));
    await removeTree(root);
  }
});

test('the realpath check is the last fs call before readdir (call order, no lstat in between)', async () => {
  const { root } = await buildLibrary();
  try {
    const calls = [];
    const logged = {
      readdir: (...a) => { calls.push('readdir'); return realFs.readdir(...a); },
      lstat: (...a) => { calls.push('lstat'); return realFs.lstat(...a); },
      realpath: (...a) => { calls.push('realpath'); return realFs.realpath(...a); },
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: logged });
    calls.length = 0;
    await port.readDir(['Birchfield', 'Alder']);
    const first = calls.indexOf('readdir');
    assert.equal(calls[first - 1], 'realpath', 'the folder realpath is checked right before its listing');
    assert.deepEqual(calls.slice(0, first).filter(call => call === 'realpath').length, 1);
  } finally {
    await removeTree(root);
  }
});

test('an lstat error code outside the closed set is reported as UNKNOWN, and its siblings are still listed', async () => {
  const { root } = await buildLibrary();
  try {
    const odd = path.join(root, 'loose.txt');
    const fake = { ...realFs, lstat: (target) => (target === odd
      ? Promise.reject(Object.assign(new Error('C:\private\denied'), { code: 'XYZ_CUSTOM' }))
      : realFs.lstat(target)) };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    const top = (await port.readDir([])).sort((a, b) => (a.name < b.name ? -1 : 1));
    assert.deepEqual(top.map(entry => [entry.name, entry.kind, entry.code]), [['Birchfield', 'dir', undefined], ['Empty', 'dir', undefined], ['loose.txt', 'unknown', 'UNKNOWN']]);
    assert.ok(!JSON.stringify(top).includes('private'), 'no message is kept');
  } finally {
    await removeTree(root);
  }
});

test('the root swapped for a link while its own listing runs is refused and no entries are returned', async (t) => {
  const { root, outside } = await buildLibrary();
  const moved = `${root}.moved`;
  try {
    const probe = path.join(outside, 'probe-link');
    const refused = await tryLink(outside, probe);
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    await removeLink(probe);

    let swapped = false;
    // The swap happens inside the root's own readdir, after the root was verified and before the listing is checked again.
    const swapping = { ...realFs, readdir: async (target, options) => {
      if (target === root && !swapped) {
        swapped = true;
        await fs.rename(root, moved);
        await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return realFs.readdir(target, options);
    } };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: swapping });
    await assert.rejects(port.readDir([]), { code: ADAPTER_CODES.ESCAPES_ROOT });
    assert.equal(swapped, true, 'the root was replaced while its listing ran');
    // A later listing is refused before any directory is read: the root itself is now a link, and every listing lstat-s it.
    await assert.rejects(port.readDir([]), { code: ADAPTER_CODES.LINK });
  } finally {
    // The root path may now be a junction to the outside folder: remove only the link, then the moved tree and the outside folder.
    if (await isLinkPath(root)) await removeLink(root);
    if (await isInsideTemp(moved)) await fs.rm(moved, { recursive: true, force: true });
    await removeTree(root);
  }
});

test('segments that could leave the root or name a stream are refused before any file system call', async () => {
  const { root } = await buildLibrary();
  try {
    let touched = 0;
    const counting = { readdir: (...a) => { touched++; return realFs.readdir(...a); }, lstat: (...a) => { touched++; return realFs.lstat(...a); }, realpath: (...a) => { touched++; return realFs.realpath(...a); } };
    // Set up the port with the real fs (root resolution), then count only what readDir touches.
    const port = await createDirectoryPort({ root, platform: 'win32', fs: counting });
    touched = 0;
    const bad = [
      ['..'], ['.'], [''], ['a/b'], ['a\\b'], ['C:'], ['x:stream'], [42], ['Birchfield', '..', '..'], ['a\u0000b'],
      Array.from({ length: MAX_SEGMENTS + 1 }, () => 'a'),
    ];
    for (const segments of bad) {
      await assert.rejects(port.readDir(segments), { code: ADAPTER_CODES.INVALID_SEGMENT }, JSON.stringify(segments).slice(0, 60));
    }
    await assert.rejects(port.readDir('Birchfield'), { code: ADAPTER_CODES.INVALID_SEGMENT });
    assert.equal(touched, 0, 'a refused path must not reach the file system');
    // On linux a backslash is an ordinary name character, so the same segment is only a missing name, not a refusal.
    const linux = await createDirectoryPort({ root, platform: 'linux', fs: realFs });
    await assert.rejects(linux.readDir(['a\\b']), (error) => error.code === 'ENOENT');
  } finally {
    await removeTree(root);
  }
});

test('a root that is missing, relative or a file is refused', async () => {
  const { root } = await buildLibrary();
  try {
    await assert.rejects(createDirectoryPort({ root: path.join(root, 'missing-folder'), fs: realFs }), { code: 'ENOENT' });
    await assert.rejects(createDirectoryPort({ root: 'relative/folder', fs: realFs }), { code: ADAPTER_CODES.ROOT });
    await assert.rejects(createDirectoryPort({ root: path.join(root, 'loose.txt'), fs: realFs }), { code: ADAPTER_CODES.ROOT_NOT_DIRECTORY });
  } finally {
    await removeTree(root);
  }
});

test('a root reached through a link is resolved once and listed through its real location', async (t) => {
  const { root, outside } = await buildLibrary();
  try {
    const refused = await tryLink(root, path.join(outside, 'rootlink'));
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    const port = await createDirectoryPort({ root: path.join(outside, 'rootlink'), platform: process.platform, fs: realFs });
    assert.equal(port.root, root);
    assert.ok((await port.readDir([])).some(entry => entry.name === 'Birchfield'));
  } finally {
    await removeTree(root);
    await removeTree(outside);
  }
});

test('reads never write: a full walk leaves names, kinds, sizes, times and content unchanged', async () => {
  const { root, outside } = await buildLibrary();
  try {
    await tryLink(outside, path.join(root, 'Link'));
    const before = await snapshot(root);
    // The port may touch only readdir, lstat and realpath; any other member access throws in the proxy.
    const guarded = new Proxy(realFs, {
      get(target, property) {
        if (!ALLOWED_FS_MEMBERS.has(property)) throw new Error(`unexpected fs member: ${String(property)}`);
        return target[property];
      },
    });
    const port = await createDirectoryPort({ root, platform: process.platform, fs: guarded });
    await walk(port);
    assert.deepEqual(await snapshot(root), before);
    assert.ok((await fs.readFile(path.join(outside, 'secret.brd'), 'utf8')) === 'outside the root');
  } finally {
    await removeTree(root);
  }
});

test('module source has no write, rename, delete or process API', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'library', 'directory-adapter.cjs'), 'utf8');
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\.(writeFile|appendFile|rename|unlink|rm|rmdir|mkdir|copyFile|cp|truncate|chmod|chown|utimes|symlink|link|open|write|createWriteStream|createReadStream|exec|spawn)\b/);
  const requires = [...code.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort();
  assert.deepEqual(requires, ['../placeholder.cjs', 'node:fs', 'node:fs/promises', 'node:path', 'node:util']);
  // The helper it uses is pure: a metadata test, no file system call and no process.
  const helper = await fs.readFile(path.join(__dirname, '..', 'electron', 'placeholder.cjs'), 'utf8');
  assert.doesNotMatch(helper, /require\(|\.(writeFile|appendFile|rename|unlink|rm|rmdir|mkdir|copyFile|cp|truncate|chmod|chown|utimes|symlink|link|open|write|createWriteStream|createReadStream|exec|spawn)\b/);
});

// W16-B4: a Windows reparse point that is not a link (cloud placeholder, dedup, app execution link). The listing's type says link;
// lstat may report a plain directory (a cloud placeholder) or fail. Simulated through the injected listing: no privilege is needed.
function asReparse(names) {
  return (target, options) => realFs.readdir(target, options).then((items) => items.map((item) => (names.includes(item.name) ? { name: item.name, isSymbolicLink: () => true } : item)));
}

test('a reparse point that is not a link is kind reparse: listed by type, never a directory, siblings kept', async () => {
  const { root } = await buildLibrary();
  try {
    await fs.mkdir(path.join(root, 'Cloud'));
    const fake = { readdir: asReparse(['Cloud']), lstat: realFs.lstat, realpath: realFs.realpath };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    const kinds = Object.fromEntries((await port.readDir([])).map((entry) => [entry.name, entry.kind]));
    assert.equal(kinds.Cloud, 'reparse', 'lstat says directory here, the listing says link: the reparse point wins');
    assert.equal(kinds.Birchfield, 'dir');
    assert.equal(kinds['loose.txt'], 'file');
    assert.equal(kinds.Empty, 'dir');
  } finally {
    await removeTree(root);
  }
});

test('a reparse point whose lstat fails is still kind reparse (no diagnostic code), and its siblings are listed', async () => {
  const { root } = await buildLibrary();
  try {
    const denied = path.join(root, 'Dedup');
    const fake = {
      readdir: (target, options) => realFs.readdir(target, options).then((items) => [...items, { name: 'Dedup', isSymbolicLink: () => true }]),
      lstat: (target, ...rest) => (target === denied ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : realFs.lstat(target, ...rest)),
      realpath: realFs.realpath,
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    const entries = Object.fromEntries((await port.readDir([])).map((entry) => [entry.name, entry]));
    assert.deepEqual(entries.Dedup, { name: 'Dedup', kind: 'reparse' }, 'not unknown: nothing about it can be read, and nothing needs to be');
    assert.equal(entries.Birchfield.kind, 'dir');
    assert.equal(entries['loose.txt'].kind, 'file');
  } finally {
    await removeTree(root);
  }
});

// W16-B4 (decided): an online-only file is a reparse point that is a file of at least one cluster with no allocated blocks. Its name and
// size are listed (kind 'file', online true); its content is never read. Simulated through the injected lstat (Node cannot read the tag).
function fakeStat(overrides) {
  return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 8192, blocks: 0, ...overrides };
}

test('an online-only file (reparse point, at least one cluster, no allocated blocks) is kind file with online true and its content is not read', async () => {
  const { root } = await buildLibrary();
  try {
    const placeholder = path.join(root, 'Cloud.cad');
    await fs.writeFile(placeholder, Buffer.alloc(8192, 7));
    const fake = {
      readdir: asReparse(['Cloud.cad']),
      lstat: (target, ...rest) => (target === placeholder ? Promise.resolve(fakeStat({ size: 8192, blocks: 0 })) : realFs.lstat(target, ...rest)),
      realpath: realFs.realpath,
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    const entry = (await port.readDir([])).find((item) => item.name === 'Cloud.cad');
    assert.deepEqual(entry, { name: 'Cloud.cad', kind: 'file', size: 8192, online: true });
  } finally {
    await removeTree(root);
  }
});

test('a reparse point file with allocated blocks, or smaller than a cluster, is not online-only: kind reparse', async () => {
  const { root } = await buildLibrary();
  try {
    const full = path.join(root, 'Full.cad');
    const small = path.join(root, 'Small.cad');
    await fs.writeFile(full, Buffer.alloc(8192, 1));
    await fs.writeFile(small, Buffer.alloc(100, 2));
    const fake = {
      readdir: asReparse(['Full.cad', 'Small.cad']),
      lstat: (target, ...rest) => {
        if (target === full) return Promise.resolve(fakeStat({ size: 8192, blocks: 16 }));
        if (target === small) return Promise.resolve(fakeStat({ size: 100, blocks: 0 }));
        return realFs.lstat(target, ...rest);
      },
      realpath: realFs.realpath,
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    const kinds = Object.fromEntries((await port.readDir([])).map((entry) => [entry.name, entry.kind]));
    assert.equal(kinds['Full.cad'], 'reparse', 'a file with its content allocated is a local reparse point, not online');
    assert.equal(kinds['Small.cad'], 'reparse', 'below one cluster the allocation says nothing');
  } finally {
    await removeTree(root);
  }
});

// TB-038: each entry is checked again after the listing. A link or a reparse point is resolved; one whose real place is outside the root
// is returned as a link with ADAPTER_ESCAPES_ROOT (the walker records the refusal). Links are junctions here (no privilege on win32).
test('TB-038: a link whose real place is outside the root is returned as a link with ADAPTER_ESCAPES_ROOT; a link inside keeps no code', async (t) => {
  const { root, outside } = await buildLibrary();
  const escape = path.join(root, 'Escape');
  const inside = path.join(root, 'Inside');
  try {
    const refused = await tryLink(outside, escape);
    if (refused) { t.skip(`link creation refused by the platform (${refused})`); return; }
    const refusedInside = await tryLink(path.join(root, 'Birchfield'), inside);
    if (refusedInside) { t.skip(`link creation refused by the platform (${refusedInside})`); return; }
    const port = await createDirectoryPort({ root, platform: process.platform });
    const entries = Object.fromEntries((await port.readDir([])).map((entry) => [entry.name, entry]));
    assert.deepEqual(entries.Escape, { name: 'Escape', kind: 'link', code: ADAPTER_CODES.ESCAPES_ROOT });
    assert.deepEqual(entries.Inside, { name: 'Inside', kind: 'link' });
  } finally {
    await removeLink(escape);
    await removeLink(inside);
    await removeTree(root);
  }
});

test('TB-038: a reparse point is resolved after the listing: outside the root it is a link with ADAPTER_ESCAPES_ROOT, inside it stays reparse', async () => {
  const { root, outside } = await buildLibrary();
  try {
    await fs.mkdir(path.join(root, 'Cloud'));
    await fs.mkdir(path.join(root, 'Local'));
    const fake = {
      readdir: asReparse(['Cloud', 'Local']),
      lstat: realFs.lstat,
      realpath: (target, ...rest) => (target === path.join(root, 'Cloud') ? Promise.resolve(outside) : realFs.realpath(target, ...rest)),
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    const entries = Object.fromEntries((await port.readDir([])).map((entry) => [entry.name, entry]));
    assert.deepEqual(entries.Cloud, { name: 'Cloud', kind: 'link', code: ADAPTER_CODES.ESCAPES_ROOT });
    assert.deepEqual(entries.Local, { name: 'Local', kind: 'reparse' });
  } finally {
    await removeTree(root);
  }
});

test('TB-038: an online-only placeholder is never resolved: no realpath call reaches its path', async () => {
  const { root } = await buildLibrary();
  try {
    const placeholder = path.join(root, 'Cloud.cad');
    await fs.writeFile(placeholder, Buffer.alloc(8192, 7));
    const resolved = [];
    const fake = {
      readdir: asReparse(['Cloud.cad']),
      lstat: (target, ...rest) => (target === placeholder ? Promise.resolve(fakeStat({ size: 8192, blocks: 0 })) : realFs.lstat(target, ...rest)),
      realpath: (target, ...rest) => { resolved.push(target); return realFs.realpath(target, ...rest); },
    };
    const port = await createDirectoryPort({ root, platform: process.platform, fs: fake });
    const entry = (await port.readDir([])).find((item) => item.name === 'Cloud.cad');
    assert.deepEqual(entry, { name: 'Cloud.cad', kind: 'file', size: 8192, online: true });
    assert.equal(resolved.some((target) => target.endsWith('Cloud.cad')), false, 'the placeholder is not resolved, so it is not read or downloaded');
  } finally {
    await removeTree(root);
  }
});
