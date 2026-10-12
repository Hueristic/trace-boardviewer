'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const navigation = require(path.join(ROOT, 'electron', 'navigation.cjs'));
const TRUSTED = 'file:///C:/TRACE/resources/app.asar/dist/index.html';

function event() {
  const calls = { prevented: 0 };
  return { calls, preventDefault() { calls.prevented += 1; } };
}

test('the trusted page is the only page of the main window: same origin, path and query; a fragment never loads another document', () => {
  assert.equal(navigation.isTrustedUrl(TRUSTED, TRUSTED), true);
  assert.equal(navigation.isTrustedUrl(`${TRUSTED}#board`, TRUSTED), true, 'the fragment is ignored');
  assert.equal(navigation.isTrustedUrl('file:///C:/TRACE/resources/app.asar/dist/other.html', TRUSTED), false, 'another page of the same origin');
  assert.equal(navigation.isTrustedUrl(`${TRUSTED}?x=1`, TRUSTED), false, 'another query');
  assert.equal(navigation.isTrustedUrl('https://example.com/', TRUSTED), false);
  assert.equal(navigation.isTrustedUrl('http://127.0.0.1:8851/', TRUSTED), false, 'the local page of another project');
  assert.equal(navigation.isTrustedUrl('not a url', TRUSTED), false);
  assert.equal(navigation.isTrustedUrl(TRUSTED, ''), false, 'no trusted page yet: nothing is trusted');
});

test('will-navigate, will-redirect and will-frame-navigate prevent every navigation that is not the trusted page, and allow the trusted one', () => {
  const guard = navigation.createNavigationGuard({ trustedUrl: () => TRUSTED });
  for (const handler of ['willNavigate', 'willRedirect', 'willFrameNavigate']) {
    const blocked = event();
    assert.equal(guard[handler](blocked, 'https://example.com/phish'), 'blocked', handler);
    assert.equal(blocked.calls.prevented, 1, `${handler} prevents the external page`);
    const local = event();
    assert.equal(guard[handler](local, 'http://127.0.0.1:8851/'), 'blocked', `${handler} blocks a local page of another project`);
    assert.equal(local.calls.prevented, 1);
    const allowed = event();
    assert.equal(guard[handler](allowed, TRUSTED), 'allowed', handler);
    assert.equal(allowed.calls.prevented, 0, `${handler} leaves the trusted page alone`);
  }
});

test('the watchdog stops a main-frame navigation to anything but the trusted page (loadURL, DevTools), and never a subframe or the trusted page', () => {
  const guard = navigation.createNavigationGuard({ trustedUrl: () => TRUSTED });
  assert.equal(guard.startNavigation('http://127.0.0.1:8851/', true), 'stop', 'the bypassing navigation is cancelled');
  assert.equal(guard.startNavigation('https://example.com/', true), 'stop');
  assert.equal(guard.startNavigation(TRUSTED, true), 'allowed', 'the trusted page loads');
  assert.equal(guard.startNavigation('https://example.com/ad', false), 'allowed', 'a subframe is governed by will-frame-navigate, not by the watchdog');
  const unset = navigation.createNavigationGuard({ trustedUrl: () => '' });
  assert.equal(unset.startNavigation('https://example.com/', true), 'stop', 'with no trusted page, a main-frame navigation is stopped');
});

test('the guard reads the trusted URL at each event: it follows the page createWindow sets (a development server or the packaged page)', () => {
  let trusted = '';
  const guard = navigation.createNavigationGuard({ trustedUrl: () => trusted });
  assert.equal(guard.isTrusted(TRUSTED), false, 'before createWindow set it');
  trusted = TRUSTED;
  assert.equal(guard.isTrusted(TRUSTED), true);
  trusted = 'http://localhost:5173/';
  assert.equal(guard.isTrusted(TRUSTED), false, 'the trusted page changed');
  assert.equal(guard.isTrusted('http://localhost:5173/'), true);
});

test('a packaged release refuses the remote debugging switches; only the QA build flag keeps them; a development run and a missing switch reader are not refused', () => {
  const withSwitch = (name) => (wanted) => wanted === name;
  const release = { isPackaged: true, buildFlavour: undefined };
  assert.equal(navigation.remoteDebuggingRefused({ ...release, hasSwitch: withSwitch('remote-debugging-port') }), true);
  assert.equal(navigation.remoteDebuggingRefused({ ...release, hasSwitch: withSwitch('remote-debugging-pipe') }), true);
  assert.equal(navigation.remoteDebuggingRefused({ ...release, hasSwitch: () => false }), false, 'no switch, no refusal');
  assert.equal(navigation.remoteDebuggingRefused({ isPackaged: true, buildFlavour: 'qa', hasSwitch: withSwitch('remote-debugging-port') }), false, 'the QA build flag keeps the switches');
  for (const flag of ['QA', 'beta', '', null, 1]) {
    assert.equal(navigation.remoteDebuggingRefused({ isPackaged: true, buildFlavour: flag, hasSwitch: withSwitch('remote-debugging-port') }), true, `${JSON.stringify(flag)} is not the QA flag: closed`);
  }
  assert.equal(navigation.remoteDebuggingRefused({ isPackaged: true, productName: 'TRACE Boardviewer QA', hasSwitch: withSwitch('remote-debugging-port') }), true, 'the product name alone never opens it');
  assert.equal(navigation.remoteDebuggingRefused({ isPackaged: false, buildFlavour: undefined, hasSwitch: withSwitch('remote-debugging-port') }), false, 'a development run is never refused');
  assert.equal(navigation.remoteDebuggingRefused({ isPackaged: true, buildFlavour: undefined, hasSwitch: undefined }), false, 'a missing switch reader does not throw');
});

test('main.cjs wires the guard to the main window, refuses the switches before startup, and keeps one place that opens a URL', () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /navigation\.createNavigationGuard\(\{ trustedUrl: \(\) => trustedPageUrl \}\)/);
  assert.match(main, /on\('will-navigate', \(event, url\) => guard\.willNavigate\(event, url\)\)/);
  assert.match(main, /on\('will-redirect', \(event, url\) => guard\.willRedirect\(event, url\)\)/);
  assert.match(main, /on\('will-frame-navigate', \(event, url\) => guard\.willFrameNavigate\(event, url\)\)/);
  assert.match(main, /guard\.startNavigation\(url, isMainFrame\) === 'stop'/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/, 'every window opening is denied');
  assert.match(main, /app\.isPackaged && navigation\.remoteDebuggingRefused\(\{ isPackaged: true, buildFlavour, hasSwitch/, 'refusal reads the build flag');
  assert.match(main, /require\('\.\.\/package\.json'\)\.traceBuildFlavor/, 'the build flag comes from the packaged package.json');
  assert.doesNotMatch(main, /productName: app\.getName\(\)/, 'the product name never decides the refusal');
  assert.match(main, /app\.exit\(1\)/);
  assert.equal((main.match(/shell\.openExternal\(/g) ?? []).length, 1, 'one call site: openExternalUrl, https only');
  assert.match(main, /if \(new URL\(url\)\.protocol !== 'https:'\) throw/);
  assert.equal((main.match(/new BrowserWindow\(/g) ?? []).length, 1, 'one window: every window gets the guard above');
  assert.match(main, /webviewTag: false/);
});
