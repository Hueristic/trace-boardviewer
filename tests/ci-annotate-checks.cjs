'use strict';

// The CI failure annotations (scripts/ci-annotate.cjs): escaping, redaction, the runner's failing lines of a log, the smoke evidence of a
// step, the per-step cap, and the way the steps are given. Pure functions and temporary folders only; no workflow, no app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const annotate = require('../scripts/ci-annotate.cjs');

test('escaping: the characters that end a workflow command are escaped in the message and in the title', () => {
  assert.equal(annotate.escapeData('100% done\nnext\r'), '100%25 done%0Anext%0D');
  assert.equal(annotate.escapeProperty('CI step: a:b,c'), 'CI step%3A a%3Ab%2Cc');
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

test('logFailures: the runner\'s failing lines are printed with the lines after them; a passing line that contains FAIL is not', () => {
  const log = [
    'ℹ fail 0',
    'PASS synthetic diagnostic timeout keeps the first error',
    'FAIL synthetic diagnostic timeout keeps original error',
    'ok 2 - second',
    'not ok 3 - the third case',
    '  actual: 3',
    ' FAIL  src/x.test.ts > alpha',
    'AssertionError: expected 1',
    '✖ tech wrote alice@example.com here',
  ].join('\n');
  const lines = annotate.logFailures(log);
  assert.ok(lines.includes('not ok 3 - the third case'));
  assert.ok(lines.includes('actual: 3'), 'the context after the failure is kept');
  assert.ok(lines.includes('FAIL  src/x.test.ts > alpha'), 'the vitest failure header is a failing line');
  assert.ok(lines.includes('✖ tech wrote <email> here'), 'the line is kept, its e-mail address redacted');
  assert.ok(!lines.some((line) => line.includes('synthetic diagnostic timeout')), 'a synthetic case that prints FAIL is not an error');
  assert.ok(!lines.some((line) => line.includes('fail 0')), 'a zero-failure summary is not a failure');
  assert.ok(!lines.some((line) => line.includes('alice@example.com')));
});

test('evidenceFailures: the error comes first, then the failing checks, the problems and the failed steps; a passing file gives nothing', () => {
  assert.deepEqual(annotate.evidenceFailures({ passed: true, failedChecks: [] }), []);
  assert.deepEqual(annotate.evidenceFailures({ status: 'pass' }), []);
  const failed = annotate.evidenceFailures({
    error: 'the app stopped on SIGSEGV', passed: false, failedChecks: ['static fuse check'], problems: ['no window'],
    steps: [{ name: 'launch', status: 'fail', error: 'timeout' }, { name: 'quit', status: 'pass' }],
  });
  assert.equal(failed[0], 'error: the app stopped on SIGSEGV', 'the error is the first line');
  assert.ok(failed.indexOf('failed check: static fuse check') < failed.indexOf('problem: no window'), 'the failing checks come before the problems');
  assert.ok(failed.indexOf('problem: no window') < failed.indexOf('step "launch" failed: timeout'), 'the problems come before the failed steps');
  assert.ok(!failed.some((line) => line.includes('quit')));
  assert.ok(annotate.evidenceFailures({ status: 'fail' }).includes('status: fail'));
});

test('stepAnnotations: a step gets its evidence first and at most MAX_LINES annotations, whatever its log holds', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ci-annotate-'));
  try {
    const log = path.join(folder, 'linux-smoke-S1.log');
    const json = path.join(folder, 'smoke-S1.json');
    fs.writeFileSync(log, Array.from({ length: 60 }, (_, index) => `not ok ${index + 1} - case`).join('\n'));
    fs.writeFileSync(json, JSON.stringify({ passed: false, error: 'the smoke test stopped early' }));
    const found = annotate.stepAnnotations({ title: 'S1', log, json });
    assert.equal(found.length, annotate.MAX_LINES, 'the cap is per step');
    assert.equal(found[0].message, 'error: the smoke test stopped early', 'the evidence is printed before the log');
    assert.equal(found[0].title, 'CI step: S1');
    assert.equal(annotate.MAX_LINES, 40);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('stepsFrom: each --step starts a step, and the --log and --json after it belong to that step', () => {
  assert.deepEqual(annotate.stepsFrom(['--step=A', '--log=x.log', '--json=y.json', '--step=B', '--log=z.log']), [
    { title: 'A', log: 'x.log', json: 'y.json' },
    { title: 'B', log: 'z.log', json: null },
  ]);
});
