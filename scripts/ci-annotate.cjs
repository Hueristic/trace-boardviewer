'use strict';

// Failure annotations for the CI jobs, readable without a login: annotations are public. A test or smoke step streams its output to a
// log file under $RUNNER_TEMP/ci-diag, and a smoke step writes a JSON evidence file. When a job fails, this script writes, for each step
// given to it, the smoke evidence first (its error, its failing checks and steps) and then the runner's own failing lines of the step's
// log, as workflow annotations (::error); the evidence of every step is written before any step's log lines. Each step has its own
// budget of MAX_LINES annotations. Redaction is by generic pattern only:
// user folders in paths, e-mail addresses and access tokens. It reads nothing but the files it is given. It always exits 0: the job has
// already failed, and an annotation is never the reason a job fails.
//
// usage: node scripts/ci-annotate.cjs --step=<title> [--log=<file>] [--json=<file>] [--step=<title> ...]

const fs = require('node:fs');

const MAX_LINES = 40;
const CONTEXT_AFTER = 5;
const CLIP = 300;
// The runner's own failing lines: a TAP "not ok", the spec reporter's cross, the vitest failure mark and file header, an assertion
// error, a TypeScript error, a Node error code. A line that only contains the word FAIL is not one of them.
const FAILURE = /^\s*not ok\b|✖|^\s*×|^\s*FAIL\s+\S+\.(?:c|m)?(?:j|t)sx?\b|AssertionError|\berror TS\d+|\bERR_[A-Z_]+\b/;
// Summary lines that count the failures as zero: they are not failures.
const ZERO_SUMMARY = /\bfail 0\b|\b0 failed\b|\b0 fail\b/;

const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * What must not be public, by generic pattern: the user folder of a path (Windows C:\Users\<name>\, macOS /Users/<name>/, Linux
 * /home/<name>/; the runner's own /home/runner stays), an e-mail address, and an access token (GitHub and API key prefixes).
 */
function redact(text) {
  return text
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, 'C:\\Users\\<user>')
    .replace(/\/Users\/[^/\s"']+/g, '/Users/<user>')
    .replace(/\/home\/(?!runner(?=\/|\s|$))[^/\s"']+/g, '/home/<user>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk_(?:live_|test_)?)[A-Za-z0-9_]{8,}/g, '<token>');
}

const clip = (text) => (text.length > CLIP ? `${text.slice(0, CLIP)}...` : text);

/** The runner's failing lines of a log, each with the lines after it, redacted. Other lines are never printed. */
function logFailures(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!FAILURE.test(line) || ZERO_SUMMARY.test(line)) continue;
    for (let next = index; next <= Math.min(lines.length - 1, index + CONTEXT_AFTER); next++) {
      const shown = redact(lines[next]).trim();
      if (shown) out.push(shown);
    }
    index += CONTEXT_AFTER;
  }
  return out;
}

/**
 * The failures of one smoke evidence file, in this order: its error, its failing checks, its problems, its failed steps. Each is
 * redacted and clipped. A file that is not evidence of a failure gives nothing.
 */
function evidenceFailures(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  if (data.error) out.push(`error: ${clip(typeof data.error === 'string' ? data.error : JSON.stringify(data.error))}`);
  if (Array.isArray(data.failedChecks)) {
    for (const item of data.failedChecks) out.push(`failed check: ${clip(typeof item === 'string' ? item : JSON.stringify(item))}`);
  }
  if (Array.isArray(data.checks)) {
    for (const check of data.checks) {
      if (check && (check.passed === false || check.status === 'fail')) out.push(`failed check: ${clip(String(check.name ?? JSON.stringify(check)))}`);
    }
  }
  if (Array.isArray(data.problems)) for (const item of data.problems) out.push(`problem: ${clip(typeof item === 'string' ? item : JSON.stringify(item))}`);
  if (data.passed === false) out.push('passed: false');
  if (typeof data.status === 'string' && data.status !== 'pass' && data.status !== 'passed') out.push(`status: ${data.status}`);
  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (step && step.status === 'fail') out.push(clip(`step "${step.name ?? 'unnamed'}" failed${step.error ? `: ${step.error}` : ''}`));
    }
  }
  return out.map(redact);
}

/** The evidence lines and the failing log lines of one step, each list within the step's MAX_LINES budget (evidence first). */
function stepParts({ log, json }) {
  let evidence = [];
  if (json && fs.existsSync(json)) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { data = null; }
    evidence = evidenceFailures(data).slice(0, MAX_LINES);
  }
  const logLines = log && fs.existsSync(log) ? logFailures(fs.readFileSync(log, 'utf8')).slice(0, MAX_LINES - evidence.length) : [];
  return { evidence, log: logLines };
}

/** The annotations of one step: its evidence first, then its failing log lines, at most MAX_LINES of them. */
function stepAnnotations(step) {
  const { evidence, log } = stepParts(step);
  return [...evidence, ...log].map((message) => ({ title: `CI step: ${step.title}`, message }));
}

/** The steps given on the command line: each --step starts one, and the --log and --json after it belong to it. */
function stepsFrom(argv) {
  const steps = [];
  let current = null;
  for (const item of argv) {
    const match = /^--(step|log|json)=(.*)$/.exec(item);
    if (!match) continue;
    if (match[1] === 'step') {
      current = { title: match[2], log: null, json: null };
      steps.push(current);
    } else if (current) {
      current[match[1]] = match[2] || null;
    }
  }
  return steps;
}

function main(argv) {
  const steps = stepsFrom(argv).map((step) => ({ step, parts: stepParts(step) }));
  let total = 0;
  // Every step's evidence before any step's log lines: GitHub shows only the first ten error annotations of this step, and the
  // expected stderr of passing tests in an earlier step's log must not push a smoke failure out of them.
  for (const kind of ['evidence', 'log']) {
    for (const { step, parts } of steps) {
      for (const message of parts[kind]) {
        total += 1;
        console.log(`::error title=${escapeProperty(`CI step: ${step.title}`)}::${escapeData(message)}`);
      }
    }
  }
  for (const { step, parts } of steps) {
    if (parts.evidence.length + parts.log.length === MAX_LINES) console.log(`::notice title=${escapeProperty(`CI step: ${step.title}`)}::the first ${MAX_LINES} failing lines of this step are shown; the logs hold the rest.`);
  }
  if (total === 0) console.log('::notice::No failing line was found in the steps given to the annotator.');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = Object.freeze({ MAX_LINES, escapeData, escapeProperty, redact, logFailures, evidenceFailures, stepAnnotations, stepsFrom });
