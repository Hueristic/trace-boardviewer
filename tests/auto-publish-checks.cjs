'use strict';

// Static checks of the automatic publication of a stable draft (windows.yml, draft-release job) and of its description in
// .github/rulesets/README.md. They read the workflow text and check the order of the steps and the guard of each step. They do not run
// the PowerShell (no Windows runner here); the run on a stable tag is the real proof.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'windows.yml'), 'utf8');
const rulesets = fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'README.md'), 'utf8');

const at = (text) => {
  const index = workflow.indexOf(text);
  assert.ok(index >= 0, `the workflow contains: ${text.slice(0, 70)}`);
  return index;
};

test('the draft is created first, then verified, then published: in this order', () => {
  const create = at("gh release create @traceArgs");
  const verify = at('- name: Verify the uploaded assets against their SHA-256 files (stable tags only)');
  const publish = at('- name: Publish the verified stable release (every job green, stable tags only)');
  assert.ok(create < verify && verify < publish, 'create, then verify, then publish');
  assert.equal(workflow.split('gh release create @traceArgs').length - 1, 1, 'one draft creation');
});

test('the verification runs only for stable tags and checks every asset of the release against its SHA-256 file', () => {
  const verify = workflow.slice(at('- name: Verify the uploaded assets against their SHA-256 files (stable tags only)'));
  const step = verify.slice(0, verify.indexOf('- name: Publish the verified stable release'));
  assert.match(step, /id: verify/);
  assert.match(step, /if: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && !contains\(github\.ref_name, '-'\) \}\}/, 'stable tags only');
  assert.match(step, /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/, 'the stable tag regex');
  assert.match(step, /gh release download \$env:TRACE_TAG/, 'the assets are downloaded from the draft');
  for (const suffix of ['.exe', '-linux-amd64.deb', '-linux-x86_64.AppImage', '-mac-arm64.zip']) {
    assert.ok(step.includes(suffix), `the asset ${suffix} is verified`);
  }
  assert.match(step, /Get-FileHash -LiteralPath \$traceFile -Algorithm SHA256/, 'the SHA-256 of the downloaded file is computed');
  assert.match(step, /SHA-256 mismatch after the upload[^"]*; the draft stays\./, 'a mismatch leaves the draft');
});

test('the publication runs only when the verification passed and the macOS job is green, and it makes the stable release the latest', () => {
  const publish = workflow.slice(at('- name: Publish the verified stable release (every job green, stable tags only)'));
  const step = publish.slice(0, publish.indexOf('\n\n') > 0 ? publish.indexOf('\n\n') : publish.length);
  assert.match(step, /if: \$\{\{ steps\.verify\.outcome == 'success' && needs\.mac\.result == 'success' \}\}/, 'the guard');
  assert.match(step, /gh release edit \$env:TRACE_TAG --repo \$env:GH_REPO --draft=false --latest/, 'the publication command');
  assert.equal(workflow.split('--draft=false').length - 1, 1, 'the only publication is this step');
});

test('the draft job still needs every job, so a failed build or a failed macOS job never publishes', () => {
  assert.match(workflow, /needs: \[build, portable-isolation, mac, linux\]/);
  assert.match(workflow, /needs\.build\.result == 'success' && needs\.portable-isolation\.result == 'success' && needs\.linux\.result == 'success'/);
});

test('the rulesets README describes the automatic stable publication, a draft on failure, and a pre-release that stays a draft', () => {
  assert.doesNotMatch(rulesets, /manual click by the owner/, 'the old sentence is gone');
  assert.match(rulesets, /publishes it automatically/);
  assert.match(rulesets, /every job is green/);
  assert.match(rulesets, /leaves the draft for manual review/);
  assert.match(rulesets, /pre-release tag[\s\S]*stays a draft/);
});
