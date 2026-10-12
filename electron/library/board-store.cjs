'use strict';

// The board records of the Library database: the BoardStore port of the device catalogue. One record per board anchor (the board code
// and revision read from the scanned file names), kept in userData/library/devices/boards.json. A record survives a restart, so the
// metadata of a board stays known when the same board is scanned again, and a board whose files are gone keeps its record.
//
// The store is the board anchor source of the device bridge (src/lib/library/devices/anchor-source.ts), with the same two methods:
//   anchorsFor(scan)    records the boards of the scan and answers the scan's own anchors. Matching therefore sees exactly the anchors
//                       it sees without the store: a stored board without a file in the scan is never matched or listed.
//   describe(anchorId)  the stored board code and revision, or undefined.
//
// Writes are atomic, as corrections.json is: a temporary file (flag 'wx', mode 0600) is renamed over the target, and a failed write
// leaves the previous file as it was. A damaged file (not JSON, another version, too large) is renamed aside to
// boards.damaged-<time>-<id>.json with its bytes kept; when that rename fails the store writes nothing, so a damaged file is never
// overwritten. A failed write never fails a scan: the records stay in memory for this session.

const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { renameWithRetry } = require('../store.cjs');
const { DIRECTORY_SEGMENTS } = require('./corrections-store.cjs');

const FILE_NAME = 'boards.json';
const VERSION = 1;
const MAX_RECORDS = 10000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 64;
// The anchor ids deriveBoardAnchors makes: `board:<CODE>|<revision>` (the code upper-cased, the revision normalized).
const ANCHOR_ID = /^board:[^|\u0000]{1,128}\|[^\u0000|]{0,64}$/;

function createBoardStore({ userDataDirectory, fs = fsPromises, renameDelaysMs, now = () => new Date().toISOString(), random = () => crypto.randomUUID() } = {}) {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) throw new TypeError('the user data directory of the board store is invalid');
  const directory = path.join(path.resolve(userDataDirectory), ...DIRECTORY_SEGMENTS);
  const filePath = path.join(directory, FILE_NAME);
  // anchorId -> { boardCode, revision (normalized or null), firstSeen, lastChanged }
  const records = new Map();
  let loaded = null;
  // False after a damaged file could not be moved aside, or the file could not be read: nothing is written then.
  let writable = true;
  let queue = Promise.resolve();

  function recordOf(entry) {
    if (entry === null || typeof entry !== 'object' || typeof entry.anchorId !== 'string' || !ANCHOR_ID.test(entry.anchorId)) return null;
    if (typeof entry.boardCode !== 'string' || entry.boardCode.length === 0 || entry.boardCode.length > MAX_TEXT) return null;
    if (entry.revision !== null && (typeof entry.revision !== 'string' || entry.revision.length > MAX_TEXT)) return null;
    const stamp = (value) => (typeof value === 'string' ? value.slice(0, 40) : '');
    return { boardCode: entry.boardCode, revision: entry.revision, firstSeen: stamp(entry.firstSeen), lastChanged: stamp(entry.lastChanged) };
  }

  async function moveAside() {
    const target = path.join(directory, `boards.damaged-${now().replace(/[:.]/g, '-')}-${random().slice(0, 8)}.json`);
    try {
      await renameWithRetry(fs, filePath, target, renameDelaysMs);
      return true;
    } catch {
      return false;
    }
  }

  async function readRecords() {
    let raw;
    try {
      raw = await fs.readFile(filePath);
    } catch (error) {
      // No file yet is the usual first start. Any other read failure means the file exists and cannot be trusted: nothing is written.
      if (error && error.code === 'ENOENT') return;
      writable = false;
      return;
    }
    let document = null;
    if (raw.length <= MAX_BYTES) {
      try { document = JSON.parse(raw.toString('utf8')); } catch { document = null; }
    }
    if (document === null || typeof document !== 'object' || document.version !== VERSION || !Array.isArray(document.boards)) {
      writable = await moveAside();
      return;
    }
    for (const entry of document.boards) {
      if (records.size >= MAX_RECORDS) break;
      const record = recordOf(entry);
      if (record !== null) records.set(entry.anchorId, record);
    }
  }

  function ready() {
    loaded ??= readRecords();
    return loaded;
  }

  async function save() {
    if (!writable) return false;
    const boards = [...records].map(([anchorId, record]) => ({ anchorId, ...record }));
    const body = `${JSON.stringify({ version: VERSION, boards }, null, 2)}\n`;
    // The pid in the name is what the start sweep reads: a temporary whose writer is gone is removed (electron/store.cjs sweepTemporaryFolder).
    const temporary = path.join(directory, `${FILE_NAME}.${process.pid}.${random()}.tmp`);
    let handle = null;
    try {
      await fs.mkdir(directory, { recursive: true });
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await renameWithRetry(fs, temporary, filePath, renameDelaysMs);
      return true;
    } catch {
      if (handle !== null) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      return false;
    }
  }

  // Writes run one after another, so two scans never interleave their files.
  function enqueue(work) {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  }

  return Object.freeze({
    // The scan's own anchors, unchanged: the boards it found are recorded (or their changed metadata is updated) before it returns.
    async anchorsFor(scan) {
      await ready();
      const at = now();
      let changed = false;
      for (const anchor of scan.derived) {
        if (typeof anchor.boardCode !== 'string' || !ANCHOR_ID.test(anchor.id)) continue;
        const boardCode = anchor.boardCode;
        const revision = anchor.revision?.normalized ?? null;
        const known = records.get(anchor.id);
        if (known === undefined) {
          if (records.size >= MAX_RECORDS) continue;
          records.set(anchor.id, { boardCode, revision, firstSeen: at, lastChanged: at });
          changed = true;
        } else if (known.boardCode !== boardCode || known.revision !== revision) {
          Object.assign(known, { boardCode, revision, lastChanged: at });
          changed = true;
        }
      }
      if (changed) await enqueue(save);
      return scan.derived;
    },

    async describe(anchorId) {
      await ready();
      const record = typeof anchorId === 'string' ? records.get(anchorId) : undefined;
      return record === undefined ? undefined : { boardCode: record.boardCode, revision: record.revision ?? undefined };
    },
  });
}

module.exports = Object.freeze({ createBoardStore, FILE_NAME, VERSION, MAX_RECORDS });
