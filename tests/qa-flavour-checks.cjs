'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const qa = require(path.join(ROOT, 'scripts', 'qa-flavour.cjs'));
const { flavour, FLAVOURS, compareAppAsar, expectedFuses, builderLibDirectory } = qa;

const yaml = require(require.resolve('js-yaml', { paths: [builderLibDirectory()] }));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const readYaml = (file) => yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

/** The builder's own schema validator, as tests/mac-config-checks.cjs uses it: nothing is added to the project. */
function builderValidator() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  const libManifest = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] });
  return require(path.join(path.dirname(libManifest), 'out', 'util', 'config', 'config.js')).validateConfiguration;
}

// The QA file of each platform is its release file with the QA identity (appId, productName, output directory, executable, desktop
// name, artifact names). Everything else is compared whole; the inspector is ON in the QA file and is compared separately.
function withoutIdentity(config) {
  const copy = clone(config);
  delete copy.appId; delete copy.productName; delete copy.directories;
  if (copy.extraMetadata) { delete copy.extraMetadata.desktopName; delete copy.extraMetadata.traceBuildFlavor; }
  if (copy.extraMetadata && Object.keys(copy.extraMetadata).length === 0) delete copy.extraMetadata;
  delete copy.linux?.executableName; delete copy.linux?.artifactName; delete copy.mac?.artifactName; delete copy.portable?.artifactName;
  // The two fuses that differ on purpose are compared on their own (see the QA fuse test below).
  if (copy.electronFuses) {
    delete copy.electronFuses.enableNodeCliInspectArguments;
    delete copy.electronFuses.enableEmbeddedAsarIntegrityValidation;
  }
  return copy;
}

test('the QA flavour is a separate identity: its appId, product name, output directories, executable and artifact names never equal the release ones', () => {
  const release = FLAVOURS.release;
  const qaFlavour = FLAVOURS.qa;
  assert.notEqual(qaFlavour.appId, release.appId);
  assert.equal(qaFlavour.appId, `${release.appId}.qa`);
  assert.equal(qaFlavour.productName, `${release.productName} QA`);
  assert.notEqual(qaFlavour.executableName, release.executableName);
  for (const platform of ['win', 'linux', 'mac']) {
    assert.notEqual(qaFlavour.outputs[platform], release.outputs[platform], platform);
    assert.match(qaFlavour.outputs[platform], /^release-qa/, `${platform} QA output lives under release-qa*`);
    assert.notEqual(qaFlavour.configs[platform], release.configs[platform], platform);
  }
  assert.match(qaFlavour.artifactPrefix, /QA/);
  assert.equal(qa.flavourFromEnvironment({}).id, 'release', 'unset means release');
  assert.equal(qa.flavourFromEnvironment({ TRACE_FLAVOUR: 'qa' }).id, 'qa');
  assert.throws(() => flavour('beta'), /unknown flavour/);
});

test('QA builds keep the inspector on and turn the asar integrity fuse off (the test log is written into app.asar); the release keeps the integrity fuse on and the inspector off', () => {
  for (const file of ['config/electron-builder.qa.yml', 'config/electron-builder.qa.linux.yml', 'config/electron-builder.qa.mac.yml']) {
    const fuses = readYaml(file).electronFuses;
    assert.equal(fuses.enableNodeCliInspectArguments, true, `${file}: inspector on`);
    assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, false, `${file}: integrity fuse off`);
  }
  for (const file of ['config/electron-builder.linux.yml', 'config/electron-builder.mac.yml']) {
    const fuses = readYaml(file).electronFuses;
    assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true, `${file}: release keeps the integrity fuse on`);
  }
  assert.equal(packageJson.build.electronFuses.enableEmbeddedAsarIntegrityValidation, true, 'the Windows release keeps the integrity fuse on');
  assert.equal(readYaml('config/electron-builder.qa.yml').electronFuses.enableEmbeddedAsarIntegrityValidation, false, 'the Windows QA file turns it off');
});

test('the QA configs are the release configs with the QA identity and the inspector ON: nothing else differs (Linux, macOS, Windows)', () => {
  const linuxRelease = readYaml('config/electron-builder.linux.yml');
  const linuxQa = readYaml('config/electron-builder.qa.linux.yml');
  assert.equal(linuxQa.electronFuses.enableNodeCliInspectArguments, true, 'the Linux QA flavour keeps the inspector on');
  assert.deepEqual(withoutIdentity(linuxQa), withoutIdentity(linuxRelease), 'the Linux QA file differs from the release file only in the identity');
  assert.equal(linuxQa.linux.executableName, 'trace-boardviewer-qa');
  assert.equal(linuxQa.linux.artifactName, 'TRACE-Boardviewer-QA-${version}-linux-${arch}.${ext}');
  assert.equal(linuxQa.extraMetadata.desktopName, 'trace-boardviewer-qa.desktop');

  const macRelease = readYaml('config/electron-builder.mac.yml');
  const macQa = readYaml('config/electron-builder.qa.mac.yml');
  assert.equal(macQa.electronFuses.enableNodeCliInspectArguments, true, 'the macOS QA flavour keeps the inspector on');
  assert.equal(macQa.electronFuses.resetAdHocDarwinSignature, true, 'the ad-hoc signature reset stays, as in the release file');
  assert.deepEqual(withoutIdentity(macQa), withoutIdentity(macRelease), 'the macOS QA file differs from the release file only in the identity');
  assert.equal(macQa.mac.artifactName, 'TRACE-Boardviewer-QA-${version}-mac-${arch}.${ext}');

  const windowsQa = readYaml('config/electron-builder.qa.yml');
  const windowsRelease = packageJson.build;
  assert.equal(windowsQa.electronFuses.enableNodeCliInspectArguments, true, 'the Windows QA flavour keeps the inspector on');
  assert.equal(windowsQa.portable.artifactName, 'TRACE-Boardviewer-QA-${version}.exe');
  assert.deepEqual(withoutIdentity(windowsQa), withoutIdentity({ ...windowsRelease, electronDist: windowsRelease.electronDist }),
    'the Windows QA file is the package.json build block with the QA identity');
});

test('every QA config passes the builder schema (the same validator the release configs pass)', async () => {
  const validate = builderValidator();
  await validate(clone(readYaml('config/electron-builder.qa.linux.yml')), { isEnabled: false, add() {} });
  await validate(clone(readYaml('config/electron-builder.qa.mac.yml')), { isEnabled: false, add() {} });
  await validate(clone(readYaml('config/electron-builder.qa.yml')), { isEnabled: false, add() {} });
  const broken = clone(readYaml('config/electron-builder.qa.yml'));
  broken.electronFuses.enableNodeCliInspectArgument = true;
  await assert.rejects(() => validate(broken, { isEnabled: false, add() {} }), /does not match the API schema|electronFuses|enableNodeCliInspectArgument/);
});

test('the expected fuses of each flavour come from its own config: the QA Windows wire keeps the inspector on', () => {
  assert.equal(expectedFuses(flavour('qa'), 'win').enableNodeCliInspectArguments, true);
  assert.equal(expectedFuses(flavour('qa'), 'linux').enableNodeCliInspectArguments, true);
  assert.equal(expectedFuses(flavour('qa'), 'mac').enableNodeCliInspectArguments, true);
  assert.deepEqual(expectedFuses(flavour('release'), 'win'), packageJson.build.electronFuses, 'the release Windows wire is the package.json block');
  assert.throws(() => expectedFuses(flavour('qa'), 'solaris'), /no solaris config/);
});

test('the Linux smoke names follow the flavour set in TRACE_FLAVOUR; release stays the default', () => {
  const probe = (env) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const smoke = require(${JSON.stringify(path.join(ROOT, 'scripts', 'linux-smoke.cjs'))});
    process.stdout.write(JSON.stringify({ product: smoke.PRODUCT_NAME, executable: smoke.EXECUTABLE_NAME, deb: smoke.DEB_PACKAGE, installed: smoke.INSTALLED_EXECUTABLE,
      appimage: smoke.artifactFileName('1.3.2', 'x64', 'AppImage'), deb_file: smoke.artifactFileName('1.3.2', 'x64', 'deb') }));
  `], { env: { ...process.env, ...env }, encoding: 'utf8' }));
  const release = probe({ TRACE_FLAVOUR: '' });
  const { appimage: releaseAppImage, deb_file: releaseDeb, ...releaseNames } = release;
  assert.deepEqual(releaseNames, { product: 'TRACE Boardviewer', executable: 'trace-boardviewer', deb: 'trace-boardviewer', installed: '/opt/TRACE Boardviewer/trace-boardviewer' });
  assert.match(releaseAppImage, /^TRACE-Boardviewer-1\.3\.2-linux-/);
  assert.match(releaseDeb, /^TRACE-Boardviewer-1\.3\.2-linux-/);
  const qaNames = probe({ TRACE_FLAVOUR: 'qa' });
  assert.equal(qaNames.product, 'TRACE Boardviewer QA');
  assert.equal(qaNames.executable, 'trace-boardviewer-qa');
  assert.equal(qaNames.deb, 'trace-boardviewer-qa');
  assert.equal(qaNames.installed, '/opt/TRACE Boardviewer QA/trace-boardviewer-qa');
  assert.match(qaNames.appimage, /^TRACE-Boardviewer-QA-1\.3\.2-linux-/);
  assert.match(qaNames.deb_file, /^TRACE-Boardviewer-QA-1\.3\.2-linux-/);
});

// Synthetic app.asar archives (no Electron build): the QA-runner's identity check on archives the test writes itself.
async function makeAsar(root, name, files) {
  const asar = require(require.resolve('@electron/asar', { paths: [builderLibDirectory()] }));
  const source = path.join(root, `${name}-src`);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), content);
  }
  const target = path.join(root, `${name}.asar`);
  await asar.createPackage(source, target);
  return target;
}

test('the QA-runner identity check: a QA app.asar that differs only in its identity is equal; any code difference is refused', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-qa-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = (productName, extra = {}) => JSON.stringify({ name: 'trace-boardviewer', version: '1.3.2', main: 'electron/main.cjs', productName, ...extra });
  const shared = { 'electron/main.cjs': 'console.log("app")\n', 'dist/index.js': 'export {}\n' };
  const release = await makeAsar(root, 'release', { ...shared, 'package.json': pkg('TRACE Boardviewer') });
  const qaSame = await makeAsar(root, 'qa-identity', { ...shared, 'package.json': pkg('TRACE Boardviewer QA') });
  assert.deepEqual(compareAppAsar(release, qaSame), { equal: true, differences: [] }, 'a QA product name is an identity difference');

  const qaCode = await makeAsar(root, 'qa-code', { ...shared, 'electron/main.cjs': 'console.log("changed")\n', 'package.json': pkg('TRACE Boardviewer QA') });
  const codeResult = compareAppAsar(release, qaCode);
  assert.equal(codeResult.equal, false);
  assert.ok(codeResult.differences.some((line) => /electron\/main\.cjs differs/.test(line)), codeResult.differences.join('; '));

  const qaExtra = await makeAsar(root, 'qa-extra', { ...shared, 'package.json': pkg('TRACE Boardviewer QA', { scripts: { start: 'node x' } }) });
  const extraResult = compareAppAsar(release, qaExtra);
  assert.equal(extraResult.equal, false);
  assert.ok(extraResult.differences.some((line) => /package\.json field scripts differs/.test(line)), extraResult.differences.join('; '));

  const qaMissing = await makeAsar(root, 'qa-missing', { 'electron/main.cjs': shared['electron/main.cjs'], 'package.json': pkg('TRACE Boardviewer QA') });
  const missingResult = compareAppAsar(release, qaMissing);
  assert.equal(missingResult.equal, false);
  assert.ok(missingResult.differences.some((line) => /dist\/index\.js is missing/.test(line) || /file lists differ/.test(line)), missingResult.differences.join('; '));
});

test('packaged QA: --flavour selects the tested flavour; release is the default and an unknown flavour is refused before anything runs', () => {
  const { parseArgs } = require(path.join(ROOT, 'scripts', 'packaged-functional-qa.cjs'));
  const base = [
    `--executable=${path.resolve(os.tmpdir(), 'TRACE Boardviewer QA.exe')}`, `--asar=${path.resolve(os.tmpdir(), 'app.asar')}`,
    `--artifact=${path.resolve(os.tmpdir(), 'TRACE-Boardviewer-QA-1.3.2.exe')}`, `--checksum=${path.resolve(os.tmpdir(), 'checksums.txt')}`,
    '--version=1.3.2', `--os=${process.platform}`, '--arch=x64', `--out=${path.resolve(os.tmpdir(), 'evidence.json')}`,
  ];
  assert.equal(parseArgs(['node', 'script', ...base, '--flavour=qa']).flavour, 'qa');
  assert.equal(parseArgs(['node', 'script', ...base]).flavour, undefined, 'no flag: the release flavour is used by inspectFuses');
  assert.throws(() => parseArgs(['node', 'script', ...base, '--flavour=beta']), /unknown flavour/);
});

test('the build flavour is a flag written at build time: each QA config sets extraMetadata.traceBuildFlavor to qa; no release config sets it', () => {
  for (const file of ['config/electron-builder.qa.yml', 'config/electron-builder.qa.linux.yml', 'config/electron-builder.qa.mac.yml']) {
    assert.equal(readYaml(file).extraMetadata?.traceBuildFlavor, 'qa', `${file} carries the QA flag`);
  }
  for (const file of ['config/electron-builder.linux.yml', 'config/electron-builder.mac.yml']) {
    assert.equal(readYaml(file).extraMetadata?.traceBuildFlavor, undefined, `${file} carries no flag: the release`);
  }
  assert.equal(packageJson.build.extraMetadata?.traceBuildFlavor, undefined, 'the Windows release carries no flag: the release');
});
