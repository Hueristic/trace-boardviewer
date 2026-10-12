'use strict';

// Runs the device-database scenario (scripts/packaged-functional/library.cjs) against a packaged QA app.
//
//   TRACE_QA_APP=<path to the packaged QA executable> node scripts/packaged-functional-library.cjs
//
// The same command runs on Windows, Linux (WSL2) and macOS; only the executable path differs. The run sets TRACE_QA_DEVICE_DATABASE=1
// (electron/device-switch.cjs), so the QA build shows the Library while the release switch stays off. Everything the run creates
// (a fresh profile and the synthetic library) lives under the system temporary folder and is removed afterwards.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const scenario = require('./packaged-functional/library.cjs');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT = 120000;

/** The English catalogue is the source of the labels: a missing key fails the run before the app starts. */
function readEnglishLabels() {
  const catalogue = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'electron', 'locales', 'en', 'library.json'), 'utf8'));
  return scenario.labelsFrom(catalogue);
}

/** A fresh profile set to English: the settings file is the one the app reads at start. */
async function writeProfile(profile) {
  await fs.mkdir(profile, { recursive: true });
  const config = {
    version: 1,
    settings: { theme: 'light', layout: 'focus', motion: false, showLabels: false, showConnections: false, language: 'en' },
    recentBoards: [],
  };
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify(config));
}

/**
 * The native folder chooser answers with `folder` for the next showOpenDialog call of the main process. The override stays until the
 * request arrived; the restore is done in the main process, so the app's own dialog is back for the next step.
 */
function folderChooser(app) {
  return async (folder, action) => {
    const token = '__traceQaLibraryFolder';
    await app.evaluate(({ dialog }, { tokenName, value }) => {
      if (globalThis[tokenName]) throw new Error('a folder chooser is already active');
      const original = dialog.showOpenDialog;
      const state = { called: false };
      const replacement = async () => { state.called = true; return { canceled: false, filePaths: [value] }; };
      globalThis[tokenName] = { original, replacement, state };
      dialog.showOpenDialog = replacement;
    }, { tokenName: token, value: folder });
    let completed = false;
    try {
      await action();
      completed = true;
    } finally {
      if (completed) {
        for (let attempt = 0; attempt < 400; attempt++) {
          const requested = await app.evaluate((_electron, { tokenName }) => !!globalThis[tokenName]?.state.called, { tokenName: token });
          if (requested) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      await app.evaluate(({ dialog }, { tokenName }) => {
        const saved = globalThis[tokenName];
        if (saved) {
          if (dialog.showOpenDialog === saved.replacement) dialog.showOpenDialog = saved.original;
          delete globalThis[tokenName];
        }
      }, { tokenName: token });
    }
  };
}

async function run() {
  const executable = process.env.TRACE_QA_APP;
  if (!executable) throw new Error('set TRACE_QA_APP to the packaged QA executable (its path differs per platform)');
  if (!fsSync.existsSync(executable)) throw new Error(`the QA executable does not exist: ${path.basename(executable)}`);
  const labels = readEnglishLabels();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-library-e2e-'));
  const profile = path.join(workspace, 'profile');
  const root = path.join(workspace, 'library');
  const started = Date.now();
  let app = null;
  try {
    await writeProfile(profile);
    const expected = await scenario.buildSyntheticLibrary(root);
    console.log(`synthetic library: ${expected.folders} folders, ${expected.files} files`);
    app = await _electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${profile}`],
      env: { ...process.env, TRACE_QA_DEVICE_DATABASE: '1' },
      timeout: TIMEOUT,
    });
    const page = await app.firstWindow({ timeout: TIMEOUT });
    await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT });
    const result = await scenario.runScenario({
      page,
      labels,
      expected,
      root,
      chooseFolder: folderChooser(app),
      log: (message) => console.log(message),
    });
    const summary = { platform: process.platform, steps: result.steps, expected: result.expected, durationMs: Date.now() - started };
    console.log(`PASS ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    if (app) await app.close().catch(() => {});
    // Only the folder this run created, under the system temporary folder.
    if (workspace.startsWith(os.tmpdir())) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`FAIL ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ readEnglishLabels, writeProfile, run });
