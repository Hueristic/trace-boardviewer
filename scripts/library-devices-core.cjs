/* Builds the main-process CommonJS bundle of the device catalogue and correction codec (electron/library/devices-core.cjs).
   Usage: node scripts/library-devices-core.cjs           (write the bundle)
          node scripts/library-devices-core.cjs --check   (fail when the committed bundle is stale) */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src/lib/library/devices/main-entry.ts');
const target = path.join(root, 'electron/library/devices-core.cjs');
const HEADER = '/* Generated from src/lib/library/devices/main-entry.ts by scripts/library-devices-core.cjs. Do not edit. */\n';

async function bundle(outDir) {
  const { build } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      target: 'node22',
      lib: { entry, formats: ['cjs'], fileName: () => 'devices-core.cjs' },
      rollupOptions: { output: { exports: 'named' } },
    },
  });
  return HEADER + fs.readFileSync(path.join(outDir, 'devices-core.cjs'), 'utf8');
}

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-devices-core-'));
  try {
    const output = await bundle(outDir);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) {
        process.stderr.write('Device catalogue main-process bundle is stale. Run: node scripts/library-devices-core.cjs\n');
        process.exitCode = 1;
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, output);
      process.stdout.write(`wrote ${path.relative(root, target)} (${output.length} bytes)\n`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
