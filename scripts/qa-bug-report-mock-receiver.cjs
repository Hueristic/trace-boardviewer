'use strict';

// QA-only localhost mock of the bug report receiver. It speaks the receiver contract (shared/bug-report-contract.cjs): one POST to
// /v1/reports with canonical JSON, answered with the acknowledgement that the app checks against the payload hash. It listens on
// loopback only, over https only, and needs a key and certificate that the QA run creates outside the repository. Nothing here is
// shipped: the release build keeps the fixed receiver endpoint (electron/bug-reports.cjs resolveEndpoint).

const crypto = require('node:crypto');
const https = require('node:https');
const contract = require('../shared/bug-report-contract.cjs');

const REPORT_PATH = '/v1/reports';
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const reply = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * The receiver logic without any socket, so the same rules can be tested in-process. `received` keeps only identifiers, hashes and
 * byte counts for QA inspection, never the report text.
 */
function createMockReceiver() {
  const hashes = new Map();
  const received = [];
  function handle({ method, path, body }) {
    if (path !== REPORT_PATH) return reply(404, { error: 'not_found' });
    if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
    if (Buffer.byteLength(text, 'utf8') > contract.MAX_BYTES) return reply(413, { error: 'too_large' });
    let value;
    try { value = JSON.parse(text); } catch { return reply(400, { error: 'invalid_json' }); }
    const checked = contract.validateBugReport(value);
    if (!checked.ok) return reply(400, { error: 'invalid_report' });
    if (contract.canonicalizeBugReport(checked.value) !== text) return reply(400, { error: 'not_canonical' });
    const payloadHash = sha256(text);
    const previous = hashes.get(value.reportId);
    if (previous !== undefined && previous !== payloadHash) return reply(409, { error: 'conflict' });
    if (previous === undefined) {
      hashes.set(value.reportId, payloadHash);
      received.push({ reportId: value.reportId, payloadHash, bytes: Buffer.byteLength(text, 'utf8') });
    }
    return reply(201, { schema: contract.ACK_SCHEMA, reportId: value.reportId, payloadHash, status: 'received' });
  }
  return Object.freeze({ handle, received });
}

/** The https server on loopback. The caller supplies the key and certificate PEM text; a non-loopback host is refused. */
function createLoopbackServer({ receiver = createMockReceiver(), host = '127.0.0.1', key, cert } = {}) {
  if (!LOOPBACK_HOSTS.includes(host)) throw new TypeError('The mock receiver listens on loopback only.');
  if (!key || !cert) throw new TypeError('The mock receiver needs a QA key and certificate; it is never shipped.');
  return https.createServer({ key, cert }, (request, response) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > contract.MAX_BYTES) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const result = tooLarge
        ? reply(413, { error: 'too_large' })
        : receiver.handle({ method: request.method, path: new URL(request.url, 'https://127.0.0.1').pathname, body: Buffer.concat(chunks) });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    });
  });
}

module.exports = Object.freeze({ REPORT_PATH, LOOPBACK_HOSTS, createMockReceiver, createLoopbackServer });

// Usage (QA only): node scripts/qa-bug-report-mock-receiver.cjs --port 8443 --key <key.pem> --cert <cert.pem>
if (require.main === module) {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const port = Number(option('--port'));
  const keyPath = option('--key');
  const certPath = option('--cert');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !keyPath || !certPath) {
    console.error('usage: node scripts/qa-bug-report-mock-receiver.cjs --port <1-65535> --key <key.pem> --cert <cert.pem>');
    process.exit(2);
  }
  const server = createLoopbackServer({ key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') });
  server.listen(port, '127.0.0.1', () => {
    console.log(`QA mock receiver listening on https://127.0.0.1:${port}${REPORT_PATH}`);
  });
}
