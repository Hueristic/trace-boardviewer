'use strict';

// Unit tests (no Windows, no Electron, no network) for scripts/win-provenance.cjs on temporary files. They prove the record binds the
// EXE, app.asar, commit, build configuration and electron-builder version by SHA-256, that tampering is named, that a missing input
// writes nothing, and that the command line refuses malformed values. The real portable EXE is only checked by a Windows build run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const wp = require('../scripts/win-provenance.cjs');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'a'.repeat(40);

async function withInputs(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'trace-win-provenance-'));
  try {
    const inputs = { exe: path.join(root, 'TRACE-Boardviewer-1.3.3.exe'), asar: path.join(root, 'app.asar'), config: path.join(root, 'electron-builder.yml') };
    await fsp.writeFile(inputs.exe, 'portable bytes');
    await fsp.writeFile(inputs.asar, 'asar bytes');
    await fsp.writeFile(inputs.config, 'appId: hu.trace.boardviewer\n');
    await run({ root, ...inputs, out: path.join(root, 'out', 'win-provenance.json') });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('the record binds the EXE, app.asar, commit, build configuration and electron-builder version by SHA-256', async () => {
  await withInputs(async ({ exe, asar, config, out }) => {
    const options = wp.parseArgs(['--exe', exe, '--asar', asar, '--commit', COMMIT, '--config', config, '--electron-builder-version', '26.15.3', '--out', out]);
    const record = await wp.writeWinProvenance(options);
    assert.deepEqual(record, {
      schema: 'trace-win-provenance/1',
      commit: COMMIT,
      package: { name: 'TRACE-Boardviewer-1.3.3.exe', sha256: sha256('portable bytes'), size: 14 },
      asar: { sha256: sha256('asar bytes'), size: 10 },
      buildConfig: { name: 'electron-builder.yml', sha256: sha256('appId: hu.trace.boardviewer\n') },
      electronBuilder: { version: '26.15.3' },
    });
    assert.deepEqual(JSON.parse(await fsp.readFile(out, 'utf8')), record);
    assert.equal((await fsp.readFile(out, 'utf8')).endsWith('\n'), true, 'the file ends with a newline');
  });
});

test('the same inputs always give the same bytes; the record has no timestamp and no path', async () => {
  await withInputs(async ({ exe, asar, config, out }) => {
    const options = wp.parseArgs(['--exe', exe, '--asar', asar, '--commit', COMMIT, '--config', config, '--electron-builder-version', '26.15.3', '--out', out]);
    await wp.writeWinProvenance(options);
    const first = await fsp.readFile(out, 'utf8');
    await wp.writeWinProvenance(options);
    assert.equal(await fsp.readFile(out, 'utf8'), first);
    assert.equal(first.includes(path.dirname(exe)), false, 'no directory of the inputs is written');
  });
});

test('a missing input writes nothing and says which file is missing', async () => {
  await withInputs(async ({ root, asar, config, out }) => {
    const options = wp.parseArgs(['--exe', path.join(root, 'absent.exe'), '--asar', asar, '--commit', COMMIT, '--config', config, '--electron-builder-version', '26.15.3', '--out', out]);
    await assert.rejects(wp.writeWinProvenance(options), (error) => error instanceof wp.ProvenanceError && /absent\.exe/.test(error.message));
    await assert.rejects(fsp.stat(out), { code: 'ENOENT' });
  });
});

test('the checker names each kind of mismatch and never throws', async () => {
  await withInputs(async ({ exe, asar, config, out }) => {
    const options = wp.parseArgs(['--exe', exe, '--asar', asar, '--commit', COMMIT, '--config', config, '--electron-builder-version', '26.15.3', '--out', out]);
    const record = await wp.writeWinProvenance(options);
    const expected = { commit: COMMIT, packageSha256: sha256('portable bytes'), asarSha256: sha256('asar bytes'),
      buildConfigSha256: sha256('appId: hu.trace.boardviewer\n'), electronBuilderVersion: '26.15.3' };
    assert.deepEqual(wp.checkWinProvenance(record, expected), []);
    assert.match(wp.checkWinProvenance({ ...record, schema: 'other' }, expected).join('\n'), /schema is "other"/);
    assert.match(wp.checkWinProvenance(record, { ...expected, commit: 'b'.repeat(40) }).join('\n'), /is not the expected commit/);
    assert.match(wp.checkWinProvenance({ ...record, package: { ...record.package, sha256: 'c'.repeat(64) } }, expected).join('\n'), /package sha256 differs/);
    assert.match(wp.checkWinProvenance({ ...record, asar: { ...record.asar, sha256: 'not-hex' } }, expected).join('\n'), /asar sha256 is missing/);
    assert.match(wp.checkWinProvenance(record, { ...expected, buildConfigSha256: 'd'.repeat(64) }).join('\n'), /build configuration sha256 differs/);
    assert.match(wp.checkWinProvenance(record, { ...expected, electronBuilderVersion: '26.15.4' }).join('\n'), /electron-builder version "26.15.3" is not 26.15.4/);
    assert.deepEqual(wp.checkWinProvenance(null, expected), ['the provenance record is not a JSON object']);
    assert.doesNotThrow(() => wp.checkWinProvenance([], expected));
  });
});

test('the command line refuses malformed values, unknown and duplicate flags, and a missing flag', () => {
  const full = ['--exe', 'a.exe', '--asar', 'app.asar', '--commit', COMMIT, '--config', 'c.yml', '--electron-builder-version', '26.15.3', '--out', 'o.json'];
  assert.equal(wp.parseArgs(full).commit, COMMIT);
  assert.equal(wp.parseArgs(['--exe=a.exe', '--asar=app.asar', '--commit=' + COMMIT, '--config=c.yml', '--electron-builder-version=26.15.3', '--out=o.json']).exe, path.resolve('a.exe'));
  assert.throws(() => wp.parseArgs(full.map((value) => (value === COMMIT ? 'ABCDEF' : value))), wp.UsageError);
  assert.throws(() => wp.parseArgs(full.map((value) => (value === '26.15.3' ? 'latest' : value))), wp.UsageError);
  assert.throws(() => wp.parseArgs([...full, '--bogus', 'x']), /Unknown argument/);
  assert.throws(() => wp.parseArgs([...full, '--out', 'again.json']), /Duplicate argument/);
  assert.throws(() => wp.parseArgs(full.slice(0, -2)), /--out is required/);
});

test('the script runs as a real CLI process: writes the record and exits 0, or exits 2 on a usage error', async () => {
  await withInputs(async ({ exe, asar, config, out }) => {
    const script = path.join(__dirname, '..', 'scripts', 'win-provenance.cjs');
    const ok = spawnSync(process.execPath, [script, '--exe', exe, '--asar', asar, '--commit', COMMIT, '--config', config,
      '--electron-builder-version', '26.15.3', '--out', out], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(await fsp.readFile(out, 'utf8')).commit, COMMIT);
    const usage = spawnSync(process.execPath, [script, '--exe', exe], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  });
});
