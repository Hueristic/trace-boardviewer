'use strict';

// Static rules of the release workflow for the QA flavour (windows.yml). Every step that launches the app over Playwright or CDP runs
// the QA flavour; the RELEASE build is only built, checked statically and launched by scripts/release-launch-check.cjs (no Playwright);
// no QA artifact is uploaded or listed as a release asset. These tests read the workflow and the scripts; they run no build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const rel = (...parts) => path.join(ROOT, ...parts);
const WORKFLOW_FILE = '.github/workflows/windows.yml';
const WORKFLOW_PATH = process.env.TRACE_QA_SMOKE_WORKFLOW_CHECKS_WORKFLOW || rel(WORKFLOW_FILE);

// The pinned electron-builder resolves its own YAML parser; nothing is added to the project.
function builderYaml() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  const libDirectory = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] }));
  return require(require.resolve('js-yaml', { paths: [libDirectory] }));
}
const workflow = builderYaml().load(fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n'));
const jobs = workflow.jobs;
const steps = (job) => jobs[job].steps.filter((step) => step && typeof step === 'object');
const allSteps = () => Object.keys(jobs).flatMap((job) => steps(job).map((step) => ({ job, step })));

// The scripts that open the app with Playwright (_electron.launch) or attach to it over CDP: the only ones that may run the QA flavour.
const LAUNCH_PATTERN = /_electron|connectOverCDP|--remote-debugging|chromium\.connect|--inspect|require\('playwright'\)/;
// A step is a QA step when it names the QA flavour or a QA output: the runner's --flavour=qa, TRACE_FLAVOUR=qa, or a QA path or output.
const isQaStep = (step) => {
  const run = typeof step.run === 'string' ? step.run : '';
  const env = step.env && typeof step.env === 'object' ? Object.values(step.env).map(String).join(' ') : '';
  return /--flavour=qa/.test(run) || (step.env && step.env.TRACE_FLAVOUR === 'qa') || /release-qa|TRACE-Boardviewer-QA|TRACE Boardviewer QA|trace-boardviewer-qa|\/QA\.|QA\.app/.test(run) || /locate_qa/.test(env);
};
const RELEASE_LAUNCH = 'scripts/release-launch-check.cjs';

test('static: every step that launches the app over Playwright or CDP runs the QA flavour, never the release build', () => {
  const invoking = allSteps().filter(({ step }) => typeof step.run === 'string' && /scripts\/(packaged-functional-qa|mac-smoke|linux-smoke)\.cjs/.test(step.run))
    .filter(({ step }) => !/linux-smoke\.cjs (static|summary)\b/.test(step.run));
  assert.ok(invoking.length >= 6, 'the packaged, the mac and the linux launch steps are all present');
  for (const { job, step } of invoking) {
    assert.ok(isQaStep(step), `${job}: "${step.name}" launches the app and must run the QA flavour`);
  }
});

test('static: the scripts that open the app over Playwright or CDP are invoked only from QA steps', () => {
  const invokedScripts = new Set();
  for (const { step } of allSteps()) {
    if (typeof step.run !== 'string') continue;
    for (const match of step.run.matchAll(/scripts\/([A-Za-z0-9_.\/-]+\.cjs)/g)) invokedScripts.add(match[1]);
  }
  const launchers = [...invokedScripts].filter((file) => LAUNCH_PATTERN.test(fs.readFileSync(rel('scripts', file), 'utf8')));
  assert.ok(launchers.includes('packaged-functional-qa.cjs') && launchers.includes('mac-smoke.cjs') && launchers.includes('linux-smoke.cjs'), 'the launchers are the three runners');
  for (const file of launchers) {
    for (const { job, step } of allSteps()) {
      if (typeof step.run !== 'string' || !step.run.includes(`scripts/${file}`)) continue;
      if (/linux-smoke\.cjs (static|summary)\b/.test(step.run)) continue;
      assert.ok(isQaStep(step), `${job}: "${step.name}" runs ${file} and must use the QA flavour`);
    }
  }
});

test('static: each platform builds the QA flavour from the same commit, with its own QA config, and keeps the release build', () => {
  const runs = (job) => steps(job).map((step) => (typeof step.run === 'string' ? step.run : '')).join('\n');
  assert.match(runs('build'), /--config config\/electron-builder\.qa\.yml/, 'the Windows QA portable EXE');
  assert.match(runs('build'), /pnpm package/, 'the Windows release package is still built');
  assert.match(runs('mac'), /--config config\/electron-builder\.qa\.mac\.yml/, 'the macOS QA zip');
  assert.match(runs('mac'), /--config config\/electron-builder\.mac\.yml/, 'the macOS release zip is still built');
  assert.match(runs('linux'), /--config config\/electron-builder\.qa\.linux\.yml/, 'the Linux QA packages');
  assert.match(runs('linux'), /--config config\/electron-builder\.linux\.yml/, 'the Linux release packages are still built');
});

test('static: each platform checks the RELEASE build without Playwright, and that step never names the QA flavour', () => {
  for (const job of ['build', 'mac', 'linux']) {
    const launch = steps(job).find((step) => typeof step.run === 'string' && step.run.includes(RELEASE_LAUNCH));
    assert.ok(launch, `${job}: a release launch check exists`);
    assert.doesNotMatch(launch.run, /--flavour=qa|QA/, `${job}: the release launch check names no QA path`);
    assert.notEqual(launch.env && launch.env.TRACE_FLAVOUR, 'qa', `${job}: the release launch check is not run with the QA flavour`);
    assert.doesNotMatch(launch.run, /_electron|connectOverCDP|--remote-debugging|--inspect/, `${job}: the release launch check does not attach over CDP`);
  }
});

test('static: no QA artifact is uploaded, and the draft release lists only the release assets', () => {
  for (const { job, step } of allSteps()) {
    if (!String(step.uses || '').startsWith('actions/upload-artifact')) continue;
    const paths = step.with && step.with.path ? String(step.with.path) : '';
    assert.doesNotMatch(paths, /release-qa|TRACE-Boardviewer-QA|QA\.app|trace-boardviewer-qa/, `${job}: "${step.name}" uploads no QA file`);
  }
  const draft = fs.readFileSync(WORKFLOW_PATH, 'utf8').split(/\n  draft-release:\n/)[1] ?? '';
  assert.ok(draft.length > 0, 'the draft-release job exists');
  assert.doesNotMatch(draft, /release-qa|TRACE-Boardviewer-QA|trace-boardviewer-qa/, 'the draft release lists no QA asset');
});

// The commands whose output is read after a failure: the tests, the smokes, the launch checks and the packaged QA runs.
const DIAGNOSED = /pnpm (exec )?(test|vitest|tsc)|pnpm test:desktop|node --test|linux-smoke\.cjs (static|run)|mac-smoke\.cjs|release-launch-check\.cjs|packaged-functional-qa\.cjs/;
// The Windows PowerShell steps (the packaged QA and the release launch of the portable EXE) are read through their JSON evidence instead.
const WINDOWS_POWERSHELL = /release\/win-unpacked|release-qa\/win-unpacked/;

test('static: every test and smoke command streams its output to a log and keeps its exit code; each job annotates its failures', () => {
  for (const job of ['build', 'mac', 'linux']) {
    for (const step of steps(job)) {
      if (typeof step.run !== 'string' || !DIAGNOSED.test(step.run) || WINDOWS_POWERSHELL.test(step.run)) continue;
      assert.match(step.run, /2>&1 \| tee "\$RUNNER_TEMP\/ci-diag\//, `${job}: "${step.name}" streams its output to the diagnostics folder`);
      assert.match(step.run, /set -o pipefail|set -euo pipefail/, `${job}: "${step.name}" keeps its exit code through the pipe`);
    }
    const annotate = steps(job).find((step) => step.if === 'failure()' && typeof step.run === 'string' && /ci-annotate\.cjs/.test(step.run));
    assert.ok(annotate, `${job}: an annotation step runs after a failure`);
    assert.match(annotate.run, /--logs="\$RUNNER_TEMP\/ci-diag"/, `${job}: the annotations read the diagnostics folder`);
  }
  const linuxSteps = steps('linux');
  assert.equal(linuxSteps[linuxSteps.length - 1].name, 'Stop leftover app processes', 'the cleanup stays the last step of the Linux job');
});

test('static: the Windows release EXE stays the asset under its release name, the QA EXE lives only in its own folder', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(text, /release\/TRACE-Boardviewer-\$env:TRACE_VERSION\.exe/, 'the release EXE is the asset');
  assert.match(text, /release-qa\/TRACE-Boardviewer-QA-\$env:TRACE_VERSION\.exe/, 'the QA EXE is built into release-qa/');
});
