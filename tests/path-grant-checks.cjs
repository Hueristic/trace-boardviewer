'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createPathGrants, SOURCES } = require(path.join(ROOT, 'electron', 'path-grants.cjs'));
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');

const BOARD = path.resolve(path.sep === '\\' ? 'C:\\Boards\\Circuit.CAD' : '/boards/Circuit.CAD');
const OTHER = path.resolve(path.sep === '\\' ? 'C:\\Boards\\Other.CAD' : '/boards/Other.CAD');

test('nothing is granted until a source grants it; a path is granted with its source; an unknown source is an error', () => {
  const grants = createPathGrants({ platform: 'linux' });
  assert.equal(grants.has(BOARD), false, 'no grant by default');
  assert.equal(grants.sourceOf(BOARD), null);
  assert.deepEqual(SOURCES, ['dialog', 'drop', 'external', 'recent', 'located']);
  for (const source of SOURCES) {
    const registry = createPathGrants({ platform: 'linux' });
    assert.equal(registry.grant(BOARD, source), true, source);
    assert.equal(registry.has(BOARD), true, source);
    assert.equal(registry.sourceOf(BOARD), source, source);
    assert.equal(registry.has(OTHER), false, `${source} grants only the path it was given`);
  }
  assert.throws(() => grants.grant(BOARD, 'renderer'), /unknown grant source/, 'a source the renderer invents is refused');
  assert.throws(() => grants.grant(BOARD), /unknown grant source/, 'a missing source is refused');
});

test('a path the renderer names is granted only as the exact path: other names, traversal and relative paths are refused', () => {
  const grants = createPathGrants({ platform: 'linux' });
  grants.grant(BOARD, 'dialog');
  assert.equal(grants.has(path.join(path.dirname(BOARD), '..', path.basename(path.dirname(BOARD)), 'Circuit.CAD')), true, 'the same file, spelled with a normalised traversal');
  assert.equal(grants.has(path.join(path.dirname(BOARD), 'Circuit.CAD.bak')), false);
  assert.equal(grants.has(path.join(path.dirname(BOARD), 'sub', '..', 'Other.CAD')), false);
  assert.equal(grants.has('Circuit.CAD'), false, 'a relative path is never granted');
  assert.equal(grants.grant('Circuit.CAD', 'dialog'), false, 'a relative path cannot be granted');
  assert.equal(grants.grant(BOARD + '\0.txt', 'dialog'), false, 'a NUL byte is refused');
  assert.equal(grants.grant(`${BOARD}${'x'.repeat(40000)}`, 'dialog'), false, 'an overlong path is refused');
  for (const bad of [undefined, null, 42, {}, [], '']) assert.equal(grants.has(bad), false, JSON.stringify(bad));
});

test('on Windows the spelling of case does not matter; elsewhere it does', () => {
  const windows = createPathGrants({ platform: 'win32' });
  windows.grant('C:\\Boards\\Circuit.CAD', 'recent');
  assert.equal(windows.has('c:\\boards\\circuit.cad'), true);
  const linux = createPathGrants({ platform: 'linux' });
  linux.grant('/boards/Circuit.CAD', 'recent');
  assert.equal(linux.has('/boards/circuit.cad'), false, 'a case-sensitive file system is a different file');
});

test('main.cjs grants at each source and gates the three read channels before any file is touched', () => {
  assert.match(main, /const grants = require\('\.\/path-grants\.cjs'\)\.createPathGrants\(\{ platform: process\.platform \}\);/);
  assert.match(main, /if \(startupBoardPath\) grants\.grant\(startupBoardPath, 'external'\);/, 'command line');
  assert.match(main, /grants\.grant\(filename, 'external'\);\n\s+if \(!app\.isReady\(\)\)|app\.on\('open-file'[\s\S]{0,120}grants\.grant\(filename, 'external'\)/, 'open-file');
  assert.match(main, /if \(filename\) \{ grants\.grant\(filename, 'external'\); boardRequested\(filename\); \}/, 'second launch');
  assert.match(main, /for \(const recent of config\.recentBoards\) grants\.grant\(recent\.path, 'recent'\);/, 'recent boards');
  assert.match(main, /grants\.grant\(choice\.filePaths\[0\], 'dialog'\);/, 'open dialog');
  assert.match(main, /for \(const filename of choice\.filePaths\) grants\.grant\(filename, 'dialog'\);/, 'attach dialog');
  assert.match(main, /if \(trustedSender\(event\)\) grants\.grant\(filename, 'drop'\);/, 'drop, from the trusted window only');
  assert.match(main, /result\.relativePath !== undefined\) grants\.grant\(result\.path, 'located'\)/, 'located inside the board folder only');
  assert.match(main, /handle\('trace:read-board', \(filename\) => \{ requireGranted\(filename\);/);
  assert.match(main, /handle\('trace:read-document', async \(filename, options\) => \{\n\s+requireGranted\(filename\);/);
  assert.match(main, /handle\('trace:locate-documents', async \(boardFile, requests\) => \{\n\s+requireGranted\(boardFile\);/);
  assert.match(main, /function requireGranted\(filename\) \{\n\s+if \(typeof filename === 'string' && path\.isAbsolute\(filename\) && !grants\.has\(filename\)\) throw new Error\(t\('native\.error\.pathNotGranted'\)\);/, 'absolute paths are gated; the others keep their syntax check');
});

test('the preload asks for the grant synchronously when it reads a dropped file, and the main process listens for it on the trusted window only', () => {
  assert.match(preload, /if \(filename\) ipcRenderer\.sendSync\('trace:grant-dropped', filename\);/);
  assert.match(main, /ipcMain\.on\('trace:grant-dropped', \(event, filename\) => \{\n\s+if \(trustedSender\(event\)\) grants\.grant\(filename, 'drop'\);\n\s+event\.returnValue = true;/);
});
