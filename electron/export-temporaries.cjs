'use strict';

// The temporaries of a user-chosen export: the workspace zip (electron/documents.cjs) and the readings pack (electron/main.cjs) are written
// next to the destination the user picked, outside the profile, so the store's start sweep does not reach them. Each one is recorded in the
// profile (export-temporaries.json) before its file is created, and forgotten once the file has been renamed into place or removed. The start
// sweep removes the recorded ones whose writer is gone, or that are older than a day, and keeps the others. Only a recorded path is ever
// removed, and only when its name keeps the writer's shape: `<destination>.<pid>.<suffix>.tmp`, with the pid that was recorded for it.

const path = require('node:path');
const fsPromises = require('node:fs/promises');
const { processGone, STALE_TEMPORARY_MS } = require('./store.cjs');

const FILE_NAME = 'export-temporaries.json';
const SHAPE = /\.(\d+)\.[0-9A-Za-z-]+\.tmp$/;

// `store` is the profile store (createJsonStore). `fs`, `pathModule`, `isGone`, `now` and `log` are injected by the tests: the platform's path
// rules (path.win32 or path.posix), the process check, the clock and the log line sink. A removal goes through `fs.unlink`, so a test can see
// every path it would remove.
function createExportTemporaries({ store, fs = fsPromises, pathModule = path, isGone = processGone, now = () => Date.now(), log = () => {} } = {}) {
  let chain = Promise.resolve(); // the record changes one after another: each one reads the record it changes

  function queued(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  async function readEntries() {
    const current = await store.read(FILE_NAME, { missing: [] });
    return Array.isArray(current) ? current : [];
  }

  // Recorded before the file is created. Never rejects: an export is a user's action and goes on whether or not its temporary can be recorded.
  // A temporary that is not recorded is not swept if the process dies during the export, and the log line says so.
  function record(temporary) {
    return queued(async () => {
      const entries = await readEntries();
      await store.write(FILE_NAME, [...entries.filter((entry) => entry.path !== temporary), { path: temporary, pid: process.pid, at: now() }]);
    }).then(() => true, (error) => {
      log(`the export temporary ${pathModule.basename(temporary)} is not recorded (${error?.code || error?.message || 'write failed'}); it is not swept if the export is interrupted`);
      return false;
    });
  }

  // Forgotten once the file has been renamed into place or removed. Never rejects: a record left behind names a file that is gone, and the
  // next start drops it.
  function forget(temporary) {
    return queued(async () => {
      const entries = await readEntries();
      const kept = entries.filter((entry) => entry.path !== temporary);
      if (kept.length !== entries.length) await store.write(FILE_NAME, kept);
    }).catch((error) => { log(`the export temporary record could not be updated (${error?.code || error?.message || 'write failed'})`); });
  }

  // A record entry is ours to judge only when its path is absolute, its name keeps the writer's shape with the recorded pid, and its time is a
  // number. Any other entry is dropped from the record without touching its file.
  function shaped(entry) {
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.pid) || entry.pid <= 0) return false;
    if (typeof entry.path !== 'string' || !Number.isFinite(entry.at) || !pathModule.isAbsolute(entry.path)) return false;
    const match = SHAPE.exec(pathModule.basename(entry.path));
    return match !== null && Number(match[1]) === entry.pid;
  }

  // Start: a recorded temporary is removed when its writer is gone or it is older than a day; a temporary of a running writer stays recorded,
  // and so does one recorded by this process (an export of this process may be in flight). Returns what it removed. Never rejects.
  function sweep() {
    return queued(async () => {
      const entries = await readEntries();
      const kept = [];
      const removed = [];
      for (const entry of entries) {
        if (!shaped(entry)) continue;
        const running = entry.pid === process.pid || !isGone(entry.pid);
        if (running && now() - entry.at <= STALE_TEMPORARY_MS) { kept.push(entry); continue; }
        const gone = await fs.unlink(entry.path).then(() => true, (error) => error?.code === 'ENOENT');
        if (gone) removed.push(entry.path);
        else kept.push(entry);
      }
      if (kept.length !== entries.length) await store.write(FILE_NAME, kept);
      return { removed, kept: kept.length };
    }).catch((error) => {
      log(`the export temporaries could not be swept at start (${error?.code || error?.message || 'read failed'})`);
      return { removed: [], kept: 0 };
    });
  }

  return Object.freeze({ record, forget, sweep });
}

module.exports = Object.freeze({ FILE_NAME, createExportTemporaries });
