'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appVersion, feedReleaseVersion, isNewerVersion } = require('../scripts/packaged-functional/update-version.cjs');

test('the update fixture is always strictly newer than the installed app it is derived from', () => {
  assert.equal(isNewerVersion(feedReleaseVersion(), appVersion()), true);
  assert.equal(feedReleaseVersion(appVersion()), `${appVersion().split('.').slice(0, 2).join('.')}.${Number(appVersion().split('.')[2]) + 1}`);
});

test('an installed 1.3.2 gets a 1.3.3 fixture, never an equal (current) feed', () => {
  assert.equal(feedReleaseVersion('1.3.2'), '1.3.3');
  assert.equal(isNewerVersion(feedReleaseVersion('1.3.2'), '1.3.2'), true);
  assert.equal(feedReleaseVersion('1.3.1'), '1.3.2');
  assert.equal(feedReleaseVersion('9.12.0'), '9.12.1');
});

test('the comparison is numeric and refuses versions that are not plain MAJOR.MINOR.PATCH', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('1.3.2', '1.3.2'), false);
  assert.equal(isNewerVersion('1.3.1', '1.3.2'), false);
  assert.throws(() => feedReleaseVersion('01.3.2'), /plain MAJOR\.MINOR\.PATCH/);
  assert.throws(() => feedReleaseVersion('v1.3.2'), /plain MAJOR\.MINOR\.PATCH/);
  assert.throws(() => feedReleaseVersion('1.3'), /plain MAJOR\.MINOR\.PATCH/);
});

test('a pre-release build (1.3.2-rc.1, 1.3.3-rc.1) derives the next patch of its core, so the fixture loads and stays newer', () => {
  assert.equal(feedReleaseVersion('1.3.2-rc.1'), '1.3.3');
  assert.equal(feedReleaseVersion('1.3.3-rc.1'), '1.3.4');
  assert.equal(feedReleaseVersion('1.3.2+build.7'), '1.3.3');
  assert.equal(isNewerVersion(feedReleaseVersion('1.3.2-rc.1'), '1.3.2-rc.1'), true);
});
