'use strict';

// The renderer and worker bundles come from `dist/`, which is not in git. A `dist/` built from other sources than the tree being
// packaged ships old UI code next to current catalogs (HUNT-WIN-20261011-09/10/11: English texts in a Hungarian UI).
// `vite build` records a content fingerprint of the renderer's inputs in dist/build-stamp.txt (vite.config.ts plugin), and
// scripts/before-pack.cjs (electron-builder beforePack) refuses to pack unless the stamp matches the current sources. Content
// hashes, not file times, so a fresh CI clone with the same sources passes whatever its checkout times are.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STAMP = path.join('dist', 'build-stamp.txt');
const INPUT_DIRS = ['src', 'shared', path.join('electron', 'locales')];
const INPUT_FILES = ['index.html', 'vite.config.ts', 'package.json'];
const INPUT_EXTENSIONS = /\.(?:ts|tsx|js|cjs|mjs|css|json|html|svg|png|jpe?g|webp|gif|woff2?|ttf|otf|wasm)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|cjs|mjs)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'release', 'coverage']);

/** Every renderer input file under the project, as project-relative POSIX paths in sorted order. */
function inputFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) walk(full); }
      else if (INPUT_EXTENSIONS.test(entry.name) && !TEST_FILE.test(entry.name)) files.push(full);
    }
  };
  for (const dir of INPUT_DIRS) { const full = path.join(root, dir); if (fs.existsSync(full)) walk(full); }
  for (const file of INPUT_FILES) { const full = path.join(root, file); if (fs.existsSync(full)) files.push(full); }
  return files.map(file => path.relative(root, file).split(path.sep).join('/')).sort();
}

/** SHA-256 over every renderer input's path and content: the same sources give the same fingerprint in any clone. */
function sourceFingerprint(root) {
  const hash = crypto.createHash('sha256');
  for (const rel of inputFiles(root)) {
    hash.update(rel).update('\0').update(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')).update('\n');
  }
  return hash.digest('hex');
}

/** Called by the vite build (closeBundle): records the fingerprint of the sources the bundle was built from. */
function writeBuildStamp(root) {
  const fingerprint = sourceFingerprint(root);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, STAMP), `${fingerprint}\n`);
  return fingerprint;
}

/** Throws unless dist/build-stamp.txt matches the current renderer sources. Returns the fingerprint it checked. */
function checkDistFresh(root) {
  const stampFile = path.join(root, STAMP);
  if (!fs.existsSync(stampFile)) throw new Error('dist/build-stamp.txt is missing: run the renderer build (vite build) before packaging');
  const stamp = fs.readFileSync(stampFile, 'utf8').trim();
  const current = sourceFingerprint(root);
  if (stamp !== current) throw new Error('dist/ was built from other sources than this tree: run the renderer build (vite build) before packaging, or the app ships stale UI code');
  return current;
}

module.exports = { checkDistFresh, sourceFingerprint, writeBuildStamp, inputFiles };
