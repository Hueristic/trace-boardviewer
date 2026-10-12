'use strict';

// The packaging guard (HUNT-WIN-20261011-09/10/11, packaged QA ac39e503): a renderer build made from other sources must stop the pack.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkDistFresh, sourceFingerprint, writeBuildStamp } = require('../scripts/dist-freshness.cjs');

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trace-dist-freshness-'));
const write = (root, rel, text = 'x') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const baseProject = () => {
  const root = project();
  write(root, 'src/app.ts', 'export const a = 1;');
  write(root, 'electron/locales/en/workspace.json', '{"x": "y"}');
  write(root, 'index.html', '<html></html>');
  write(root, 'vite.config.ts', 'export default {};');
  write(root, 'package.json', '{"name": "t"}');
  return root;
};

test('a stamp written from the current sources passes the check', () => {
  const root = baseProject();
  writeBuildStamp(root);
  assert.equal(checkDistFresh(root), sourceFingerprint(root));
});

test('a source changed after the build is refused', () => {
  const root = baseProject();
  writeBuildStamp(root);
  write(root, 'src/app.ts', 'export const a = 2;');
  assert.throws(() => checkDistFresh(root), /built from other sources/);
});

test('a catalog change after the build is refused (the packaged app ships the catalogs from the sources)', () => {
  const root = baseProject();
  writeBuildStamp(root);
  write(root, 'electron/locales/en/workspace.json', '{"x": "z"}');
  assert.throws(() => checkDistFresh(root), /built from other sources/);
});

test('a missing stamp is refused, whatever the file times', () => {
  const root = baseProject();
  fs.mkdirSync(path.join(root, 'dist'));
  write(root, 'dist/index.html', '<html></html>');
  assert.throws(() => checkDistFresh(root), /dist\/build-stamp\.txt is missing/);
});

test('the fingerprint depends on content, not on file times (a fresh clone with the same sources matches)', () => {
  const root = baseProject();
  const before = sourceFingerprint(root);
  const later = new Date(Date.now() + 86_400_000);
  for (const rel of ['src/app.ts', 'index.html', 'package.json']) fs.utimesSync(path.join(root, rel), later, later);
  assert.equal(sourceFingerprint(root), before);
});

test('tests, node_modules, dist and release do not change the fingerprint', () => {
  const root = baseProject();
  writeBuildStamp(root);
  write(root, 'src/app.test.ts', 'test');
  write(root, 'node_modules/pkg/index.js', 'x');
  write(root, 'release/app.asar', 'x');
  write(root, 'dist/assets/index.js', 'x');
  assert.doesNotThrow(() => checkDistFresh(root));
});
