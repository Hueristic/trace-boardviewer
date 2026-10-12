'use strict';

// Contract checks of the device-database scenario (LIB-02): the steps, the labels, the count text, the synthetic library and the runner's
// refusals. No Electron is started here; the packaged run is scripts/packaged-functional-library.cjs with TRACE_QA_APP set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const scenario = require('../scripts/packaged-functional/library.cjs');
const runner = require('../scripts/packaged-functional-library.cjs');

const EN = require('../electron/locales/en/library.json');
const labels = scenario.labelsFrom(EN);

// A page that behaves like the Library panel for the scenario's steps: the texts it shows change with the clicks, and a wait fails when a
// text is not shown. Every click is recorded, so the order can be checked.
function fakePage({ showCounts = true, cancelReports = true } = {}) {
  const shown = new Set();
  const clicks = [];
  let scans = 0;
  const locator = (match, onClick) => {
    const api = {
      first: () => api,
      click: async () => { clicks.push(onClick ? onClick.name : String(match)); if (onClick) onClick.run(); },
      waitFor: async () => {
        const visible = [...shown].some((text) => (typeof match === 'string' ? match === text : match.test(text)));
        if (!visible) throw new Error(`not visible: ${String(match)}`);
      },
      allInnerTexts: async () => [...shown].filter((text) => /folders/.test(text)),
    };
    return api;
  };
  const click = (name, action) => ({ name, run: action });
  const page = {
    clicks,
    shown,
    getByRole(role, { name }) {
      const actions = {
        [labels.entry]: () => shown.add('testid:devices-view'),
        [labels.startScan]: () => {
          scans++;
          if (scans === 2) { shown.add(labels.runningScan); return; }
          shown.delete(labels.runningScan);
          shown.delete(labels.cancelledScan);
          shown.add(labels.doneScan);
          if (showCounts) shown.add(scenario.countsText(labels, scenario.expectedCounts()).replace('24000', '24,000'));
        },
        [labels.cancelScan]: () => {
          shown.delete(labels.runningScan);
          if (cancelReports) shown.add(labels.cancelledScan);
        },
        [labels.removeRoot]: () => { shown.clear(); shown.add(labels.emptyRoots); },
      };
      const action = actions[name];
      return locator(name, action ? click(name, action) : null);
    },
    getByTestId(id) {
      return locator(`testid:${id}`, null);
    },
    getByText(match) {
      return locator(match, null);
    },
  };
  // The fake root row: the basename appears once the folder chooser answers.
  page.addRoot = (name) => shown.add(name);
  return page;
}

const chooseFolderOn = (page) => async (folder, action) => {
  await action();
  page.addRoot(path.basename(folder));
};

test('the scenario runs its five steps in order against a panel that shows each result', async () => {
  const page = fakePage();
  const root = path.join(os.tmpdir(), 'trace-library-contract', 'library');
  const result = await scenario.runScenario({ page, labels, expected: scenario.expectedCounts(), root, chooseFolder: chooseFolderOn(page), log: () => {} });
  assert.deepEqual(result.steps, [...scenario.STEPS]);
  assert.deepEqual(result.expected, { folders: scenario.FOLDERS, files: scenario.FOLDERS * scenario.FILES_PER_FOLDER });
  const expectedClicks = [labels.entry, labels.addRoot, labels.startScan, labels.startScan, labels.cancelScan, labels.startScan, labels.removeRoot];
  assert.deepEqual(page.clicks, expectedClicks, 'the clicks follow the steps');
});

test('a panel that does not show the expected counts fails the result step and names what it shows', async () => {
  const page = fakePage({ showCounts: false });
  await assert.rejects(
    scenario.runScenario({ page, labels, expected: scenario.expectedCounts(), root: '/x/library', chooseFolder: chooseFolderOn(page), log: () => {} }),
    /does not show "60 folders, 24000 files"/,
  );
});

test('a panel that never reports a cancel fails the cancel step', async () => {
  const page = fakePage({ cancelReports: false });
  await assert.rejects(
    scenario.runScenario({ page, labels, expected: scenario.expectedCounts(), root: '/x/library', chooseFolder: chooseFolderOn(page), log: () => {} }),
    /not visible/,
  );
});

test('the count pattern accepts the grouped and the plain file count, and rejects a wrong folder or file count', () => {
  const pattern = scenario.countsPattern(labels, { folders: 60, files: 24000 });
  for (const text of ['60 folders, 24,000 files', '60 folders, 24 000 files', '60 folders, 24000 files']) assert.equal(pattern.test(text), true, text);
  for (const text of ['60 folders, 2,4000 files', '61 folders, 24,000 files', '60 folders, 24,000 files!', '60 folders, 23,999 files']) assert.equal(pattern.test(text), false, text);
  assert.equal(scenario.groupedDigits(1234567), '1[,.\\s\\u00a0\\u202f]?234[,.\\s\\u00a0\\u202f]?567');
});

test('every label the scenario uses exists in the English catalogue, and a missing one is refused', () => {
  for (const key of Object.values(scenario.LABEL_KEYS)) assert.equal(typeof EN[key], 'string', key);
  const without = { ...EN };
  delete without[scenario.LABEL_KEYS.cancelScan];
  assert.throws(() => scenario.labelsFrom(without), /lacks libraryDevices\.scan\.cancel/);
});

test('the synthetic library holds exactly the folders and files it reports, and is generated from names only', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-library-contract-'));
  try {
    const root = path.join(workspace, 'library');
    const counts = await scenario.buildSyntheticLibrary(root, { folders: 3, filesPerFolder: 4 });
    assert.deepEqual(counts, { folders: 3, files: 12 });
    const folders = (await fs.readdir(root)).sort();
    assert.deepEqual(folders, ['Synthetic-Board-000', 'Synthetic-Board-001', 'Synthetic-Board-002']);
    const files = await fs.readdir(path.join(root, folders[0]));
    assert.equal(files.length, 4);
    assert.ok(files.every((name) => /^MB-0-\d+\.brd$/.test(name)), 'the file names are generated here');
    await assert.rejects(scenario.buildSyntheticLibrary(root, { folders: 1 }), /EEXIST/, 'an existing root is never reused');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('the runner refuses to start without the packaged executable, and refuses a path that does not exist', async () => {
  const saved = process.env.TRACE_QA_APP;
  try {
    delete process.env.TRACE_QA_APP;
    await assert.rejects(runner.run(), /set TRACE_QA_APP/);
    process.env.TRACE_QA_APP = path.join(os.tmpdir(), 'trace-library-contract-missing', 'app.exe');
    await assert.rejects(runner.run(), /does not exist/);
  } finally {
    if (saved === undefined) delete process.env.TRACE_QA_APP; else process.env.TRACE_QA_APP = saved;
  }
});
