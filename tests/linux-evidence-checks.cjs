'use strict';

// Native checks for the Linux evidence binding (TB-084): the installed state of the .deb must be the exact Version of the .deb the run
// was given (a status prefix is not a match), and the evidence carries the digest of the executable that ran. No Linux, no network:
// the pure helpers are checked here; the run itself is the Linux acceptance.

const test = require('node:test');
const assert = require('node:assert/strict');
const { installedProblems, buildEvidence } = require('../scripts/linux-smoke.cjs');

test('the installed .deb must be the exact version of the .deb, not a status prefix or a longer version that starts with it', () => {
  const ok = { status: 'install ok installed 1.3.2-1', debVersion: '1.3.2-1', apparmorProfileFile: true };
  assert.deepEqual(installedProblems(ok), []);
  const longer = installedProblems({ ...ok, status: 'install ok installed 1.3.2-10' });
  assert.equal(longer.length, 1, 'a longer version with the same prefix is refused');
  assert.match(longer[0], /installed version 1\.3\.2-10 is not the version of the \.deb \(1\.3\.2-1\)/);
  assert.equal(installedProblems({ ...ok, status: 'deinstall ok config-files 1.3.2-1' }).length, 1, 'a removed package is refused');
  assert.equal(installedProblems({ ...ok, status: '' }).length, 1, 'a package that dpkg does not know is refused');
  assert.equal(installedProblems({ ...ok, debVersion: null }).length, 1, 'a .deb without a Version field is refused');
  assert.equal(installedProblems({ ...ok, apparmorProfileFile: false }).length, 1, 'a missing AppArmor profile is refused');
});

test('the evidence carries the digest of the executable that ran, and null when there is none', () => {
  const digest = 'a'.repeat(64);
  assert.equal(buildEvidence({ kind: 'run', executable: '/opt/trace/trace-boardviewer', executableSha256: digest }).executableSha256, digest);
  assert.equal(buildEvidence({ kind: 'run' }).executableSha256, null);
});
