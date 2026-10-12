'use strict';

// Launch check of a RELEASE build without Playwright. The release build has the Electron inspector OFF (fuse FUSE-INSPECT), so a
// Playwright launch of it fails by design. The packaged functional QA and the smoke tests therefore run on the QA flavour
// (scripts/qa-flavour.cjs). This check only shows that the release app starts and stays up: it starts the executable with a fresh
// user-data folder and requires that it is still running after --stay-ms. On Linux a window of it must be visible in that period; on
// macOS it must be registered with LaunchServices (lsappinfo, no permission needed) in that period. Then it asks the app to close
// (SIGTERM on macOS and Linux, taskkill without /F on Windows) and requires a clean exit. The verdict never uses a forced kill; a
// process that does not exit in time is a failure, and only then is it killed, so the runner ends clean.
//
// usage: node scripts/release-launch-check.cjs --executable=<absolute path> --os=<darwin|linux|win32> --out=<file> [--stay-ms=10000] [--close-ms=30000]
// Exit codes: 0 = the release app started, stayed up, was visible or registered where required, and closed cleanly; 1 = a check failed; 2 = refused or bad arguments.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SCHEMA = 'trace-release-launch-check/1';
const PLATFORMS = Object.freeze({
  darwin: Object.freeze({ windowRequired: false, registrationRequired: true }),
  linux: Object.freeze({ windowRequired: true, registrationRequired: false }),
  win32: Object.freeze({ windowRequired: false, registrationRequired: false }),
});
const CRASH_SIGNALS = Object.freeze(['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE']);
const POLL_MS = 500;

function parseArgs(argv) {
  const values = new Map();
  for (const item of argv.slice(2)) {
    const match = /^--([a-z][a-z-]*)=(.*)$/.exec(item);
    if (!match || !match[2]) throw new Error(`Expected --name=value, received ${item || '(empty)'}`);
    if (values.has(match[1])) throw new Error(`Duplicate option --${match[1]}`);
    values.set(match[1], match[2]);
  }
  for (const name of ['executable', 'os', 'out']) {
    if (!values.has(name)) throw new Error(`Required option missing: --${name}=...`);
  }
  const platform = values.get('os');
  if (!Object.hasOwn(PLATFORMS, platform)) throw new Error(`--os must be one of ${Object.keys(PLATFORMS).join(', ')}`);
  const executable = values.get('executable');
  if (!path.isAbsolute(executable)) throw new Error('--executable must be an absolute path');
  const stayMs = Number(values.get('stay-ms') ?? 10000);
  const closeMs = Number(values.get('close-ms') ?? 30000);
  if (!Number.isInteger(stayMs) || stayMs < 1000 || !Number.isInteger(closeMs) || closeMs < 1000) {
    throw new Error('--stay-ms and --close-ms must be whole numbers of at least 1000');
  }
  return { executable, platform, out: path.resolve(values.get('out')), stayMs, closeMs };
}

/** A close is clean when the app exits with code 0, or when it ends by the SIGTERM this check sent it. Anything else is not clean. */
function isCleanExit(facts) {
  if (!facts.exit) return false;
  if (facts.exit.code === 0) return true;
  return facts.closeRequested && facts.exit.code === null && facts.exit.signal === 'SIGTERM';
}

/**
 * The reasons a release launch failed, from the facts of one run. Pure: no process, no file, no clock. An empty list means the check passed.
 */
function decideLaunch(facts) {
  const problems = [];
  if (facts.startError) problems.push(`the executable did not start (${facts.startError})`);
  else if (!facts.startedAt) problems.push('the executable did not start');
  if (problems.length) return problems;
  if (facts.exitedBeforeStay) {
    problems.push(`the app exited within ${facts.stayMs} ms of its start (code ${facts.exitedBeforeStay.code}, signal ${facts.exitedBeforeStay.signal})`);
  }
  if (facts.exit && CRASH_SIGNALS.includes(facts.exit.signal)) problems.push(`the app stopped on ${facts.exit.signal}`);
  if (facts.windowRequired && facts.window !== true) problems.push('no window of the app was visible within the stay period');
  if (facts.registrationRequired && facts.registered !== true) problems.push('the app was not registered with LaunchServices within the stay period');
  if (facts.closeRequestFailed) problems.push('the close request could not be sent');
  if (facts.closeTimedOut) problems.push(`the app did not exit within ${facts.closeMs} ms after the close request`);
  else if (!facts.exitedBeforeStay && facts.exit && !isCleanExit(facts)) {
    problems.push(`the close was not clean (code ${facts.exit.code}, signal ${facts.exit.signal})`);
  }
  return problems;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a window of the process is visible (Linux, through xdotool on the Xvfb display). Not used on the other platforms. */
function hasWindow(platform, pid) {
  if (platform !== 'linux') return null;
  const found = spawnSync('xdotool', ['search', '--onlyvisible', '--pid', String(pid)], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim().length > 0;
}

/**
 * Whether LaunchServices lists the process as the TRACE app (macOS). `lsappinfo list` needs no permission: it prints each app with
 * its name and its pid, so the check is that the pid and the app name are listed together.
 */
function isRegistered(platform, pid, name = 'TRACE Boardviewer') {
  if (platform !== 'darwin') return null;
  const listed = spawnSync('lsappinfo', ['list'], { encoding: 'utf8' });
  if (listed.status !== 0) return false;
  return new RegExp(`pid\\s*=\\s*${pid}\\b`).test(listed.stdout) && listed.stdout.includes(`"${name}"`);
}

/** Asks the app to close, without forcing it: SIGTERM on macOS and Linux, taskkill without /F on Windows (it sends a close request). */
function requestClose(platform, child) {
  if (platform === 'win32') return spawnSync('taskkill', ['/PID', String(child.pid)], { encoding: 'utf8' }).status === 0;
  return child.kill('SIGTERM');
}

async function checkRelease(options) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-release-launch-'));
  const facts = {
    platform: options.platform, stayMs: options.stayMs, closeMs: options.closeMs, windowRequired: PLATFORMS[options.platform].windowRequired,
    registrationRequired: PLATFORMS[options.platform].registrationRequired, registered: null,
    startedAt: null, startError: null, window: null, closeRequested: false, closeRequestFailed: false, closeMethod: null,
    exit: null, exitedBeforeStay: null, closeTimedOut: false, crashSignal: null,
  };
  let child = null;
  let stderr = '';
  let exitInfo = null;
  try {
    child = spawn(options.executable, [`--user-data-dir=${userData}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.on('error', (error) => { facts.startError = error.code || error.message; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
    if (!facts.startError) facts.startedAt = new Date().toISOString();

    // The app must stay up for the whole stay period; on macOS and Linux a window is looked for within it.
    const stayDeadline = Date.now() + options.stayMs;
    while (Date.now() < stayDeadline && exitInfo === null && !facts.startError) {
      if (facts.windowRequired && facts.window !== true) facts.window = hasWindow(options.platform, child.pid);
      if (facts.registrationRequired && facts.registered !== true) facts.registered = isRegistered(options.platform, child.pid);
      await sleep(POLL_MS);
    }
    if (exitInfo !== null) {
      facts.exitedBeforeStay = exitInfo;
      facts.exit = exitInfo;
    } else if (!facts.startError) {
      if (facts.windowRequired && facts.window !== true) facts.window = hasWindow(options.platform, child.pid);
      if (facts.registrationRequired && facts.registered !== true) facts.registered = isRegistered(options.platform, child.pid);
      facts.closeRequested = true;
      facts.closeMethod = options.platform === 'win32' ? 'taskkill without /F' : 'SIGTERM';
      if (!requestClose(options.platform, child)) facts.closeRequestFailed = true;
      const closeDeadline = Date.now() + options.closeMs;
      while (Date.now() < closeDeadline && exitInfo === null) await sleep(POLL_MS);
      if (exitInfo === null) facts.closeTimedOut = true;
      else facts.exit = exitInfo;
    }
    if (facts.exit && CRASH_SIGNALS.includes(facts.exit.signal)) facts.crashSignal = facts.exit.signal;
  } finally {
    // Only after the verdict has its facts: a process that is still running is killed so that the runner ends clean.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(userData, { recursive: true, force: true });
  }
  const problems = decideLaunch(facts);
  const verdict = {
    schema: SCHEMA, platform: options.platform, executable: path.basename(options.executable), passed: problems.length === 0, problems,
    startedAt: facts.startedAt, stayMs: facts.stayMs, closeMs: facts.closeMs, windowRequired: facts.windowRequired, window: facts.window,
    registrationRequired: facts.registrationRequired, registered: facts.registered,
    closeRequested: facts.closeRequested, closeMethod: facts.closeMethod, closeTimedOut: facts.closeTimedOut,
    exit: facts.exit ? { code: facts.exit.code, signal: facts.exit.signal } : null,
  };
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`release launch check (${options.platform}): ${verdict.passed ? 'passed' : `FAILED: ${problems.join('; ')}`}`);
  if (stderr.trim()) console.log(`stderr of the app (last part):\n${stderr.trim()}`);
  return verdict.passed ? 0 : 1;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`release-launch-check.cjs: ${error.message}`);
    console.error('usage: node scripts/release-launch-check.cjs --executable=<absolute path> --os=<darwin|linux|win32> --out=<file> [--stay-ms=10000] [--close-ms=30000]');
    return 2;
  }
  return checkRelease(options);
}

if (require.main === module) {
  main(process.argv).then((code) => { process.exitCode = code; });
}

module.exports = Object.freeze({ SCHEMA, PLATFORMS, CRASH_SIGNALS, parseArgs, decideLaunch, isCleanExit });
