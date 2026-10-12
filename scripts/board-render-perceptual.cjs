'use strict';

/*
 * Perceptual comparison of two board canvas captures (qa-board-render.cjs --out=<dir> output): structural similarity (SSIM) per
 * canvas, plus the count of pixels whose colour moved by more than a visible step. Byte equality is reported too, so a capture that must
 * stay identical (a close zoom) is checked exactly.
 *
 *   node scripts/board-render-perceptual.cjs --reference=<dir> --candidate=<dir> [--out=<file.json>]
 *       [--identical=<capture ids, comma separated>] [--min-mean=0.98] [--min-window=<off>] [--visible-step=8]
 *
 * SSIM uses the usual constants (luminance 0-255, K1 0.01, K2 0.03) on 8 x 8 windows every 4 pixels. Each canvas is gated on its mean SSIM.
 * The worst window is reported, and gated only when --min-window is given: a window of near-flat background has a near-zero SSIM when one
 * pixel changes, so the worst window says little about what a viewer sees. A capture named in --identical must match byte for byte on both canvases. Exit code 1 when a canvas fails.
 * Captures are read in place; the output holds numbers and capture ids only.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const WINDOW = 8, STEP = 4;
const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;

function parseArguments(argv) {
  const value = name => { const hit = argv.find(item => item.startsWith(`--${name}=`)); return hit === undefined ? undefined : hit.slice(name.length + 3); };
  const reference = value('reference'), candidate = value('candidate');
  if (!reference || !candidate) throw new RangeError('Give --reference=<dir> and --candidate=<dir> (qa-board-render.cjs output folders).');
  const number = (name, fallback) => {
    const text = value(name);
    if (text === undefined) return fallback;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new RangeError(`--${name} must be a number.`);
    return parsed;
  };
  return {
    reference: path.resolve(reference), candidate: path.resolve(candidate),
    out: value('out') ? path.resolve(value('out')) : null,
    identical: new Set((value('identical') ?? '').split(',').map(item => item.trim()).filter(Boolean)),
    minMean: number('min-mean', 0.98), minWindow: number('min-window', 0), visibleStep: number('visible-step', 8),
  };
}

/** Luminance (0-255) of an RGBA buffer, one value per pixel. */
function luminance(rgba) {
  const count = rgba.length / 4;
  const out = new Float32Array(count);
  for (let p = 0, i = 0; p < count; p++, i += 4) out[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return out;
}

/** Mean SSIM over the windows, and the worst window. A window is WINDOW x WINDOW pixels, the next one starts STEP pixels further. */
function ssim(a, b, width, height) {
  let total = 0, count = 0, worst = Infinity;
  for (let y0 = 0; y0 + WINDOW <= height; y0 += STEP) for (let x0 = 0; x0 + WINDOW <= width; x0 += STEP) {
    let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
    for (let y = y0; y < y0 + WINDOW; y++) for (let x = x0; x < x0 + WINDOW; x++) {
      const p = y * width + x;
      const va = a[p], vb = b[p];
      sumA += va; sumB += vb; sumAA += va * va; sumBB += vb * vb; sumAB += va * vb;
    }
    const n = WINDOW * WINDOW;
    const meanA = sumA / n, meanB = sumB / n;
    const varA = sumAA / n - meanA * meanA, varB = sumBB / n - meanB * meanB, cov = sumAB / n - meanA * meanB;
    const value = ((2 * meanA * meanB + C1) * (2 * cov + C2)) / ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
    total += value; count++;
    if (value < worst) worst = value;
  }
  return { mean: count ? total / count : 1, worst: count ? worst : 1, windows: count };
}

/** Pixels that changed at all, and those that moved by more than `visibleStep` on some channel. */
function changed(a, b, visibleStep) {
  let changedPixels = 0, visiblePixels = 0, maxDelta = 0;
  for (let i = 0; i < a.length; i += 4) {
    const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (!delta) continue;
    changedPixels++;
    if (delta > visibleStep) visiblePixels++;
    if (delta > maxDelta) maxDelta = delta;
  }
  return { changedPixels, visiblePixels, maxDelta };
}

function readRgba(file) { return zlib.gunzipSync(fs.readFileSync(file)); }

function compare(options) {
  const reference = JSON.parse(fs.readFileSync(path.join(options.reference, 'manifest.json'), 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(path.join(options.candidate, 'manifest.json'), 'utf8'));
  const result = { reference: options.reference, candidate: options.candidate, thresholds: { minMean: options.minMean, minWindow: options.minWindow, visibleStep: options.visibleStep }, canvases: [], missing: [], failures: [] };
  for (const board of candidate.boards) {
    const other = reference.boards.find(item => item.tag === board.tag);
    if (!other) { result.missing.push(board.tag); continue; }
    for (const capture of board.captures) {
      const previous = other.captures.find(item => item.id === capture.id);
      if (!previous) { result.missing.push(`${board.tag}/${capture.id}`); continue; }
      for (const name of ['base', 'overlay']) {
        const label = `${board.tag}/${capture.id}/${name}`;
        const exactRequired = options.identical.has(capture.id);
        const entry = { capture: `${board.tag}/${capture.id}`, canvas: name, identical: previous.canvases[name].sha256 === capture.canvases[name].sha256, exactRequired };
        if (!entry.identical) {
          const width = capture.canvases[name].width;
          const a = readRgba(path.join(options.reference, board.tag, `${capture.id}.${name}.rgba.gz`));
          const b = readRgba(path.join(options.candidate, board.tag, `${capture.id}.${name}.rgba.gz`));
          const height = a.length / 4 / width;
          Object.assign(entry, changed(a, b, options.visibleStep), { sizeDiffers: a.length !== b.length });
          const { mean, worst, windows } = ssim(luminance(a), luminance(b), width, height);
          Object.assign(entry, { ssimMean: mean, ssimWorst: worst, windows });
        } else Object.assign(entry, { ssimMean: 1, ssimWorst: 1, changedPixels: 0, visiblePixels: 0, maxDelta: 0 });
        const failed = [];
        if (exactRequired && !entry.identical) failed.push('not byte-identical');
        if (entry.ssimMean < options.minMean) failed.push(`mean SSIM ${entry.ssimMean.toFixed(4)} < ${options.minMean}`);
        if (entry.ssimWorst < options.minWindow) failed.push(`worst window ${entry.ssimWorst.toFixed(4)} < ${options.minWindow}`);
        entry.failed = failed;
        if (failed.length) result.failures.push(`${label}: ${failed.join('; ')}`);
        result.canvases.push(entry);
      }
    }
  }
  result.summary = {
    canvases: result.canvases.length,
    identical: result.canvases.filter(item => item.identical).length,
    exactRequiredChecked: result.canvases.filter(item => item.exactRequired).length,
    minMeanSsim: Math.min(...result.canvases.map(item => item.ssimMean)),
    minWorstSsim: Math.min(...result.canvases.map(item => item.ssimWorst)),
  };
  return result;
}

function main(argv) {
  const options = parseArguments(argv);
  const result = compare(options);
  if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  const s = result.summary;
  console.log(`canvases ${s.canvases}, identical ${s.identical}, exact-required ${s.exactRequiredChecked}, min mean SSIM ${s.minMeanSsim.toFixed(4)}, min worst window ${s.minWorstSsim.toFixed(4)}, missing ${result.missing.length}`);
  for (const failure of result.failures) console.log(`FAIL ${failure}`);
  const ok = result.failures.length === 0 && result.missing.length === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  return ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof RangeError ? error.message : error); process.exitCode = 2; }
}

module.exports = { luminance, ssim, changed, parseArguments };
