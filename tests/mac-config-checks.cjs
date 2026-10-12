'use strict';

// STATIC / SIMULATED checks for the macOS packaging baseline. This is NOT macOS runtime acceptance: it never
// launches the app, never builds a macOS bundle and says nothing about how the product behaves on a Mac.
// It parses config/electron-builder.mac.yml with the pinned electron-builder's own YAML loader and schema,
// checks it against the "build" block of package.json (the Mac file is a copy, see its header), checks the
// mac job and the draft-release job of the release workflow, and exercises the pure decision logic of
// scripts/mac-smoke.cjs. It runs on Linux, Windows and macOS:
//
//   node --test tests/mac-config-checks.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (...parts) => path.join(ROOT, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), 'utf8');
const smoke = require('../scripts/mac-smoke.cjs');

const CONFIG_FILE = 'config/electron-builder.mac.yml';
const WORKFLOW_FILE = '.github/workflows/windows.yml';
const DOC_FILE = 'docs/MAC_VALIDATION.md';
const SMOKE_FILE = 'scripts/mac-smoke.cjs';
const SELF_FILE = 'tests/mac-config-checks.cjs';
// The only negation the Mac "files" list may add to the package.json list; see the header of the config file.
const ALLOWED_NEGATIONS = ['!node_modules/@napi-rs/**', '!node_modules/!(fflate)/**/*'];

// The pinned electron-builder resolves its own YAML parser and schema validator; nothing is added to the project.
function builderTools() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  const libManifest = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] });
  const libDirectory = path.dirname(libManifest);
  return {
    directory: libDirectory,
    version: JSON.parse(fs.readFileSync(libManifest, 'utf8')).version,
    yaml: require(require.resolve('js-yaml', { paths: [libDirectory] })),
    validateConfiguration: require(path.join(libDirectory, 'out', 'util', 'config', 'config.js')).validateConfiguration,
  };
}
const tools = builderTools();
const parseYaml = (text) => tools.yaml.load(text);
// The three inputs below can be pointed at COPIES (mutation checks of the assertions): the real package.json
// belongs to another working copy and is never edited, not even temporarily.
const CONFIG_PATH = process.env.TRACE_MAC_CHECKS_CONFIG || rel(CONFIG_FILE);
const WORKFLOW_PATH = process.env.TRACE_MAC_CHECKS_WORKFLOW || rel(WORKFLOW_FILE);
const PACKAGE_JSON_PATH = process.env.TRACE_MAC_CHECKS_PACKAGE_JSON || rel('package.json');
const SMOKE_SOURCE_PATH = process.env.TRACE_MAC_CHECKS_SMOKE_SOURCE || rel(SMOKE_FILE);
const configText = fs.readFileSync(CONFIG_PATH, 'utf8');
const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const macConfig = parseYaml(configText);
const workflow = parseYaml(workflowText);
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
// One job's YAML text (from its "  <name>:" line to the next job) for checks that must be scoped to the mac job.
const jobText = (name) => {
  const text = workflowText.replace(/\r\n/g, '\n');
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `job ${name} exists in ${WORKFLOW_FILE}`);
  const next = text.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
};
const stripYamlComments = (text) => text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');

const macFiles = () => {
  const found = [CONFIG_FILE, DOC_FILE, WORKFLOW_FILE, SELF_FILE];
  for (const name of fs.readdirSync(rel('scripts'))) if (/^mac-.*\.cjs$/.test(name)) found.push(`scripts/${name}`);
  const extra = rel('config', 'mac');
  if (fs.existsSync(extra)) {
    const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.relative(ROOT, path.join(directory, entry.name)).split(path.sep).join('/')]));
    found.push(...walk(extra));
  }
  return found;
};

test('static: the Mac config is a valid electron-builder configuration for the pinned builder', async () => {
  assert.equal(tools.version, packageJson.devDependencies['electron-builder'], 'the schema checked against is the pinned builder version');
  await tools.validateConfiguration(JSON.parse(JSON.stringify(macConfig)), { isEnabled: false, add() {} });
  assert.ok(macConfig && typeof macConfig === 'object' && !Array.isArray(macConfig));
  // The schema rejects unknown keys, so a typo in a security-relevant option cannot pass silently.
  const broken = JSON.parse(JSON.stringify(macConfig));
  broken.mac.notarise = false;
  await assert.rejects(() => tools.validateConfiguration(broken, { isEnabled: false, add() {} }), /does not match the API schema/);
});

test('static: placement - the config is not auto-discovered and nothing Mac-specific sits in the shipped trees', () => {
  const discovered = fs.readdirSync(ROOT).filter((name) => /^electron-builder\.(?:ya?ml|json5?|toml|[cm]?js|ts)$/.test(name));
  assert.deepEqual(discovered, [], 'a root electron-builder.* file would be auto-discovered by the builder');
  assert.equal(path.posix.dirname(CONFIG_FILE), 'config');
  for (const file of macFiles()) {
    assert.ok(fs.existsSync(rel(file)), `${file} exists`);
    assert.ok(!['assets', 'electron', 'src', 'dist'].includes(file.split('/')[0]), `${file} must not sit under a shipped tree`);
  }
  // The shipped trees (the ASAR packs assets/, electron/ and dist/) must hold no Mac packaging artifacts either.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (/\.(?:icns|plist|entitlements|dmg)$/i.test(entry.name) || /(?:^|[-_.])mac(?:[-_.]|$)/i.test(entry.name)) offenders.push(path.relative(ROOT, full));
    }
  };
  for (const tree of ['assets', 'electron', 'src']) if (fs.existsSync(rel(tree))) walk(rel(tree));
  assert.deepEqual(offenders, []);
});

test('static: design - one architecture per run, zip only, arch in every artifact name, separate output directory', () => {
  const targets = [].concat(macConfig.mac.target).map((target) => (typeof target === 'string' ? target : target.target));
  assert.deepEqual(targets, ['zip'], 'baseline target is zip only (dmg, pkg and mas are deferred)');
  for (const target of [].concat(macConfig.mac.target)) assert.equal(typeof target, 'string', 'the arch is chosen by the command line, never pinned inside the target');
  assert.ok(!/universal/i.test(JSON.stringify(macConfig)), 'no universal build in the baseline');
  assert.match(macConfig.mac.artifactName, /\$\{arch\}/);
  assert.match(macConfig.mac.artifactName, /\$\{version\}/);
  assert.match(macConfig.mac.artifactName, /\$\{ext\}/);
  // The declared minimum is the one the docs state; a change must update both (the 1.3.2 measurement confirms it later).
  assert.equal(macConfig.mac.minimumSystemVersion, '13.0', 'the declared minimum macOS of the baseline');
  assert.match(read(DOC_FILE), /Minimum macOS version[^\n]*\b13\.0\b/, 'docs/MAC_VALIDATION.md states the declared minimum');
  assert.equal(macConfig.directories.output, 'release-mac');
  assert.notEqual(macConfig.directories.output, packageJson.build.directories.output, 'must differ from the Windows output directory');
  for (const [a, b] of [[macConfig.directories.output, packageJson.build.directories.output], [packageJson.build.directories.output, macConfig.directories.output]]) {
    assert.ok(!`${a}/`.startsWith(`${b}/`), `${a} must not live inside ${b}`);
  }
  assert.equal(macConfig.publish, null, 'nothing is published and no app-update.yml is generated from the git remote');
  assert.equal(macConfig.electronDist, undefined, 'the host Electron (node_modules/electron/dist) must not be copied into a possibly other-arch build');
  assert.equal(macConfig.mac.defaultArch, undefined);
  const icon = fs.readFileSync(rel(macConfig.mac.icon));
  assert.equal(icon.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(icon.readUInt32BE(16) >= 512 && icon.readUInt32BE(20) >= 512, 'the builder needs a PNG of at least 512x512 to derive the .icns');
});

test('static: signing - ad-hoc only, no certificate, no notarization, no secrets', () => {
  assert.equal(macConfig.mac.identity, '-', 'ad-hoc ("-") is the only identity allowed: never a certificate name');
  assert.equal(macConfig.mac.hardenedRuntime, false);
  assert.equal(macConfig.mac.notarize, false);
  assert.equal(macConfig.mac.gatekeeperAssess, false);
  for (const key of ['cscLink', 'cscKeyPassword', 'cscInstallerLink', 'cscInstallerKeyPassword', 'provisioningProfile', 'entitlements', 'entitlementsInherit', 'sign', 'type', 'forceCodeSigning', 'identityValidation']) {
    assert.ok(!(key in macConfig.mac) && !(key in macConfig), `${key} must not be configured`);
  }
  for (const hook of ['afterSign', 'afterPack', 'beforePack', 'afterAllArtifactBuild', 'onNodeModuleFile']) assert.ok(!(hook in macConfig), `${hook} hook`);
  const secrets = /CSC_LINK|CSC_KEY_PASSWORD|CSC_NAME|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|APPLE_API_KEY|APPLE_KEYCHAIN|\.p12|\.pfx|PRIVATE KEY|Developer ID/;
  for (const [file, text] of [[CONFIG_FILE, configText], [WORKFLOW_FILE, workflowText]]) assert.doesNotMatch(stripYamlComments(text), secrets, `${file} references no signing material`);
  const macText = stripYamlComments(jobText('mac'));
  assert.doesNotMatch(macText, /secrets\./, 'the mac job uses no secret; the draft-release job is the only one with a token');
  assert.doesNotMatch(macText, /GITHUB_TOKEN|GH_TOKEN/);
  assert.equal(workflow.jobs.mac.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
});

test('static: drift guard - appId, productName, asar and files match package.json "build"', () => {
  const build = packageJson.build;
  assert.equal(macConfig.appId, build.appId);
  assert.equal(macConfig.productName, build.productName);
  assert.equal(macConfig.asar, build.asar);
  const negations = macConfig.files.filter((pattern) => pattern.startsWith('!'));
  assert.deepEqual(negations.filter((pattern) => !ALLOWED_NEGATIONS.includes(pattern)), [], 'only documented negations are allowed');
  assert.deepEqual(macConfig.files.filter((pattern) => !pattern.startsWith('!')), build.files.filter((pattern) => !pattern.startsWith('!')), 'the positive patterns are identical, in order');
  assert.ok(build.files.includes('shared/bug-report-contract.cjs'), 'the shared report contract is packaged');
  assert.deepEqual(build.files.filter((pattern) => pattern.startsWith('!') && !macConfig.files.includes(pattern)), [], 'a negation added to package.json must also be in the Mac list');
  assert.deepEqual(macConfig.files.slice(-negations.length), negations, 'negations come last');
  assert.ok(!('asarUnpack' in macConfig) && !('extraResources' in macConfig) && !('extraFiles' in macConfig), 'no extra payload beyond package.json build');
});

// The fuses the shipped binaries carry (H1-07). Both configurations flip the same set: no ELECTRON_RUN_AS_NODE, no NODE_OPTIONS,
// application code only from the integrity-checked app.asar, encrypted cookies; file:// keeps its privileges (the UI and pdf.js load
// over it) and --inspect stays on (scripts/mac-smoke.cjs and every Playwright launch of a packaged build attach through it). The Mac
// file adds the ad-hoc signature reset. A fuse not listed keeps Electron's default, so the lists are compared whole.
test('static: Electron fuses - package.json "build" and the Mac file flip the same fuses, the pinned builder maps every name and its schema rejects a misspelled one', async () => {
  const expected = {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true, enableCookieEncryption: true, grantFileProtocolExtraPrivileges: true,
  };
  assert.deepEqual(packageJson.build.electronFuses, expected, 'the Windows build block');
  assert.deepEqual(macConfig.electronFuses, { ...expected, resetAdHocDarwinSignature: true }, 'the Mac file: the same set plus the signature reset');
  await tools.validateConfiguration(JSON.parse(JSON.stringify(packageJson.build)), { isEnabled: false, add() {} });
  for (const bad of [{ enableNodeCliInspect: false }, { resetAdhocDarwinSignature: true }, { grantFileProtocolExtraPrivilege: true }]) {
    const broken = JSON.parse(JSON.stringify(macConfig));
    broken.electronFuses = { ...broken.electronFuses, ...bad };
    await assert.rejects(() => tools.validateConfiguration(broken, { isEnabled: false, add() {} }), /does not match the API schema/, JSON.stringify(bad));
  }
  // The names are mapped one by one onto @electron/fuses (platformPackager.generateFuseConfig); a key the pinned builder does not
  // map would pass the schema and change nothing in the binary.
  const packager = fs.readFileSync(path.join(tools.directory, 'out', 'platformPackager.js'), 'utf8');
  for (const key of Object.keys(expected)) assert.ok(packager.includes(`if (fuses.${key} != null)`), `${key} is handed to @electron/fuses by app-builder-lib ${tools.version}`);
  assert.ok(packager.includes('resetAdHocDarwinSignature: fuses.resetAdHocDarwinSignature'));
  assert.ok(packager.includes('await this.doAddElectronFuses(packContext);') && packager.indexOf('await this.doAddElectronFuses(packContext);') < packager.indexOf('await this.doSignAfterPack('), 'the fuses are flipped before signing');
  // Windows: the builder embeds the ASAR hash in the executable's resources whenever integrity is not disabled, which is what the
  // enableEmbeddedAsarIntegrityValidation fuse checks at start.
  assert.equal(packageJson.build.disableAsarIntegrity, undefined);
  assert.equal(macConfig.disableAsarIntegrity, undefined);
  assert.ok(fs.readFileSync(path.join(tools.directory, 'out', 'electron', 'electronWin.js'), 'utf8').includes('id: "ELECTRONASAR"'));
});

test('static: the @napi-rs exclusion is safe - no shipped runtime code can require it', () => {
  assert.ok(ALLOWED_NEGATIONS.every((pattern) => macConfig.files.includes(pattern)), 'the documented exclusion is present');
  const allowedRequires = new Set(['electron', 'fflate']);
  for (const name of fs.readdirSync(rel('electron')).filter((entry) => entry.endsWith('.cjs'))) {
    const source = fs.readFileSync(rel('electron', name), 'utf8');
    assert.doesNotMatch(source, /napi-rs|pdfjs-dist|createRequire/, `electron/${name} must not reach @napi-rs/canvas`);
    for (const [, specifier] of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      assert.ok(allowedRequires.has(specifier), `electron/${name} requires "${specifier}": review whether the Mac "files" exclusions still hold`);
    }
  }
  assert.ok(packageJson.dependencies.fflate, 'fflate (required by electron/documents.cjs) is a production dependency and is not excluded');
  // fflate is the one node_modules package the packaged code needs (electron/documents.cjs); it is included by name before the negations.
  assert.deepEqual(macConfig.files.filter((pattern) => !pattern.startsWith('!') && /fflate/.test(pattern)), ['node_modules/fflate/**/*'], 'fflate is the one node_modules package included, by name');
});

test('static: the mac job builds the unsigned arm64 zip inside the release workflow, read-only, with the pinned SHAs of the Windows build', () => {
  assert.equal(fs.existsSync(rel('.github', 'workflows', 'macos.yml')), false, 'the macOS build lives in the release workflow; a second workflow would be a second, unreviewed path to a build');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.concurrency && workflow.concurrency.group);
  const job = workflow.jobs.mac;
  assert.ok(job, 'job "mac"');
  assert.match(String(job['runs-on']), /^macos-\d+$/, 'an explicit versioned Apple silicon label (macos-<version>): never macos-latest, an -intel or -large (x64) label, or an expression');
  assert.equal(job.if, "github.event_name != 'pull_request'", 'pull requests do not spend hosted macOS minutes');
  assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
  assert.ok(!('permissions' in job), 'no job-level permission override: the mac job never writes to the repository');
  assert.equal(job.defaults.run.shell, 'bash');
  assert.equal(job.env.TRACE_ARCH, 'arm64');
  assert.equal(job.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.deepEqual(Object.keys(job.outputs).sort(), ['artifact_name', 'version']);

  const pinsOf = (steps) => new Map(steps.filter((step) => step.uses).map((step) => step.uses.split('@')));
  const buildPins = pinsOf(workflow.jobs.build.steps);
  const macPins = pinsOf(job.steps);
  assert.ok(macPins.size >= 4);
  for (const [name, sha] of macPins) {
    assert.match(sha, /^[0-9a-f]{40}$/, `${name} is pinned to a full commit SHA`);
    assert.equal(buildPins.get(name), sha, `${name} uses the same pinned SHA as the Windows build job`);
  }
  const checkout = job.steps.find((step) => step.uses && step.uses.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const names = job.steps.map((step) => step.name);
  const order = ['Install locked dependencies', 'Validate release metadata', 'Run the static macOS packaging checks', 'Build the renderer', 'Build the unsigned macOS app', 'Locate the app and generate the zip checksum', 'Run the packaged-app smoke test', 'Scan the app bundle for private names and paths', 'Upload macOS zip and checksum', 'Upload macOS smoke evidence'];
  assert.deepEqual(names.filter((name) => order.includes(name)), order, 'the steps run in this order: the smoke test and the scan come before the upload');
  assert.ok(!names.some((name) => /Prepare Electron runtime/.test(name)), 'no setup:electron: the builder downloads the arm64 Electron itself');

  const text = stripYamlComments(jobText('mac'));
  assert.doesNotMatch(text, /gh release|contents:\s*write|softprops|action-gh-release|download-artifact/, 'the mac job only builds and uploads');
  for (const step of job.steps.filter((entry) => entry.run)) {
    assert.doesNotMatch(step.run, /\$\{\{/, `step "${step.name}": contexts reach scripts through env only`);
  }
  const build = job.steps.find((step) => step.run && /electron-builder/.test(step.run));
  assert.match(build.run, /--mac zip "--\$TRACE_ARCH" --config config\/electron-builder\.mac\.yml --publish never/);
  assert.doesNotMatch(build.run, /--win|--linux|--universal|--publish always/);
  const checksum = job.steps.find((step) => step.name === 'Locate the app and generate the zip checksum');
  assert.match(checksum.run, /shasum -a 256 "\$\(basename "\$zip"\)" > "\$\(basename "\$zip"\)\.sha256"/, 'the same "<sha256>  <file name>" line as the EXE checksum');
  const smokeStep = job.steps.find((step) => step.run && step.run.includes('scripts/mac-smoke.cjs'));
  assert.ok(smokeStep['timeout-minutes'], 'the smoke step has its own timeout');
  assert.match(smokeStep.run, /--app "\$TRACE_APP" --arch "\$TRACE_ARCH" --commit "\$TRACE_COMMIT" --artifact "\$TRACE_ZIP" --out "test-results\/mac\/mac-smoke-evidence-\$TRACE_ARCH\.json"/);
  assert.doesNotMatch(smokeStep.run, /--evidence-only/, 'the release build runs the full smoke test');

  const scan = job.steps.find((step) => step.name === 'Scan the app bundle for private names and paths');
  for (const needle of ['/Users/runner', '/home/runner', 'runner/work']) assert.ok(scan.run.includes(needle), `the scan looks for ${needle}`);
  assert.match(scan.run, /grep -r -I -i -l -E "\$pattern" "\$TRACE_APP"/, 'every text file of the bundle, case-insensitively');
  assert.match(scan.run, /grep -a -i -q -E "\$pattern" "\$file"/, 'the asar and the main executable as bytes');
  assert.ok(scan.run.includes('Contents/Resources/app.asar') && scan.run.includes('Contents/MacOS/TRACE Boardviewer'));
  assert.match(scan.run, /if \[ "\$hits" -ne 0 \]; then\n\s+echo '[^\n]*' >&2\n\s+exit 1/, 'one hit fails the job');
  assert.equal(scan.if, undefined);

  const upload = job.steps.find((step) => step.name === 'Upload macOS zip and checksum');
  assert.equal(upload.if, undefined, 'the zip is uploaded only when every step before it passed');
  assert.equal(upload.with.name, '${{ steps.metadata.outputs.artifact_name }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 14);
  assert.match(upload.with.path, /-mac-\$\{\{ env\.TRACE_ARCH \}\}\.zip\n/);
  assert.match(upload.with.path, /-mac-\$\{\{ env\.TRACE_ARCH \}\}\.zip\.sha256\n?$/);
  const evidence = job.steps.find((step) => step.name === 'Upload macOS smoke evidence');
  assert.equal(evidence.if, 'always()');
  assert.match(evidence.with.path, /test-results\/mac\/\*\.json/);
  assert.equal(evidence.with['retention-days'], 14);
});

test('static: the macOS ZIP is verified against its manifest and the commit, strictly, and the draft checks the commit again', () => {
  const job = workflow.jobs.mac;
  const generate = job.steps.find((step) => step.run && step.run.includes('scripts/mac-payload-manifest.cjs generate'));
  assert.ok(generate, 'the mac job writes the manifest of the built app');
  assert.match(generate.run, /generate --app "\$TRACE_APP" --commit "\$TRACE_COMMIT" --out release-mac\/mac-payload-manifest\.json/);
  const provenance = job.steps.find((step) => step.run && step.run.includes('scripts/mac-payload-manifest.cjs provenance'));
  assert.ok(provenance, 'the mac job writes the provenance record');
  assert.match(provenance.run, /--run-id "\$GITHUB_RUN_ID" --run-attempt "\$GITHUB_RUN_ATTEMPT" --out release-mac\/mac-provenance\.json/);
  const verify = job.steps.find((step) => step.run && step.run.includes('scripts/mac-payload-manifest.cjs verify'));
  assert.ok(verify, 'the mac job verifies the ZIP');
  assert.match(verify.run, /ditto -x -k "\$TRACE_ZIP" "\$unpacked"/, 'the ZIP is unpacked with ditto, the way users unpack it');
  assert.match(verify.run, /--app "\$unpacked\/TRACE Boardviewer\.app"/);
  assert.match(verify.run, /--commit "\$TRACE_COMMIT"/);
  assert.match(verify.run, /set -euo pipefail/);
  assert.equal(verify['continue-on-error'], undefined, 'the verification is not allowed to fail quietly');
  assert.doesNotMatch(verify.run, /\|\||\btrue\b/, 'no fallback in the verifying step');
  const order = job.steps.map((step) => step.name);
  assert.ok(order.indexOf('Locate the app and generate the zip checksum') < order.indexOf('Write the macOS payload manifest of the built app'));
  assert.ok(order.indexOf('Write the macOS provenance record') < order.indexOf('Verify the ZIP against its manifest and the commit'));
  const upload = job.steps.find((step) => step.name === 'Upload macOS zip and checksum');
  assert.match(upload.with.path, /release-mac\/mac-payload-manifest\.json\n\s*release-mac\/mac-provenance\.json\n/, 'the manifest and the provenance travel with the ZIP');
  const release = workflow.jobs['draft-release'];
  const check = release.steps.find((step) => step.name === 'Check the macOS provenance against the tagged commit');
  assert.ok(check, 'the draft checks the macOS provenance');
  assert.equal(check.if, "needs.mac.result == 'success'");
  assert.equal(check['continue-on-error'], true, 'a failed check keeps the Windows and Linux draft');
  assert.equal(check.env.TRACE_COMMIT, '${{ github.sha }}', 'the commit comes from the tagged run');
  assert.match(check.run, /--commit \$env:TRACE_COMMIT/);
  assert.match(check.run, /TRACE_MAC_ATTACHED=\$traceAttached/);
  assert.match(check.run, /exit \$traceCode/, 'the failure is still shown on the step');
});

test('static: the draft release carries every build and a suffixed version becomes a prerelease', () => {
  const release = workflow.jobs['draft-release'];
  assert.deepEqual(release.needs, ['build', 'portable-isolation', 'mac', 'linux']);
  assert.deepEqual(release.permissions, { contents: 'write' });
  const downloads = release.steps.filter((step) => step.uses && step.uses.startsWith('actions/download-artifact@')).map((step) => step.with.name);
  assert.deepEqual(downloads, ['${{ needs.build.outputs.artifact_name }}', '${{ needs.mac.outputs.artifact_name }}', '${{ needs.linux.outputs.artifact_name }}']);
  const create = release.steps.find((step) => step.name === 'Create draft GitHub release');
  assert.equal(create.env.TRACE_MAC_VERSION, '${{ needs.mac.outputs.version }}');
  // A failed or skipped macOS job never blocks the Windows and Linux draft: the macOS ZIP is attached only when its job succeeded.
  assert.equal(create.env.TRACE_MAC_RESULT, '${{ needs.mac.result }}', 'the draft knows whether the macOS build is attached');
  assert.match(create.run, /\$traceMacAttached = \(\$env:TRACE_MAC_RESULT -eq 'success'\) -and \(\$env:TRACE_MAC_ATTACHED -eq 'true'\)/, 'attached only when the macOS job succeeded and its provenance check passed');
  assert.match(create.run, /if \(\$traceMacAttached -and \$env:TRACE_MAC_VERSION -ne \$env:TRACE_VERSION\) \{ throw/, 'both builds must be of the same version when the macOS build is attached');
  assert.match(create.run, /\$traceZip = Join-Path release "TRACE-Boardviewer-\$env:TRACE_VERSION-mac-arm64\.zip"/);
  assert.match(create.run, /\$traceFiles = @\(\$traceExe, \$traceAppImage, \$traceDeb\)\s*\n\s*if \(\$traceMacAttached\) \{ \$traceFiles = @\(\$traceExe, \$traceZip, \$traceAppImage, \$traceDeb\) \}/, 'the macOS ZIP joins the list only when its job succeeded');
  assert.match(create.run, /foreach \(\$traceFile in \$traceFiles\)/, 'every asset is checked against its .sha256 file');
  assert.match(create.run, /Get-FileHash -LiteralPath \$traceFile -Algorithm SHA256/);
  assert.match(create.run, /\$traceAssets \+= @\(\$traceFile, \$traceChecksum\)/, 'every asset and its checksum file are attached');
  assert.match(create.run, /@\('--draft', '--verify-tag', '--title', "TRACE Boardviewer \$env:TRACE_VERSION", '--notes-file', 'release-notes\.md'\)/);
  assert.match(create.run, /if \(\$env:TRACE_VERSION -match '-'\) \{ \$traceArgs \+= '--prerelease' \}/, 'a prerelease suffix never becomes the latest release the app checks');
  assert.match(create.run, /gh release create @traceArgs\n/);
  assert.doesNotMatch(create.run, /--latest|--prerelease=false/);
  // The macOS line is built once, before the notes, and the notes take it from there (attached, or said to be missing).
  const macLine = create.run.slice(create.run.indexOf('if ($traceMacAttached) {'), create.run.indexOf('@"'));
  assert.match(macLine, /TRACE-Boardviewer-\$env:TRACE_VERSION-mac-arm64\.zip/);
  assert.match(macLine, /experimental/i);
  assert.match(macLine, /ad-hoc signed/i);
  assert.match(macLine, /not notarized/);
  assert.match(macLine, /Apple silicon only/);
  assert.match(macLine, /not attached to this draft/, 'a missing macOS build is said in the notes, not hidden');
  assert.ok(macLine.includes('Do not remove its quarantine flag or bypass Gatekeeper'), 'the notes forbid removing the quarantine flag or bypassing Gatekeeper');
  const notes = create.run.slice(create.run.indexOf('@"'), create.run.indexOf('"@'));
  assert.match(notes, /TRACE-Boardviewer-\$\{env:TRACE_VERSION\}\.exe/);
  assert.match(notes, /\$\{traceMacLine\}/);
  assert.match(notes, /experimental/i);
  assert.doesNotMatch(notes, /`/, 'no backticks: the notes are a double-quoted PowerShell here-string, where a backtick escapes');
});

// Governing-prohibition guard. The text is split into units at sentence stops, colons and semicolons (hard stops), and at commas,
// coordinators ("and", "or") and sequence words ("then", "but") (soft joins). A bypass hit is allowed only when a prohibition governs
// every unit it touches: the prohibition's own unit, or a unit joined to a bypass-related prohibition. A prohibition is bypass-related
// when its unit names a bypass action or target (quarantine, Gatekeeper, xattr, spctl, Open Anyway, right-click Open, the security
// settings) or a bare removal verb. "Do not panic and remove the quarantine flag" leaves the removal ungoverned; "Never remove the
// quarantine flag or disable Gatekeeper" governs both. A locale catalogue is read with its own language and English; other files with
// all languages. Read-only listings (`xattr -l`, `xattr -lr`, `xattr -p`) remove nothing and match no pattern.
const LEXICON = {
  en: {
    quarantine: ['quarantin\\p{L}*'],
    removal: ['remov\\p{L}*', 'strip\\p{L}*', 'clear\\p{L}*', 'delet\\p{L}*', 'drop\\p{L}*', 'ignor\\p{L}*', 'disabl\\p{L}*', 'bypass\\p{L}*', 'skip\\p{L}*', 'circumvent\\p{L}*', 'get around', 'go around', 'turn off'],
    removedPast: ['removed', 'cleared', 'stripped', 'deleted', 'dropped', 'ignored', 'disabled', 'skipped'],
    openAnyway: ['open anyway'],
    click: ['control[- ]click', 'right[- ]click'],
    openWord: ['open\\p{L}*'],
    securityPane: ['Privacy (?:&|and) Security'],
    allowWord: ['allow\\p{L}*'],
    prohibition: ['not', 'never', 'no', 'cannot', 'without', 'nothing', 'prohibited'],
    coordAnd: ['and'],
    coordOr: ['or', 'nor'],
    targetVerb: ['use', 'uses', 'using', 'change', 'changes', 'changing'],
    sequence: ['then', 'so', 'but', 'yet'],
  },
  de: {
    quarantine: ['Quarant[äa]n\\p{L}*'],
    removal: ['entfern\\p{L}*', 'lösch\\p{L}*', 'ignorier\\p{L}*', 'umgeh\\p{L}*', 'deaktivier\\p{L}*', 'überspring\\p{L}*'],
    removedPast: ['entfernt', 'gelöscht', 'ignoriert', 'umgangen', 'deaktiviert'],
    openAnyway: ['Trotzdem öffnen'],
    click: ['Rechtsklick', 'Control-Klick'],
    openWord: ['öffnen\\p{L}*'],
    securityPane: ['Datenschutz (?:&|und) Sicherheit'],
    allowWord: ['erlaub\\p{L}*'],
    prohibition: ['nicht', 'niemals', 'kein', 'keine', 'ohne', 'verboten'],
    coordAnd: ['und'],
    coordOr: ['oder', 'noch'],
    targetVerb: ['verwend\\p{L}*', 'nutz\\p{L}*', 'änder\\p{L}*'],
    sequence: ['dann', 'aber', 'also', 'sondern'],
  },
  fr: {
    quarantine: ['quarantain\\p{L}*'],
    removal: ['supprim\\p{L}*', 'retir\\p{L}*', 'enlev\\p{L}*', 'ignor\\p{L}*', 'désactiv\\p{L}*', 'contourn\\p{L}*'],
    removedPast: ['supprimé', 'retiré', 'enlevé', 'ignoré', 'désactivé', 'contourné'],
    openAnyway: ['ouvrir quand même'],
    click: ['clic droit', 'Contrôle-clic'],
    openWord: ['ouvr\\p{L}*'],
    securityPane: ['Confidentialité et sécurité'],
    allowWord: ['autoris\\p{L}*'],
    prohibition: ['ne', 'pas', 'jamais', 'sans', 'aucun', 'interdit'],
    coordAnd: ['et'],
    coordOr: ['ou', 'ni'],
    targetVerb: ['utilis\\p{L}*', 'modifi\\p{L}*'],
    sequence: ['puis', 'mais', 'donc'],
  },
  hu: {
    quarantine: ['karant[ée]n\\p{L}*'],
    removal: ['távolít\\p{L}*', 'eltávolít\\p{L}*', 'töröl\\p{L}*', 'figyelmen kívül hagy\\p{L}*', 'kikapcsol\\p{L}*', 'letilt\\p{L}*', 'kerüld meg', 'kapcsold ki'],
    removedPast: ['eltávolított', 'törölt', 'kikapcsolt', 'letiltott'],
    openAnyway: ['mégis megnyit\\p{L}*'],
    click: ['jobb gombbal', 'Ctrl-kattint\\p{L}*'],
    openWord: ['megnyit\\p{L}*'],
    securityPane: ['Adatvédelem és biztonság'],
    allowWord: ['engedélyez\\p{L}*'],
    prohibition: ['ne', 'nem', 'soha', 'nélkül', 'tilos'],
    coordAnd: ['és'],
    coordOr: ['vagy', 'sem'],
    targetVerb: ['használ\\p{L}*', 'módosít\\p{L}*'],
    sequence: ['majd', 'aztán', 'de'],
  },
  it: {
    quarantine: ['quarantena\\p{L}*'],
    removal: ['rimuov\\p{L}*', 'elimin\\p{L}*', 'ignor\\p{L}*', 'disattiv\\p{L}*', 'aggir\\p{L}*'],
    removedPast: ['rimosso', 'eliminato', 'ignorato', 'disattivato', 'aggirato'],
    openAnyway: ['apri comunque'],
    click: ['clic destro', 'Control-clic'],
    openWord: ['apri\\p{L}*'],
    securityPane: ['Privacy e sicurezza'],
    allowWord: ['consent\\p{L}*'],
    prohibition: ['non', 'mai', 'senza', 'nessun', 'vietato'],
    coordAnd: ['e'],
    coordOr: ['o', 'né'],
    targetVerb: ['usa\\p{L}*', 'modific\\p{L}*'],
    sequence: ['poi', 'ma', 'quindi'],
  },
  pl: {
    quarantine: ['kwarant\\p{L}*'],
    removal: ['usu[nńw]\\p{L}*', 'zignoruj\\p{L}*', 'ignoruj\\p{L}*', 'wyłącz\\p{L}*', 'omi[ńąa]\\p{L}*', 'pomi[ńąa]\\p{L}*', 'obejdź\\p{L}*'],
    removedPast: ['usunięty', 'zignorowany', 'ignorowany', 'wyłączony', 'pominięty'],
    openAnyway: ['otwórz mimo to'],
    click: ['prawym', 'Ctrl-klik\\p{L}*'],
    openWord: ['otw[óo]rz\\p{L}*', 'otwierać'],
    securityPane: ['Prywatność i ochrona'],
    allowWord: ['zezwól\\p{L}*'],
    prohibition: ['nie', 'nigdy', 'bez', 'zabronione'],
    coordAnd: ['i'],
    coordOr: ['lub', 'ani'],
    targetVerb: ['używ\\p{L}*', 'zmieni\\p{L}*'],
    sequence: ['potem', 'ale', 'więc', 'a'],
  },
  sk: {
    quarantine: ['karant[ée]n\\p{L}*'],
    removal: ['odstr[áa]\\p{L}*', 'vymaz\\p{L}*', 'ignor\\p{L}*', 'vypn\\p{L}*', 'obí[dď]\\p{L}*'],
    removedPast: ['odstránený', 'vymazaný', 'ignorovaný', 'vypnutý', 'obídený'],
    openAnyway: ['napriek tomu otvori\\p{L}*'],
    click: ['pravým tlačidlom', 'Ctrl-klik\\p{L}*'],
    openWord: ['otvor\\p{L}*'],
    securityPane: ['Súkromie a bezpečnosť'],
    allowWord: ['povoľ\\p{L}*'],
    prohibition: ['nie', 'nikdy', 'bez', 'nesmiete', 'nesmie', 'zakázané'],
    coordAnd: ['a'],
    coordOr: ['alebo', 'ani'],
    targetVerb: ['použív\\p{L}*', 'zmen\\p{L}*'],
    sequence: ['potom', 'ale', 'tak'],
  },
  uk: {
    quarantine: ['карантин\\p{L}*'],
    removal: ['видал\\p{L}*', 'ігнору\\p{L}*', 'вимкн\\p{L}*', 'вимикай\\p{L}*', 'обійд\\p{L}*'],
    removedPast: ['видалений', 'ігнорований', 'вимкнений', 'обійдений'],
    openAnyway: ['все одно відкри\\p{L}*'],
    click: ['правою', 'Ctrl-клік\\p{L}*'],
    openWord: ['відкри\\p{L}*'],
    securityPane: ['Конфіденційність і безпека'],
    allowWord: ['дозвол\\p{L}*'],
    prohibition: ['не', 'ніколи', 'без', 'заборонено'],
    coordAnd: ['і', 'та'],
    coordOr: ['або', 'чи'],
    targetVerb: ['використ\\p{L}*', 'змін\\p{L}*'],
    sequence: ['потім', 'але', 'тож', 'а'],
  },
};
const SCAN_LANGUAGES = Object.keys(LEXICON);
// Short coordinators and sequence words are also ordinary words of other languages ("a", "e", "i", "o", "de", "so", "et"). Outside its own
// locale catalogue such a word would split English at every article, so it separates units only in its own catalogue.
const AMBIGUOUS_SEPARATORS = ['a', 'e', 'o', 'i', 'de', 'ma', 'ni', 'né', 'és', 'et', 'ou', 'і', 'та', 'so'];
const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';
const GAP = '[^\\n(){}:;=,]{0,30}'; // stops at punctuation, so code such as `dropped: 0, quarantine` is not prose
// What a coordinator or sequence word may follow when no comma comes first. The no-comma mutant replaces it with a pattern that never matches.
const NO_COMMA = '\\s+';
// The rules for one file, compiled from the lexicon of its languages. A locale catalogue is read with its own language and English;
// every other file with all languages, without the ambiguous short separators.
const buildScope = (langs, global) => {
  const alt = (key) => langs.flatMap((lang) => LEXICON[lang][key]).join('|');
  const words = (key) => langs.flatMap((lang) => LEXICON[lang][key]).filter((word) => !global || !AMBIGUOUS_SEPARATORS.includes(word)).join('|');
  const quarantine = alt('quarantine');
  const removal = alt('removal');
  // A gap between two words of one prohibited action never crosses a coordinator: "remove the quarantine flag or ignore it" is two units.
  const coordinators = `${words('coordAnd')}|${words('coordOr')}`;
  const gap = `(?:(?!\\s(?:${coordinators})${WORD_END})[^\\n(){}:;=,]){0,30}`;
  // Finite verbs that make a prohibition a bypass action when they take a bypass target, in either order (`use Gatekeeper`, `Gatekeeper deaktivieren`).
  const actionVerb = `${removal}|${alt('targetVerb')}`;
  // A bypass action run into the unit before it with no separator at all ("Do not panic remove the quarantine flag") is a unit of its own:
  // without the split, the prohibition of the first clause would govern the bypass too. The split is not made after a prohibition word
  // (with at most an adverb between: "Do not ever remove" stays one clause), nor after a coordinator or sequence word, which already
  // separates the units ("Do not use Gatekeeper, and remove ..." stays one joint prohibition).
  // Only a removal that takes its bypass target directly (the same shape the hit patterns below match) is split off, and never after a
  // preposition: "must not be opened by removing the quarantine flag" keeps its prohibition.
  const JUXTAPOSED = `(?<!${WORD_START}(?:${alt('prohibition')}|${words('coordAnd')}|${words('coordOr')}|${words('sequence')}|by|to|of|with|for|in|on|at|from|into|through|via)(?:\\s+(?:ever|even|also|just|simply|directly|any|yet))?)\\s+(?=(?:${removal})${gap}(?:${quarantine}|Gatekeeper\\p{L}*))`;
  const target = `Gatekeeper\\p{L}*|${quarantine}`;
  const strong = new RegExp(`${WORD_START}(?:${alt('openAnyway')}|${alt('click')})|xattr\\s+-[a-z]*d|xattr\\s+-c\\b|spctl\\s+--`, 'iu');
  const verbTarget = new RegExp(`${WORD_START}(?:${actionVerb})${gap}${WORD_START}(?:${target})|${WORD_START}(?:${target})${gap}${WORD_START}(?:${actionVerb})`, 'iu');
  const bareVerb = new RegExp(`${WORD_START}(?:${actionVerb})$`, 'iu');
  // A prohibition is bypass-related when its unit is a bypass action. A mere mention of Gatekeeper or of the quarantine is not enough.
  const joinable = (text) => strong.test(text) || verbTarget.test(text) || bareVerb.test(text.replace(/[\s.,;:!?]+$/, ''));
  return {
    joinable,
    prohibition: new RegExp(`${WORD_START}(?:${alt('prohibition')})${WORD_END}`, 'iu'),
    // Hard stops; a sequence word after a comma or without one; a comma-coordinator (", or", ", and"); a coordinator without a comma; a plain comma.
    separator: new RegExp(`[.!?;:](?=\\s|$)|(?:,\\s*|${NO_COMMA})(?<seq>${words('sequence')})${WORD_END}|,\\s*(?<orc>${words('coordOr')})${WORD_END}|,\\s*(?<andc>${words('coordAnd')})${WORD_END}|${NO_COMMA}(?<ws>${words('coordOr')}|${words('coordAnd')})${WORD_END}|${JUXTAPOSED}|,\\s+`, 'giu'),
    sequenceStart: new RegExp(`^\\s*(?:${words('sequence')})${WORD_END}`, 'iu'),
    // A unit that opens with a removal or target verb is a new instruction, not a list noun.
    actionStart: new RegExp(`^\\s*(?:${actionVerb})${WORD_END}`, 'iu'),
    patterns: [
      /\bxattr\s+-[a-z]*d[a-z]*\b/gi, // removing an attribute, for example `xattr -dr com.apple.quarantine`
      /\bxattr\s+-c\b/gi, // clearing every attribute
      new RegExp(`${WORD_START}(?:${removal})${gap}${WORD_START}(?:${quarantine})`, 'giu'), // drop, ignore or remove the quarantine
      new RegExp(`${WORD_START}(?:${quarantine})${gap}${WORD_START}(?:${alt('removedPast')})${WORD_END}`, 'giu'), // the quarantine is removed
      new RegExp(`${WORD_START}(?:${alt('openAnyway')})`, 'giu'), // Open Anyway
      new RegExp(`${WORD_START}(?:${alt('click')})[^\\n]{0,60}${WORD_START}(?:${alt('openWord')})`, 'giu'), // Control-click or right-click, then open
      new RegExp(`(?:${alt('securityPane')})[^\\n]{0,60}${WORD_START}(?:${alt('openWord')}|${alt('allowWord')})`, 'giu'), // Privacy & Security, then open or allow
      new RegExp(`${WORD_START}(?:${alt('allowWord')})[^\\n]{0,40}${WORD_START}(?:${alt('securityPane')}|Gatekeeper\\p{L}*)`, 'giu'), // allow it, in the security settings or at Gatekeeper
      new RegExp(`${WORD_START}(?:${removal})${gap}${WORD_START}Gatekeeper\\p{L}*`, 'giu'), // ignore or disable Gatekeeper
      new RegExp(`${WORD_START}(?:${target})${gap}${WORD_START}(?:${removal})`, 'giu'), // object first: Gatekeeper deaktivieren, das Quarantäne-Attribut entfernen
      /\bspctl\s+--(?:add|master-disable|global-disable)\b/gi, // changing Gatekeeper's rules (`spctl --assess` is read-only)
    ],
  };
};
const scopes = new Map();
const scopeFor = (lang) => {
  const key = lang ?? 'all';
  if (!scopes.has(key)) scopes.set(key, lang ? buildScope([lang, 'en'], false) : buildScope(SCAN_LANGUAGES, true));
  return scopes.get(key);
};
// Private Mac documents: make-public-tree removes them, so the public tree does not carry them. Each check that reads one is skipped with
// a reason when it is missing; the other checks still run. These names are written only in the definitions below.
const M3_REPORT = 'docs/MAC_LOCAL_REPORT_arm64_2026-10-06.md';
const PRIVATE_MAC_DOCS = ['docs/MAC_LOCAL_LOG.md', M3_REPORT, 'docs/MAC_LOCAL_REPORT_TEMPLATE.md', 'docs/MAC_LOCAL_SESSION.md'];
const BYPASS_FILES = ['README.md', 'CHANGELOG.md', 'scripts/mac-local-evidence.sh', ...PRIVATE_MAC_DOCS];
const missingPrivateSkip = () => {
  const missing = PRIVATE_MAC_DOCS.filter((file) => !fs.existsSync(rel(file)));
  return missing.length ? `private document(s) not in this tree (removed from the public tree): ${missing.join(', ')}` : false;
};

const EIGHT_LOCALES = ['de', 'en', 'fr', 'hu', 'it', 'pl', 'sk', 'uk'];
const USER_DOCS = ['README.md', 'CHANGELOG.md', 'RELEASING.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/SUPPORT.md', 'docs/LINUX.md'];

// The kind of the separator in front of a unit: a hard stop or a sequence word starts a new unit ('seq'); a comma-coordinator or a plain
// comma starts a list item ('list'); a coordinator without a comma starts a coordinated unit ('coord').
const separatorKind = (sep) => {
  if (sep.groups?.seq !== undefined || /^[.!?;:]$/.test(sep[0].trim())) return 'seq';
  if (sep.groups?.andc !== undefined || sep.groups?.ws !== undefined) return 'coord';
  return 'list';
};

// The units of a line: the pieces between separators, each with the kind of the separator in front of it.
const itemsOf = (line, scope) => {
  const items = [];
  let from = 0;
  let kind = 'start';
  for (const sep of line.matchAll(scope.separator)) {
    items.push({ start: from, text: line.slice(from, sep.index), kind });
    kind = separatorKind(sep);
    from = sep.index + sep[0].length;
  }
  items.push({ start: from, text: line.slice(from), kind });
  return items.map((item) => (item.kind !== 'seq' && scope.sequenceStart.test(item.text) ? { ...item, kind: 'seq' } : item));
};

// Marks each unit as governed. Its own prohibition governs it. A bypass-scoped prohibition governs the list items joined to it by a
// comma, and the coordinated units that are bypass actions themselves. A prohibition on an unrelated unit covers only that unit.
const governedItems = (items, scope) => {
  let previous = { scope: null, joinable: false };
  return items.map((item) => {
    const own = scope.prohibition.test(item.text);
    const joinable = scope.joinable(item.text);
    let carried = null;
    // A list item that opens with a removal or target verb is a new instruction: it needs a bypass predecessor to carry the prohibition.
    if (!own && previous.scope === 'bypass' && item.kind === 'list' && (!scope.actionStart.test(item.text) || previous.joinable)) carried = 'bypass';
    else if (!own && previous.scope === 'bypass' && item.kind === 'coord' && previous.joinable && joinable) carried = 'bypass';
    previous = { scope: own ? (joinable ? 'bypass' : 'unrelated') : carried, joinable };
    return { ...item, governed: own || carried !== null };
  });
};

// Every bypass hit in `text` that no prohibition governs. `lang` names the language of a locale catalogue (null for any other file).
const bypassViolations = (text, lang = null) => {
  const scope = scopeFor(lang);
  const hits = [];
  for (const line of text.split('\n')) {
    let items = null;
    for (const pattern of scope.patterns) {
      for (const match of line.matchAll(pattern)) {
        items ??= governedItems(itemsOf(line, scope), scope);
        // A hit may run across separators: it is governed only when every unit it touches is governed.
        const touched = items.filter((unit) => unit.start < match.index + match[0].length && unit.start + unit.text.length > match.index);
        if (!touched.every((unit) => unit.governed) && !scope.prohibition.test(match[0])) hits.push(match[0]);
      }
    }
  }
  return hits;
};

const listFiles = (directory, keep) => fs.readdirSync(rel(directory), { withFileTypes: true }).flatMap((entry) => {
  const name = `${directory}/${entry.name}`;
  return entry.isDirectory() ? listFiles(name, keep) : (keep(name) ? [name] : []);
});

const SERVICE_DOCS = ['services/bug-report-worker/README.md', 'services/support-worker/README.md'];
// Test harness fixtures are test material, not user guidance: the tests and harness folders, `testing/` and `fixtures/` folders, and `*.test.*` files.
const isFixture = (name) => /^(?:tests|harness)\//.test(name) || /(?:^|\/)(?:testing|fixtures?)\//.test(name) || /\.test\.[tj]sx?$/.test(name);
// Website source, when a checkout carries it. Nothing is fetched: an absent site is simply not in the repository.
const WEBSITE_DIRS = ['site', 'website', 'www', 'web', 'pages', 'public', 'docs/site'];
const WEBSITE_TEXT = /\.(?:md|mdx|html?|tsx?|jsx?|json|ya?ml)$/;
// The language of a locale catalogue ('sk' for electron/locales/sk/...), or null for every other file.
const langOf = (file) => /^electron\/locales\/([a-z]{2})\//.exec(file)?.[1] ?? null;
// Everything a user can read: root and docs Markdown, issue templates, service READMEs, all eight locales, the app's source strings,
// website source when present, plus the Mac sources.
const userFacingFiles = () => [...new Set([
  ...fs.readdirSync(ROOT).filter((name) => name.endsWith('.md') && fs.statSync(rel(name)).isFile()),
  ...listFiles('docs', (name) => name.endsWith('.md')),
  ...listFiles('.github', (name) => /\.(?:md|ya?ml)$/.test(name)),
  ...SERVICE_DOCS.filter((file) => fs.existsSync(rel(file))),
  ...BYPASS_FILES.filter((file) => fs.existsSync(rel(file))),
  ...EIGHT_LOCALES.flatMap((lang) => listFiles(`electron/locales/${lang}`, (name) => name.endsWith('.json'))),
  ...listFiles('src', (name) => /\.(?:tsx?|json)$/.test(name)),
  ...WEBSITE_DIRS.filter((dir) => fs.existsSync(rel(dir))).flatMap((dir) => listFiles(dir, (name) => WEBSITE_TEXT.test(name))),
  ...macFiles(),
])].filter((file) => !isFixture(file) && file !== SELF_FILE);

test('static: every user-facing text gives no Gatekeeper bypass: root and docs, issue templates, service READMEs, all eight locales, src and the Mac sources', () => {
  assert.deepEqual(fs.readdirSync(rel('electron', 'locales')).sort(), EIGHT_LOCALES, 'the scan covers exactly the eight shipped locales');
  const files = userFacingFiles();
  for (const lang of EIGHT_LOCALES) assert.ok(files.some((file) => file.startsWith(`electron/locales/${lang}/`)), `electron/locales/${lang} is scanned`);
  assert.ok(files.some((file) => file.startsWith('src/') && file.endsWith('.tsx')), 'src components are scanned');
  assert.ok(files.some((file) => file.startsWith('src/') && file.endsWith('.ts')), 'src modules are scanned');
  assert.ok(files.some((file) => file.startsWith('docs/') && file.endsWith('.md')), 'tracked docs are scanned');
  assert.ok(files.includes('.github/ISSUE_TEMPLATE/bug_report.yml') && files.includes('.github/ISSUE_TEMPLATE/format_request.yml'), 'issue templates are scanned');
  for (const file of [...USER_DOCS, ...SERVICE_DOCS].filter((name) => fs.existsSync(rel(name)))) assert.ok(files.includes(file), `${file} is scanned`);
  assert.ok(files.includes(WORKFLOW_FILE) && files.includes('README.md') && files.includes('CHANGELOG.md'), 'the release body and the public README are scanned');
  const violations = files.flatMap((file) => bypassViolations(read(file), langOf(file)).map((hit) => `${file}: ${hit}`));
  assert.deepEqual(violations, [], 'no user-facing or Mac text may tell a user to remove the quarantine flag, use Open Anyway, right-click Open or disable Gatekeeper');
});

test('static: test harness fixtures are not user guidance; the inventory covers the user-facing trees', () => {
  const files = userFacingFiles();
  for (const fixture of ['tests/mac-config-checks.cjs', 'harness/workspace.tsx', 'src/lib/library/testing/families.ts', 'src/lib/formats/zip.test.ts']) {
    assert.equal(isFixture(fixture), true, `${fixture} is a fixture`);
    assert.ok(!files.includes(fixture), `${fixture} is not classified as user guidance`);
  }
  assert.equal(isFixture('src/components/workspace/Shell.tsx'), false, 'application source is not a fixture');
  assert.ok(files.includes('services/support-worker/README.md'), 'service READMEs are inventoried');
  assert.ok(files.includes('.github/ISSUE_TEMPLATE/bug_report.yml'), 'issue templates are inventoried');
});

test('static: website source is scanned whenever it is present in the repository; nothing is fetched', () => {
  const files = userFacingFiles();
  for (const dir of WEBSITE_DIRS.filter((name) => fs.existsSync(rel(name)))) {
    for (const file of listFiles(dir, (name) => WEBSITE_TEXT.test(name))) {
      if (!isFixture(file)) assert.ok(files.includes(file), `${file} is scanned`);
    }
  }
});

test('static: the guard catches injected bypass guidance in a locale value, a source string, a doc table row, a bullet and a sentence', () => {
  const injected = [
    ['locale value', '  "macos.blocked": "Remove the quarantine flag, then open the app.",'],
    ['source string', "const hint = 'Control-click the app and choose Open.'; // shown to the user"],
    ['doc table row', '| 3 | Run xattr -dr com.apple.quarantine "/Applications/TRACE Boardviewer.app" in Terminal |'],
    ['doc bullet', '- Click "Open Anyway" in System Settings > Privacy & Security.'],
    ['doc sentence', 'Turn off Gatekeeper with sudo spctl --master-disable, then open it.'],
    ['ignore the flag', 'You can ignore the quarantine warning and open the app.'],
    ['allow once', 'Click Allow it once in Privacy & Security.'],
    ['right-click', 'Right-click the app and choose Open to get past Gatekeeper.'],
    ['later sentence', 'Do not panic. Remove the quarantine flag, then open the app.'],
    ['issue template step', '      Run xattr -dr com.apple.quarantine on the app, then open it.'],
    ['service README step', '3. Ignore the quarantine warning and open the app.'],
    ['list item', '- Remove the quarantine flag; then open the app.'],
  ];
  for (const [form, line] of injected) assert.ok(bypassViolations(line).length > 0, `${form} is not caught: ${line}`);
});

test('static: the guard allows explicit prohibitions and read-only xattr listings', () => {
  const allowed = [
    'Do not run xattr -dr com.apple.quarantine on this app.',
    'Never use Control-click or right-click Open, or Open Anyway.',
    'The quarantine flag must not be removed to open it.',
    'Do not click Allow it once in Privacy & Security.',
    'Do not change Gatekeeper settings or run spctl --master-disable.',
    'This page gives no way around that block: do not remove the quarantine flag.',
    'Read-only evidence: xattr -l "$ZIP" and xattr -lr "$APP" list the attributes.',
    'Read-only check: xattr -p com.apple.quarantine "$APP" prints the flag.',
    'Gatekeeper may block a downloaded copy; this page gives no way around that block.',
  ];
  for (const line of allowed) assert.deepEqual(bypassViolations(line), [], line);
});

// Each guard family has its own test, so a failure in one family cannot hide another (in particular the no-comma family).
test('static: comma variants of an unrelated prohibition are caught', () => {
  const unrelated = [
    'Do not panic, and remove the quarantine flag, then open the app.',
    'Do not panic, remove the quarantine flag.',
    'Do not panic; remove the quarantine flag.',
    'Do not panic: remove the quarantine flag.',
    'Do not panic. Remove the quarantine flag.',
    'Do not panic, and then remove the quarantine flag.',
    'Do not panic, and clear the quarantine flag.',
  ];
  for (const line of unrelated) assert.ok(bypassViolations(line).length > 0, `not caught: ${line}`);
});

test('static: the exact unrelated-panic control is caught: "Do not panic and remove the quarantine flag."', () => {
  assert.ok(bypassViolations('Do not panic and remove the quarantine flag.').length > 0, 'the exact control is not caught');
});

// The no-comma family alone: no comma and no punctuation between the unrelated prohibition and the bypass action.
test('static: no-comma variants of an unrelated prohibition are caught (isolated no-comma regression)', () => {
  const unrelated = [
    'Do not panic or remove the quarantine flag.',
    'Do not panic and disable Gatekeeper.',
    'Do not panic and run xattr -dr com.apple.quarantine.',
    'Do not panic and then remove the quarantine flag.',
    'Never mind and remove the quarantine flag.',
    'Do not delete your notes and remove the quarantine flag.',
  ];
  for (const line of unrelated) assert.ok(bypassViolations(line).length > 0, `not caught: ${line}`);
});

test('static: a bypass action with no prohibition at all is always caught', () => {
  for (const line of ['Remove the quarantine flag and disable Gatekeeper.', 'Remove the quarantine flag or disable Gatekeeper.']) {
    assert.ok(bypassViolations(line).length > 0, `not caught: ${line}`);
  }
});

// A bypass-related prohibition does not reach an unrelated action, and a mere mention of Gatekeeper or the quarantine
// does not make a prohibition bypass-related.
test('static: an unrelated action or a mere mention does not inherit a bypass prohibition', () => {
  const inherited = [
    'Do not panic about Gatekeeper and remove the quarantine flag.',
    'Do not use Gatekeeper and panic and remove the quarantine flag.',
    'Do not use Gatekeeper, panic, and remove the quarantine flag.',
    'Gatekeeper disabled, then open the app.',
  ];
  assert.deepEqual(inherited.filter((line) => bypassViolations(line).length === 0), [], 'every inherited-bypass sample is caught');
});

// TB-056: a prohibition on an unrelated clause does not reach a removal that is joined to it with no separator, or with ", and"; a joint
// prohibition of two bypass actions, and a prohibited object ("must not be opened by removing ..."), stay allowed.
test('static: a prohibition on an unrelated clause does not reach a removal joined to it without a separator or with ", and" (TB-056)', () => {
  const inherited = [
    'Do not panic remove the quarantine flag.',
    'Do not panic and remove the quarantine flag.',
    'Do not panic, and remove the quarantine flag.',
    'Do not panic, remove the quarantine flag.',
  ];
  assert.deepEqual(inherited.filter((line) => bypassViolations(line).length === 0), [], 'every inherited-bypass sample is caught');
  const allowed = [
    'Do not use Gatekeeper remove the quarantine flag.',
    'Do not use Gatekeeper, and remove the quarantine flag.',
    'The app must not be opened by removing the quarantine flag.',
    'Do not ever remove the quarantine flag.',
  ];
  assert.deepEqual(allowed.filter((line) => bypassViolations(line).length !== 0), [], 'joint prohibitions and prohibited objects stay allowed');
});

test('static: genuine prohibition lists and jointly prohibited bypass actions stay allowed', () => {
  const genuine = [
    'Do not use Control-click or right-click Open, "Open Anyway" in System Settings, quarantine-attribute removal (`xattr -d` or `-dr`), or any change to Gatekeeper or `spctl` settings to let the app run.',
    'Do not run xattr -dr com.apple.quarantine, or remove the quarantine flag.',
    'Never use Control-click or right-click Open, or Open Anyway.',
    'Do not change Gatekeeper settings, and do not remove the quarantine flag.',
    'Never remove the quarantine flag and disable Gatekeeper.',
    'Never remove the quarantine flag or disable Gatekeeper.',
    'Do not remove or disable Gatekeeper.',
    'Do not use Gatekeeper, notes, or Open Anyway.',
    'Never remove quarantine, disable Gatekeeper, or ignore Gatekeeper.',
    'Do not have Gatekeeper disabled.',
    'Do not change Gatekeeper settings or run spctl --master-disable.',
    // Read-only listings and prohibitions beside them.
    'Read-only: xattr -l "$ZIP" lists the flag. Do not remove it.',
    'xattr -lr "$APP"',
  ];
  for (const line of genuine) assert.deepEqual(bypassViolations(line), [], line);
});

// Per locale: an unsafe removal; an unrelated prohibition followed by the same removal, with no comma and with one; an Open Anyway
// step; a removal of Gatekeeper; a joint prohibition of two bypass actions (must stay allowed); and an explicit prohibition (allowed).
const LOCALE_CONTROLS = {
  de: { unsafe: 'Entfernen Sie das Quarantäne-Attribut mit xattr und öffnen Sie die App.', unrelatedNoComma: 'Nicht schlimm und entfernen Sie das Quarantäne-Attribut.', unrelated: 'Nicht schlimm, entfernen Sie das Quarantäne-Attribut.', openAnyway: 'Klicken Sie auf „Trotzdem öffnen“, um die App zu starten.', disableGatekeeper: 'Deaktivieren Sie Gatekeeper, um die App zu starten.', jointAllowed: 'Entfernen Sie das Quarantäne-Attribut nicht oder deaktivieren Sie Gatekeeper nicht.', allowed: 'Entfernen Sie das Quarantäne-Attribut nicht, ignorieren Sie es nicht.' },
  en: { unsafe: 'Remove the quarantine flag with xattr, then open the app.', unrelatedNoComma: 'Do not panic and remove the quarantine flag.', unrelated: 'Do not panic, and remove the quarantine flag.', openAnyway: 'Click Open Anyway to start the app.', disableGatekeeper: 'Disable Gatekeeper to start the app.', jointAllowed: 'Never remove the quarantine flag or disable Gatekeeper.', allowed: 'Do not remove the quarantine flag or ignore it.' },
  fr: { unsafe: 'Supprimez l’attribut de quarantaine avec xattr, puis ouvrez l’app.', unrelatedNoComma: 'Ce n’est pas grave et supprimez l’attribut de quarantaine.', unrelated: 'Ce n’est pas grave, supprimez l’attribut de quarantaine.', openAnyway: 'Cliquez sur « Ouvrir quand même » pour lancer l’app.', disableGatekeeper: 'Désactivez Gatekeeper pour lancer l’app.', jointAllowed: 'Ne supprimez pas l’attribut de quarantaine ni ne désactivez Gatekeeper.', allowed: 'Ne supprimez pas l’attribut de quarantaine, ne l’ignorez pas.' },
  hu: { unsafe: 'Távolítsd el a karantén attribútumot xattr-rel, majd nyisd meg az appot.', unrelatedNoComma: 'Ne aggódj és távolítsd el a karantén attribútumot.', unrelated: 'Ne aggódj, távolítsd el a karantén attribútumot.', openAnyway: 'Kattints a „Mégis megnyitás” gombra.', disableGatekeeper: 'Kapcsold ki a Gatekeepert, majd nyisd meg az appot.', jointAllowed: 'Ne távolítsd el a karantén attribútumot, vagy kapcsold ki a Gatekeepert.', allowed: 'Ne távolítsd el a karantén attribútumot, és ne nyisd meg mégis.' },
  it: { unsafe: 'Rimuovi l’attributo di quarantena con xattr e apri l’app.', unrelatedNoComma: 'Non è niente e rimuovi l’attributo di quarantena.', unrelated: 'Non è niente, rimuovi l’attributo di quarantena.', openAnyway: 'Clicca su «Apri comunque» per avviare l’app.', disableGatekeeper: 'Disattiva Gatekeeper per avviare l’app.', jointAllowed: 'Non rimuovere l’attributo di quarantena né disattivare Gatekeeper.', allowed: 'Non rimuovere l’attributo di quarantena, non ignorarlo.' },
  pl: { unsafe: 'Usuń atrybut kwarantanny poleceniem xattr, a potem otwórz aplikację.', unrelatedNoComma: 'Nie martw się i usuń atrybut kwarantanny.', unrelated: 'Nie martw się, usuń atrybut kwarantanny.', openAnyway: 'Kliknij „Otwórz mimo to”, aby uruchomić aplikację.', disableGatekeeper: 'Wyłącz Gatekeepera, aby uruchomić aplikację.', jointAllowed: 'Nie usuwaj atrybutu kwarantanny ani nie wyłączaj Gatekeepera.', allowed: 'Nie usuwaj atrybutu kwarantanny, nie ignoruj go.' },
  sk: { unsafe: 'Odstráňte atribút karantény príkazom xattr a potom otvorte aplikáciu.', unrelatedNoComma: 'Nie sa boj a odstráňte atribút karantény.', unrelated: 'Nie sa boj, odstráňte atribút karantény.', openAnyway: 'Kliknite na „Napriek tomu otvoriť“.', disableGatekeeper: 'Vypnite Gatekeeper, aby sa aplikácia spustila.', jointAllowed: 'Nesmiete odstrániť atribút karantény ani vypnúť Gatekeeper.', allowed: 'Nesmiete odstrániť atribút karantény a nesmiete ignorovať Gatekeeper.' },
  uk: { unsafe: 'Видаліть атрибут карантину командою xattr, а потім відкрийте застосунок.', unrelatedNoComma: 'Не хвилюйтеся і видаліть атрибут карантину.', unrelated: 'Не хвилюйтеся, видаліть атрибут карантину.', openAnyway: 'Натисніть «Все одно відкрити».', disableGatekeeper: 'Вимикайте Gatekeeper, щоб запустити застосунок.', jointAllowed: 'Не видаляйте атрибут карантину або не вимикайте Gatekeeper.', allowed: 'Не видаляйте атрибут карантину, не ігноруйте його.' },
};

test('static: every locale catches unsafe, no-comma and comma unrelated prohibitions, Open Anyway and Gatekeeper removal, and allows joint and explicit prohibitions', () => {
  assert.deepEqual(Object.keys(LOCALE_CONTROLS).sort(), EIGHT_LOCALES, 'a control set for each of the eight locales');
  for (const [lang, control] of Object.entries(LOCALE_CONTROLS)) {
    for (const key of ['unsafe', 'unrelatedNoComma', 'unrelated', 'openAnyway', 'disableGatekeeper']) {
      assert.ok(bypassViolations(control[key], lang).length > 0, `${lang}: ${key} is not caught: ${control[key]}`);
    }
    for (const key of ['jointAllowed', 'allowed']) {
      assert.deepEqual(bypassViolations(control[key], lang), [], `${lang}: ${key} is not allowed: ${control[key]}`);
    }
  }
});

// A comma list that carries a bypass prohibition: its items may be unrelated words, but an item that starts with a removal verb is a new
// instruction and must be a bypass action of its own (or follow one). Must be caught in every locale.
const LIST_CARRY = {
  de: 'Verwenden Sie Gatekeeper nicht, lachen Sie, oder entfernen Sie das Quarantäne-Attribut.',
  en: 'Do not use Gatekeeper, panic, or remove the quarantine flag.',
  fr: 'N’utilisez pas Gatekeeper, riez, ou supprimez l’attribut de quarantaine.',
  hu: 'Ne használd a Gatekeepert, nevess, vagy távolítsd el a karantén attribútumot.',
  it: 'Non usare Gatekeeper, ridere, o rimuovi l’attributo di quarantena.',
  pl: 'Nie używaj Gatekeepera, śmiej się, lub usuń atrybut kwarantanny.',
  sk: 'Nesmiete používať Gatekeeper, smiať sa, alebo odstrániť atribút karantény.',
  uk: 'Не використовуйте Gatekeeper, сміятися, або видаліть атрибут карантину.',
};

// Object-first removal of the quarantine flag (German infinitive, Hungarian noun before the object): caught; with a prohibition: allowed.
const OBJECT_FIRST_QUARANTINE = {
  de: { unsafe: 'Das Quarantäne-Attribut entfernen, dann öffnen Sie die App.', negated: 'Das Quarantäne-Attribut nicht entfernen.' },
  hu: { unsafe: 'A karantén attribútum eltávolítása, majd nyisd meg az appot.', negated: 'A karantén attribútum eltávolítása tilos.' },
  en: { unsafe: 'The quarantine flag removed, then open the app.', negated: 'The quarantine flag must not be removed.' },
  fr: { unsafe: 'L’attribut de quarantaine supprimé, puis ouvrez l’app.', negated: 'L’attribut de quarantaine ne doit pas être supprimé.' },
  it: { unsafe: 'L’attributo di quarantena rimosso, poi apri l’app.', negated: 'L’attributo di quarantena non deve essere rimosso.' },
  pl: { unsafe: 'Atrybut kwarantanny usunięty, a potem otwórz aplikację.', negated: 'Atrybut kwarantanny nie może być usunięty.' },
  sk: { unsafe: 'Atribút karantény odstránený, potom otvorte aplikáciu.', negated: 'Atribút karantény nesmie byť odstránený.' },
  uk: { unsafe: 'Атрибут карантину видалений, потім відкрийте застосунок.', negated: 'Атрибут карантину не можна видалити.' },
};

test('static: every locale catches a list that carries a bypass prohibition into a removal, and object-first quarantine removal; a prohibited object-first form is allowed', () => {
  assert.deepEqual(Object.keys(LIST_CARRY).sort(), EIGHT_LOCALES, 'a list-carry control for each of the eight locales');
  assert.deepEqual(Object.keys(OBJECT_FIRST_QUARANTINE).sort(), EIGHT_LOCALES, 'an object-first control for each of the eight locales');
  const failures = [];
  for (const [lang, line] of Object.entries(LIST_CARRY)) {
    if (bypassViolations(line, lang).length === 0) failures.push(`${lang}: list carry is not caught: ${line}`);
  }
  for (const [lang, control] of Object.entries(OBJECT_FIRST_QUARANTINE)) {
    if (bypassViolations(control.unsafe, lang).length === 0) failures.push(`${lang}: object-first removal is not caught: ${control.unsafe}`);
    if (bypassViolations(control.negated, lang).length > 0) failures.push(`${lang}: object-first prohibition is not allowed: ${control.negated}`);
  }
  assert.deepEqual(failures, [], 'every list-carry and object-first control holds');
});

// Per locale: a joint prohibition of two bypass actions, one of them a change of Gatekeeper's settings (the change verb is in the lexicon
// for this reason). The spctl item is a bypass action in its own right, so the prohibition must carry to it; the sentence must stay allowed.
const CHANGE_CONTROLS = {
  de: 'Ändern Sie Gatekeeper-Einstellungen nicht oder starten Sie spctl --master-disable nicht.',
  en: 'Do not change Gatekeeper settings or run spctl --master-disable.',
  fr: 'Ne modifiez pas Gatekeeper ou n’exécutez pas spctl --master-disable.',
  hu: 'Ne módosítsd a Gatekeepert, vagy ne futtasd a spctl --master-disable parancsot.',
  it: 'Non modificare Gatekeeper o non eseguire spctl --master-disable.',
  pl: 'Nie zmieniaj Gatekeepera lub nie uruchamiaj spctl --master-disable.',
  sk: 'Nesmiete zmeniť Gatekeeper alebo spustiť spctl --master-disable.',
  uk: 'Не змінюйте Gatekeeper або не запускайте spctl --master-disable.',
};

test('static: every locale allows a joint prohibition that includes a change of Gatekeeper settings', () => {
  assert.deepEqual(Object.keys(CHANGE_CONTROLS).sort(), EIGHT_LOCALES, 'a change control for each of the eight locales');
  const failures = Object.entries(CHANGE_CONTROLS).filter(([lang, line]) => bypassViolations(line, lang).length > 0).map(([lang, line]) => `${lang}: ${line}`);
  assert.deepEqual(failures, [], 'every change control is allowed in its own locale');
});

// Per locale: a mere mention of Gatekeeper before an unrelated removal (must be caught); a bypass-related prohibition carried through an
// unrelated action (must be caught); an object-first Gatekeeper removal (must be caught, the German and Hungarian forms especially); the
// same with a prohibition (must be allowed); and a legitimate comma-separated list under one bypass prohibition (must be allowed).
const GAP_CONTROLS = {
  de: { mention: 'Sprechen Sie nicht über Gatekeeper und entfernen Sie das Quarantäne-Attribut.', carry: 'Verwenden Sie Gatekeeper nicht und lachen Sie und entfernen Sie das Quarantäne-Attribut.', objectFirst: 'Gatekeeper deaktivieren, um die App zu starten.', objectFirstNegated: 'Gatekeeper nicht deaktivieren, um die App zu starten.', list: 'Verwenden Sie Gatekeeper nicht, Notizen, oder Trotzdem öffnen.' },
  en: { mention: 'Do not panic about Gatekeeper and remove the quarantine flag.', carry: 'Do not use Gatekeeper and panic and remove the quarantine flag.', objectFirst: 'Gatekeeper disabled, then open the app.', objectFirstNegated: 'Gatekeeper must not be disabled.', list: 'Do not use Gatekeeper, notes, or Open Anyway.' },
  fr: { mention: 'Ne parlez pas de Gatekeeper et supprimez l’attribut de quarantaine.', carry: 'N’utilisez pas Gatekeeper et riez et supprimez l’attribut de quarantaine.', objectFirst: 'Gatekeeper désactivé, puis ouvrez l’app.', objectFirstNegated: 'Gatekeeper ne doit pas être désactivé.', list: 'N’utilisez pas Gatekeeper, notes, ou Ouvrir quand même.' },
  hu: { mention: 'Ne beszélj a Gatekeeperről és távolítsd el a karantén attribútumot.', carry: 'Ne használd a Gatekeepert és nevess és távolítsd el a karantén attribútumot.', objectFirst: 'A Gatekeeper kikapcsolása, majd nyisd meg az appot.', objectFirstNegated: 'A Gatekeeper kikapcsolása tilos.', list: 'Ne használd a Gatekeepert, jegyzeteket, vagy a Mégis megnyitás gombot.' },
  it: { mention: 'Non parlare di Gatekeeper e rimuovi l’attributo di quarantena.', carry: 'Non usare Gatekeeper e ridere e rimuovi l’attributo di quarantena.', objectFirst: 'Gatekeeper disattivato, poi apri l’app.', objectFirstNegated: 'Gatekeeper non deve essere disattivato.', list: 'Non usare Gatekeeper, note, o Apri comunque.' },
  pl: { mention: 'Nie mów o Gatekeeperze i usuń atrybut kwarantanny.', carry: 'Nie używaj Gatekeepera i śmiej się i usuń atrybut kwarantanny.', objectFirst: 'Gatekeeper wyłączony, a potem otwórz aplikację.', objectFirstNegated: 'Gatekeeper nie może być wyłączony.', list: 'Nie używaj Gatekeepera, notatek, lub Otwórz mimo to.' },
  sk: { mention: 'Nesmiete hovoriť o Gatekeeper a odstrániť atribút karantény.', carry: 'Nesmiete používať Gatekeeper a smiať sa a odstrániť atribút karantény.', objectFirst: 'Gatekeeper vypnutý, potom otvorte aplikáciu.', objectFirstNegated: 'Gatekeeper nesmie byť vypnutý.', list: 'Nesmiete používať Gatekeeper, poznámky, alebo Napriek tomu otvoriť.' },
  uk: { mention: 'Не говоріть про Gatekeeper і видаліть атрибут карантину.', carry: 'Не використовуйте Gatekeeper і смійтеся і видаліть атрибут карантину.', objectFirst: 'Gatekeeper вимкнений, потім відкрийте застосунок.', objectFirstNegated: 'Gatekeeper не можна вимкнути.', list: 'Не використовуйте Gatekeeper, нотатки, або Все одно відкрити.' },
};

test('static: every locale catches a mention-only, a carried and an object-first bypass, and allows the prohibited object-first form and the legitimate list', () => {
  assert.deepEqual(Object.keys(GAP_CONTROLS).sort(), EIGHT_LOCALES, 'a gap control set for each of the eight locales');
  const failures = [];
  for (const [lang, control] of Object.entries(GAP_CONTROLS)) {
    for (const key of ['mention', 'carry', 'objectFirst']) {
      if (bypassViolations(control[key], lang).length === 0) failures.push(`${lang}: ${key} is not caught: ${control[key]}`);
    }
    for (const key of ['objectFirstNegated', 'list']) {
      if (bypassViolations(control[key], lang).length > 0) failures.push(`${lang}: ${key} is not allowed: ${control[key]}`);
    }
  }
  assert.deepEqual(failures, [], 'every gap control of every locale holds');
});

test('static: the public Mac wording states the no-bypass rule and calls the M3 run development evidence', () => {
  const readme = read('README.md');
  assert.match(readme, /do not remove the quarantine flag/i);
  assert.match(readme, /not an acceptance test/);
  assert.doesNotMatch(readme, /validated on an Apple M3/i);
  const changelog = read('CHANGELOG.md');
  const release = changelog.slice(changelog.indexOf('## 1.2.0'), changelog.indexOf('## 1.1.0'));
  assert.match(release, /development evidence, not an acceptance test/);
  assert.doesNotMatch(release, /validated natively/i);
});

test('static: the private Mac documents give no bypass guidance, and the M3 report states the no-bypass rule', { skip: missingPrivateSkip() }, () => {
  for (const file of PRIVATE_MAC_DOCS) assert.deepEqual(bypassViolations(read(file), null), [], `${file} gives no bypass guidance`);
  assert.match(read(M3_REPORT), /must not be opened by removing the quarantine flag/);
});

test('static: the smoke script refuses to produce evidence off macOS', () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const gate = smoke.platformGate(platform);
    assert.equal(gate.allowed, false, platform);
    assert.match(gate.message, /refuses to run on "/);
    assert.match(gate.message, /only runs on macOS/);
  }
  assert.equal(smoke.platformGate('darwin').allowed, true);
  const source = fs.readFileSync(SMOKE_SOURCE_PATH, 'utf8');
  assert.match(source, /if \(require\.main === module\)/, 'the OS part only runs when executed directly');
  const mainBody = source.slice(source.indexOf('async function main('));
  assert.ok(mainBody.indexOf('platformGate(process.platform)') > 0 && mainBody.indexOf('platformGate(process.platform)') < mainBody.indexOf('parseArgs('), 'the platform gate is the first thing main() does');
  const runSmokeBody = source.slice(source.indexOf('async function runSmoke('), source.indexOf('async function main('));
  assert.ok(runSmokeBody.indexOf('platformGate(process.platform)') >= 0 && runSmokeBody.indexOf('platformGate(process.platform)') < runSmokeBody.indexOf('collectStaticEvidence('));
  assert.doesNotMatch(source.split('\n').filter((line) => /^(?:const|let|var)\s/.test(line)).join('\n'), /require\('playwright'\)/, 'playwright is loaded lazily, after the gate');
  if (process.platform !== 'darwin') {
    for (const args of [[], ['--app', 'X.app', '--arch', 'arm64'], ['--help']]) {
      const result = spawnSync(process.execPath, [rel(SMOKE_FILE), ...args], { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 2, `exit code 2 for ${JSON.stringify(args)}`);
      assert.match(result.stderr, /refuses to run on/);
      assert.equal(result.stdout, '', 'nothing is produced on stdout');
    }
  } else {
    const result = spawnSync(process.execPath, [rel(SMOKE_FILE)], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 2, 'missing arguments are refused with exit code 2');
  }
});

test('simulated: runSmoke() itself rejects off macOS', { skip: process.platform === 'darwin' && 'on macOS runSmoke() would really run' }, async () => {
  await assert.rejects(() => smoke.runSmoke({ app: 'X.app', arch: 'arm64', out: path.join(ROOT, 'test-results', 'must-not-exist.json') }), /refuses to run on/);
  assert.equal(fs.existsSync(rel('test-results', 'must-not-exist.json')), false);
});

test('simulated: argument parsing', () => {
  const ok = smoke.parseArgs(['--app', 'a/B.app', '--arch=arm64', '--artifact', 'z.zip', '--evidence-only'], { GITHUB_SHA: 'abc' });
  assert.deepEqual({ app: ok.app, arch: ok.arch, artifact: ok.artifact, evidenceOnly: ok.evidenceOnly, commit: ok.commit, errors: ok.errors }, { app: 'a/B.app', arch: 'arm64', artifact: 'z.zip', evidenceOnly: true, commit: 'abc', errors: [] });
  assert.equal(smoke.parseArgs(['--app', 'a.app', '--arch', 'x64', '--commit', 'c0ffee'], { GITHUB_SHA: 'abc' }).commit, 'c0ffee');
  for (const bad of [[], ['--app', 'a.app'], ['--app', 'a.app', '--arch', 'universal'], ['--app', 'a.app', '--arch', 'x86_64'], ['--app', 'a.dmg', '--arch', 'arm64'], ['--app', 'a.app', '--arch'], ['--app', 'a.app', '--arch', 'arm64', '--bogus']]) {
    assert.ok(smoke.parseArgs(bad).errors.length > 0, JSON.stringify(bad));
  }
  assert.equal(smoke.parseArgs(['--help']).errors.length, 0);
});

test('simulated: architecture parsing and the native / Rosetta classification', () => {
  assert.equal(smoke.normalizeArch('x86_64'), 'x64');
  assert.equal(smoke.normalizeArch('arm64e'), 'arm64');
  assert.equal(smoke.normalizeArch('ppc'), null);
  assert.deepEqual(smoke.parseMachArchs('Non-fat file: /A/TRACE Boardviewer is architecture: arm64'), ['arm64']);
  assert.deepEqual(smoke.parseMachArchs('Architectures in the fat file: /A/TRACE are: x86_64 arm64'), ['arm64', 'x64']);
  assert.deepEqual(smoke.parseMachArchs('Mach-O 64-bit executable x86_64'), ['x64']);
  assert.deepEqual(smoke.parseMachArchs('Mach-O 64-bit executable arm64'), ['arm64']);
  assert.deepEqual(smoke.parseMachArchs('Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]'), ['arm64', 'x64']);
  assert.deepEqual(smoke.parseMachArchs('ELF 64-bit LSB executable, x86-64'), [], 'a non-Mach-O file names no macOS architecture');
  assert.deepEqual(smoke.parseMachArchs(''), []);

  assert.equal(smoke.parseTranslated({ output: '1\n', failed: false, hostArch: 'arm64' }), true);
  assert.equal(smoke.parseTranslated({ output: '0\n', failed: false, hostArch: 'arm64' }), false);
  assert.equal(smoke.parseTranslated({ output: '', failed: true, hostArch: 'x64' }), false);
  assert.equal(smoke.parseTranslated({ output: '', failed: true, hostArch: 'arm64' }), null, 'unknown is never reported as native');

  const native = smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64'], hostArch: 'arm64', translated: false });
  assert.equal(native.native, true);
  assert.match(native.label, /^native arm64/);
  assert.equal(smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'x64', translated: false }).native, true);
  const rosetta = smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'arm64', translated: true });
  assert.equal(rosetta.native, false);
  assert.match(rosetta.label, /Rosetta/);
  assert.match(rosetta.label, /NOT native Intel validation/);
  assert.equal(smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'arm64', translated: false }).native, false, 'an x64 binary on an arm64 host is never native');
  const translatedSameArch = smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'x64', translated: true });
  assert.equal(translatedSameArch.native, false, 'a translated process is never native, even when the architectures agree');
  assert.ok(translatedSameArch.reasons.some((reason) => /Rosetta/.test(reason)));
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64'], hostArch: 'arm64', translated: null }).native, false);
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['x64'], hostArch: 'arm64', translated: false }).native, false, 'requested and built architecture differ');
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64', 'x64'], hostArch: 'arm64', translated: false }).native, false, 'a universal binary is not a single-arch validation');
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: [], hostArch: 'arm64', translated: false }).native, false);
});

test('simulated: signature, zip and UI-text parsing', () => {
  const adhoc = ['Executable=/x/TRACE Boardviewer.app/Contents/MacOS/TRACE Boardviewer', 'Identifier=hu.trace.boardviewer', 'Format=app bundle with Mach-O thin (arm64)',
    'CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7 location=embedded', 'Signature=adhoc', 'TeamIdentifier=not set'].join('\n');
  assert.deepEqual({ ...smoke.parseCodesign(adhoc) }, { signed: true, adhoc: true, teamIdentifier: 'not set', hasTeamIdentifier: false, identifier: 'hu.trace.boardviewer', authorities: [] });
  const unsigned = smoke.parseCodesign('/x/TRACE Boardviewer.app: code object is not signed at all');
  assert.equal(unsigned.signed, false);
  assert.equal(unsigned.adhoc, false);
  const real = smoke.parseCodesign('Identifier=a.b\nCodeDirectory v=20500 size=9 flags=0x10000(runtime) hashes=1+1 location=embedded\nAuthority=Developer ID Application: Someone (ABCDE12345)\nTeamIdentifier=ABCDE12345');
  assert.equal(real.adhoc, false);
  assert.equal(real.hasTeamIdentifier, true);
  assert.equal(real.authorities.length, 1);

  assert.deepEqual(smoke.parseZipTopLevel('TRACE Boardviewer.app/Contents/Info.plist\nTRACE Boardviewer.app/Contents/MacOS/x\n'), ['TRACE Boardviewer.app']);
  assert.deepEqual(smoke.parseZipTopLevel('mac-arm64/a.app/x\nreadme\n'), ['mac-arm64', 'readme']);

  assert.deepEqual(smoke.extractCounts('2 components · 4 pins · 2 nets'), { components: 2, pins: 4, nets: 2 });
  assert.deepEqual(smoke.extractCounts('2 alkatrész · 4 pin · 2 net'), { components: 2, pins: 4, nets: 2 });
  assert.equal(smoke.extractCounts('no digits here'), null);
  assert.equal(smoke.extractCounts('1 · 2'), null);
  assert.equal(smoke.sameCounts({ components: 2, pins: 4, nets: 2 }, smoke.EXPECTED_COUNTS), true);
  assert.equal(smoke.sameCounts({ components: 2, pins: 4, nets: 3 }, smoke.EXPECTED_COUNTS), false);
  assert.equal(smoke.isPainted({ different: 100 }), true);
  assert.equal(smoke.isPainted({ different: 99 }), false);
  assert.equal(smoke.isPainted(null), false);
});

test('simulated: workspace, quit and evidence decisions', () => {
  const names = ['macsmoke.pdf', 'macsmoke.png'];
  assert.equal(smoke.decideRows([{ name: 'MacSmoke.pdf', status: 'ready' }, { name: 'macsmoke.png', status: 'ready' }], names).ok, true);
  assert.equal(smoke.decideRows([{ name: 'macsmoke.pdf', status: 'ready' }], names).ok, false, 'a missing row is a failure');
  assert.equal(smoke.decideRows([{ name: 'macsmoke.pdf', status: 'ready' }, { name: 'macsmoke.png', status: 'missing' }], names).ok, false);
  assert.equal(smoke.decideRows([{ name: 'macsmoke.pdf', status: 'ready' }, { name: 'macsmoke.png', status: 'ready' }, { name: 'extra.pdf', status: 'ready' }], names).ok, false);
  const key = 'a'.repeat(64);
  assert.equal(smoke.decideManifest({ board: { key }, documents: [{ name: 'macsmoke.png' }, { name: 'macsmoke.pdf' }] }, { key, names }).ok, true);
  assert.equal(smoke.decideManifest({ board: { key: 'b'.repeat(64) }, documents: [] }, { key, names }).ok, false);
  assert.equal(smoke.decideManifest({ board: { key }, documents: [{ name: 'macsmoke.pdf' }] }, { key, names }).ok, false);
  assert.equal(smoke.decideManifest(null, { key, names }).ok, false);

  assert.equal(smoke.isCleanExit({ code: 0, signal: null, timedOut: false }), true);
  assert.equal(smoke.isCleanExit({ code: 1, signal: null, timedOut: false }), false);
  assert.equal(smoke.isCleanExit({ code: null, signal: 'SIGKILL', timedOut: true }), false);
  assert.equal(smoke.isCleanExit({ code: 0, signal: 'SIGTERM', timedOut: false }), false);

  assert.deepEqual(smoke.summarizeChecks([{ name: 'a', status: 'pass' }, { name: 'b', status: 'pass' }]), { passed: true, failed: [], skipped: [], total: 2 });
  assert.equal(smoke.summarizeChecks([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail' }]).passed, false);
  assert.equal(smoke.summarizeChecks([{ name: 'a', status: 'pass' }, { name: 'b', status: 'skipped' }]).passed, false, 'a skipped check is not a pass');
  assert.equal(smoke.summarizeChecks([]).passed, false, 'no checks is not a pass');

  const nativeClass = smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64'], hostArch: 'arm64', translated: false });
  const checks = [{ name: 'a', status: 'pass' }];
  const full = smoke.buildEvidence({ commit: 'c', requestedArch: 'arm64', classification: nativeClass, mode: 'full', checks });
  assert.equal(full.nativeValidation, true);
  assert.equal(full.schema, smoke.SCHEMA);
  assert.match(full.disclaimer, /Not a release acceptance/);
  assert.ok(full.notCovered.length >= 8 && full.notCovered.some((item) => /Gatekeeper/.test(item)) && full.notCovered.some((item) => /notarization/.test(item)));
  assert.equal(smoke.buildEvidence({ commit: 'c', requestedArch: 'arm64', classification: nativeClass, mode: 'evidence-only', checks }).nativeValidation, false, 'static evidence alone is never native validation');
  assert.equal(smoke.buildEvidence({ commit: 'c', requestedArch: 'arm64', classification: nativeClass, mode: 'full', checks: [...checks, { name: 'b', status: 'fail' }] }).nativeValidation, false);
  const rosetta = smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'arm64', translated: true });
  assert.equal(smoke.buildEvidence({ commit: 'c', requestedArch: 'x64', classification: rosetta, mode: 'full', checks }).nativeValidation, false);
  assert.equal(smoke.buildEvidence({ requestedArch: 'x64', checks }).commit, 'unknown', 'a missing commit is never invented');
});

test('simulated: the synthetic fixtures are original, consistent and valid', () => {
  const lines = smoke.FIXTURE_BOARD.trim().split('\n');
  const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
  assert.equal(count(/^COMPONENT /), smoke.EXPECTED_COUNTS.components);
  assert.equal(count(/^SIGNAL /), smoke.EXPECTED_COUNTS.nets);
  assert.equal(count(/^PIN /) * smoke.EXPECTED_COUNTS.components, smoke.EXPECTED_COUNTS.pins, 'every component instantiates the two-pin shape');
  for (const section of ['HEADER', 'BOARD', 'PADS', 'PADSTACKS', 'SHAPES', 'COMPONENTS', 'DEVICES', 'SIGNALS']) {
    assert.ok(lines.includes(`$${section}`) && lines.includes(`$END${section}`), `$${section} section`);
  }
  assert.ok(lines.length < 60);
  assert.ok(!/\.(?:cad|gcd)$/i.test(smoke.DOCUMENT_NAMES.join('')), 'documents are not boards');

  const pdf = smoke.makePdf().toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)[1]);
  assert.ok(pdf.slice(startxref).startsWith('xref\n0 6\n'));
  const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(entries.length, 5);
  entries.forEach((offset, index) => assert.ok(pdf.slice(offset).startsWith(`${index + 1} 0 obj\n`), `xref offset of object ${index + 1}`));
  assert.deepEqual(smoke.makePdf(), smoke.makePdf(), 'fixtures are deterministic');

  const png = smoke.makePng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let position = 8;
  const types = [];
  while (position < png.length) {
    const length = png.readUInt32BE(position);
    const type = png.toString('latin1', position + 4, position + 8);
    const crc = png.readUInt32BE(position + 8 + length);
    assert.equal(crc, zlib.crc32(png.subarray(position + 4, position + 8 + length)) >>> 0, `CRC of ${type}`);
    types.push(type);
    position += 12 + length;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 16);
  assert.deepEqual(smoke.makePng(), smoke.makePng());
});

test('static: the validation document has its required sections and no unqualified Mac claims', () => {
  const doc = read(DOC_FILE);
  for (const heading of [/^## 1\. Architecture support/m, /^## 2\. What was inspected/m, /^## 3\. Unsigned app behaviour/m, /^## 4\. Native validation checklist/m, /^## 5\. Blockers and gaps/m, /^## 6\. Proposed shared-code changes \(NOT applied\)/m]) {
    assert.match(doc, heading);
  }
  // One native run exists (section 7, Apple M3); every other Mac target is still unrun.
  assert.match(doc, /one native run on an Apple M3/);
  assert.match(doc, /have not been run on any Mac/i);
  assert.match(doc, /UNVERIFIED/);
  assert.match(doc, /NOT native Intel validation/);
  const claims = [
    /\b(?:was|were|has been|have been|is|are)\s+(?:successfully\s+)?(?:tested|validated|verified|launched|run|started|signed|notarized|smoke-tested)\s+on\s+(?:a\s+|an\s+|the\s+)?(?:real\s+)?(?:mac|macos|apple)/i,
    /\bmac(?:os)?\s+(?:release|build|app)\s+is\s+(?:ready|working|supported|validated)\b/i,
    /\bready\s+for\s+(?:a\s+)?mac(?:os)?\s+release\b/i,
  ];
  for (const file of macFiles().filter((name) => name !== SELF_FILE)) {
    const text = read(file);
    for (const claim of claims) {
      for (const match of text.matchAll(new RegExp(claim.source, 'gi'))) {
        // A negated sentence ("has never been run on macOS", "Nothing ... has been run on macOS") is the honest form.
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const before = text.slice(lineStart, match.index);
        assert.match(before, /\b(?:not|never|nothing|no|cannot|without|unverified)\b/i, `${file} must not claim macOS testing: "${match[0]}"`);
      }
    }
  }
});
