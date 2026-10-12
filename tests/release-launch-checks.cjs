'use strict';

// The release launch check (scripts/release-launch-check.cjs): its argument rules and its pure verdict. The process itself is run by
// the workflow on each platform; these tests need no app and no display.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, decideLaunch, isCleanExit, PLATFORMS } = require('../scripts/release-launch-check.cjs');

const argv = (...items) => ['node', 'scripts/release-launch-check.cjs', ...items];
const ABSOLUTE = path.resolve('release', 'TRACE Boardviewer.exe');

test('parseArgs: the executable, the platform and the output are required, the periods default to 10 s and 30 s', () => {
  const parsed = parseArgs(argv(`--executable=${ABSOLUTE}`, '--os=win32', '--out=evidence/launch.json'));
  assert.equal(parsed.stayMs, 10000);
  assert.equal(parsed.closeMs, 30000);
  assert.equal(parsed.platform, 'win32');
  assert.equal(parsed.executable, ABSOLUTE);
  assert.throws(() => parseArgs(argv(`--executable=${ABSOLUTE}`, '--os=win32')), /Required option missing: --out/);
  assert.throws(() => parseArgs(argv(`--executable=${ABSOLUTE}`, '--os=freebsd', '--out=x.json')), /--os must be one of/);
});

test('parseArgs: the executable must be absolute, options take the --name=value form only, and the periods are whole seconds', () => {
  assert.throws(() => parseArgs(argv('--executable=release/app', '--os=linux', '--out=x.json')), /absolute path/);
  assert.throws(() => parseArgs(argv('--executable', ABSOLUTE, '--os=linux', '--out=x.json')), /Expected --name=value/);
  assert.throws(() => parseArgs(argv(`--executable=${ABSOLUTE}`, '--os=linux', '--out=x.json', '--out=y.json')), /Duplicate option --out/);
  assert.throws(() => parseArgs(argv(`--executable=${ABSOLUTE}`, '--os=linux', '--out=x.json', '--stay-ms=500')), /whole numbers of at least 1000/);
});

test('isCleanExit: code 0 is clean; a SIGTERM is clean only when this check asked for the close; anything else is not', () => {
  assert.equal(isCleanExit({ closeRequested: true, exit: { code: 0, signal: null } }), true);
  assert.equal(isCleanExit({ closeRequested: true, exit: { code: null, signal: 'SIGTERM' } }), true);
  assert.equal(isCleanExit({ closeRequested: false, exit: { code: null, signal: 'SIGTERM' } }), false, 'a SIGTERM the app received before any close request is not clean');
  assert.equal(isCleanExit({ closeRequested: true, exit: { code: 1, signal: null } }), false);
  assert.equal(isCleanExit({ closeRequested: true, exit: { code: null, signal: 'SIGKILL' } }), false);
  assert.equal(isCleanExit({ closeRequested: true, exit: null }), false);
});

const CLEAN = Object.freeze({
  platform: 'linux', stayMs: 10000, closeMs: 30000, windowRequired: true, startedAt: '2026-10-12T00:00:00.000Z', startError: null,
  window: true, closeRequested: true, closeRequestFailed: false, closeTimedOut: false, exit: { code: null, signal: 'SIGTERM' }, exitedBeforeStay: null, crashSignal: null,
});

test('decideLaunch: a release that starts, shows its window and closes on request passes', () => {
  assert.deepEqual(decideLaunch(CLEAN), []);
  assert.deepEqual(decideLaunch({ ...CLEAN, exit: { code: 0, signal: null } }), []);
});

test('decideLaunch: no window on Linux fails; macOS asks for LaunchServices registration instead of a window; Windows asks for neither', () => {
  assert.match(decideLaunch({ ...CLEAN, window: false }).join('\n'), /no window of the app was visible/);
  const mac = { ...CLEAN, platform: 'darwin', windowRequired: false, registrationRequired: true, window: null, exit: { code: 0, signal: null } };
  assert.match(decideLaunch({ ...mac, registered: false }).join('\n'), /not registered with LaunchServices/);
  assert.deepEqual(decideLaunch({ ...mac, registered: true }), [], 'a registered release app passes without any window');
  assert.deepEqual(decideLaunch({ ...CLEAN, platform: 'win32', windowRequired: false, window: null, exit: { code: 0, signal: null } }), []);
});

test('the platforms: Linux needs a window, macOS needs LaunchServices registration, Windows needs neither', () => {
  assert.deepEqual(PLATFORMS.linux, { windowRequired: true, registrationRequired: false });
  assert.deepEqual(PLATFORMS.darwin, { windowRequired: false, registrationRequired: true });
  assert.deepEqual(PLATFORMS.win32, { windowRequired: false, registrationRequired: false });
});

test('the macOS check uses no System Events and no osascript: lsappinfo needs no permission on the runner', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release-launch-check.cjs'), 'utf8');
  assert.doesNotMatch(source, /osascript|System Events|Accessibility/);
  assert.match(source, /spawnSync\('lsappinfo', \['list'\]/);
});

test('decideLaunch: an app that exits within the stay period fails, and so does one that stops on a crash signal', () => {
  const early = decideLaunch({ ...CLEAN, closeRequested: false, exitedBeforeStay: { code: 1, signal: null }, exit: { code: 1, signal: null }, window: null });
  assert.match(early.join('\n'), /exited within 10000 ms of its start/);
  assert.match(decideLaunch({ ...CLEAN, exit: { code: null, signal: 'SIGSEGV' }, crashSignal: 'SIGSEGV' }).join('\n'), /stopped on SIGSEGV/);
});

test('decideLaunch: a close that is not clean fails, a close that times out fails, and a failed close request fails', () => {
  assert.match(decideLaunch({ ...CLEAN, exit: { code: 3, signal: null } }).join('\n'), /close was not clean \(code 3/);
  assert.match(decideLaunch({ ...CLEAN, closeTimedOut: true, exit: null }).join('\n'), /did not exit within 30000 ms/);
  assert.match(decideLaunch({ ...CLEAN, closeRequestFailed: true }).join('\n'), /close request could not be sent/);
});

test('decideLaunch: an executable that does not start fails with the reason', () => {
  const problems = decideLaunch({ ...CLEAN, startedAt: null, startError: 'ENOENT', window: null, exit: null, closeRequested: false });
  assert.deepEqual(problems, ['the executable did not start (ENOENT)']);
});
