/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * PDF.js static resources (CMaps, standard fonts, wasm decoders, ICC profiles) are shipped with the app and
 * resolved by `src/lib/pdf/worker.ts` relative to index.html, so a document never triggers a network request.
 * Build: emitted as `pdfjs/<folder>/<file>` next to index.html. Dev server: served from node_modules under /pdfjs/.
 */
const PDFJS_FOLDERS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;
function pdfjsAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  // The scripting sandbox engine is never loaded (document JavaScript is not supported), so it is not shipped either.
  const EXCLUDED = new Set(['quickjs-eval.js', 'quickjs-eval.wasm']);
  const files = (folder: string): string[] => readdirSync(path.join(root, folder), { withFileTypes: true }).filter(entry => entry.isFile() && !EXCLUDED.has(entry.name)).map(entry => entry.name);
  return {
    name: 'trace-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (request, response, next) => {
        const [folder, name, ...rest] = decodeURIComponent((request.url ?? '').split('?')[0]).replace(/^\/+/, '').split('/');
        if (rest.length || !name || !(PDFJS_FOLDERS as readonly string[]).includes(folder) || !files(folder).includes(name)) { next(); return; }
        const target = path.join(root, folder, name);
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.setHeader('Content-Length', String(statSync(target).size));
        response.end(readFileSync(target));
      });
    },
    generateBundle() {
      for (const folder of PDFJS_FOLDERS) {
        for (const name of files(folder)) this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${name}`, source: readFileSync(path.join(root, folder, name)) });
      }
    },
  };
}

/** The dev-server websocket (`ws://127.0.0.1:5173`) is listed in index.html's CSP only for `vite dev`; a production build has no dev server, so the entry is removed from the shipped page (W-win-build-05). */
const DEV_WS_CSP_ENTRY = ' ws://127.0.0.1:5173';
export function stripDevServerCsp(html: string): string {
  return html.replace(DEV_WS_CSP_ENTRY, '');
}
function productionCsp(): Plugin {
  return { name: 'trace-production-csp', apply: 'build', transformIndexHtml: { order: 'post', handler: html => stripDevServerCsp(html) } };
}

/**
 * The commit the renderer is built from, as a meta tag of the shipped index.html. The packaging scripts read it back from the packaged
 * app.asar and stop when it is not the HEAD they package. TRACE_BUILD_COMMIT overrides it for a build made outside a git checkout.
 */
function gitShortHead(): string {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; }
}
function buildCommitMeta(): Plugin {
  const commit = process.env.TRACE_BUILD_COMMIT || gitShortHead();
  return {
    name: 'trace-build-commit',
    apply: 'build',
    transformIndexHtml: { order: 'post', handler: html => html.replace('<head>', `<head>\n  <meta name="trace-build-commit" content="${commit}" />`) },
  };
}

/** Records the fingerprint of the sources this bundle is built from (dist/build-stamp.txt); scripts/before-pack.cjs checks it before packing. */
function buildStamp(): Plugin {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const { writeBuildStamp } = createRequire(import.meta.url)('./scripts/dist-freshness.cjs') as { writeBuildStamp: (root: string) => string };
  return { name: 'trace-build-stamp', apply: 'build', closeBundle() { writeBuildStamp(root); } };
}

export default defineConfig({
  base: './',
  plugins: [pdfjsAssets(), productionCsp(), buildCommitMeta(), buildStamp()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'chrome140', sourcemap: false, assetsInlineLimit: 0 },
  // A test that parses a large input takes seconds on a busy machine; the default 5 s limit then fails a correct run. Timing is asserted
  // relative to a reference (src/test-support/timing.ts), so the limit only has to end a test that never returns.
  test: { testTimeout: 120_000, hookTimeout: 120_000 },
});
