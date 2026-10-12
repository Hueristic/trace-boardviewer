'use strict';

// The QA switch of the device database (LIB-02, electron/device-switch.cjs). Pure checks of the guard, and source checks of the wiring:
// the release constant stays false, the renderer learns the switch from its own window argument, and the entry point follows it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const deviceSwitch = require('../electron/device-switch.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFile(path.join(ROOT, ...parts), 'utf8');

test('the QA switch is on only for a packaged QA build whose environment says exactly 1', () => {
  const on = { isPackaged: true, buildFlavour: 'qa', env: { TRACE_QA_DEVICE_DATABASE: '1' } };
  assert.equal(deviceSwitch.deviceDatabaseQaSwitch(on), true);
  for (const variant of [
    { ...on, isPackaged: false },
    { ...on, buildFlavour: 'release' },
    { ...on, buildFlavour: undefined },
    { ...on, env: { TRACE_QA_DEVICE_DATABASE: '0' } },
    { ...on, env: { TRACE_QA_DEVICE_DATABASE: 'true' } },
    { ...on, env: { TRACE_QA_DEVICE_DATABASE: '' } },
    { ...on, env: {} },
    { ...on, env: undefined },
  ]) assert.equal(deviceSwitch.deviceDatabaseQaSwitch(variant), false, JSON.stringify(variant));
});

test('the release flavour can never switch the feature on, whatever its environment says', () => {
  for (const isPackaged of [true, false]) {
    assert.equal(deviceSwitch.deviceDatabaseQaSwitch({ isPackaged, buildFlavour: undefined, env: { TRACE_QA_DEVICE_DATABASE: '1' } }), false);
    assert.equal(deviceSwitch.deviceDatabaseQaSwitch({ isPackaged, buildFlavour: 'release', env: { TRACE_QA_DEVICE_DATABASE: '1' } }), false);
  }
});

test('the renderer argument and the environment name are the constants the other files repeat', async () => {
  assert.equal(deviceSwitch.RENDERER_ARGUMENT, '--trace-qa-device-database');
  assert.equal(deviceSwitch.ENVIRONMENT_NAME, 'TRACE_QA_DEVICE_DATABASE');
  const preload = await read('electron', 'preload.cjs');
  assert.ok(preload.includes(`process.argv?.includes('${deviceSwitch.RENDERER_ARGUMENT}') === true`), 'the preload reads the same argument');
});

test('main keeps the release constant false and turns the bridge on only through the QA switch', async () => {
  const main = await read('electron', 'main.cjs');
  assert.match(main, /^const DEVICE_DATABASE_ENABLED = false;$/m, 'the release switch stays false');
  assert.match(main, /const DEVICE_DATABASE_QA = deviceSwitch\.deviceDatabaseQaSwitch\(\{ isPackaged: app\.isPackaged, buildFlavour: packagedBuildFlavour, env: process\.env \}\);/);
  assert.match(main, /^const DEVICE_DATABASE_ON = DEVICE_DATABASE_ENABLED \|\| DEVICE_DATABASE_QA;$/m);
  assert.match(main, /if \(DEVICE_DATABASE_ON\) \{\n\s+handle\('trace:library-pick-root'/, 'the channels follow the combined switch');
  assert.match(main, /additionalArguments: DEVICE_DATABASE_QA \? \[deviceSwitch\.RENDERER_ARGUMENT\] : \[\],/, 'only the QA switch adds the renderer argument');
});

test('the renderer shows the entry through the function that keeps the release constant', async () => {
  const feature = await read('src', 'lib', 'library', 'devices', 'feature.ts');
  assert.match(feature, /^export const DEVICE_DATABASE_ENABLED = false;$/m, 'the renderer release switch stays false');
  assert.match(feature, /export function deviceDatabaseVisible\(qaSwitch: boolean \| undefined\): boolean \{\n\s+return DEVICE_DATABASE_ENABLED \|\| qaSwitch === true;/);
  const shell = await read('src', 'components', 'workspace', 'Shell.tsx');
  assert.match(shell, /deviceDatabaseVisible\(desktop\?\.qaDeviceDatabase\) \? \(\) => setModal\('devices'\) : undefined/, 'the entry point follows the window switch');
  assert.doesNotMatch(shell, /DEVICE_DATABASE_ENABLED/, 'Shell reads the switch through the function only');
});
