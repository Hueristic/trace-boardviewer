'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { luminance, ssim, changed, parseArguments } = require('../scripts/board-render-perceptual.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'board-render-perceptual.cjs');

/** A deterministic RGBA image: a flat grey with a seeded pattern on top. */
function image(width, height, seed, pattern = true) {
  const rgba = Buffer.alloc(width * height * 4);
  let state = seed;
  for (let p = 0; p < width * height; p++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const value = pattern ? 96 + (state % 64) : 128;
    rgba[p * 4] = value; rgba[p * 4 + 1] = value; rgba[p * 4 + 2] = value; rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

test('luminance maps white to 255 and black to 0', () => {
  const white = luminance(Buffer.from([255, 255, 255, 255]));
  const black = luminance(Buffer.from([0, 0, 0, 255]));
  assert.equal(white[0], 255);
  assert.equal(black[0], 0);
});

test('an identical image has SSIM exactly 1 in every window', () => {
  const rgba = image(32, 24, 7);
  const l = luminance(rgba);
  const result = ssim(l, l, 32, 24);
  assert.equal(result.mean, 1);
  assert.equal(result.worst, 1);
  assert.ok(result.windows > 0);
});

test('a visible structural change lowers SSIM well below 1, while a uniform brightness shift of one level barely does', () => {
  const width = 32, height = 32;
  const base = luminance(image(width, height, 3));
  const other = luminance(image(width, height, 99));
  const shifted = base.map(value => value + 1);
  const structural = ssim(base, other, width, height);
  assert.ok(structural.mean < 0.5, `structural mean ${structural.mean}`);
  assert.ok(structural.worst < structural.mean);
  const brightness = ssim(base, shifted, width, height);
  assert.ok(brightness.mean > 0.999, `brightness mean ${brightness.mean}`);
});

test('changed counts changed pixels and those above the visible step, and the largest channel delta', () => {
  const a = Buffer.from([10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255]);
  const b = Buffer.from([10, 10, 10, 255, 11, 10, 10, 255, 30, 10, 10, 255]);
  assert.deepEqual(changed(a, b, 8), { changedPixels: 2, visiblePixels: 1, maxDelta: 20 });
});

test('parseArguments needs both folders and reads thresholds', () => {
  assert.throws(() => parseArguments(['--reference=a']), RangeError);
  const options = parseArguments(['--reference=a', '--candidate=b', '--identical=x,y', '--min-mean=0.99']);
  assert.equal(options.minMean, 0.99);
  assert.equal(options.minWindow, 0);
  assert.deepEqual([...options.identical], ['x', 'y']);
});

/** A capture folder in the qa-board-render layout: manifest.json and <tag>/<id>.<canvas>.rgba.gz. */
function writeCapture(dir, canvases, id) {
  fs.mkdirSync(path.join(dir, 'board'), { recursive: true });
  const manifest = { boards: [{ tag: 'board', captures: [{ id, canvases: {} }] }] };
  for (const [name, rgba] of Object.entries(canvases)) {
    fs.writeFileSync(path.join(dir, 'board', `${id}.${name}.rgba.gz`), zlib.gzipSync(rgba));
    manifest.boards[0].captures[0].canvases[name] = { width: 32, height: rgba.length / 4 / 32, sha256: require('node:crypto').createHash('sha256').update(rgba).digest('hex') };
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

test('end to end: a near-identical capture passes, an identical-required capture fails when it differs, and the exit code reports it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-perceptual-'));
  try {
    const reference = path.join(root, 'reference'), candidate = path.join(root, 'candidate');
    const base = image(32, 32, 5), tiny = Buffer.from(base);
    tiny[0] = Math.min(255, tiny[0] + 2); // one channel of one pixel moves by 2: changed, not visible
    writeCapture(reference, { base, overlay: image(32, 32, 9) }, 'fit');
    writeCapture(candidate, { base: tiny, overlay: image(32, 32, 9) }, 'fit');
    const passing = execFileSync(process.execPath, [SCRIPT, `--reference=${reference}`, `--candidate=${candidate}`], { encoding: 'utf8' });
    assert.match(passing, /PASS/);
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, `--reference=${reference}`, `--candidate=${candidate}`, '--identical=fit'], { encoding: 'utf8', stdio: 'pipe' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
