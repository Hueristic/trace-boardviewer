'use strict';

// The two flavours of the packaged builds. "release" is what is published. "qa" is the same app with a different identity
// (appId, productName, output directory, artifact names) and the Electron inspector kept ON, so that the packaged QA runs
// (Playwright, scripts/packaged-functional-qa.cjs) and the Linux smoke (scripts/linux-smoke.cjs) can attach to the main process.
// A QA build is never published. The QA-runner refuses a QA app whose app.asar differs from the release app.asar in anything
// but the identity (compareAppAsar), so that the QA build tests the same code the release ships.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

const FLAVOURS = Object.freeze({
  release: Object.freeze({
    id: 'release', productName: 'TRACE Boardviewer', appId: 'hu.trace.boardviewer', artifactPrefix: 'TRACE-Boardviewer', executableName: 'trace-boardviewer',
    outputs: Object.freeze({ win: 'release', linux: 'release-linux', mac: 'release-mac' }),
    configs: Object.freeze({ win: 'package.json', linux: 'config/electron-builder.linux.yml', mac: 'config/electron-builder.mac.yml' }),
  }),
  qa: Object.freeze({
    id: 'qa', productName: 'TRACE Boardviewer QA', appId: 'hu.trace.boardviewer.qa', artifactPrefix: 'TRACE-Boardviewer-QA', executableName: 'trace-boardviewer-qa',
    outputs: Object.freeze({ win: 'release-qa', linux: 'release-qa-linux', mac: 'release-qa-mac' }),
    configs: Object.freeze({ win: 'config/electron-builder.qa.yml', linux: 'config/electron-builder.qa.linux.yml', mac: 'config/electron-builder.qa.mac.yml' }),
  }),
});

/** The flavour by its id ("release" or "qa"); anything else is refused, never guessed. */
function flavour(id = 'release') {
  if (!Object.hasOwn(FLAVOURS, id)) throw new Error(`unknown flavour "${id}": use release or qa`);
  return FLAVOURS[id];
}

/** The flavour named by the TRACE_FLAVOUR environment variable; unset means release. */
function flavourFromEnvironment(env = process.env) {
  return flavour(env.TRACE_FLAVOUR || 'release');
}

/** The identity fields that may differ between the QA and the release app.asar: the package.json inside it names the product. */
const IDENTITY_KEYS = Object.freeze(['productName', 'desktopName', 'build']);

function builderLibDirectory() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  return path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] }));
}

/**
 * The electronFuses one flavour is configured with for one platform: the Windows release reads the package.json "build" block,
 * every other case reads its YAML file (electron-builder ignores package.json when given --config).
 */
function expectedFuses(selected, platform, root = ROOT) {
  const file = selected.configs[platform];
  if (!file) throw new Error(`no ${platform} config for the ${selected.id} flavour`);
  if (file === 'package.json') return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.electronFuses;
  const yaml = require(require.resolve('js-yaml', { paths: [builderLibDirectory()] }));
  return yaml.load(fs.readFileSync(path.join(root, file), 'utf8')).electronFuses;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** The regular files of an asar archive, by their path inside it (forward slashes, sorted); directories are not files. */
function archiveFiles(asar, archive) {
  const { header } = asar.getRawHeader(archive);
  const names = [];
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, full); else names.push(full);
    }
  })(header, '');
  return names.sort();
}

/**
 * Compares the app.asar of a QA build with the release app.asar. Every file must be the same byte for byte (SHA-256), except
 * package.json, which may differ only in IDENTITY_KEYS. Returns { equal, differences } and never throws on a difference.
 */
function compareAppAsar(releaseAsar, qaAsar) {
  const asar = require(require.resolve('@electron/asar', { paths: [builderLibDirectory()] }));
  const releaseFiles = archiveFiles(asar, releaseAsar);
  const qaFiles = archiveFiles(asar, qaAsar);
  const differences = [];
  if (releaseFiles.join('\n') !== qaFiles.join('\n')) differences.push('the file lists differ');
  for (const name of releaseFiles) {
    if (!qaFiles.includes(name)) { differences.push(`${name} is missing from the QA app`); continue; }
    const releaseBytes = asar.extractFile(releaseAsar, name);
    const qaBytes = asar.extractFile(qaAsar, name);
    if (name === 'package.json') {
      const releaseJson = JSON.parse(releaseBytes.toString('utf8'));
      const qaJson = JSON.parse(qaBytes.toString('utf8'));
      const keys = [...new Set([...Object.keys(releaseJson), ...Object.keys(qaJson)])];
      for (const key of keys) {
        if (JSON.stringify(releaseJson[key]) === JSON.stringify(qaJson[key])) continue;
        if (!IDENTITY_KEYS.includes(key)) differences.push(`package.json field ${key} differs and is not identity`);
      }
    } else if (sha256(releaseBytes) !== sha256(qaBytes)) {
      differences.push(`${name} differs (SHA-256)`);
    }
  }
  return { equal: differences.length === 0, differences };
}

module.exports = Object.freeze({ FLAVOURS, flavour, flavourFromEnvironment, IDENTITY_KEYS, expectedFuses, compareAppAsar, sha256, builderLibDirectory });
