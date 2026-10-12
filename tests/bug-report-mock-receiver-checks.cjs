'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('../shared/bug-report-contract.cjs');
const mock = require('../scripts/qa-bug-report-mock-receiver.cjs');
const { createBugReportService, qaCertificateVerifier, fingerprintHex, QA_FINGERPRINT_ENV, QA_ENDPOINT_ENV } = require('../electron/bug-reports.cjs');
const { createElectronFetch } = require('../electron/net/egress.cjs');

const WORKERS_ENDPOINT = 'https://trace-bug-report.trace-boardviewer.workers.dev/v1/reports';
const OVERRIDE = 'https://127.0.0.1:8443/v1/reports';
const REPORT_ID = '00000000-0000-4000-8000-000000000001';
const PIN_HEX = crypto.createHash('sha256').update('synthetic QA certificate').digest('hex');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const canonical = (description = 'Synthetic mock report.') => contract.canonicalizeBugReport({
  schema: contract.SCHEMA, reportId: REPORT_ID, description, diagnostics: null,
});
const post = (body, receiver) => receiver.handle({ method: 'POST', path: mock.REPORT_PATH, body });

function memoryStore() {
  const files = new Map();
  return {
    files,
    async read(name) { return files.has(name) ? structuredClone(files.get(name)) : null; },
    async update(name, updater, options) {
      const next = await updater(files.has(name) ? structuredClone(files.get(name)) : null);
      assert.ok(Buffer.byteLength(JSON.stringify(next)) <= options.maxBytes);
      files.set(name, structuredClone(next));
      return structuredClone(next);
    },
    async flush() {},
  };
}

test('the mock accepts the canonical report and answers the acknowledgement the app checks against the payload hash', () => {
  const receiver = mock.createMockReceiver();
  const text = canonical();
  const result = post(text, receiver);
  assert.equal(result.status, 201);
  assert.equal(contract.isValidAcknowledgement(JSON.parse(result.body), REPORT_ID, sha256(text)), true);
  assert.deepEqual(receiver.received, [{ reportId: REPORT_ID, payloadHash: sha256(text), bytes: Buffer.byteLength(text, 'utf8') }],
    'the QA record keeps identifiers and sizes, never the report text');
});

test('a body that is not the canonical report, is invalid, or breaks the transport rules gets no acknowledgement', () => {
  const receiver = mock.createMockReceiver();
  const text = canonical();
  assert.deepEqual(JSON.parse(post(JSON.stringify(JSON.parse(text), null, 1), receiver).body), { error: 'not_canonical' });
  assert.equal(post(JSON.stringify({ schema: contract.SCHEMA, reportId: REPORT_ID, description: '', diagnostics: null }), receiver).status, 400);
  assert.equal(post('not json', receiver).status, 400);
  assert.equal(post('x'.repeat(contract.MAX_BYTES + 1), receiver).status, 413);
  assert.equal(receiver.handle({ method: 'GET', path: mock.REPORT_PATH, body: '' }).status, 405);
  assert.equal(receiver.handle({ method: 'POST', path: '/other', body: text }).status, 404);
  assert.deepEqual(receiver.received, [], 'nothing refused is recorded as received');
});

test('the same report sent again is acknowledged again, while a different body under the same identifier is a conflict', () => {
  const receiver = mock.createMockReceiver();
  assert.equal(post(canonical(), receiver).status, 201);
  assert.equal(post(canonical(), receiver).status, 201, 'a retry of the same bytes is acknowledged again');
  assert.equal(post(canonical('Synthetic changed text.'), receiver).status, 409);
  assert.equal(receiver.received.length, 1);
});

test('the mock listens on loopback only and needs a QA key and certificate; nothing is shipped with keys', () => {
  assert.throws(() => mock.createLoopbackServer({ host: '0.0.0.0', key: 'k', cert: 'c' }), /loopback only/);
  assert.throws(() => mock.createLoopbackServer({}), /QA key and certificate/);
});

test('a send through the service reaches the mock in-process and ends received, with no network', async () => {
  const receiver = mock.createMockReceiver();
  const egress = {
    request: async (_feature, url, options) => {
      const result = receiver.handle({ method: options.method, path: new URL(url).pathname, body: options.body });
      return { ok: true, status: result.status, headers: {}, body: Buffer.from(result.body, 'utf8') };
    },
  };
  const service = createBugReportService({
    store: memoryStore(), egress, getVersion: () => '1.3.3', platform: 'linux', arch: 'x64', locale: () => 'en',
    config: { enabled: true, endpoint: WORKERS_ENDPOINT },
  });
  const preview = await service.prepare({ description: 'Synthetic in-process send.', includeDiagnostics: false, context: null });
  assert.equal(preview.status, 'prepared');
  assert.equal((await service.send({ prepareId: preview.prepareId })).status, 'received');
  assert.equal(receiver.received.length, 1);
  assert.equal(receiver.received[0].reportId, preview.report.reportId);
});

test('a live TLS round trip over loopback works when openssl makes the QA certificate (skipped without openssl)', async (t) => {
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('openssl is not available on this host'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-qa-mock-'));
  try {
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem',
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { cwd: dir });
    assert.equal(made.status, 0, String(made.stderr));
    const key = await fs.readFile(path.join(dir, 'key.pem'), 'utf8');
    const cert = await fs.readFile(path.join(dir, 'cert.pem'), 'utf8');
    const server = mock.createLoopbackServer({ key, cert });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const text = canonical();
    const status = await new Promise((resolve, reject) => {
      const request = https.request({ host: '127.0.0.1', port, path: mock.REPORT_PATH, method: 'POST', ca: cert,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end(text);
    });
    await new Promise((resolve) => server.close(resolve));
    assert.equal(status.status, 201);
    assert.equal(contract.isValidAcknowledgement(JSON.parse(status.body), REPORT_ID, sha256(text)), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the QA certificate policy accepts only the pinned certificate for the loopback override host, in the QA flavour', () => {
  const env = { [QA_ENDPOINT_ENV]: OVERRIDE, [QA_FINGERPRINT_ENV]: PIN_HEX };
  const verifier = qaCertificateVerifier({ flavour: 'qa', env });
  assert.equal(typeof verifier, 'function');
  const base64Pin = `sha256/${Buffer.from(PIN_HEX, 'hex').toString('base64')}`;
  const colonPin = PIN_HEX.match(/../g).join(':').toUpperCase();
  const decide = (request) => { let result; verifier(request, (value) => { result = value; }); return result; };
  assert.equal(decide({ hostname: '127.0.0.1', certificate: { fingerprint: base64Pin } }), 0);
  assert.equal(decide({ hostname: '127.0.0.1', certificate: { fingerprint: colonPin } }), 0);
  assert.equal(decide({ hostname: '127.0.0.1', certificate: { fingerprint: `sha256/${Buffer.alloc(32, 1).toString('base64')}` } }), -3, 'another certificate keeps the default');
  assert.equal(decide({ hostname: 'example.test', certificate: { fingerprint: base64Pin } }), -3, 'another host keeps the default');
  assert.equal(decide({ hostname: '127.0.0.1', certificate: {} }), -3, 'a certificate without a fingerprint keeps the default');
});

test('the certificate policy does not exist in the release, without an override, without a pin, or for a non-loopback override', () => {
  const env = { [QA_ENDPOINT_ENV]: OVERRIDE, [QA_FINGERPRINT_ENV]: PIN_HEX };
  assert.equal(qaCertificateVerifier({ flavour: undefined, env }), null, 'the release has no verifier');
  assert.equal(qaCertificateVerifier({ flavour: 'release', env }), null);
  assert.equal(qaCertificateVerifier({ flavour: 'qa', env: { [QA_FINGERPRINT_ENV]: PIN_HEX } }), null, 'no override, no policy');
  assert.equal(qaCertificateVerifier({ flavour: 'qa', env: { [QA_ENDPOINT_ENV]: OVERRIDE } }), null, 'no pin, no policy');
  assert.equal(qaCertificateVerifier({ flavour: 'qa', env: { [QA_ENDPOINT_ENV]: 'https://example.test:8443/v1/reports', [QA_FINGERPRINT_ENV]: PIN_HEX } }), null);
  assert.equal(qaCertificateVerifier({ flavour: 'qa', env: { [QA_ENDPOINT_ENV]: OVERRIDE, [QA_FINGERPRINT_ENV]: 'not a fingerprint' } }), null);
});

test('fingerprints are read in the hex form openssl prints, in the colon form, and in Electron base64 form', () => {
  assert.equal(fingerprintHex(PIN_HEX), PIN_HEX);
  assert.equal(fingerprintHex(PIN_HEX.match(/../g).join(':')), PIN_HEX);
  assert.equal(fingerprintHex(`sha256/${Buffer.from(PIN_HEX, 'hex').toString('base64')}`), PIN_HEX);
  assert.equal(fingerprintHex('short'), null);
  assert.equal(fingerprintHex(undefined), null);
});

test('the egress transport sets the QA verifier on its partition, and sets nothing when there is none', async () => {
  const verifier = () => {};
  const bare = { fetch: async () => 'ok' };
  await assert.doesNotReject(createElectronFetch({ session: { fromPartition: () => bare }, isAllowed: () => true, certificateVerifier: verifier })(
    'https://127.0.0.1:8443/v1/reports', {}), 'a partition without a verifier setter is tolerated');

  const recording = { calls: [], fetch: async () => 'ok', setCertificateVerifyProc(proc) { this.calls.push(proc); } };
  await createElectronFetch({ session: { fromPartition: () => recording }, isAllowed: () => true, certificateVerifier: verifier })('https://127.0.0.1:8443/v1/reports', {});
  assert.deepEqual(recording.calls, [verifier]);

  const release = { calls: [], fetch: async () => 'ok', setCertificateVerifyProc(proc) { this.calls.push(proc); } };
  await createElectronFetch({ session: { fromPartition: () => release }, isAllowed: () => true })('https://trace-bug-report.trace-boardviewer.workers.dev/v1/reports', {});
  assert.deepEqual(release.calls, [], 'the release passes no verifier and leaves the default certificate check alone');
});
