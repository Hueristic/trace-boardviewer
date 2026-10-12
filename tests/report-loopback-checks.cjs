'use strict';

// Tests for scripts/packaged-functional/report-loopback.cjs, the offline stand-in for the bug-report receiver used by the packaged QA run.
// They start the real loopback HTTPS server on 127.0.0.1 with a certificate made by openssl and check the acknowledgement the app
// validates (shared/bug-report-contract.cjs isValidAcknowledgement). No network leaves the machine; the packaged app itself is not run here.
// The tests are skipped when openssl is not installed, which the QA run itself would then refuse loudly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const { startReportLoopback, REPORT_HOST, REPORT_PATH } = require('../scripts/packaged-functional/report-loopback.cjs');
const contract = require('../shared/bug-report-contract.cjs');

const hasOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function post({ port, host = REPORT_HOST, urlPath = REPORT_PATH, body = '' }) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', rejectUnauthorized: false,
      headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('the loopback receiver answers a report with the contract acknowledgement (report id and SHA-256 of the exact bytes)', { skip: !hasOpenssl && 'openssl is not installed' }, async () => {
  const loop = await startReportLoopback();
  try {
    const body = JSON.stringify({ schema: contract.SCHEMA, reportId: 'report-loopback-1', description: 'synthetic', diagnostics: null });
    const { status, text } = await post({ port: loop.port, body });
    assert.equal(status, 201);
    assert.ok(contract.isValidAcknowledgement(JSON.parse(text), 'report-loopback-1', sha256(body)), `acknowledgement: ${text}`);
    assert.deepEqual(loop.received, [{ reportId: 'report-loopback-1', bytes: Buffer.byteLength(body), sha256: sha256(body) }]);
  } finally {
    await loop.close();
  }
});

test('the loopback receiver refuses another path, another host header, a body without a report id, and an oversized body', { skip: !hasOpenssl && 'openssl is not installed' }, async () => {
  const loop = await startReportLoopback();
  try {
    assert.equal((await post({ port: loop.port, urlPath: '/v1/other', body: '{"reportId":"x"}' })).status, 404);
    assert.equal((await post({ port: loop.port, host: 'example.invalid', body: '{"reportId":"x"}' })).status, 404);
    assert.equal((await post({ port: loop.port, body: '{"description":"no id"}' })).status, 400);
    await assert.rejects(post({ port: loop.port, body: 'x'.repeat(70 * 1024) }));
    assert.deepEqual(loop.received, [], 'nothing refused is recorded as received');
  } finally {
    await loop.close();
  }
});

test('the QA app is pointed at the loopback receiver by its host-resolver rule, and trusts only that run certificate', { skip: !hasOpenssl && 'openssl is not installed' }, async () => {
  const loop = await startReportLoopback();
  try {
    assert.ok(loop.launchArgs.includes(`--host-resolver-rules=MAP ${REPORT_HOST} 127.0.0.1:${loop.port}`), JSON.stringify(loop.launchArgs));
    assert.ok(loop.launchArgs.includes('--ignore-certificate-errors'));
    assert.equal(loop.host, REPORT_HOST);
  } finally {
    await loop.close();
  }
});
