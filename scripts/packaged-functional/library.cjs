'use strict';

// The device-database scenario of the packaged QA app (LIB-02, TB-036): add a root, scan, cancel a scan, read the result, remove the
// root. The same steps run on Windows, Linux (WSL2) and macOS; only the path of the packaged executable differs (the runner takes it
// from the environment). The module itself has no Playwright or Electron import: the runner passes the page and the native helpers in.

const fs = require('node:fs/promises');
const path = require('node:path');

// A flat synthetic library: FOLDERS folders under the root, FILES_PER_FOLDER small board files in each. Every name is generated here;
// no file of the private test sample set is read or copied.
const FOLDERS = 60;
const FILES_PER_FOLDER = 400;
const WRITE_BATCH = 500;

/** The expected counts of the synthetic library: the root shows these folders and files once fully scanned. */
function expectedCounts({ folders = FOLDERS, filesPerFolder = FILES_PER_FOLDER } = {}) {
  return { folders, files: folders * filesPerFolder };
}

/** Writes the synthetic library under `root` (which must not exist yet) and returns its expected counts. */
async function buildSyntheticLibrary(root, options = {}) {
  const { folders, filesPerFolder } = { folders: FOLDERS, filesPerFolder: FILES_PER_FOLDER, ...options };
  await fs.mkdir(root, { recursive: false });
  const body = Buffer.from('$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n', 'utf8');
  for (let folder = 0; folder < folders; folder++) {
    const directory = path.join(root, `Synthetic-Board-${String(folder).padStart(3, '0')}`);
    await fs.mkdir(directory);
    const names = [];
    for (let file = 0; file < filesPerFolder; file++) names.push(path.join(directory, `MB-${folder}-${file}.brd`));
    for (let start = 0; start < names.length; start += WRITE_BATCH) {
      await Promise.all(names.slice(start, start + WRITE_BATCH).map((name) => fs.writeFile(name, body)));
    }
  }
  return expectedCounts({ folders, filesPerFolder });
}

// The labels the scenario clicks and waits for. They are read from the English catalogue at run time, so a changed wording fails the
// run in one place (electron/locales/en/library.json) instead of silently matching nothing.
const LABEL_KEYS = Object.freeze({
  entry: 'libraryDevices.title',
  addRoot: 'libraryDevices.roots.add',
  removeRoot: 'libraryDevices.roots.remove',
  emptyRoots: 'libraryDevices.roots.empty',
  startScan: 'libraryDevices.scan.start',
  cancelScan: 'libraryDevices.scan.cancel',
  runningScan: 'libraryDevices.scan.running',
  doneScan: 'libraryDevices.scan.done',
  cancelledScan: 'libraryDevices.scan.cancelled',
  treeCounts: 'libraryDevices.tree.counts',
});

/** The English text of each label key; throws when a key is missing from the catalogue. */
function labelsFrom(catalogue) {
  const out = {};
  for (const [name, key] of Object.entries(LABEL_KEYS)) {
    if (typeof catalogue[key] !== 'string' || catalogue[key].length === 0) throw new Error(`the English catalogue lacks ${key}`);
    out[name] = catalogue[key];
  }
  return Object.freeze(out);
}

/** The root row text the view shows once the root is scanned, from the same counts (the placeholders are filled in). */
function countsText(labels, expected) {
  return labels.treeCounts.replace('{folders}', String(expected.folders)).replace('{files}', String(expected.files));
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The file count is shown with group separators ("24,000"); any separator is accepted, the digits are exact.
// Group boundaries are the positions with a multiple of three digits to their right ("24,000"). The separator is optional, the digits
// are exact: "24,000", "24 000" and "24000" match, "2,4000" does not.
const groupedDigits = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u0000').split('\u0000').join('[,.\\s\\u00a0\\u202f]?');

/** The same text as countsText, with the file count matched through any group separator. */
function countsPattern(labels, expected) {
  const body = labels.treeCounts.split(/(\{folders\}|\{files\})/).map((part) => {
    if (part === '{folders}') return escapeRegExp(String(expected.folders));
    if (part === '{files}') return groupedDigits(expected.files);
    return escapeRegExp(part);
  }).join('');
  return new RegExp(`^${body}$`);
}

/** The steps in order. Each name is the step the runner reports; the runner refuses a scenario that skips one. */
const STEPS = Object.freeze(['add a root', 'scan the root', 'cancel a scan', 'scan again and read the result', 'remove the root']);

/** The support notice may cover the window after a start: it is dismissed with its "not now" control when it shows, and left alone otherwise. */
async function dismissSupportNotice(page) {
  const notice = page.getByTestId('support-notice');
  const appeared = await notice.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
  if (appeared) await page.getByTestId('support-not-now').click();
  await notice.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

/**
 * Runs the scenario. `ctx` supplies: page (Playwright), labels, expected, chooseFolder(path, action) (the native folder chooser answers
 * with `path`), and log(step). Every step asserts what the view shows; a mismatch throws with the step name.
 */
async function runScenario(ctx) {
  const { page, labels, expected, root, chooseFolder, log } = ctx;
  const done = [];
  const step = async (name, action) => {
    log(`step: ${name}`);
    await action();
    done.push(name);
  };
  await dismissSupportNotice(page);
  await step('add a root', async () => {
    await page.getByRole('button', { name: labels.entry, exact: true }).click();
    await page.getByTestId('devices-view').waitFor({ state: 'visible', timeout: 30000 });
    await chooseFolder(root, () => page.getByRole('button', { name: labels.addRoot, exact: true }).click());
    await page.getByText(path.basename(root), { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  });
  await step('scan the root', async () => {
    await page.getByRole('button', { name: labels.startScan, exact: true }).click();
    await page.getByText(labels.doneScan, { exact: true }).waitFor({ state: 'visible', timeout: 300000 });
  });
  await step('cancel a scan', async () => {
    await page.getByRole('button', { name: labels.startScan, exact: true }).click();
    await page.getByText(labels.runningScan, { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
    await page.getByRole('button', { name: labels.cancelScan, exact: true }).click();
    await page.getByText(labels.cancelledScan, { exact: true }).waitFor({ state: 'visible', timeout: 120000 });
    // Results found so far stay listed: the root is still in the list after a cancel.
    await page.getByText(path.basename(root), { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  });
  await step('scan again and read the result', async () => {
    await page.getByRole('button', { name: labels.startScan, exact: true }).click();
    await page.getByText(labels.doneScan, { exact: true }).waitFor({ state: 'visible', timeout: 300000 });
    const counts = countsText(labels, expected);
    await page.getByText(countsPattern(labels, expected)).first().waitFor({ state: 'visible', timeout: 60000 }).catch(async () => {
      // A mismatch names what the view shows, so the expected text or the count can be checked by hand.
      const shown = await page.getByText(/folders/).allInnerTexts().catch(() => []);
      throw new Error(`the root does not show "${counts}" (grouped digits allowed); the view shows ${JSON.stringify(shown.slice(0, 8))}`);
    });
  });
  await step('remove the root', async () => {
    await page.getByRole('button', { name: labels.removeRoot, exact: true }).first().click();
    await page.getByText(labels.emptyRoots, { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  });
  if (done.join('|') !== STEPS.join('|')) throw new Error(`the scenario ran ${done.length} of ${STEPS.length} steps`);
  return { steps: done, expected };
}

module.exports = Object.freeze({ FOLDERS, FILES_PER_FOLDER, STEPS, LABEL_KEYS, expectedCounts, buildSyntheticLibrary, labelsFrom, countsText, countsPattern, groupedDigits, runScenario });
