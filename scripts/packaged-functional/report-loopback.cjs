'use strict';

// Offline stand-in for the real bug-report receiver, for the packaged QA run only (HUNT-LNX-20261011-06: the send step needed the real
// endpoint, which an offline run cannot reach). The QA app is launched with a host-resolver rule that points the report host at this
// loopback server. The request keeps its exact URL, so the inspector's gate still matches it, and the bytes never leave the machine.
// The certificate is made per run by openssl for that host name only; the QA app alone trusts it (--ignore-certificate-errors is a
// QA-only launch argument). The answer is the contract's own acknowledgement: the report id from the body and the SHA-256 of the exact
// bytes received, which is what the app checks before it reports the report as received.

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const contract = require('../../shared/bug-report-contract.cjs');

const REPORT_HOST = 'trace-bug-report.trace-boardviewer.workers.dev';
const REPORT_PATH = '/v1/reports';
const MAX_BODY_BYTES = 64 * 1024;

function makeCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${REPORT_HOST}`, '-addext', `subjectAltName=DNS:${REPORT_HOST}`], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`openssl could not make the loopback certificate for the offline QA run: ${(result.error && result.error.message) || result.stderr || `exit ${result.status}`}`);
  }
  return { key: fsSync.readFileSync(key), cert: fsSync.readFileSync(cert) };
}

/** Starts the loopback receiver. `launchArgs` go to the QA app; `received` lists what arrived; `close()` stops it and removes its files. */
async function startReportLoopback({ tempRoot = os.tmpdir() } = {}) {
  const dir = await fsp.mkdtemp(path.join(tempRoot, 'trace-report-loopback-'));
  let server = null;
  try {
    const { key, cert } = makeCertificate(dir);
    const received = [];
    server = https.createServer({ key, cert }, (request, response) => {
      const reply = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method !== 'POST' || request.url !== REPORT_PATH || request.headers.host !== REPORT_HOST) return reply(404, { error: 'not-found' });
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { tooLarge = true; request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('error', () => {});
      request.on('end', () => {
        if (tooLarge) return;
        const body = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = null; }
        if (!parsed || typeof parsed.reportId !== 'string') return reply(400, { error: 'invalid-report' });
        const payloadHash = createHash('sha256').update(body.toString('utf8'), 'utf8').digest('hex');
        received.push({ reportId: parsed.reportId, bytes: body.length, sha256: payloadHash });
        reply(201, { schema: contract.ACK_SCHEMA, reportId: parsed.reportId, payloadHash, status: 'received' });
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    return {
      host: REPORT_HOST,
      path: REPORT_PATH,
      port,
      received,
      launchArgs: [`--host-resolver-rules=MAP ${REPORT_HOST} 127.0.0.1:${port}`, '--ignore-certificate-errors'],
      async close() {
        await new Promise((resolve) => server.close(() => resolve()));
        await fsp.rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) server.close();
    await fsp.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { startReportLoopback, REPORT_HOST, REPORT_PATH, MAX_BODY_BYTES };
