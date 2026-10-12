#!/usr/bin/env node
'use strict';

// Native macOS check of the open-file paths (TB-130 / TB-311). Run on a Mac where the TRACE Boardviewer build is
// installed. It needs macOS and cannot prove anything on another platform; `--self-test` only writes the three synthetic samples and
// prints the plan, so it runs anywhere.
//
//   node scripts/mac-open-file-check.cjs --app "/Applications/TRACE Boardviewer.app" [--out <folder>] [--only S1,S4] [--self-test]
//
// Scenarios. Each one starts from a quit application (the script refuses to start while the application runs; quit it first):
//   S1  cold open, refused CST        open -a <app> <file> with the application not running (the Finder open route)
//   S2  cold open, accepted CST       the same; a board must open
//   S3  cold open, unsupported file   an extension TRACE does not read; the notice must be shown
//   S4  open into a running app       the application runs with its window; open -a <app> <file>
//   S5  open while it starts          open -a <app>, then the file at once (before the window exists)
//   S6  open with no window           the window is closed, the application still runs; open -a <app> <file> (Dock reopen case)
//   S7  Dock drop (manual)            the file is dragged onto the Dock icon; press Enter after the drop
//   S8  Finder double-click (manual)  the file is double-clicked in Finder; press Enter after the double-click
//
// Measured per scenario: t0 (the open call, or Enter for the manual ones), the time from t0 until the window is visible, and a
// screenshot at +1 s, +5 s and +10 s after t0. After each screenshot the tester answers whether the notice is on screen (y / n / k to
// skip); the answer is recorded with the screenshot.
//
// Output in the output folder: report.json (every measurement and answer), report.md (one table), shots/*.png, samples/*.cst or *.unsupported.
// Requirements: macOS 13 or later. System Events (window state) may ask for Accessibility permission for the terminal; screencapture
// may ask for Screen Recording permission. Nothing is sent over the network. The samples are built from the CST layout, not from any file.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { build } = require('../tests/fixtures/cst/make-cst-02.cjs');

const PROCESS = 'TRACE Boardviewer';
const OFFSETS_S = [1, 5, 10];
const WINDOW_TIMEOUT_MS = 30000;
const QUIT_TIMEOUT_MS = 20000;

const SCENARIOS = [
  { id: 'S1', name: 'cold open, refused CST', kind: 'cold', sample: 'refused' },
  { id: 'S2', name: 'cold open, accepted CST', kind: 'cold', sample: 'accepted' },
  { id: 'S3', name: 'cold open, unsupported file', kind: 'cold', sample: 'unsupported' },
  { id: 'S4', name: 'open into a running application', kind: 'running', sample: 'refused' },
  { id: 'S5', name: 'open while the application starts', kind: 'during-launch', sample: 'refused' },
  { id: 'S6', name: 'open with no window (Dock reopen)', kind: 'no-window', sample: 'refused' },
  { id: 'S7', name: 'Dock drop (manual)', kind: 'manual', sample: 'refused', action: 'Drag the file onto the TRACE Boardviewer icon in the Dock.' },
  { id: 'S8', name: 'Finder double-click (manual)', kind: 'manual', sample: 'refused', action: 'Double-click the file in Finder.' },
];

function parseArgs(argv) {
  const options = { app: '/Applications/TRACE Boardviewer.app', out: null, only: null, selfTest: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--app') options.app = argv[++index];
    else if (value === '--out') options.out = argv[++index];
    else if (value === '--only') options.only = argv[++index].split(',').map((item) => item.trim().toUpperCase());
    else if (value === '--self-test') options.selfTest = true;
    else throw new Error(`unknown option ${value}`);
  }
  options.out ??= path.join(os.homedir(), 'Desktop', `trace-mac-open-file-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return options;
}

// The three samples. The refused one has a layer code the parser does not accept (0x08); the unsupported one is the accepted bytes under
// an extension TRACE does not read.
function writeSamples(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const accepted = Buffer.from(build());
  const files = {
    refused: path.join(directory, 'refused.cst'),
    accepted: path.join(directory, 'accepted.cst'),
    unsupported: path.join(directory, 'unsupported.notaboard'),
  };
  fs.writeFileSync(files.refused, Buffer.from(build({ partLayers: [0x08, 0x01] })));
  fs.writeFileSync(files.accepted, accepted);
  fs.writeFileSync(files.unsupported, accepted);
  return files;
}

function osascript(script) {
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return `error: ${String(error.stderr || error.message).trim().slice(0, 200)}`;
  }
}

function isRunning() {
  return spawnSync('pgrep', ['-x', PROCESS]).status === 0;
}

// { running, windows, visible } from System Events; a permission or scripting error is reported as running:unknown.
function windowState() {
  const answer = osascript(`tell application "System Events" to if exists process "${PROCESS}" then return (count of windows of process "${PROCESS}") & "|" & (visible of process "${PROCESS}") else return "none"`);
  if (answer === 'none') return { running: false, windows: 0, visible: false };
  const [windows, visible] = answer.split('|');
  if (Number.isNaN(Number(windows))) return { running: 'unknown', windows: 0, visible: false, detail: answer };
  return { running: true, windows: Number(windows), visible: visible === 'true' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

async function waitForWindow() {
  return waitFor(() => { const state = windowState(); return state.running === true && state.windows > 0 && state.visible ? Date.now() : null; }, WINDOW_TIMEOUT_MS);
}

async function quit() {
  osascript(`tell application "${PROCESS}" to quit`);
  const gone = await waitFor(() => !isRunning(), QUIT_TIMEOUT_MS);
  return gone !== null;
}

function startApp(app) {
  execFileSync('open', ['-a', app]);
}

// Asks the tester; y = yes, n = no, k = skip. Anything else is re-asked.
async function ask(rl, question) {
  for (;;) {
    const answer = (await rl.question(`${question} [y/n/k] `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'n' || answer === 'k') return answer === 'y' ? true : answer === 'n' ? false : null;
  }
}

async function measureAfter(t0, rl, shotsDirectory, id) {
  const shots = [];
  for (const offset of OFFSETS_S) {
    const wait = t0 + offset * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    const file = path.join(shotsDirectory, `${id}-plus${offset}s.png`);
    spawnSync('screencapture', ['-x', file]);
    const state = windowState();
    const noticeOnScreen = await ask(rl, `  ${id} +${offset}s (${path.basename(file)}): is the notice on screen?`);
    shots.push({ offsetS: offset, file: path.relative(shotsDirectory, file), window: state, noticeOnScreen });
  }
  return shots;
}

async function runScenario(scenario, ctx) {
  const { app, samples, shotsDirectory, rl } = ctx;
  const file = samples[scenario.sample];
  const record = { id: scenario.id, name: scenario.name, file: path.basename(file), problems: [] };
  if (isRunning()) {
    record.problems.push('the application was already running at the start; the scenario was skipped (quit it first)');
    return record;
  }
  let t0;
  if (scenario.kind === 'cold') {
    t0 = Date.now();
    record.openCall = 'open -a <app> <file>';
    execFileSync('open', ['-a', app, file]);
  } else if (scenario.kind === 'running') {
    startApp(app);
    if (!(await waitForWindow())) record.problems.push('the window never became visible before the second open');
    await sleep(2000);
    t0 = Date.now();
    execFileSync('open', ['-a', app, file]);
    record.openCall = 'open -a <app> <file> into a running application';
  } else if (scenario.kind === 'during-launch') {
    startApp(app);
    t0 = Date.now();
    execFileSync('open', ['-a', app, file]);
    record.openCall = 'open -a <app>, then open -a <app> <file> at once';
  } else if (scenario.kind === 'no-window') {
    startApp(app);
    if (!(await waitForWindow())) record.problems.push('the window never became visible before the test');
    osascript(`tell application "${PROCESS}" to close window 1`);
    const closed = await waitFor(() => windowState().windows === 0, 10000);
    if (closed === null) {
      record.problems.push('the window could not be closed by script; close it by hand, then press Enter');
      await rl.question('Close the window by hand, then press Enter. ');
    }
    t0 = Date.now();
    execFileSync('open', ['-a', app, file]);
    record.openCall = 'open -a <app> <file> with no window';
  } else if (scenario.kind === 'manual') {
    await rl.question(`${scenario.action} Press Enter right after you do it. `);
    t0 = Date.now();
    record.openCall = `manual: ${scenario.action}`;
  }
  record.windowVisibleAfterMs = await (async () => {
    const at = await waitForWindow();
    return at === null ? null : at - t0;
  })();
  record.shots = await measureAfter(t0, rl, shotsDirectory, scenario.id);
  record.quit = await quit();
  if (!record.quit) record.problems.push('the application did not quit within 20 s');
  return record;
}

function markdown(report) {
  const rows = report.scenarios.map((item) => {
    const notice = (item.shots ?? []).map((shot) => (shot.noticeOnScreen === null ? 'skipped' : shot.noticeOnScreen ? 'yes' : 'no')).join(' / ') || '-';
    const window = item.windowVisibleAfterMs === null || item.windowVisibleAfterMs === undefined ? 'never' : `${(item.windowVisibleAfterMs / 1000).toFixed(1)} s`;
    return `| ${item.id} | ${item.name} | ${item.file} | ${window} | ${notice} | ${item.problems.join('; ') || '-'} |`;
  });
  return [
    '# TRACE Boardviewer: open-file check (native macOS)',
    '',
    `Application: ${report.app}  |  macOS: ${report.macos}  |  started: ${report.started}`,
    '',
    'Notice on screen at +1 s / +5 s / +10 s after the open (yes, no or skipped).',
    '',
    '| Scenario | Name | File | Window visible after | Notice at +1 s / +5 s / +10 s | Problems |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const shotsDirectory = path.join(options.out, 'shots');
  const samplesDirectory = path.join(options.out, 'samples');
  const samples = writeSamples(samplesDirectory);
  const scenarios = SCENARIOS.filter((item) => options.only === null || options.only.includes(item.id));
  if (options.selfTest) {
    console.log(`samples written to ${samplesDirectory}`);
    for (const item of scenarios) console.log(`${item.id} ${item.name} (${item.kind}, ${path.basename(samples[item.sample])})`);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('this check runs on macOS only (use --self-test elsewhere)');
  if (!fs.existsSync(options.app)) throw new Error(`the application is not at ${options.app} (use --app)`);
  fs.mkdirSync(shotsDirectory, { recursive: true });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const report = { app: options.app, macos: os.release(), started: new Date().toISOString(), scenarios: [] };
  try {
    for (const scenario of scenarios) {
      console.log(`\n== ${scenario.id} ${scenario.name}`);
      report.scenarios.push(await runScenario(scenario, { app: options.app, samples, shotsDirectory, rl }));
      fs.writeFileSync(path.join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      fs.writeFileSync(path.join(options.out, 'report.md'), markdown(report));
    }
  } finally {
    rl.close();
  }
  console.log(`\nreport: ${path.join(options.out, 'report.md')}`);
}

main().catch((error) => {
  console.error(`mac-open-file-check: ${error.message}`);
  process.exitCode = 1;
});
