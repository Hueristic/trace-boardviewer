'use strict';

// The profile folder (userData) of the desktop app, pinned per platform. It only reads the sources and the docs; nothing is launched.
//   - Linux: electron/main.cjs sets the folder to appData/<name>, the literal in that branch.
//   - Windows and macOS: no path is set in code. Electron derives the folder from the package name, so package.json must not set a
//     productName that would take its place, and the display name 'TRACE Boardviewer' (app.setName) must never build a folder path.
//   - The literal, the package name and the folder named by the user-facing docs and release notes are one and the same name.
// Not covered: a real start on Windows or macOS. Whether Electron really derives that folder there is a native check (docs/MAC_VALIDATION.md, J).
//
//   node --test tests/profile-location-checks.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const pkg = JSON.parse(read('package.json'));
const main = read('electron', 'main.cjs');
const PROFILE_FOLDER = 'trace-boardviewer';

test('the package name is the profile folder name', () => {
  assert.equal(pkg.name, PROFILE_FOLDER);
});

test('Linux pins the profile to appData/<package name>', () => {
  const linux = /process\.platform === 'linux'\) \{[\s\S]*?path\.join\(app\.getPath\('appData'\), '([^']+)'\)/.exec(main);
  assert.ok(linux, 'the Linux branch of electron/main.cjs names the profile folder');
  assert.equal(linux[1], pkg.name);
  assert.equal(linux[1], PROFILE_FOLDER);
});

test('only the --user-data-dir override and the Linux branch set the profile path', () => {
  const start = main.indexOf('const profileOverride');
  const end = main.indexOf("app.setName('TRACE Boardviewer')");
  assert.ok(start > 0 && end > start, 'the profile block sits between profileOverride and setName');
  const block = main.slice(start, end);
  const sets = main.match(/setPath\('userData'/g) || [];
  assert.equal(sets.length, 2, 'two places set userData: the override and the Linux pin');
  assert.equal((block.match(/setPath\('userData'/g) || []).length, 2, 'both are inside the profile block');
  const platforms = block.match(/process\.platform === '[a-z0-9]+'/g) || [];
  assert.deepEqual(platforms, ["process.platform === 'linux'"], 'the block has no Windows or macOS branch that sets a path');
});

test('package.json sets no productName, so Electron takes the Windows and macOS folder from the name', () => {
  assert.equal(pkg.productName, undefined);
});

test('the display name is never used to build a folder path', () => {
  assert.doesNotMatch(main, /path\.join\([^)]*TRACE Boardviewer/);
});

test('the user-facing docs and release notes name the same folder on every platform', () => {
  const docs = ['README.md', 'docs/LINUX.md', 'docs/MAC_VALIDATION.md', 'CHANGELOG.md', 'release-notes/1.3.3.md'];
  const patterns = [/%APPDATA%\\([A-Za-z0-9_.-]+)/g, /Application Support\/([A-Za-z0-9_.-]+)/g, /\.config\/([A-Za-z0-9_.-]+)/g];
  let named = 0;
  for (const doc of docs) {
    const text = read(...doc.split('/'));
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        named += 1;
        assert.equal(match[1], pkg.name, `${doc} names "${match[1]}" in "${match[0]}"; the profile folder is "${pkg.name}"`);
      }
    }
  }
  assert.ok(named >= 5, `the docs name the profile folder at least five times (found ${named})`);
});
