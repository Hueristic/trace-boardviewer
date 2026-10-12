'use strict';

// Unit tests (no macOS, no network, no Electron) for scripts/mac-payload-manifest.cjs: the manifest of a macOS app bundle,
// its validation, the provenance record that binds the ZIP's SHA-256 to a commit, the comparison of an extracted bundle with
// its manifest, and the command line. Most cases run on an in-memory bundle, so symbolic links and the executable bit are
// tested on every platform; a few cases use real files and one real symbolic link (skipped where the system refuses one).
//
//   node --test tests/mac-payload-manifest-checks.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mpm = require('../scripts/mac-payload-manifest.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'mac-payload-manifest.cjs');
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const ROOT = path.join(os.tmpdir(), 'trace-fake-bundle', 'TRACE Boardviewer.app');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** A bundle that lives only in memory. `files` maps a relative path to { content, exec } or { link } or { fifo }. */
function fakeBundle(root, files, { unreadable = new Set() } = {}) {
  const nodes = new Map();
  const dirs = new Set([root]);
  for (const [rel, spec] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    nodes.set(full, spec);
    for (let parent = path.dirname(full); parent.length > root.length; parent = path.dirname(parent)) dirs.add(parent);
  }
  const kindOf = (full) => {
    if (dirs.has(full)) return 'dir';
    const spec = nodes.get(full);
    if (!spec) return null;
    if (spec.link !== undefined) return 'link';
    if (spec.fifo) return 'fifo';
    return 'file';
  };
  const error = (code, full) => Object.assign(new Error(`${code}: ${full}`), { code });
  const statOf = (kind, size, mode) => ({
    size, mode, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link',
  });
  return {
    async lstat(full) {
      const kind = kindOf(full);
      if (!kind) throw error('ENOENT', full);
      if (kind === 'dir') return statOf('dir', 0, 0o755);
      if (kind === 'link') return statOf('link', 0, 0o777);
      if (kind === 'fifo') return statOf('fifo', 0, 0o644);
      const spec = nodes.get(full);
      return statOf('file', Buffer.byteLength(spec.content ?? ''), spec.exec ? 0o755 : 0o644);
    },
    async readdir(full) {
      if (unreadable.has(full)) throw error('EACCES', full);
      if (!dirs.has(full)) throw error('ENOTDIR', full);
      const names = new Set();
      for (const child of [...nodes.keys(), ...dirs]) if (child !== root && path.dirname(child) === full) names.add(path.basename(child));
      return [...names].sort().map((name) => {
        const kind = kindOf(path.join(full, name));
        return { name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' };
      });
    },
    async readlink(full) {
      const spec = nodes.get(full);
      if (!spec || spec.link === undefined) throw error('EINVAL', full);
      return spec.link;
    },
    createReadStream(full) {
      const bytes = Buffer.from(nodes.get(full).content ?? '');
      return (async function* () { yield bytes; })();
    },
  };
}

const SAMPLE = {
  'Contents/Info.plist': { content: '<plist/>' },
  'Contents/MacOS/TRACE Boardviewer': { content: 'binary-v1', exec: true },
  'Contents/Resources/app.asar': { content: 'asar-bytes' },
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework': { content: 'framework', exec: true },
  'Contents/Frameworks/Electron Framework.framework/Versions/Current': { link: 'A' },
  'Contents/Frameworks/Electron Framework.framework/Electron Framework': { link: 'Versions/Current/Electron Framework' },
};

const manifestOf = (files, commit = COMMIT, root = ROOT) => mpm.generateManifest({ appDir: root, commit, api: fakeBundle(root, files) });
const cloneJson = (value) => JSON.parse(JSON.stringify(value));

test('generate lists every entry in code-unit order, with sizes, hashes, the executable bit and link targets', async () => {
  const manifest = await manifestOf(SAMPLE);
  const paths = manifest.entries.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort(), 'entries are in plain code-unit order');
  assert.equal(manifest.app, 'TRACE Boardviewer.app');
  assert.equal(manifest.commit, COMMIT);
  const binary = manifest.entries.find((entry) => entry.path === 'Contents/MacOS/TRACE Boardviewer');
  assert.deepEqual(binary, { path: 'Contents/MacOS/TRACE Boardviewer', type: 'file', size: 'binary-v1'.length, sha256: sha256('binary-v1'), executable: true });
  const current = manifest.entries.find((entry) => entry.path.endsWith('/Versions/Current'));
  assert.deepEqual(current, { path: 'Contents/Frameworks/Electron Framework.framework/Versions/Current', type: 'link', target: 'A' });
  assert.deepEqual(manifest.entries.find((entry) => entry.path === 'Contents/MacOS'), { path: 'Contents/MacOS', type: 'dir' });
  assert.equal(manifest.fileCount, 4);
  assert.equal(manifest.linkCount, 2);
  assert.equal(manifest.dirCount, 7);
  assert.equal(manifest.totalBytes, '<plist/>'.length + 'binary-v1'.length + 'asar-bytes'.length + 'framework'.length);
  assert.deepEqual(mpm.validateManifest(manifest), [], 'a generated manifest is valid');
});

test('the digest changes with any content, mode, link target or added entry, and not when the same tree is read again', async () => {
  const base = (await manifestOf(SAMPLE)).manifestDigest;
  assert.equal((await manifestOf(SAMPLE)).manifestDigest, base, 'the same bundle gives the same digest');
  const changed = [
    { ...SAMPLE, 'Contents/Resources/app.asar': { content: 'asar-bytex' } },
    { ...SAMPLE, 'Contents/MacOS/TRACE Boardviewer': { content: 'binary-v1', exec: false } },
    { ...SAMPLE, 'Contents/Frameworks/Electron Framework.framework/Versions/Current': { link: 'B' } },
    { ...SAMPLE, 'Contents/Resources/extra.txt': { content: '' } },
  ];
  for (const files of changed) assert.notEqual((await manifestOf(files)).manifestDigest, base);
});

test('generate refuses an incomplete or unsafe bundle instead of writing a manifest with holes', async () => {
  const absent = { ...fakeBundle(ROOT, SAMPLE), lstat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  await assert.rejects(mpm.generateManifest({ appDir: ROOT, commit: COMMIT, api: absent }), /bundle directory not found/);
  await assert.rejects(manifestOf({ 'Contents/MacOS/x': { content: 'x' } }), /no Contents\/Info\.plist/);
  const unreadable = new Set([path.join(ROOT, 'Contents', 'MacOS')]);
  await assert.rejects(mpm.generateManifest({ appDir: ROOT, commit: COMMIT, api: fakeBundle(ROOT, SAMPLE, { unreadable }) }), /could not be listed/);
  await assert.rejects(manifestOf({ ...SAMPLE, 'Contents/weird': { fifo: true } }), /not a regular file/);
  await assert.rejects(manifestOf({ ...SAMPLE, 'Contents/bad\nname': { content: 'x' } }), /unsafe entry name/);
  await assert.rejects(manifestOf(SAMPLE, 'xyz'), /full lowercase 40-character SHA/);
});

test('validateManifest accepts a generated manifest and refuses each kind of tampering', async () => {
  const base = cloneJson(await manifestOf(SAMPLE));
  const refuses = (mutate, pattern) => {
    const copy = cloneJson(base);
    mutate(copy);
    const problems = mpm.validateManifest(copy);
    assert.ok(problems.some((problem) => pattern.test(problem)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
  };
  assert.deepEqual(mpm.validateManifest(base), []);
  refuses((m) => { m.schema = 'trace-payload-manifest/1'; }, /schema is/);
  refuses((m) => { m.manifestDigest = '0'.repeat(64); }, /manifestDigest does not match/);
  refuses((m) => { [m.entries[0], m.entries[1]] = [m.entries[1], m.entries[0]]; }, /not strictly sorted/);
  refuses((m) => { m.entries.push(cloneJson(m.entries[0])); }, /not strictly sorted|fileCount|linkCount|dirCount|totalBytes|manifestDigest/);
  refuses((m) => { m.fileCount += 1; }, /fileCount is/);
  refuses((m) => { m.entries.find((entry) => entry.type === 'file').sha256 = 'XYZ'; }, /not a well-formed file entry/);
  refuses((m) => { m.entries[0].path = '../evil'; }, /no valid path or type/);
  refuses((m) => { m.commit = 'abc'; }, /full lowercase SHA/);
  refuses((m) => { m.entries.find((entry) => entry.type === 'link').target = ''; }, /has no link target/);
});

test('compareBundle passes an identical bundle and reports every kind of difference', async () => {
  const manifest = await manifestOf(SAMPLE);
  const compare = (files, root = ROOT) => mpm.compareBundle({ manifest, appDir: root, api: fakeBundle(root, files) });
  assert.deepEqual(await compare(SAMPLE), []);
  const expectOne = async (files, pattern) => {
    const problems = await compare(files);
    assert.ok(problems.some((problem) => pattern.test(problem)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
  };
  await expectOne({ ...SAMPLE, 'Contents/Resources/app.asar': { content: 'asar-bytex' } }, /content differs: Contents\/Resources\/app\.asar/);
  await expectOne({ ...SAMPLE, 'Contents/Resources/app.asar': { content: 'asar-bytes-more' } }, /size differs: Contents\/Resources\/app\.asar/);
  await expectOne({ ...SAMPLE, 'Contents/MacOS/TRACE Boardviewer': { content: 'binary-v1', exec: false } }, /executable bit differs: Contents\/MacOS\/TRACE Boardviewer/);
  await expectOne({ ...SAMPLE, 'Contents/Frameworks/Electron Framework.framework/Versions/Current': { link: 'B' } }, /link target differs: .*Versions\/Current/);
  const withoutAsar = { ...SAMPLE };
  delete withoutAsar['Contents/Resources/app.asar'];
  await expectOne(withoutAsar, /missing: Contents\/Resources\/app\.asar/);
  await expectOne({ ...SAMPLE, 'Contents/Resources/extra.txt': { content: '' } }, /unexpected: Contents\/Resources\/extra\.txt/);
  await expectOne({ ...SAMPLE, 'Contents/Resources/app.asar': { link: 'x' } }, /type differs: Contents\/Resources\/app\.asar/);
  const other = path.join(os.tmpdir(), 'trace-fake-bundle', 'Other.app');
  const named = await mpm.compareBundle({ manifest, appDir: other, api: fakeBundle(other, SAMPLE) });
  assert.ok(named.some((problem) => /named "Other\.app"/.test(problem)));
});

test('provenance binds the ZIP hash and the commit: every mismatch is reported', async () => {
  const manifest = await manifestOf(SAMPLE);
  const zip = { name: 'TRACE-Boardviewer-1.3.1-mac-arm64.zip', sha256: 'c'.repeat(64), size: 1234 };
  const provenance = mpm.buildProvenance({ manifest, manifestName: 'mac-payload-manifest.json', zip, run: { id: '987', attempt: 1 } });
  assert.deepEqual(mpm.checkProvenance({ provenance, manifest, zip, commit: COMMIT }), []);
  const expectProblem = (problems, pattern) => assert.ok(problems.some((problem) => pattern.test(problem)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
  expectProblem(mpm.checkProvenance({ provenance, manifest, zip, commit: OTHER_COMMIT }), /is not the expected commit/);
  expectProblem(mpm.checkProvenance({ provenance, manifest, zip: { ...zip, sha256: 'd'.repeat(64) }, commit: COMMIT }), /ZIP SHA-256 differs/);
  expectProblem(mpm.checkProvenance({ provenance, manifest, zip: { ...zip, size: 1235 }, commit: COMMIT }), /ZIP size differs/);
  expectProblem(mpm.checkProvenance({ provenance, manifest, zip: { ...zip, name: 'other.zip' }, commit: COMMIT }), /ZIP name differs/);
  const tampered = cloneJson(provenance);
  tampered.manifest.digest = '0'.repeat(64);
  expectProblem(mpm.checkProvenance({ provenance: tampered, manifest, zip, commit: COMMIT }), /manifest digest differs/);
  const wrongCommit = cloneJson(provenance);
  wrongCommit.commit = OTHER_COMMIT;
  expectProblem(mpm.checkProvenance({ provenance: wrongCommit, manifest, zip, commit: COMMIT }), /provenance commit/);
  const wrongSchema = cloneJson(provenance);
  wrongSchema.schema = 'nope';
  expectProblem(mpm.checkProvenance({ provenance: wrongSchema, manifest, zip, commit: COMMIT }), /provenance schema/);
  const noRun = cloneJson(provenance);
  delete noRun.run.id;
  expectProblem(mpm.checkProvenance({ provenance: noRun, manifest, zip, commit: COMMIT }), /run id is missing/);
  const attemptZero = cloneJson(provenance);
  attemptZero.run.attempt = 0;
  expectProblem(mpm.checkProvenance({ provenance: attemptZero, manifest, zip, commit: COMMIT }), /run attempt is missing/);
});

test('parseArgs accepts both flag forms and reports every usage error', () => {
  const ok = mpm.parseArgs(['verify', '--manifest', 'm.json', '--provenance=p.json', '--zip', 'z.zip', '--commit', COMMIT]);
  assert.equal(ok.command, 'verify');
  assert.equal(ok.values['--provenance'], 'p.json');
  assert.throws(() => mpm.parseArgs([]), mpm.UsageError);
  assert.throws(() => mpm.parseArgs(['sign']), /Unknown command/);
  assert.throws(() => mpm.parseArgs(['verify', '--nope', 'x']), /Unknown argument/);
  assert.throws(() => mpm.parseArgs(['verify', '--zip', 'a', '--zip', 'b']), /Repeated argument/);
  assert.throws(() => mpm.parseArgs(['verify', '--zip']), /needs a value/);
  assert.throws(() => mpm.parseArgs(['verify', '--zip', 'a']), /is required/);
});

/** A real bundle in a fresh temporary directory, with the same files as SAMPLE (plus one link where the system allows it). */
function realBundle({ withLink = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-payload-manifest-'));
  const app = path.join(tmp, 'TRACE Boardviewer.app');
  for (const [rel, spec] of Object.entries(SAMPLE)) {
    if (spec.link !== undefined) continue;
    const full = path.join(app, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, spec.content);
  }
  let linked = false;
  if (withLink) {
    try { fs.symlinkSync('A', path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'Current')); linked = true; } catch { linked = false; }
  }
  return { tmp, app, linked };
}

test('real files: generate and compare pass; one changed byte is reported', async (t) => {
  const { tmp, app } = realBundle();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const manifest = await mpm.generateManifest({ appDir: app, commit: COMMIT });
  assert.deepEqual(await mpm.compareBundle({ manifest, appDir: app }), []);
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), 'asar-bytex');
  const problems = await mpm.compareBundle({ manifest, appDir: app });
  assert.ok(problems.some((problem) => /content differs: Contents\/Resources\/app\.asar/.test(problem)), JSON.stringify(problems));
});

test('real files: a symbolic link is recorded by its target and never followed (skipped where the system refuses links)', async (t) => {
  const { tmp, app, linked } = realBundle({ withLink: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  if (!linked) { t.skip('this system does not allow creating a symbolic link'); return; }
  const manifest = await mpm.generateManifest({ appDir: app, commit: COMMIT });
  const link = manifest.entries.find((entry) => entry.path.endsWith('/Versions/Current'));
  assert.deepEqual(link, { path: 'Contents/Frameworks/Electron Framework.framework/Versions/Current', type: 'link', target: 'A' });
  assert.deepEqual(await mpm.compareBundle({ manifest, appDir: app }), []);
});

test('command line: usage errors exit 2; generate, provenance and verify pass on a real bundle; a changed byte exits 1', async (t) => {
  const { tmp, app } = realBundle();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const usage = run([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
  assert.equal(run(['generate', '--app', app, '--commit', COMMIT]).status, 2, 'a missing --out is a usage error');
  assert.equal(run(['verify', '--manifest', 'x', '--provenance', 'y', '--zip', 'z', '--commit', 'nope', '--extra']).status, 2);

  const manifestPath = path.join(tmp, 'out', 'mac-payload-manifest.json');
  const generated = run(['generate', '--app', app, '--commit', COMMIT, '--out', manifestPath]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /mac payload manifest of TRACE Boardviewer\.app/);
  assert.equal(run(['generate', '--app', app, '--commit', COMMIT, '--out', path.join(app, 'inside.json')]).status, 1, 'the manifest may not be written inside the bundle');

  const zipPath = path.join(tmp, 'TRACE-Boardviewer-1.3.1-mac-arm64.zip');
  fs.writeFileSync(zipPath, 'zip bytes for the provenance record');
  const provenancePath = path.join(tmp, 'out', 'mac-provenance.json');
  const recorded = run(['provenance', '--zip', zipPath, '--manifest', manifestPath, '--commit', COMMIT, '--run-id', '42', '--run-attempt', '1', '--out', provenancePath]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const verifyArgs = ['verify', '--manifest', manifestPath, '--provenance', provenancePath, '--zip', zipPath, '--commit', COMMIT];
  assert.equal(run(verifyArgs).status, 0);
  assert.equal(run([...verifyArgs, '--app', app]).status, 0);

  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'TRACE Boardviewer'), 'binary-v2');
  const changed = run([...verifyArgs, '--app', app]);
  assert.equal(changed.status, 1, 'a changed byte in the bundle fails the check');
  assert.match(changed.stderr, /content differs: Contents\/MacOS\/TRACE Boardviewer/);

  const otherCommit = run(['verify', '--manifest', manifestPath, '--provenance', provenancePath, '--zip', zipPath, '--commit', OTHER_COMMIT]);
  assert.equal(otherCommit.status, 1);
  assert.match(otherCommit.stderr, /is not the expected commit/);

  fs.writeFileSync(zipPath, 'other zip bytes');
  assert.match(run(verifyArgs).stderr, /ZIP SHA-256 differs from the record/, 'a replaced ZIP fails the provenance check');
});
