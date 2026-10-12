'use strict';

// Licence register drift guard (LIC-02). THIRD_PARTY_NOTICES.md must name every production dependency and every package that
// reaches app.asar, and every licence file it links must exist. A new production dependency fails here until the register
// and its licence text are updated in the same change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const notices = read('THIRD_PARTY_NOTICES.md');

// The production dependencies, each with the name the register uses for it.
const PRODUCTION = {
  '@fontsource/ibm-plex-mono': 'IBM Plex Mono',
  '@fontsource/manrope': 'Manrope',
  'fast-xml-parser': 'fast-xml-parser',
  fflate: 'fflate',
  'lucide-react': 'Lucide React',
  'pdfjs-dist': 'pdfjs-dist',
  react: 'React',
  'react-dom': 'React DOM',
};

// Packages that reach app.asar through a production dependency (bundled by Vite), each named in the register.
const BUNDLED_TRANSITIVE = ['scheduler', 'anynum', 'fast-xml-builder', 'is-unsafe', 'path-expression-matcher', 'strnum', 'xml-naming', '@nodable/entities'];

test('the production dependencies are exactly the ones the register was written for', () => {
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), Object.keys(PRODUCTION).sort(),
    'a production dependency changed: update THIRD_PARTY_NOTICES.md (and its licence text) and this list together');
});

test('every production dependency is named in the register', () => {
  for (const [name, label] of Object.entries(PRODUCTION)) {
    assert.ok(notices.includes(label), `${name} (${label}) must be named in THIRD_PARTY_NOTICES.md`);
  }
});

test('every package bundled through a production dependency is named in the register', () => {
  for (const name of BUNDLED_TRANSITIVE) {
    assert.ok(notices.includes(name), `${name} reaches the renderer through a production dependency and must be named in THIRD_PARTY_NOTICES.md`);
  }
});

test('every licence file the register links exists in assets/licenses', () => {
  const links = [...notices.matchAll(/\]\((assets\/licenses\/[^)\s]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 30, 'the register links the licence texts it names');
  for (const link of links) {
    assert.ok(fs.existsSync(path.join(ROOT, link)), `${link} is linked by THIRD_PARTY_NOTICES.md but missing`);
  }
});

test('the Electron licence text and the bundled MIT texts are present and non-empty', () => {
  for (const file of ['electron-LICENSE.electron.txt', 'scheduler-MIT.txt', 'strnum-MIT.txt', 'anynum-MIT.txt', 'fast-xml-builder-MIT.txt',
    'is-unsafe-MIT.txt', 'path-expression-matcher-MIT.txt', 'xml-naming-MIT.txt']) {
    const text = read('assets', 'licenses', file);
    assert.ok(text.trim().length > 200, `assets/licenses/${file} must be the upstream licence text`);
  }
  assert.match(read('assets', 'licenses', 'electron-LICENSE.electron.txt'), /Copyright \(c\) Electron contributors/);
});
