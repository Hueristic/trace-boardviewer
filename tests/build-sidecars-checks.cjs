'use strict';

// Unit tests (no Windows, no Electron, no network) for scripts/write-build-sidecars.cjs on temporary folders. They prove that the
// checksum line and the payload manifest are computed from the given files, and that a refused input writes nothing. They do not
// make or accept a real build: the real win-unpacked tree and EXE are checked only by the packaged QA harness on a Windows runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, writeBuildSidecars, SidecarError } = require('../scripts/write-build-sidecars.cjs');

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

async function buildFolder(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'trace-sidecars-'));
  try {
    const build = path.join(root, 'build');
    const unpacked = path.join(build, 'win-unpacked');
    await fsp.mkdir(path.join(unpacked, 'resources'), { recursive: true });
    await fsp.writeFile(path.join(unpacked, 'TRACE Boardviewer.exe'), 'runtime bytes');
    await fsp.writeFile(path.join(unpacked, 'resources', 'app.asar'), 'asar bytes');
    const exe = path.join(build, 'TRACE-Boardviewer-1.3.2.exe');
    await fsp.writeFile(exe, 'portable bytes');
    await run({ root, build, unpacked, exe });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('writes the EXE checksum in the release-job format and a payload manifest of the unpacked app', async () => {
  await buildFolder(async ({ build, unpacked, exe }) => {
    const logs = [];
    const result = await writeBuildSidecars({ exe, unpacked }, { log: line => logs.push(line) });
    assert.equal(await fsp.readFile(`${exe}.sha256`, 'utf8'), `${sha256('portable bytes')}  TRACE-Boardviewer-1.3.2.exe\n`);
    const manifest = JSON.parse(await fsp.readFile(path.join(build, 'payload-manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'trace-payload-manifest/1');
    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.exeSha256, sha256('runtime bytes'));
    assert.equal(manifest.asarSha256, sha256('asar bytes'));
    assert.equal(result.sha256, sha256('portable bytes'));
    assert.ok(logs.some(line => line.includes('payload manifest:')), 'the payload manifest summary is logged');
  });
});

test('refuses a missing EXE or unpacked folder, and a manifest written inside the unpacked folder, and writes no checksum', async () => {
  await buildFolder(async ({ root, unpacked, exe }) => {
    await assert.rejects(writeBuildSidecars({ exe: path.join(root, 'absent.exe'), unpacked }, { log: () => {} }), SidecarError);
    await assert.rejects(writeBuildSidecars({ exe, unpacked: path.join(root, 'absent') }, { log: () => {} }), SidecarError);
    await assert.rejects(writeBuildSidecars({ exe, unpacked, outDir: unpacked }, { log: () => {} }), /outside --dir/);
    await assert.rejects(fsp.stat(`${exe}.sha256`), { code: 'ENOENT' });
  });
});

test('a QA build names its main executable "TRACE Boardviewer QA.exe" in the manifest, when told to with --flavour qa', async () => {
  await buildFolder(async ({ build, unpacked, exe }) => {
    await fsp.writeFile(path.join(unpacked, 'TRACE Boardviewer QA.exe'), 'qa runtime bytes');
    await writeBuildSidecars({ exe, unpacked, flavour: 'qa' }, { log: () => {} });
    const manifest = JSON.parse(await fsp.readFile(path.join(build, 'payload-manifest.json'), 'utf8'));
    assert.equal(manifest.exeSha256, sha256('qa runtime bytes'));
    assert.equal(manifest.fileCount, 3);
  });
});

test('parses the flags with either spelling and refuses unknown flags and missing values', () => {
  assert.deepEqual(parseArgs(['--exe=a.exe', '--unpacked', 'u', '--out-dir', 'o']), { exe: 'a.exe', unpacked: 'u', outDir: 'o', flavour: 'release', help: false });
  assert.equal(parseArgs(['--exe', 'a.exe', '--unpacked', 'u', '--flavour', 'qa']).flavour, 'qa');
  assert.throws(() => parseArgs(['--exe', 'a.exe', '--bogus']), /Unknown argument: --bogus/);
  assert.throws(() => parseArgs(['--exe']), /--exe needs a value/);
});
