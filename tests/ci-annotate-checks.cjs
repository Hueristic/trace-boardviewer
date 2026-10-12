'use strict';

// The CI failure annotations (scripts/ci-annotate.cjs): escaping, redaction, the failing lines of a log, the failing steps of the smoke
// evidence, and the cap on annotations. Pure functions and temporary folders only; no workflow, no app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const annotate = require('../scripts/ci-annotate.cjs');

test('escaping: the characters that end a workflow command are escaped in the message and in the title', () => {
  assert.equal(annotate.escapeData('100% done\nnext\r'), '100%25 done%0Anext%0D');
  assert.equal(annotate.escapeProperty('CI log: a:b,c'), 'CI log%3A a%3Ab%2Cc');
  assert.equal(annotate.escapeProperty('x:y,z'), 'x%3Ay%2Cz');
});

test('redaction: user folders of paths, e-mail addresses and access tokens are replaced by generic markers; the runner paths stay', () => {
  assert.equal(annotate.redact('C:\\Users\\Alice\\Desktop\\x'), 'C:\\Users\\<user>\\Desktop\\x');
  assert.equal(annotate.redact('/Users/someone/work/x'), '/Users/<user>/work/x');
  assert.equal(annotate.redact('/home/runner/work/trace-boardviewer'), '/home/runner/work/trace-boardviewer');
  assert.equal(annotate.redact('/home/tech/x'), '/home/<user>/x');
  assert.equal(annotate.redact('contact alice@example.com now'), 'contact <email> now');
  assert.equal(annotate.redact('token ghp_abcdefgh12345678 used'), 'token <token> used');
});

test('logFailures: a failing line is printed with the lines after it; passing summaries are not; an e-mail address in a line is redacted', () => {
  const log = [
    'ok 1 - first', 'not ok 2 - the second case', '  ---', '  expected: 1', '  actual: 2', '  at file:///home/runner/work/x.test.ts:9', '  ...',
    'ℹ fail 0', 'ok 3 - third', '✖ tech wrote alice@example.com here', 'after the failing line',
  ].join('\n');
  const lines = annotate.logFailures(log);
  assert.ok(lines.includes('not ok 2 - the second case'));
  assert.ok(lines.includes('actual: 2'), 'the context after the failure is kept');
  assert.ok(!lines.some((line) => line.includes('fail 0')), 'a zero-failure summary is not a failure');
  assert.ok(lines.includes('✖ tech wrote <email> here'), 'the line is kept, its e-mail address redacted');
  assert.ok(!lines.some((line) => line.includes('alice@example.com')));
});

test('evidenceFailures: a not-passed verdict, the listed checks and problems, and the failed steps are reported', () => {
  assert.deepEqual(annotate.evidenceFailures({ passed: true, failedChecks: [] }), []);
  const failed = annotate.evidenceFailures({
    passed: false, failedChecks: ['static fuse check'], problems: ['no window'],
    steps: [{ name: 'launch', status: 'fail', error: 'timeout' }, { name: 'quit', status: 'pass' }],
  });
  assert.ok(failed.includes('passed: false'));
  assert.ok(failed.includes('failedChecks: static fuse check'));
  assert.ok(failed.includes('problems: no window'));
  assert.ok(failed.includes('step "launch" failed: timeout'));
  assert.ok(!failed.some((line) => line.includes('quit')));
  assert.deepEqual(annotate.evidenceFailures({ status: 'pass' }), []);
  assert.ok(annotate.evidenceFailures({ status: 'fail' }).includes('status: fail'));
});

test('annotations: the logs and the evidence of a folder become titled annotations, and no more than MAX_LINES are printed', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ci-annotate-'));
  try {
    const logs = path.join(folder, 'ci-diag');
    const evidence = path.join(folder, 'evidence');
    fs.mkdirSync(logs);
    fs.mkdirSync(evidence);
    fs.writeFileSync(path.join(logs, 'linux-vitest.log'), 'Test FAIL src/x.test.ts > case\nAssertionError: expected 1\n');
    fs.writeFileSync(path.join(evidence, 'release-launch-x64.json'), JSON.stringify({ passed: false, problems: ['the app exited early'] }));
    const found = annotate.annotations({ logs: [path.join(logs, 'linux-vitest.log')], evidence: [path.join(evidence, 'release-launch-x64.json')] });
    assert.ok(found.some((item) => item.title === 'CI log: linux-vitest' && item.message.includes('AssertionError')));
    assert.ok(found.some((item) => item.title === 'CI evidence: release-launch-x64' && item.message === 'problems: the app exited early'));
    assert.equal(annotate.MAX_LINES, 40);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
