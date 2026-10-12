'use strict';

// Writes cst-02-synthetic.cst: a synthetic CAST (CST) boardview with two components (one on each layer the parser accepts, 0x0c top
// and 0x01 bottom), three nets and four test pads. It is built only from the layout that src/lib/formats/cst.ts documents, so it is
// free of any licence and contains no content of an owner or third-party file. The bytes are fixed: the test pins their SHA-256.
// Usage: node tests/fixtures/cst/make-cst-02.cjs

const fs = require('node:fs');
const path = require('node:path');

const TOP = 0x0c;
const BOTTOM = 0x01;
const PARTS = ['U1', 'U2'];
const PART_LAYERS = [TOP, BOTTOM];
const NETS = ['GND', 'VCC', 'SIG'];
// [part index, net index, x (mils), y (mils)] per test pad, in file order
const PINS = [[0, 0, 100, 200], [0, 1, -50, 25], [1, 2, 300, -40], [1, 0, 0, 0]];

// `partLayers` other than the accepted pair builds a variant the parser refuses (layer 0x08 is UNSUPPORTED_VARIANT): the Mac check
// uses it for a refused sample.
function build({ partLayers = PART_LAYERS } = {}) {
  const data = [];
  const u16 = (value) => data.push(value & 255, (value >>> 8) & 255);
  const text = (value) => data.push(...Buffer.from(value, 'utf8'));
  u16(PARTS.length); data.push(0, 0, 0, 0); u16(4); text('CDev');
  PARTS.forEach((ref, index) => {
    data.push(ref.length); text(ref); data.push(0, 0, 0, 0, partLayers[index], 0, 0, 0, 0);
    u16(index === PARTS.length - 1 ? NETS.length : 0);
  });
  for (const net of NETS) { data.push(net.length); text(net); }
  u16(PINS.length); data.push(0, 0, 0, 0); u16(4); text('CPad');
  PINS.forEach(([part, net, x, y], index) => { u16(part); u16(index + 1); u16(net); u16(x); u16(y); u16(0); data.push(0, 0, 0, 0); });
  return Uint8Array.from(data);
}

if (require.main === module) {
  const target = path.join(__dirname, 'cst-02-synthetic.cst');
  fs.writeFileSync(target, build());
  console.log(`wrote ${target}`);
}

module.exports = Object.freeze({ build });
