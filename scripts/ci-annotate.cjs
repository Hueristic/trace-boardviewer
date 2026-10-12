'use strict';

// Failure annotations for the CI jobs, readable without a login: annotations are public. A test or smoke step streams its output to a
// log file under $RUNNER_TEMP/ci-diag; when a job fails, this script writes the failing lines of those logs and the failing steps of the
// smoke evidence (JSON files of a test-results folder) as workflow annotations (::error). It writes at most MAX_LINES annotations, and
// redacts what must not be public by generic patterns only: user folders in paths, e-mail addresses and access tokens. It reads nothing
// but those files. It always exits 0: the job has already failed, and an annotation is never the reason a job fails.
//
// usage: node scripts/ci-annotate.cjs [--logs=<folder of .log files>] [--evidence=<folder of .json evidence files>]

const fs = require('node:fs');
const path = require('node:path');

const MAX_LINES = 40;
const CONTEXT_AFTER = 5;
// The lines that mean a failure: TAP "not ok", the reporters' failure marks, assertion and TypeScript errors, a non-zero exit.
const FAILURE = /\bnot ok\b|✖|×|\bFAIL\b|AssertionError|\bError:|error TS\d+|\bERR_[A-Z_]+|exit=[1-9]\d*/;
// Summary lines that count failures as zero: they are not failures.
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

/** The failing lines of a log, each with the lines after it, redacted. */
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

/** The failing steps of one evidence file: a verdict that is not passed, the checks or problems it lists, and its failed steps. */
function evidenceFailures(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  if (data.passed === false) out.push('passed: false');
  if (typeof data.status === 'string' && data.status !== 'pass' && data.status !== 'passed') out.push(`status: ${data.status}`);
  for (const key of ['failedChecks', 'problems']) {
    if (Array.isArray(data[key])) for (const item of data[key]) out.push(`${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`);
  }
  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (step && step.status === 'fail') out.push(`step "${step.name ?? 'unnamed'}" failed${step.error ? `: ${step.error}` : ''}`);
    }
  }
  return out.map(redact);
}

function listFiles(folder, extension) {
  if (!folder || !fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.endsWith(extension)).sort().map((name) => path.join(folder, name));
}

/** The annotation lines for a set of logs and evidence files, at most MAX_LINES of them. */
function annotations({ logs = [], evidence = [] }) {
  const out = [];
  for (const file of logs) {
    const title = `CI log: ${path.basename(file, '.log')}`;
    for (const line of logFailures(fs.readFileSync(file, 'utf8'))) out.push({ title, message: line });
  }
  for (const file of evidence) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
    const title = `CI evidence: ${path.basename(file, '.json')}`;
    for (const message of evidenceFailures(data)) out.push({ title, message });
  }
  return out;
}

function main(argv) {
  const value = (name) => {
    const found = argv.find((item) => item.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : null;
  };
  const all = annotations({ logs: listFiles(value('logs'), '.log'), evidence: listFiles(value('evidence'), '.json') });
  const shown = all.slice(0, MAX_LINES);
  for (const { title, message } of shown) {
    console.log(`::error title=${escapeProperty(title)}::${escapeData(message)}`);
  }
  if (all.length > shown.length) console.log(`::notice::${all.length - shown.length} more failing lines are in the job's logs (annotations stop at ${MAX_LINES}).`);
  if (all.length === 0) console.log('::notice::No failing line was found in the step logs or the smoke evidence.');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = Object.freeze({ MAX_LINES, escapeData, escapeProperty, redact, logFailures, evidenceFailures, annotations });
