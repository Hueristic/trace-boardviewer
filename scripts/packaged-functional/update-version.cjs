'use strict';

// Versions for the packaged update fixture. Both come from the repository package.json that builds the app under test, so the
// fixture never hard-codes a release number: the feed is always the next patch of the installed version, which is strictly newer.

const path = require('node:path');
const { version: APP_VERSION } = require(path.join(__dirname, '..', '..', 'package.json'));

const PLAIN_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// A pre-release suffix (1.3.2-rc.1) or build metadata (+sha) is not part of the MAJOR.MINOR.PATCH core that the fixture is derived from.
const coreOf = value => value.replace(/[-+].*$/, '');

function parsePlainSemver(value) {
  const match = PLAIN_SEMVER.exec(coreOf(value));
  if (!match) throw new Error('the package.json version must be a plain MAJOR.MINOR.PATCH to derive the update fixture');
  return match.slice(1).map(Number);
}

/** The version of the application under test. */
function appVersion() {
  return APP_VERSION;
}

/** The local feed fixture's stable release: the next patch of the installed version's MAJOR.MINOR.PATCH core (1.3.2-rc.1 -> 1.3.3). */
function feedReleaseVersion(current = APP_VERSION) {
  const [major, minor, patch] = parsePlainSemver(current);
  return `${major}.${minor}.${patch + 1}`;
}

/** True when version a's core is strictly newer than version b's core (MAJOR.MINOR.PATCH; a suffix is ignored). */
function isNewerVersion(a, b) {
  const left = parsePlainSemver(a);
  const right = parsePlainSemver(b);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}

module.exports = { appVersion, feedReleaseVersion, isNewerVersion };
