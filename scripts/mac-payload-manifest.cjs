#!/usr/bin/env node
'use strict';

// Manifest of the macOS app bundle and the check that the published ZIP holds exactly that bundle, built from the commit
// the ZIP was built from. The Windows counterpart is scripts/payload-manifest.cjs. A macOS bundle needs more than a list of
// regular files: it has symbolic links (recorded by their target, never followed), directories and executables (the
// executable bit is recorded).
//
// Usage:
//   node scripts/mac-payload-manifest.cjs generate   --app <TRACE Boardviewer.app> --commit <sha> --out <manifest.json>
//   node scripts/mac-payload-manifest.cjs provenance --zip <zip> --manifest <manifest.json> --commit <sha> --run-id <id> --run-attempt <n> --out <provenance.json>
//   node scripts/mac-payload-manifest.cjs verify     --manifest <manifest.json> --provenance <provenance.json> --zip <zip> --commit <sha> [--app <extracted .app>]
//
// generate:   walks the bundle and writes { schema, app, commit, fileCount, linkCount, dirCount, totalBytes, manifestDigest,
//             entries }. A walk that is incomplete (a directory that cannot be listed, an entry that cannot be read, a
//             special file, an unsafe name) fails the run: a manifest with holes proves nothing.
// provenance: writes { schema, commit, zip: { name, sha256, size }, manifest: { name, digest, fileCount, totalBytes },
//             run: { id, attempt } }. It binds the ZIP's SHA-256 to the commit the manifest was made for.
// verify:     checks the manifest against its own digest, the provenance record against the ZIP and the commit and, with
//             --app, every entry of the extracted bundle (SHA-256, size, executable bit, link target, no extra entry).
//
// Exit codes: 0 every check passed; 1 a check failed (every mismatch is printed); 2 usage error.
// No dependencies beyond Node. Files are hashed as streams.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 'trace-mac-payload-manifest/1';
const PROVENANCE_SCHEMA = 'trace-mac-provenance/1';
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RUN_ATTEMPT_RE = /^[1-9][0-9]*$/;
const ENTRY_TYPES = Object.freeze(['file', 'link', 'dir']);
const DIFF_LIMIT = 10;
const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2 });
const USAGE = [
  'Usage:',
  '  node scripts/mac-payload-manifest.cjs generate --app <.app> --commit <sha> --out <manifest.json>',
  '  node scripts/mac-payload-manifest.cjs provenance --zip <zip> --manifest <manifest.json> --commit <sha> --run-id <id> --run-attempt <n> --out <provenance.json>',
  '  node scripts/mac-payload-manifest.cjs verify --manifest <manifest.json> --provenance <provenance.json> --zip <zip> --commit <sha> [--app <extracted .app>]',
].join('\n');
const FLAGS = Object.freeze({
  generate: Object.freeze({ required: ['--app', '--commit', '--out'], optional: [] }),
  provenance: Object.freeze({ required: ['--zip', '--manifest', '--commit', '--run-id', '--run-attempt', '--out'], optional: [] }),
  verify: Object.freeze({ required: ['--manifest', '--provenance', '--zip', '--commit'], optional: ['--app'] }),
});

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}
class ManifestError extends Error {
  constructor(message) { super(message); this.name = 'ManifestError'; }
}

const defaultApi = Object.freeze({
  lstat: fsp.lstat, readdir: fsp.readdir, readlink: fsp.readlink, createReadStream: fs.createReadStream,
});

const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortEntries = (entries) => entries.slice().sort((a, b) => compareCodeUnits(a.path, b.path));
const isGone = (error) => !!error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/** A name that can be written into a manifest without ambiguity: no separator, no backslash, no control character. */
function isSafeName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\\u0000-\u001f\u007f]/.test(name);
}

/** A relative POSIX path made of safe names only. */
function isSafeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.split('/').every(isSafeName);
}

/** Streaming SHA-256 of one file, with the number of bytes streamed. */
async function hashStream(file, api = defaultApi) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of api.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

/** One entry as a canonical JSON line: the same bytes for the same bundle on any machine. */
function entryLine(entry) {
  if (entry.type === 'file') return [entry.path, 'file', entry.size, entry.sha256, entry.executable ? 1 : 0];
  if (entry.type === 'link') return [entry.path, 'link', entry.target];
  return [entry.path, 'dir'];
}

function digestEntries(entries) {
  const hash = crypto.createHash('sha256');
  hash.update(`${SCHEMA}\n`);
  for (const entry of sortEntries(entries)) hash.update(`${JSON.stringify(entryLine(entry))}\n`);
  return hash.digest('hex');
}

function countEntries(entries) {
  const files = entries.filter((entry) => entry.type === 'file');
  return {
    fileCount: files.length,
    linkCount: entries.filter((entry) => entry.type === 'link').length,
    dirCount: entries.filter((entry) => entry.type === 'dir').length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
  };
}

/** The manifest object of described entries. Throws ManifestError for a bad commit, an unsafe name or a duplicate path. */
function buildManifest({ app, commit, entries }) {
  if (!COMMIT_RE.test(commit)) throw new ManifestError('the commit must be a full lowercase 40-character SHA');
  if (!isSafeName(app)) throw new ManifestError(`unsafe bundle name: ${JSON.stringify(app)}`);
  const sorted = sortEntries(entries);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].path === sorted[index - 1].path) throw new ManifestError(`duplicate entry: ${sorted[index].path}`);
  }
  return { schema: SCHEMA, app, commit, ...countEntries(sorted), manifestDigest: digestEntries(sorted), entries: sorted };
}

/** Every entry below `root`, found without following a symbolic link. A directory that cannot be listed is reported. */
async function walkBundle(root, api) {
  const found = [];
  const problems = [];
  const pending = [{ full: root, rel: '' }];
  while (pending.length) {
    const { full, rel } = pending.pop();
    let children;
    try { children = await api.readdir(full, { withFileTypes: true }); } catch (error) {
      problems.push(`${rel || '.'} (${(error && error.code) || 'ERROR'})`);
      continue;
    }
    for (const child of children) {
      const entry = { path: rel ? `${rel}/${child.name}` : child.name, full: path.join(full, child.name) };
      if (child.isSymbolicLink()) found.push({ ...entry, kind: 'link' });
      else if (child.isDirectory()) {
        found.push({ ...entry, kind: 'dir' });
        pending.push({ full: entry.full, rel: entry.path });
      } else if (child.isFile()) found.push({ ...entry, kind: 'file' });
      else found.push({ ...entry, kind: 'other' });
    }
  }
  return { found, problems };
}

/** The manifest entry of one walked entry. Throws ManifestError for anything that cannot be described exactly. */
async function describeEntry(entry, api) {
  if (!isSafeRelativePath(entry.path)) throw new ManifestError(`unsafe entry name: ${JSON.stringify(entry.path)}`);
  if (entry.kind === 'dir') return { path: entry.path, type: 'dir' };
  if (entry.kind === 'link') {
    const target = await api.readlink(entry.full);
    if (typeof target !== 'string' || target === '') throw new ManifestError(`empty link target: ${entry.path}`);
    return { path: entry.path, type: 'link', target };
  }
  if (entry.kind === 'file') {
    const info = await api.lstat(entry.full);
    const { sha256, bytes } = await hashStream(entry.full, api);
    if (bytes !== info.size) throw new ManifestError(`changed while it was read: ${entry.path}`);
    return { path: entry.path, type: 'file', size: info.size, sha256, executable: (info.mode & 0o111) !== 0 };
  }
  throw new ManifestError(`not a regular file, a directory or a symbolic link: ${entry.path}`);
}

/** Describes every entry below `root`. Any failure is listed; nothing is left out silently. */
async function describeTree(root, api) {
  const walked = await walkBundle(root, api);
  if (walked.problems.length) {
    throw new ManifestError(`directories could not be listed: ${walked.problems.slice(0, DIFF_LIMIT).join(', ')}`);
  }
  const entries = [];
  const failures = [];
  for (const entry of walked.found) {
    try { entries.push(await describeEntry(entry, api)); } catch (error) {
      if (error instanceof ManifestError) failures.push(error.message);
      else failures.push(`${entry.path} (${isGone(error) ? 'vanished while it was read' : (error && error.code) || 'ERROR'})`);
    }
  }
  if (failures.length) {
    throw new ManifestError(`${failures.length} entries could not be described: ${failures.slice(0, DIFF_LIMIT).join('; ')}`);
  }
  return sortEntries(entries);
}

/** The manifest of a bundle directory at the given commit. Throws ManifestError when the walk is incomplete. */
async function generateManifest({ appDir, commit, api = defaultApi }) {
  const info = await api.lstat(appDir).catch((error) => {
    if (isGone(error)) return null;
    throw error;
  });
  if (!info || !info.isDirectory()) throw new ManifestError(`bundle directory not found: ${appDir}`);
  const entries = await describeTree(appDir, api);
  if (!entries.some((entry) => entry.path === 'Contents/Info.plist' && entry.type === 'file')) {
    throw new ManifestError('the bundle has no Contents/Info.plist, so it is not an app bundle');
  }
  return buildManifest({ app: path.basename(appDir), commit, entries });
}

/** Everything wrong with a manifest object (an empty list means valid and internally consistent). Never throws. */
function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['the manifest is not a JSON object'];
  if (manifest.schema !== SCHEMA) problems.push(`schema is ${JSON.stringify(manifest.schema)}, expected "${SCHEMA}"`);
  if (typeof manifest.commit !== 'string' || !COMMIT_RE.test(manifest.commit)) problems.push('the manifest commit is not a full lowercase SHA');
  if (!isSafeName(manifest.app)) problems.push(`the bundle name is unsafe: ${JSON.stringify(manifest.app)}`);
  if (!Array.isArray(manifest.entries)) return problems.concat(['entries is not an array']);
  let wellFormed = true;
  manifest.entries.forEach((entry, index) => {
    const where = `entries[${index}]`;
    if (!entry || typeof entry !== 'object' || !isSafeRelativePath(entry.path) || !ENTRY_TYPES.includes(entry.type)) {
      problems.push(`${where} has no valid path or type`);
      wellFormed = false;
      return;
    }
    if (entry.type === 'file') {
      const ok = Number.isSafeInteger(entry.size) && entry.size >= 0 && typeof entry.sha256 === 'string'
        && SHA256_RE.test(entry.sha256) && typeof entry.executable === 'boolean';
      if (!ok) { problems.push(`${where} (${entry.path}) is not a well-formed file entry`); wellFormed = false; }
    } else if (entry.type === 'link' && (typeof entry.target !== 'string' || entry.target === '')) {
      problems.push(`${where} (${entry.path}) has no link target`);
      wellFormed = false;
    }
  });
  if (wellFormed) {
    for (let index = 1; index < manifest.entries.length; index++) {
      if (compareCodeUnits(manifest.entries[index - 1].path, manifest.entries[index].path) >= 0) {
        problems.push(`entries are not strictly sorted at "${manifest.entries[index].path}"`);
        break;
      }
    }
    const counts = countEntries(manifest.entries);
    for (const key of Object.keys(counts)) {
      if (manifest[key] !== counts[key]) problems.push(`${key} is ${JSON.stringify(manifest[key])}, the entries give ${counts[key]}`);
    }
    if (manifest.manifestDigest !== digestEntries(manifest.entries)) problems.push('manifestDigest does not match the entries');
  }
  return problems;
}

/** The provenance record: the ZIP's SHA-256 and size, bound to the commit and to the manifest digest. */
function buildProvenance({ manifest, manifestName, zip, run }) {
  return {
    schema: PROVENANCE_SCHEMA,
    commit: manifest.commit,
    zip: { name: zip.name, sha256: zip.sha256, size: zip.size },
    manifest: { name: manifestName, digest: manifest.manifestDigest, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes },
    run: { id: String(run.id), attempt: Number(run.attempt) },
    generator: 'scripts/mac-payload-manifest.cjs',
  };
}

/** Everything wrong with a provenance record for this ZIP, this manifest and this expected commit. Never throws. */
function checkProvenance({ provenance, manifest, zip, commit }) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return ['the provenance record is not a JSON object'];
  const problems = [];
  const zipRecord = provenance.zip && typeof provenance.zip === 'object' ? provenance.zip : {};
  const manifestRecord = provenance.manifest && typeof provenance.manifest === 'object' ? provenance.manifest : {};
  const run = provenance.run && typeof provenance.run === 'object' ? provenance.run : {};
  if (provenance.schema !== PROVENANCE_SCHEMA) problems.push(`provenance schema is ${JSON.stringify(provenance.schema)}, expected "${PROVENANCE_SCHEMA}"`);
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) problems.push('the expected commit is not a full lowercase SHA');
  if (provenance.commit !== commit) problems.push(`provenance commit ${JSON.stringify(provenance.commit)} is not the expected commit ${commit}`);
  if (manifest.commit !== commit) problems.push(`manifest commit ${manifest.commit} is not the expected commit ${commit}`);
  if (zipRecord.name !== zip.name) problems.push(`ZIP name differs: ${JSON.stringify(zip.name)} vs ${JSON.stringify(zipRecord.name)} in the record`);
  if (zipRecord.sha256 !== zip.sha256) problems.push(`ZIP SHA-256 differs from the record: ${zip.sha256} vs ${zipRecord.sha256}`);
  if (zipRecord.size !== zip.size) problems.push(`ZIP size differs from the record: ${zip.size} vs ${zipRecord.size}`);
  if (manifestRecord.digest !== manifest.manifestDigest) problems.push('the manifest digest differs from the provenance record');
  if (typeof run.id !== 'string' || run.id === '') problems.push('the run id is missing from the provenance record');
  if (!Number.isSafeInteger(run.attempt) || run.attempt < 1) problems.push('the run attempt is missing from the provenance record');
  return problems;
}

/** The differences between a manifest and an extracted bundle. An empty list means the bundle is exactly the manifest. */
async function compareBundle({ manifest, appDir, api = defaultApi }) {
  const problems = [];
  if (path.basename(appDir) !== manifest.app) problems.push(`the bundle is named "${path.basename(appDir)}", the manifest says "${manifest.app}"`);
  let actual;
  try { actual = await describeTree(appDir, api); } catch (error) { return problems.concat([error.message]); }
  const found = new Map(actual.map((entry) => [entry.path, entry]));
  const expected = new Set(manifest.entries.map((entry) => entry.path));
  for (const entry of manifest.entries) {
    const got = found.get(entry.path);
    if (!got) { problems.push(`missing: ${entry.path}`); continue; }
    if (got.type !== entry.type) { problems.push(`type differs: ${entry.path} (manifest ${entry.type}, bundle ${got.type})`); continue; }
    if (entry.type === 'file') {
      if (got.size !== entry.size) problems.push(`size differs: ${entry.path} (${entry.size} -> ${got.size})`);
      else if (got.sha256 !== entry.sha256) problems.push(`content differs: ${entry.path}`);
      if (got.executable !== entry.executable) problems.push(`executable bit differs: ${entry.path}`);
    } else if (entry.type === 'link' && got.target !== entry.target) {
      problems.push(`link target differs: ${entry.path} (${entry.target} -> ${got.target})`);
    }
  }
  for (const entry of actual) if (!expected.has(entry.path)) problems.push(`unexpected: ${entry.path}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

/** Parses `<command> --flag value` or `--flag=value`. Unknown and repeated flags are usage errors. */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError('A command is required: generate, provenance or verify.');
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) throw new UsageError(`Unknown command: ${command}`);
  const spec = FLAGS[command];
  const allowed = [...spec.required, ...spec.optional];
  const values = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const equals = arg.indexOf('=');
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    if (!allowed.includes(flag)) throw new UsageError(`Unknown argument: ${arg}`);
    if (Object.prototype.hasOwnProperty.call(values, flag)) throw new UsageError(`Repeated argument: ${flag}`);
    if (equals > 0) values[flag] = arg.slice(equals + 1);
    else {
      if (index + 1 >= rest.length) throw new UsageError(`${flag} needs a value.`);
      values[flag] = rest[++index];
    }
  }
  for (const flag of spec.required) {
    if (!Object.prototype.hasOwnProperty.call(values, flag) || values[flag] === '') throw new UsageError(`${flag} is required.`);
  }
  return { command, values };
}

async function writeJson(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch (error) { throw new ManifestError(`cannot read ${file}: ${(error && error.code) || error.message}`); }
  try { return JSON.parse(text); } catch (error) { throw new ManifestError(`${file} is not JSON: ${error.message}`); }
}

/** Name, SHA-256 and size of a file, as the provenance record and the verifier see it. */
async function fileRecord(file) {
  const { sha256, bytes } = await hashStream(file);
  return { name: path.basename(file), sha256, size: bytes };
}

async function runGenerate(values, { api, log }) {
  const appDir = path.resolve(values['--app']);
  const out = path.resolve(values['--out']);
  if (out === appDir || out.startsWith(`${appDir}${path.sep}`)) throw new ManifestError('--out must be outside the bundle (the manifest would otherwise list itself)');
  const manifest = await generateManifest({ appDir, commit: values['--commit'], api });
  await writeJson(out, manifest);
  log(`mac payload manifest of ${manifest.app}: ${manifest.fileCount} files, ${manifest.linkCount} links, ${manifest.dirCount} directories, ${manifest.totalBytes} bytes`);
  log(`  commit ${manifest.commit}`);
  log(`  manifestDigest ${manifest.manifestDigest}`);
  log(`  written to ${out}`);
  return EXIT.OK;
}

async function runProvenance(values, { log }) {
  const manifestPath = path.resolve(values['--manifest']);
  const manifest = await readJson(manifestPath);
  const problems = validateManifest(manifest);
  if (problems.length) throw new ManifestError(`the manifest is not valid: ${problems.slice(0, DIFF_LIMIT).join('; ')}`);
  if (manifest.commit !== values['--commit']) throw new ManifestError(`the manifest was made for commit ${manifest.commit}, not ${values['--commit']}`);
  if (!RUN_ATTEMPT_RE.test(values['--run-attempt'])) throw new ManifestError('--run-attempt must be a positive whole number');
  const zip = await fileRecord(path.resolve(values['--zip']));
  const provenance = buildProvenance({
    manifest, manifestName: path.basename(manifestPath), zip, run: { id: values['--run-id'], attempt: values['--run-attempt'] },
  });
  const out = path.resolve(values['--out']);
  await writeJson(out, provenance);
  log(`provenance: commit ${provenance.commit}, ZIP ${zip.name} sha256 ${zip.sha256} (${zip.size} bytes)`);
  log(`  manifest digest ${provenance.manifest.digest}`);
  log(`  written to ${out}`);
  return EXIT.OK;
}

async function runVerify(values, { api, log, error }) {
  const commit = values['--commit'];
  const problems = [];
  let manifest = null;
  let provenance = null;
  let zip = null;
  try { manifest = await readJson(path.resolve(values['--manifest'])); } catch (problem) { problems.push(problem.message); }
  if (manifest) problems.push(...validateManifest(manifest));
  try { provenance = await readJson(path.resolve(values['--provenance'])); } catch (problem) { problems.push(problem.message); }
  try { zip = await fileRecord(path.resolve(values['--zip'])); } catch (problem) { problems.push(`cannot read the ZIP: ${problem.message}`); }
  if (manifest && provenance && zip) problems.push(...checkProvenance({ provenance, manifest, zip, commit }));
  if (manifest && values['--app']) {
    problems.push(...(await compareBundle({ manifest, appDir: path.resolve(values['--app']), api })));
  }
  if (problems.length) {
    error(`FAIL: ${problems.length} problem(s)`);
    for (const problem of problems.slice(0, DIFF_LIMIT)) error(`  ${problem}`);
    if (problems.length > DIFF_LIMIT) error(`  ... and ${problems.length - DIFF_LIMIT} more`);
    return EXIT.FAIL;
  }
  log(`PASS: manifest ${manifest.app}: ${manifest.fileCount} files, ${manifest.linkCount} links, ${manifest.dirCount} directories, digest ${manifest.manifestDigest}`);
  log(`  provenance: commit ${commit}, ZIP ${zip.name} sha256 ${zip.sha256}`);
  if (values['--app']) log(`  bundle: every entry of ${path.basename(path.resolve(values['--app']))} matches the manifest`);
  return EXIT.OK;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const error = deps.error || ((line) => console.error(line));
  const api = deps.api || defaultApi;
  let parsed;
  try { parsed = parseArgs(argv); } catch (problem) {
    error(`${problem.message}\n${USAGE}`);
    return EXIT.USAGE;
  }
  try {
    if (parsed.command === 'generate') return await runGenerate(parsed.values, { api, log });
    if (parsed.command === 'provenance') return await runProvenance(parsed.values, { log });
    return await runVerify(parsed.values, { api, log, error });
  } catch (problem) {
    error(`mac-payload-manifest ${parsed.command} failed: ${problem.message}`);
    return EXIT.FAIL;
  }
}

module.exports = Object.freeze({
  SCHEMA, PROVENANCE_SCHEMA, COMMIT_RE, ENTRY_TYPES, DIFF_LIMIT, EXIT, USAGE, UsageError, ManifestError, defaultApi,
  isSafeName, isSafeRelativePath, hashStream, digestEntries, countEntries, buildManifest, walkBundle, describeTree,
  generateManifest, validateManifest, buildProvenance, checkProvenance, compareBundle, parseArgs, fileRecord, main,
});

if (require.main === module) {
  main().then((code) => { process.exit(code); }, (problem) => { console.error(problem); process.exit(EXIT.FAIL); });
}
