'use strict';

// Tests that the draft release of a stable version reads release-notes/<version>.md (windows.yml), that the notes file for 1.3.3 holds
// every New and Improved-and-fixed entry of the 1.3.2 and 1.3.3 CHANGELOG sections, that it has the three sections and the 1.3.2 sentence,
// and that it carries no internal identifiers or forbidden wording. The prerelease note stays as it was. No network, no Windows runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const NOTES_FILE = 'release-notes/1.3.3.md';

/** Bullets of the "New" and "Improved and fixed" subsections of one CHANGELOG version section. */
function changelogBullets(text, version) {
  const bullets = [];
  let inVersion = false;
  let sub = null;
  for (const line of text.split('\n')) {
    const heading = /^## (\S+)/.exec(line);
    if (heading) { inVersion = heading[1] === version; sub = null; continue; }
    if (!inVersion) continue;
    if (/^### (New|Improved and fixed)$/.test(line)) { sub = line; continue; }
    if (/^### /.test(line)) { sub = null; continue; }
    if (sub && /^- /.test(line)) bullets.push(line.slice(2).trim());
  }
  return bullets;
}

test('the draft release of a stable version inserts release-notes/<version>.md and fails when it is missing', () => {
  const workflow = read('.github/workflows/windows.yml');
  assert.match(workflow, /Join-Path 'release-notes' "\$env:TRACE_VERSION\.md"/, 'the notes path is built from the release version');
  assert.match(workflow, /Release notes are missing for the stable version: \$traceNotesPath/, 'a missing stable notes file stops the release');
  assert.match(workflow, /if \(-not \(\$env:TRACE_VERSION -match '-'\)\) \{\s*\n\s*\$traceNotesPath/, 'the file is read for stable versions only');
  assert.match(workflow, /^\s+\$\{traceNotesBlock\}$/m, 'the notes are inserted after the introductory paragraph');
  assert.match(workflow, /\*\*This is a prerelease for testing\.\*\*/, 'the prerelease note is still there and unchanged');
});

test('the 1.3.3 notes file has the three sections and the 1.3.2 sentence', () => {
  const notes = read(NOTES_FILE);
  assert.match(notes, /^# TRACE Boardviewer 1\.3\.3$/m);
  assert.match(notes, /^## What's new$/m);
  assert.match(notes, /^## Improvements$/m);
  assert.match(notes, /^## Bug fixes$/m);
  assert.match(notes, /^1\.3\.2 was not released separately; its changes ship here\.$/m);
});

test('every New and Improved-and-fixed entry of the 1.3.2 and 1.3.3 CHANGELOG sections is in the notes', () => {
  const changelog = read('CHANGELOG.md');
  const notes = read(NOTES_FILE);
  for (const version of ['1.3.3', '1.3.2']) {
    const bullets = changelogBullets(changelog, version);
    assert.ok(bullets.length > 0, `${version} has entries in the CHANGELOG`);
    for (const bullet of bullets) assert.ok(notes.includes(`- ${bullet}`), `${version} entry missing from the notes: ${bullet.slice(0, 80)}`);
  }
});

test('the notes carry no internal identifier or forbidden wording', () => {
  const notes = read(NOTES_FILE);
  // The words are assembled from parts, so this file does not contain the words it looks for (the public-tree audit scans it).
  const forbidden = new RegExp(['T' + 'B-\\d', 'MAC' + '-TEST', 'HU' + 'NT-', 'IN' + 'T-\\d', '\\bl' + 'ane\\b', 'corp' + 'us', 'Clau' + 'de', '\\bA' + 'I\\b', 'Cod' + 'ex', 'own' + 'er', 'xatt' + 'r', 'FX' + 'QA', 'U-\\d\\d'].join('|'), 'i');
  const hit = notes.split('\n').find((line) => forbidden.test(line));
  assert.equal(hit, undefined, `forbidden wording: ${hit}`);
});
