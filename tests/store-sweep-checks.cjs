'use strict';

// TB-079 (MLX-03-12): the temporaries a killed store write leaves behind are swept when the store opens. These are the regression
// tests for the start-up sweep in electron/store.cjs (sweepTemporaries): a stale temporary is removed in the profile root and in its
// immediate sub-directories (notes/, workspaces/, readings/); a temporary of a process that still runs is kept while it is young, and
// the temporary of this process is always kept; a file that does not carry the temporary name is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createJsonStore } = require('../electron/store.cjs');
const { isInsideTemp, makeTempDir } = require('./canonical-temp.cjs');

const t = (key) => key;
const UUID = '0b6f6a5e-3c2d-4e7f-9a1b-2c3d4e5f6a7b';
const DAY_MS = 24 * 60 * 60 * 1000;

// A process id that is not running: a child that has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// Writes a file with a partial body, optionally aged (its modification time set in the past).
async function writeTemporary(file, ageMs = 0) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'partial write');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(file, when, when);
  }
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

// Opens a store on the directory and waits for its first queued operation: the start-up sweep runs before any read or write.
async function openStore(directory) {
  const store = createJsonStore({ directory, t });
  await store.read('sweep-barrier.json');
  return store;
}

// A process that keeps running until it is stopped: its pid counts as live for the sweep.
async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return child;
}

test('a temporary of a stopped process is removed at the next start, in the profile root and in notes/, workspaces/ and readings/', async () => {
  const root = await makeTempDir('trace-sweep-test-');
  try {
    const dead = deadPid();
    const stale = [
      `config.json.${dead}.${UUID}.tmp`,
      path.join('notes', `pins.json.${dead}.${UUID}.tmp`),
      path.join('workspaces', `board-1.json.${dead}.${UUID}.tmp`),
      path.join('readings', `reading-1.json.${dead}.${UUID}.tmp`),
    ];
    for (const name of stale) await writeTemporary(path.join(root, name));
    await openStore(root);
    for (const name of stale) assert.equal(await exists(path.join(root, name)), false, `${name} is removed at the next start`);
  } finally {
    if (await isInsideTemp(root)) await fs.rm(root, { recursive: true, force: true });
  }
});

test('the start-up sweep keeps the temporary of this process, and one of a process that still runs, while they are young', async () => {
  const root = await makeTempDir('trace-sweep-test-');
  const child = await liveChild();
  try {
    const own = path.join(root, `config.json.${process.pid}.${UUID}.tmp`);
    const running = path.join(root, `config.json.${child.pid}.${UUID}.tmp`);
    await writeTemporary(own);
    await writeTemporary(running);
    await openStore(root);
    assert.equal(await exists(own), true, 'the temporary of this process is kept');
    assert.equal(await exists(running), true, 'a young temporary of a process that still runs is kept');
  } finally {
    child.kill();
    if (await isInsideTemp(root)) await fs.rm(root, { recursive: true, force: true });
  }
});

test('a temporary older than a day is removed even when its process still runs (a reused pid or a write that never finished)', async () => {
  const root = await makeTempDir('trace-sweep-test-');
  const child = await liveChild();
  try {
    const old = path.join(root, `workspaces/board-2.json.${child.pid}.${UUID}.tmp`);
    await writeTemporary(old, DAY_MS + 60 * 1000);
    await openStore(root);
    assert.equal(await exists(old), false, 'a temporary older than a day is removed');
  } finally {
    child.kill();
    if (await isInsideTemp(root)) await fs.rm(root, { recursive: true, force: true });
  }
});

test('the sweep touches only files that carry the temporary name: other names, other shapes and deeper folders are kept', async () => {
  const root = await makeTempDir('trace-sweep-test-');
  try {
    const dead = deadPid();
    const others = [
      'config.json',
      `config.json.bak-${dead}`,
      `config.json.${dead}.tmp`,
      `config.json.${dead}.${UUID.toUpperCase()}.tmp`,
      `config.json.${dead}.${UUID}.TMP`,
      path.join('notes', 'pins.json'),
      path.join('notes', 'deep', `pins.json.${dead}.${UUID}.tmp`),
    ];
    for (const name of others) await writeTemporary(path.join(root, name));
    await openStore(root);
    for (const name of others) assert.equal(await exists(path.join(root, name)), true, `${name} is never touched`);
  } finally {
    if (await isInsideTemp(root)) await fs.rm(root, { recursive: true, force: true });
  }
});
