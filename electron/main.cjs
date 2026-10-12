'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const i18n = require('./i18n.cjs');
const formats = require('./formats.cjs');
const identity = require('./identity.cjs');
const workspace = require('./workspace.cjs');
const documents = require('./documents.cjs');
const diagnostics = require('./diagnostics.cjs');
const updates = require('./updates.cjs');
const support = require('./support.cjs');
const navigation = require('./navigation.cjs');
// The paths the renderer may read (electron/path-grants.cjs): filled as the user chooses files, the system names one, or a recent board is loaded.
const grants = require('./path-grants.cjs').createPathGrants({ platform: process.platform });
const { createEgress, createElectronFetch } = require('./net/egress.cjs');
const bugReports = require('./bug-reports.cjs');
const { createJsonStore, createByteBudget, readBounded, hasStreamSeparator, renameWithRetry } = require('./store.cjs');
const readingsFormat = require('./readings.cjs');
const deviceSwitch = require('./device-switch.cjs');
const { createRepairStore } = require('./repair-store.cjs');
const { createDeviceBridge } = require('./library/devices-bridge.cjs');
const deviceCore = require('./library/devices-core.cjs');
const { createBoardStore } = require('./library/board-store.cjs');
const { DIRECTORY_SEGMENTS: LIBRARY_DEVICE_SEGMENTS } = require('./library/corrections-store.cjs');
const { createExportTemporaries } = require('./export-temporaries.cjs');
const { applicationMenuTemplate } = require('./app-menu.cjs');

// Bounds for one board file (the primary and every companion sidecar together). The general bound is shared with the formats
// code through shared/import-limits.json; the native Allegro bound applies only to a file whose header carries the Allegro marker.
const importLimits = require('../shared/import-limits.json');
const MAX_BOARD_BYTES = importLimits.maxImportBytes;
const MAX_NATIVE_BOARD_BYTES = importLimits.maxNativeAllegroImportBytes;
/** The byte limit of one board file: the native bound only when the header carries the Allegro database marker ("all" at 0xF8). */
async function boardByteLimit(handle, size) {
  if (size <= MAX_BOARD_BYTES) return MAX_BOARD_BYTES;
  const head = Buffer.alloc(0x100);
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  const marked = bytesRead === head.length && head[0xf8] === 0x61 && head[0xf9] === 0x6c && head[0xfa] === 0x6c;
  return marked ? MAX_NATIVE_BOARD_BYTES : MAX_BOARD_BYTES;
}
const MAX_NOTES_BYTES = 8 * 1024 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
// A readings file picked for import (pack, CSV, OpenBoardData text) and a written export.
const MAX_READINGS_FILE_BYTES = 64 * 1024 * 1024;
// Bytes that concurrent reads (boards and documents together) may hold at once; a burst of opens
// can never allocate more than this, whatever the sizes of the files.
const MAX_INFLIGHT_READ_BYTES = 2 * MAX_BOARD_BYTES;
const MAX_RECENTS = 12;
const MAX_READ_CANDIDATES = 64;
const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: false, updateCheckAsked: false,
});
// Support notice (shown on every start, see src/components/SupportNotice.tsx) and the heart button of the top bar. The links (Stripe, Ko-fi and
// the support page of the project website) live HERE and nowhere else in the desktop app: the renderer sends an id over
// 'trace:open-support-link', never a URL, and only these three ids are ever opened. Bug reports stay inside the app.
const SUPPORT_LINKS = Object.freeze({
  stripe: 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00',
  kofi: 'https://ko-fi.com/tracerboardview',
  support: 'https://trace-boardviewer.github.io/support.html',
});
// Update notification (see electron/updates.cjs and src/components/UpdateNotice.tsx): the renderer uses separate startup/manual channels and gets a bare result; it never
// sends a URL or a tag. The validated tag of the last check that found a newer release is kept HERE, and 'trace:open-update-page' opens the release page of exactly that tag.
let availableUpdateTag = null;
// GitHub allows 60 unauthenticated requests per hour per address, shared with every other GitHub client behind the same connection. So a request is spent at most
// once per UPDATE_MIN_INTERVAL_MS and, after a 403 or 429, not before the time the answer asked for (retryAfterMs of updates.cjs: a minute to an hour); until then
// every ask, from the start-up check or from Check now, gets the last answer again without a request, and asks that overlap share the one request in flight.
const UPDATE_MIN_INTERVAL_MS = 30 * 1000;
const UPDATE_MAX_INTERVAL_MS = 60 * 60 * 1000;
let nextUpdateRequestAt = 0;
let lastUpdateAnswer = { status: 'unavailable' };
let updateRequest = null;
// The network layer (electron/net/egress.cjs): the only code of the main process that makes a request. Created on first use; every feature registers there
// (the update check, for now) and its requests land in the activity log that Settings shows through the two 'trace:*-network-activity' channels below.
let egress = null;
// The build flavour of the receiver endpoint (see electron/bug-reports.cjs resolveEndpoint). Missing or unknown: the release, with the fixed endpoint.
const bugReportFlavour = (() => { try { return require('../package.json').traceBuildFlavor; } catch { return undefined; } })();
function getEgress() {
  if (!egress) {
    const layer = createEgress({
      // The in-memory partition 'trace-egress': no cookies or cache, no permissions, no downloads, only hosts some feature may reach.
      fetchImpl: createElectronFetch({ session, isAllowed: (url) => layer.isAllowedUrl(url), certificateVerifier: bugReports.qaCertificateVerifier({ flavour: bugReportFlavour }) }),
      version: app.getVersion(), now: () => Date.now(),
      // Read at the moment of each request from the committed settings, so a switch that was just turned off holds at once.
      isEnabled: (setting) => config.settings[setting] === true,
    });
    layer.register(updates.FEATURE);
    layer.register(support.FEATURE);
    if (bugReports.CONFIG.enabled === true) layer.register(bugReports.featureFor({ flavour: bugReportFlavour }));
    egress = layer;
  }
  return egress;
}
/** One request to the releases API: the answer for the renderer (status and version only), the remembered tag and the cooldown change together. */
async function requestUpdateCheck({ userAction }) {
  const result = await updates.checkForUpdate({ currentVersion: app.getVersion(), egress: getEgress(), userAction });
  nextUpdateRequestAt = Date.now() + Math.min(UPDATE_MAX_INTERVAL_MS, Math.max(UPDATE_MIN_INTERVAL_MS, result.retryAfterMs || 0));
  availableUpdateTag = result.status === 'available' ? result.tag : null;
  lastUpdateAnswer = result.status === 'available' ? { status: 'available', version: result.version } : { status: result.status };
  return lastUpdateAnswer;
}
// The one place that hands a URL to the operating system. Both callers build the URL from main-process data only (SUPPORT_LINKS, or RELEASE_PAGE_BASE plus a validated
// tag), never from renderer input; anything but https is refused here as a last guard.
async function openExternalUrl(url) {
  if (new URL(url).protocol !== 'https:') throw new Error('Only https links are opened.');
  await shell.openExternal(url);
}
// Errors that carry one of these codes keep the code readable by the renderer: Electron drops custom
// error properties on the way through IPC, so the message starts with "[CODE] " and preload.cjs turns it
// back into `error.code` (the clean text follows the prefix).
const PUBLIC_CODE = /^(?:DOCUMENT_|EXPORT_|WORKSPACE_|READINGS_|DIAGNOSTIC_|LIBRARY_)[A-Z_]+$|^(?:STORE_CLOSING|BOARD_CLOSING|BOARD_MISMATCH|MANIFEST_INVALID)$/;
// Language of every native message and dialog. It follows the saved setting (see loadConfig and
// trace:save-settings), so a language switch in the renderer applies here immediately.
let locale = i18n.LEGACY_LANGUAGE;
const t = (key, params) => i18n.translate(locale, key, params);
// The language stored in the settings file, read at start-up (loadConfig). null when none is stored (a new profile, or a file that could not
// be read): the renderer then keeps the system language. The renderer reads it before its first paint (TB-041).
let savedLanguage = null;
// The family filters of the open dialog: formats.json holds the English family ids, their labels come from the catalogue.
function familyLabel(name) {
  switch (name) {
    case 'GenCAD': return t('native.dialog.familyGenCAD');
    case 'Boardview': return t('native.dialog.familyBoardview');
    case 'ECAD design': return t('native.dialog.familyEcad');
    case 'Gerber': return t('native.dialog.familyGerber');
    default: return name;
  }
}
let mainWindow = null;
let config = { version: 1, settings: { ...DEFAULT_SETTINGS, language: locale }, recentBoards: [] };
// One queued atomic store for the settings, the notes and the workspaces: a single shutdown gate
// (B01) covers every write.
let store = null;
let bugReportService = null;
function getBugReportService() {
  if (!bugReportService) bugReportService = bugReports.createBugReportService({
    store: getStore(), egress: getEgress(), getVersion: () => app.getVersion(), platform: process.platform,
    arch: process.arch, locale: () => locale, flavour: bugReportFlavour,
  });
  return bugReportService;
}
// The readings of every board family (electron/repair-store.cjs): its own queue, closed by the same quit sequence.
let repairStore = null;
let deviceBridge = null;
const readBudget = createByteBudget(MAX_INFLIGHT_READ_BYTES);
const exportsInFlight = new Set();
let initialBoardPromise = null;
let startupBoardPath = null;
let trustedPageUrl = '';
let rendererReady = false;
let pendingBoardPath = null;
let boardDeliveryGeneration = 0;
const readCandidates = new Map();
let quitting = false;
let finalQuit = false;
let windowsAllowed = false; // set once the startup chain created the first window (macOS activate / open-file must not beat it)
// The quit in progress (before-quit, see quitWithSave): 'flushing' while the renderer writes what it holds, 'deciding' while the user
// answers a save that failed, 'closing' once the stores are shutting down (nothing can be undone from then on), null when no quit is.
// quitToken changes whenever a quit stage is abandoned, so a stage that outlived it does nothing (O-31).
let quitStage = null;
let quitToken = 0;
// A config.json that could not be read (damaged, or written by another version of the application) is kept as
// config.json.bak-<timestamp> before the first write replaces it (see preserveUnreadableConfig).
let configUnreadable = false;

// The value of '--option=value' or '--option value'. Chromium moves the switches of a second instance in front of its positional
// arguments, so the space form arrives as '--board', '--some-switch', ..., '<path>': a following switch is never the value (the
// bare path is then found by findBoardArgument).
function optionValue(argv, option) {
  const equal = argv.find((argument) => typeof argument === 'string' && argument.startsWith(`${option}=`));
  if (equal) return equal.slice(option.length + 1);
  const index = argv.indexOf(option);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return typeof next === 'string' && !next.startsWith('-') ? next : null;
}

// A network location (\\server\share) stays refused: opening one can send the Windows sign-in to that server. The message says so
// (MLX-03-04). Device namespace prefixes (\\?\, \\.\) are not network locations and keep the generic invalid-path text.
function networkPath(value) {
  return typeof value === 'string' && /^[\\/]{2}/.test(value) && !/^[\\/]{2}[?.][\\/]/.test(value);
}

function localAbsolutePath(value) {
  if (networkPath(value)) throw new Error(t('native.error.networkPathUnsupported'));
  if (typeof value !== 'string' || value.length === 0 || value.length > 32767 || value.includes('\0') ||
      !path.isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//')) {
    throw new Error(t('native.error.invalidPath'));
  }
  return path.normalize(value);
}

// A macOS AppleDouble companion ("._name") is read whatever its extension (an extensionless "._board" included): the renderer's readers
// refuse its bytes with the explanation of parse.error.appleDoubleMetadata, on every platform. Its name is never a board.
const isMacMetadataName = (filename) => path.basename(filename).startsWith('._');

function boardPath(value) {
  const filename = localAbsolutePath(value);
  // W-fin-lifecycle-01: "host.txt:alt.cad" names an NTFS alternate data stream, not a board file.
  if (hasStreamSeparator(filename, process.platform)) throw new Error(t('native.error.invalidPath'));
  if (!formats.isSupportedExtension(filename) && !isMacMetadataName(filename)) {
    throw new Error(t('native.error.unsupportedFile'));
  }
  return filename;
}

// Linux launch arguments come from desktop launchers and shells: a desktop entry's %U hands over file:// URIs (a file dropped on the
// launcher, "Open with"), and a shell hands over paths relative to the directory it was started in (the .deb puts trace-boardviewer
// on the PATH). Both become an absolute path here, so the board checks that follow are the ones every other path gets; a URI of
// another host or of another scheme names no local file and gives null. Windows and macOS pass absolute paths and keep the old rule
// (absolute paths only, no URIs): there the argument comes back unchanged.
const URI_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
function argumentPath(argument, workingDirectory) {
  if (process.platform !== 'linux' || typeof argument !== 'string') return argument;
  if (/^file:\/\//i.test(argument)) {
    try {
      const url = new URL(argument);
      return url.host === '' ? fileURLToPath(url) : null; // the URL parser already turns file://localhost/ into an empty host
    } catch { return null; }
  }
  if (URI_WITH_SCHEME.test(argument)) return null;
  if (path.isAbsolute(argument)) return argument;
  return typeof workingDirectory === 'string' && path.isAbsolute(workingDirectory) ? path.resolve(workingDirectory, argument) : null;
}

// `workingDirectory` is the directory the launch was started in (this process, or the second instance), for relative arguments.
// A --board value that cannot be turned into a local path is kept as it is, so that the usual check reports it.
// A positional file the application does not read (an extension, but not a supported one) is named too, when no supported file is
// among the arguments: the read then reports it as an unsupported file, the notice a dropped file gets, instead of ignoring an open
// the user asked for. A directory (for example the working directory of `electron .`) and an argument without an extension stay ignored.
function findBoardArgument(argv, workingDirectory) {
  const explicit = optionValue(argv, '--board');
  if (explicit) return argumentPath(explicit, workingDirectory) ?? explicit;
  let unsupported = null;
  for (const raw of argv) {
    if (typeof raw !== 'string' || raw.startsWith('-')) continue;
    const argument = argumentPath(raw, workingDirectory);
    if (typeof argument !== 'string' || !path.isAbsolute(argument)) continue;
    if (formats.isSupportedExtension(argument)) return argument;
    if (unsupported === null && (path.extname(argument) !== '' || isMacMetadataName(argument)) && isNamedFile(argument)) unsupported = argument;
  }
  return unsupported;
}

// A path that is not a directory (an existing file, or a name that does not exist yet, which the read reports as missing).
function isNamedFile(filename) {
  try { return !fsSync.statSync(filename).isDirectory(); } catch { return true; }
}

// The working directory of this launch. process.cwd() throws when that directory was removed in the meantime.
function launchDirectory() {
  try { return process.cwd(); } catch { return undefined; }
}

// A separate profile makes development/QA runs independent of the user's saved data.
const profileOverride = optionValue(process.argv, '--user-data-dir');
if (profileOverride) {
  // MLX-03-06: a profile folder that cannot be used stops the start with its message on stderr, not with an uncaught exception.
  try {
    const directory = localAbsolutePath(profileOverride);
    fsSync.mkdirSync(directory, { recursive: true });
    app.setPath('userData', directory);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    app.exit(2);
  }
} else if (process.platform === 'linux') {
  // Linux: Electron derives the default profile from package.json before this script runs, so setName below cannot move it, and a
  // builder or Electron upgrade that changed that default would leave the settings, notes and workspaces behind. Pinned instead:
  // $XDG_CONFIG_HOME/trace-boardviewer (~/.config/trace-boardviewer), created private (0700) as Chromium creates its own profile.
  const directory = path.join(app.getPath('appData'), 'trace-boardviewer');
  try {
    fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath('userData', directory);
  } catch (error) {
    console.warn('TRACE: the profile directory could not be prepared; the default location is used:', error.message);
  }
}
app.setName('TRACE Boardviewer');
app.setAppUserModelId('hu.trace.boardviewer');
startupBoardPath = findBoardArgument(process.argv.slice(app.isPackaged ? 1 : 2), launchDirectory());
if (startupBoardPath) grants.grant(startupBoardPath, 'external');

// Created on first use, after the profile directory is final. Once the stores started closing a store created
// later is born closed, so no write can slip in between the closing and the final quit.
function getStore() {
  if (!store) {
    // The library's device folder is swept with the profile: the temporaries its writers leave behind (electron/library) are removed the same way.
    store = createJsonStore({
      directory: app.getPath('userData'), maxBytes: MAX_WORKSPACE_BYTES, t, fs, trusted: true,
      temporaryFolders: [path.join(app.getPath('userData'), ...LIBRARY_DEVICE_SEGMENTS)],
    });
    if (quitStage === 'closing') void store.beginShutdown();
  }
  return store;
}

// The record of the export temporaries in the profile (electron/export-temporaries.cjs): created on first use, after the store.
let exportTemporaries = null;
function getExportTemporaries() {
  if (!exportTemporaries) exportTemporaries = createExportTemporaries({ store: getStore(), fs, log: exportLog });
  return exportTemporaries;
}

// A line in the profile's export.log. A journal that cannot be written does not stop an export (the export goes on, its temporary is not
// swept if the process dies), so the failure is recorded here instead.
function exportLog(message) {
  try { fsSync.appendFileSync(path.join(app.getPath('userData'), 'export.log'), `${new Date().toISOString()} ${message}\n`); }
  catch (error) { console.warn('TRACE: the export log could not be written:', error.message); }
}
let supportService = null;
function getSupportService() {
  if (!supportService) supportService = support.createSupportService({ store: getStore(), egress: getEgress });
  return supportService;
}
function getRepairStore() {
  if (!repairStore) {
    repairStore = createRepairStore({ directory: app.getPath('userData'), t, fs, trusted: true });
    if (quitStage === 'closing') void repairStore.beginShutdown();
  }
  return repairStore;
}

// Release switch of the Library bridge (LIB-05, defect O-43). It mirrors DEVICE_DATABASE_ENABLED in src/lib/library/devices/feature.ts, the
// switch of the entry point; tests/desktop-checks.cjs fails when the two differ. While this is false no trace:library-* channel is
// registered (see installIpc), so the shipped build answers none of them.
const DEVICE_DATABASE_ENABLED = false;
// The QA switch (LIB-02, electron/device-switch.cjs): on only in a packaged QA build started with TRACE_QA_DEVICE_DATABASE=1, so the
// three-platform scenario can run. The release never sets it; DEVICE_DATABASE_ENABLED stays false.
const packagedBuildFlavour = (() => { try { return require('../package.json').traceBuildFlavor; } catch { return undefined; } })();
const DEVICE_DATABASE_QA = deviceSwitch.deviceDatabaseQaSwitch({ isPackaged: app.isPackaged, buildFlavour: packagedBuildFlavour, env: process.env });
const DEVICE_DATABASE_ON = DEVICE_DATABASE_ENABLED || DEVICE_DATABASE_QA;
// Library device catalogue (Library): created on first use. Only the native folder chooser of the main window picks a root.
function getDeviceBridge() {
  if (!deviceBridge) {
    deviceBridge = createDeviceBridge({
      core: deviceCore,
      userDataDirectory: app.getPath('userData'),
      anchorSource: createBoardStore({ userDataDirectory: app.getPath('userData') }),
      chooseDirectory: async () => {
        const choice = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
        return choice.canceled || !choice.filePaths[0] ? null : choice.filePaths[0];
      },
    });
  }
  return deviceBridge;
}

const nativeError = (message, code) => Object.assign(new Error(message), { code });
function validateKey(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error(t('native.error.invalidBoardKey'));
  }
  return key;
}
const notesName = (key) => `notes/${validateKey(key)}.json`;

// Platform aware path identity (M01): see identity.cjs.
const pathId = (filename) => identity.pathIdentity(filename, { platform: process.platform });
const samePath = (a, b) => identity.samePath(a, b, { platform: process.platform });
// A fresh Uint8Array over the read buffer's own, exactly sized ArrayBuffer: a pooled Buffer view would
// carry unrelated memory across IPC.
const exactBytes = (buffer) => (buffer.byteOffset === 0 && buffer.buffer.byteLength === buffer.byteLength
  ? new Uint8Array(buffer.buffer, 0, buffer.byteLength) : new Uint8Array(buffer));

function settingsValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.language !== undefined && !i18n.isLanguage(value.language)) ||
      (value.updateCheck !== undefined && typeof value.updateCheck !== 'boolean') ||
      (value.updateCheckAsked !== undefined && typeof value.updateCheckAsked !== 'boolean') ||
      !['dark', 'light', 'system'].includes(value.theme) ||
      !['workshop', 'focus'].includes(value.layout) ||
      ['motion', 'showLabels', 'showConnections'].some((key) => typeof value[key] !== 'boolean')) {
    throw new Error(t('native.error.invalidSettings'));
  }
  return {
    // A caller that does not know about languages keeps the current one.
    language: value.language ?? locale, theme: value.theme, layout: value.layout, motion: value.motion,
    showLabels: value.showLabels, showConnections: value.showConnections,
    // A caller that predates the update check keeps the current choice.
    updateCheck: value.updateCheck ?? config.settings.updateCheck,
    // The first-start question (see src/components/UpdateNotice.tsx) is answered once; a caller that predates it keeps the answer.
    updateCheckAsked: value.updateCheckAsked ?? config.settings.updateCheckAsked,
  };
}

// Each stored field is checked on its own, so one damaged value never resets the other settings.
function storedSettings(stored, language) {
  const field = (key, valid) => (valid(stored[key]) ? stored[key] : DEFAULT_SETTINGS[key]);
  const flag = (value) => typeof value === 'boolean';
  return {
    language,
    theme: field('theme', (value) => ['dark', 'light', 'system'].includes(value)),
    layout: field('layout', (value) => ['workshop', 'focus'].includes(value)),
    motion: field('motion', flag), showLabels: field('showLabels', flag), showConnections: field('showConnections', flag),
    // Profiles saved before the update check have no such field: they get the default (off), and the first start asks once.
    updateCheck: field('updateCheck', flag),
    updateCheckAsked: field('updateCheckAsked', flag),
  };
}

// Only called after app is ready (from loadConfig): the system language is not reliable earlier.
function systemLanguages() {
  const languages = [];
  try { if (typeof app.getPreferredSystemLanguages === 'function') languages.push(...app.getPreferredSystemLanguages()); } catch { /* Fall through. */ }
  try { if (typeof app.getLocale === 'function') languages.push(app.getLocale()); } catch { /* Fall through. */ }
  return languages;
}

// Notes (pin notes and measurements included) are validated by workspace.cjs, which keeps the same
// limits as before: one note per target is an invariant (B15), so a second record for the same
// target would stay hidden in the UI and be dropped by the next save; such an array is rejected on read
// and write alike. A note's target is a key (reference and pin number, see src/lib/note-keys.ts) or, for
// notes written before keys existed, the importer's positional ids (componentId, pinId), which the
// renderer converts once when it opens the board (the validator reads both kinds in one list). Notes
// written before pin notes existed (id, componentId, text, updatedAt) are positional notes of that kind.
function notesValue(value) {
  try { return workspace.validateNotes(value); }
  catch (error) {
    if (error && error.code === 'TOO_MANY_NOTES') throw new Error(t('native.error.tooManyNotes', { max: workspace.LIMITS.notes }));
    if (error && error.code === 'NOTES_INVALID') throw new Error(t('native.error.invalidNote', { max: workspace.LIMITS.text }));
    throw error;
  }
}

// A positional note that no conversion has been tried on (a keyed note has `target`; a tried one carries `unresolved`).
const pendingPositional = (note) => note !== null && typeof note === 'object' && !Array.isArray(note) &&
  note.target === undefined && note.componentId !== undefined && note.unresolved === undefined;
// Every save that replaces positional notes by their keyed form keeps the file it replaces beside it as a numbered copy
// (`<notes file>.positional.bak.1`, newest, to `.5`, oldest, which is dropped), inside the write's own queue slot (keepRotated in store.cjs). U-02:
// the earlier one-shot copy was never refreshed, so a later conversion overwrote the record of the first one. The renderer converts each positional
// id by looking it up in the board as the current importer reads it; a copy keeps the old ids, the only record of what the notes pointed at, so the
// step can be undone by hand. A save that still carries unconverted positional notes (an older writer) keeps nothing: nothing was converted.
const POSITIONAL_COPIES = 5;
const positionalNotesCopy = (name, incoming) => (incoming.some(pendingPositional) ? undefined
  : { name: (index) => `${name}.positional.bak.${index}`, count: POSITIONAL_COPIES, when: (current) => Array.isArray(current) && current.some(pendingPositional) });

// A missing config file is a brand-new profile; an unreadable one is damaged (defaults, Hungarian UI).
const MISSING = Symbol('missing');

// A config.json that a sharing lock holds (another program, an antivirus scan) is not damaged: its read is retried for a moment (about 1.5 s in
// all). When it still fails the file is left exactly as it is (configLocked): the program starts on defaults, no config write goes over the
// file (updateConfig refuses), and the next start reads it again.
const CONFIG_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const isConfigLock = (error) => CONFIG_LOCK_CODES.has(error?.cause?.code) || CONFIG_LOCK_CODES.has(error?.code);
let configLocked = false;
// A lock that appeared while the program runs (J09): a write of the settings failed on the lock. The settings this session holds stay in
// memory, the file stays as it was, and the write is tried again until it succeeds. The state is "locked" meanwhile (the same notice).
let configRuntimeLocked = false;
// The state of config.json for the renderer (see ConfigNotice): "ok"; "locked" (another program locks it: unreadable, nothing is written over it);
// "unreadable" (damaged, or another version: kept aside before the first write); "readonly" (readable but without write access: the settings change
// in memory only and the file is never replaced). A locked or read-only file is checked again every few seconds and when the window gets focus.
// The first readable read of a lock adopts the saved settings, and the renderer is told to read them again. Until it did (configStale) it cannot
// save: a save from its defaults would overwrite what the file holds (CONFIG_STALE).
const CONFIG_REREAD_MS = 3000;
let configStale = false;
let configReadOnly = false;
let configRereadTimer = null;
let configReading = false;
let configStateSent = "ok";
const configState = () => (configLocked || configRuntimeLocked ? "locked" : configUnreadable ? "unreadable" : configReadOnly ? "readonly" : "ok");

// Takes the settings of a version-1 config.json as this process settings; false when the file is another version (kept aside on the next write).
function adoptSavedConfig(saved) {
  if (!saved || saved.version !== 1) return false;
  const stored = saved.settings && typeof saved.settings === 'object' && !Array.isArray(saved.settings) ? saved.settings : {};
  // A profile saved before language support (or holding an unusable value) keeps the Hungarian UI it was used with.
  const language = i18n.normalizeLanguage(stored.language) || i18n.LEGACY_LANGUAGE;
  config.settings = storedSettings(stored, language);
  if (Array.isArray(saved.recentBoards)) {
    config.recentBoards = saved.recentBoards.slice(0, MAX_RECENTS).flatMap((item) => {
      try {
        const filename = boardPath(item.path);
        if (typeof item.openedAt !== 'string' || !Number.isFinite(Date.parse(item.openedAt))) return [];
        return [{ name: path.basename(filename), path: filename, openedAt: item.openedAt }];
      } catch { return []; }
    });
  }
  // Linux: "Do not ask again" in the question about a missing Chromium sandbox (confirmUnsandboxedStart). Only a stored true counts.
  // The recent boards of this profile are granted: the renderer opens them from the recent list (electron/path-grants.cjs).
  for (const recent of config.recentBoards) grants.grant(recent.path, 'recent');
  if (saved.noSandboxAccepted === true) config.noSandboxAccepted = true;
  return true;
}

async function loadConfig() {
  let freshProfile = false;
  try {
    const saved = await getStore().read('config.json', { maxBytes: MAX_CONFIG_BYTES, missing: MISSING });
    if (saved === MISSING) freshProfile = true;
    else if (!adoptSavedConfig(saved)) configUnreadable = true; // Another version wrote it: kept aside before this one overwrites it.
  } catch (error) {
    if (isConfigLock(error)) {
      configLocked = true;
      console.warn('TRACE: the local settings are locked by another program; defaults were loaded and the file is left as it is.');
    } else {
      configUnreadable = true;
      console.warn('TRACE: the local settings could not be read; defaults were loaded instead.');
    }
  }
  // Only a brand-new profile follows the system language; it is stored with the first config write.
  if (freshProfile) config.settings = { ...config.settings, language: i18n.detectLanguage(systemLanguages()) };
  locale = config.settings.language;
  savedLanguage = freshProfile || configUnreadable || configLocked ? null : config.settings.language;
  // A file the program can read but not write: its settings change in memory only (updateConfig). The renderer reads the state when it starts.
  configReadOnly = !configLocked && !configUnreadable && !configWritableNow();
  configStateSent = configState();
  scheduleConfigReread();
}

// Tells the renderer that the state changed; before it is ready it reads the state when it starts (trace:config-state).
function publishConfigState() {
  const state = configState();
  if (state === configStateSent) return;
  configStateSent = state;
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("trace:config-state-changed", state);
}

// Write access now? A missing file can be created; a file without write access (a read-only attribute, a mode without write) is never replaced.
function configWritableNow() {
  const file = getStore().path("config.json");
  try {
    if ((fsSync.statSync(file).mode & 0o222) === 0) return false; // no write bit at all: read-only (root passes the access check on any mode)
    fsSync.accessSync(file, fsSync.constants.W_OK);
    return true;
  } catch (error) { return error.code === "ENOENT"; }
}

function scheduleConfigReread() {
  if (configRereadTimer || (!configLocked && !configReadOnly && !configRuntimeLocked)) return;
  configRereadTimer = setTimeout(() => { configRereadTimer = null; void checkConfigState(); }, CONFIG_REREAD_MS);
  configRereadTimer.unref?.(); // the window keeps the application alive; the timer alone must not keep a test process running
}

// A locked file is read again; a read-only one is tested for write access, and the settings kept in memory are saved once it is writable.
// The next check is scheduled while the state is still not ok.
async function checkConfigState() {
  if (configLocked) await rereadLockedConfig();
  else if (configRuntimeLocked) {
    // The write of what this session holds is tried again: when the lock has ended it is saved, and the state returns to ok.
    void updateConfig((current) => current).catch(() => {});
  } else if (configReadOnly && configWritableNow()) {
    // The settings kept in memory are written now; updateConfig clears the flag and publishes the state once they are on disk.
    void updateConfig((current) => current).catch(() => {});
  }
  scheduleConfigReread();
}

// A readable locked file is adopted (the renderer is told to read the settings again); a lock that still holds, or any other read error, leaves
// the program locked.
async function rereadLockedConfig() {
  if (configReading) return;
  configReading = true;
  try {
    const saved = await getStore().read("config.json", { maxBytes: MAX_CONFIG_BYTES, missing: MISSING });
    configLocked = false;
    if (saved !== MISSING) {
      if (adoptSavedConfig(saved)) {
        configStale = true;
        locale = config.settings.language;
        if (process.platform === "darwin") Menu.setApplicationMenu(applicationMenu());
        if (rendererReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("trace:settings-changed");
      } else configUnreadable = true; // another version wrote it: kept aside before the first write
    }
    configReadOnly = !configUnreadable && !configWritableNow();
  } catch (error) {
    if (!isConfigLock(error)) console.warn("TRACE: the locked settings file could not be read again:", error.message);
  } finally {
    configReading = false;
  }
  publishConfigState();
}

// Focus: the file may be free now, so it is checked at once instead of at the next timer.
function rereadLockedConfigNow() {
  if (!configLocked && !configReadOnly && !configRuntimeLocked) return;
  clearTimeout(configRereadTimer);
  configRereadTimer = null;
  void checkConfigState();
}

// Moves an unreadable config.json aside once, right before the first write and inside the store queue (no other write can slip
// in between). Best effort: a failed rename only costs the backup, never the write.
async function preserveUnreadableConfig() {
  if (!configUnreadable) return;
  configUnreadable = false;
  const filename = getStore().path('config.json');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await fs.rename(filename, `${filename}.bak-${stamp}`).catch(() => {});
}

// The updater runs inside the store queue, in submission order, on the committed in-memory config; the
// result is written atomically and only then becomes the config.
function updateConfig(updater) {
  // The settings this process holds are defaults when the file was locked at start-up: writing them over the file would lose what it holds.
  // Until the file can be read again the write is refused and the file stays as it is.
  if (configLocked) return Promise.reject(nativeError(t("native.error.configLocked"), "CONFIG_LOCKED"));
  if (!configWritableNow()) {
    // A file without write access is never replaced: the change is kept in memory for this session, and the next check that finds the file
    // writable saves all of it (checkConfigState).
    try { config = updater(config); } catch (error) { return Promise.reject(error); }
    configReadOnly = true;
    publishConfigState();
    scheduleConfigReread();
    return Promise.resolve();
  }
  configReadOnly = false;
  let next;
  return getStore().compute("config.json", async () => {
    await preserveUnreadableConfig();
    next = updater(config);
    return next;
  }, { maxBytes: MAX_CONFIG_BYTES, commit: () => { config = next; } }).then(() => {
    configRuntimeLocked = false;
    publishConfigState();
  }, (error) => {
    if (!isConfigLock(error)) throw error;
    // A lock that appeared while the program runs (J09). The change stays in memory, so nothing the user chose is lost: the write is tried
    // again (checkConfigState) and the next change saves all of it. The file is left as it was, the state says the settings are not saved,
    // and the caller learns it through CONFIG_LOCKED.
    if (next !== undefined) config = next;
    configRuntimeLocked = true;
    publishConfigState();
    scheduleConfigReread();
    throw nativeError(t("native.error.configLocked"), "CONFIG_LOCKED");
  });
}

const superseded = () => Object.assign(new Error('superseded'), { superseded: true });

// Companion sidecars of a board file are gathered only from the primary file's own
// directory and never followed outside that directory. The plan
// lists what exists and what it weighs BEFORE any byte is allocated; a missing sibling is simply
// omitted (the parser decides what it needs). The primary and every companion together stay within
// the limit of the board. `formats.companionNames` lists the siblings of whichever set member was chosen, so the
// same complete file set (and therefore the same board key, B32) results from every entry file.
// Name policy: an entry spelled exactly as the companion name is the companion, and other spellings of that name are not considered.
// Without an exact entry, a single entry that differs only by case is the companion, so mixed-case companions keep working. Two or
// more such entries are ambiguous, so none is chosen. The read is refused only when that name's companion set is the chosen one, the
// same rule an unreadable alternative follows; the user then sees the localized read failure.
function companionAmbiguous() {
  return Object.assign(new Error('the companion sidecar name is ambiguous'), { code: 'COMPANION_AMBIGUOUS' });
}

async function planCompanions(primaryPath, primaryBytes, limit = MAX_BOARD_BYTES) {
  const wanted = formats.companionNames(path.basename(primaryPath));
  if (!wanted.length) return { items: [], bytes: 0 };
  const directory = path.dirname(primaryPath);
  const entries = (await fs.readdir(directory)).sort();
  const items = [];
  const candidateErrors = new Map();
  for (const name of wanted) {
    const exact = entries.find((candidate) => candidate === name);
    const variants = entries.filter((candidate) => candidate.toLowerCase() === name);
    if (exact === undefined && variants.length > 1) {
      candidateErrors.set(name, companionAmbiguous());
      continue;
    }
    const entry = exact ?? variants[0];
    if (entry === undefined) continue;
    try {
      const canonical = await fs.realpath(path.join(directory, entry));
      if (!samePath(path.dirname(canonical), directory)) continue; // A link leaving the directory is not a sibling.
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) continue; // A directory named like a sidecar is not one.
      items.push({ name, canonical, size: stat.size });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; // Removed between listing and reading.
      candidateErrors.set(name, error); // An unselected alternative must not prevent opening the chosen set.
    }
  }
  const selected = new Set(formats.companionNames(primaryPath, [path.basename(primaryPath), ...items.map((item) => item.name), ...candidateErrors.keys()]));
  for (const [name, error] of candidateErrors) if (selected.has(name)) throw error;
  const chosen = items.filter((item) => selected.has(item.name));
  let total = primaryBytes;
  for (const item of chosen) {
    if (item.size > limit - total) throw new Error(t('native.error.boardTooLarge', { max: Math.round(limit / 1048576) }));
    total += item.size;
  }
  return { items: chosen, bytes: total - primaryBytes };
}

async function readCompanions(plan, checkpoint) {
  const companions = {};
  for (const item of plan.items) {
    let handle;
    try {
      handle = await fs.open(item.canonical, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      if (stat.size !== item.size) throw Object.assign(new Error(t('native.error.fileChangedWhileReading')), { code: 'STORE_CHANGED' });
      companions[item.name] = exactBytes(await readBounded(handle, stat.size, item.size, t, { checkpoint }));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }
  return Object.keys(companions).length ? companions : null;
}

function rememberCandidate(result) {
  const candidateId = `${pathId(result.path)}\0${result.key}`;
  readCandidates.delete(candidateId);
  readCandidates.set(candidateId, { name: result.name, path: result.path, key: result.key });
  while (readCandidates.size > MAX_READ_CANDIDATES) readCandidates.delete(readCandidates.keys().next().value);
}

// `wanted` lets an external delivery that was superseded by a newer request stop at every checkpoint:
// before it opens anything, before the budget grants it memory, before the allocation and between the
// chunks of the read (B11). The bytes of all concurrent reads together stay within readBudget.
async function readBoard(filename, wanted = () => true) {
  const requested = boardPath(filename);
  const checkpoint = () => { if (!wanted()) throw superseded(); };
  let handle;
  let release = null;
  try {
    checkpoint();
    const canonical = boardPath(await fs.realpath(requested));
    checkpoint();
    handle = await fs.open(canonical, 'r');
    checkpoint();
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(t('native.error.notAFile'));
    const limit = await boardByteLimit(handle, stat.size);
    if (stat.size > limit) throw new Error(t('native.error.boardTooLarge', { max: Math.round(limit / 1048576) }));
    if (stat.size === 0) throw new Error(t('native.error.boardEmpty'));
    checkpoint();
    const plan = await planCompanions(canonical, stat.size, limit);
    release = await readBudget.acquire(stat.size + plan.bytes, checkpoint);
    // The original bytes travel unchanged; the renderer parser recognizes the format and a recent is
    // only recorded after that parse succeeds (acceptBoard).
    const contents = await readBounded(handle, stat.size, limit, t, { checkpoint });
    const companions = await readCompanions(plan, checkpoint);
    const key = identity.boardKey([
      { name: path.basename(canonical), data: contents },
      ...Object.entries(companions ?? {}).map(([name, data]) => ({ name, data })),
    ]);
    const result = {
      name: path.basename(canonical), path: canonical, data: exactBytes(contents),
      ...(companions ? { companions } : {}), key,
    };
    rememberCandidate(result);
    return result;
  } catch (error) {
    if (error.superseded) throw error;
    if (error.code === 'ENOENT') throw new Error(t('native.error.boardNotFound'));
    // A file another program holds open exclusively fails with EBUSY on Windows (O-07): say so instead of a generic failure.
    if (error.code === 'EBUSY') throw new Error(t('native.error.fileInUse'));
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(t('native.error.boardNotReadable'));
    // Size and change errors already carry their localized text.
    if (typeof error.code === 'string' && error.code.startsWith('STORE_')) throw new Error(error.message);
    if (error.code) throw new Error(t('native.error.boardReadFailed'));
    throw error;
  } finally {
    // The budget is returned only after the handle is closed: open handles are bounded too.
    if (handle) await handle.close();
    if (release) release();
  }
}

// Format diagnostic report (Help > Format diagnostic report, electron/diagnostics.cjs, docs/DIAGNOSTIC-REPORT.md). The main process owns both dialogs:
// the file is chosen HERE and its bytes go to the renderer's diagnostic worker under a neutral name (diagnostics.parserName: only an extension, or the
// fixed role name of a companion-set member), so that neither the name, the folder nor the user's profile ever reaches the renderer or the report.
// Nothing here touches the network or the clipboard; the report is validated against the closed schema again before the one file write.
// The dedupe code is an HMAC under a random secret of this installation (diagnostic-secret.json in the profile); the secret never leaves this file.
let diagnosticSecret = null;
function getDiagnosticSecret() {
  diagnosticSecret ??= (async () => {
    const stored = await getStore().read('diagnostic-secret.json', { maxBytes: 4096, missing: null }).catch(() => null);
    const existing = diagnostics.parseSecret(stored);
    if (existing) return existing;
    const created = diagnostics.newSecret();
    // A secret that could not be stored still serves this session; the next one makes another (codes are then no longer comparable).
    await getStore().write('diagnostic-secret.json', created, { maxBytes: 4096 }).catch(() => {});
    return diagnostics.parseSecret(created);
  })();
  return diagnosticSecret;
}

async function readDiagnosticFile(filename) {
  const requested = localAbsolutePath(filename);
  if (hasStreamSeparator(requested, process.platform)) throw new Error(t('native.error.invalidPath'));
  let handle;
  let release = null;
  try {
    const canonical = await fs.realpath(requested);
    if (hasStreamSeparator(canonical, process.platform)) throw new Error(t('native.error.invalidPath'));
    handle = await fs.open(canonical, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(t('native.error.notAFile'));
    const limit = await boardByteLimit(handle, stat.size);
    if (stat.size > limit) throw new Error(t('native.error.boardTooLarge', { max: Math.round(limit / 1048576) }));
    const plan = await planCompanions(canonical, stat.size, limit);
    release = await readBudget.acquire(stat.size + plan.bytes, diagnosticOpen);
    const contents = await readBounded(handle, stat.size, limit, t, { checkpoint: diagnosticOpen });
    const companions = await readCompanions(plan, diagnosticOpen);
    const base = path.basename(canonical);
    const member = formats.companionNames(base).length > 0;
    // A single file is identified by its bytes alone (a renamed copy gives the same code); a set by its members' roles and bytes.
    const code = diagnostics.dedupeCode(await getDiagnosticSecret(), [
      { name: member ? base : '', data: contents },
      ...Object.entries(companions ?? {}).map(([name, data]) => ({ name, data })),
    ]);
    return { name: diagnostics.parserName(base, member), data: exactBytes(contents), ...(companions ? { companions } : {}), os: diagnostics.osFamily(process.platform), dedupe: code };
  } catch (error) {
    if (error.code === 'DIAGNOSTIC_CLOSING') throw error;
    if (error.code === 'ENOENT') throw new Error(t('native.error.boardNotFound'));
    if (error.code === 'EBUSY') throw new Error(t('native.error.fileInUse'));
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(t('native.error.boardNotReadable'));
    if (typeof error.code === 'string' && error.code.startsWith('STORE_')) throw new Error(error.message);
    if (error.code) throw new Error(t('native.error.boardReadFailed'));
    throw error;
  } finally {
    if (handle) await handle.close();
    if (release) release();
  }
}

async function pickDiagnosticFile() {
  diagnosticOpen();
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: t('native.dialog.diagnosticPickTitle'), buttonLabel: t('native.dialog.diagnosticPickButton'), properties: ['openFile'],
    // Any file may be diagnosed (an unrecognized one is the usual reason): "all files" first, then the format filters.
    filters: [{ name: t('native.dialog.diagnosticAllFiles'), extensions: ['*'] }, ...formats.dialogFilters(t('native.dialog.openFilter'), undefined, familyLabel)],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  diagnosticOpen();
  return readDiagnosticFile(choice.filePaths[0]);
}

async function saveDiagnosticReport(report) {
  diagnosticOpen();
  let text;
  try { text = diagnostics.serializeReport(diagnostics.validateReport(report, { reviewed: true })); }
  catch (error) {
    console.warn('TRACE: a diagnostic report was refused:', error && error.message); // names a field, never a value
    throw nativeError(t('native.error.diagnosticInvalid'), 'DIAGNOSTIC_INVALID');
  }
  diagnosticOpen(); // no await since the check: the last look before the dialog opens
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: t('native.dialog.diagnosticSaveTitle'), buttonLabel: t('native.dialog.diagnosticSaveButton'),
    // A bare name: the dialog starts where the user last saved, not next to the file that was examined.
    defaultPath: 'trace-format-diagnostic.json', filters: [{ name: t('native.dialog.diagnosticSaveFilter'), extensions: ['json'] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  diagnosticOpen();
  const target = /\.json$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.json`;
  const work = fs.writeFile(target, text, 'utf8');
  exportsInFlight.add(work);
  try { await work; }
  catch { throw nativeError(t('native.error.diagnosticWriteFailed'), 'DIAGNOSTIC_WRITE_FAILED'); }
  finally { exportsInFlight.delete(work); }
  return { bytes: Buffer.byteLength(text, 'utf8') };
}


// The same file under another spelling of its name: APFS folds case and normalises Unicode, so one file can be reached under several
// names. Device and inode decide it, as for the library roots (9db2291); a case-sensitive volume keeps such names as two files.
async function sameRecentFile(left, right) {
  if (samePath(left, right)) return true;
  try {
    const [a, b] = [await fs.stat(left), await fs.stat(right)];
    return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

async function acceptBoard(filename, key) {
  const checkedPath = boardPath(filename);
  const checkedKey = validateKey(key);
  const candidate = readCandidates.get(`${pathId(checkedPath)}\0${checkedKey}`);
  if (!candidate) throw new Error(t('native.error.boardNotVerified'));
  // An entry for the same file is replaced by this one, not kept beside it.
  const replaced = new Set();
  for (const item of config.recentBoards) if (await sameRecentFile(item.path, candidate.path)) replaced.add(item.path);
  // A locked settings file (see updateConfig) does not stop the board: it opens, and only the recents of this session are not kept.
  return updateConfig((current) => ({
    ...current,
    recentBoards: [
      { name: candidate.name, path: candidate.path, openedAt: new Date().toISOString() },
      ...current.recentBoards.filter((item) => !samePath(item.path, candidate.path) && !replaced.has(item.path)),
    ].slice(0, MAX_RECENTS),
  })).catch((error) => { if (error?.code !== 'CONFIG_LOCKED') throw error; });
}

function isTrustedUrl(value) {
  return navigation.isTrustedUrl(value, trustedPageUrl);
}

function trustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame && isTrustedUrl(event.senderFrame.url));
}

function allowClipboardWrite(contents, permission, details) {
  return Boolean(permission === 'clipboard-sanitized-write' && mainWindow && !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents && details?.isMainFrame === true &&
    isTrustedUrl(details.requestingUrl) && isTrustedUrl(contents.mainFrame.url));
}

function exposeCode(error) {
  const code = error && error.code;
  if (typeof code !== 'string' || !PUBLIC_CODE.test(code) || typeof error.message !== 'string') return error;
  return Object.assign(new Error(`[${code}] ${error.message}`, { cause: error }), { code });
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error(t('native.error.untrustedSender'));
    try { return await callback(...args); } catch (error) { throw exposeCode(error); }
  });
}

// A new renderer intent or external open makes every older external delivery obsolete, including
// those still waiting for read budget.
function supersedeDeliveries() {
  const generation = ++boardDeliveryGeneration;
  readBudget.poke();
  return generation;
}

async function loadManifest(key) {
  let raw;
  try { raw = await getStore().read(workspace.manifestName(key), { maxBytes: MAX_WORKSPACE_BYTES }); }
  catch {
    throw nativeError(t('native.error.workspaceUnreadable'), 'WORKSPACE_UNREADABLE');
  }
  // BOARD_MISMATCH / MANIFEST_INVALID: a manifest of another board or a damaged one is never returned.
  return raw === null ? null : workspace.validateManifest(raw, key);
}

function pickOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || (value.multiple !== undefined && typeof value.multiple !== 'boolean')) {
    throw nativeError(t('native.error.documentOptionsInvalid'), 'DOCUMENT_INVALID_OPTIONS');
  }
  return { kinds: value.kinds, multiple: value.multiple };
}

// The renderer may name a file only if the user chose it, the system named it, or the profile remembers it (electron/path-grants.cjs).
// A relative or malformed path is never granted, but it is not a file the user could have chosen either: the handler's own syntax check
// names it (the usual invalid-path message), so it is left to that check.
function requireGranted(filename) {
  if (typeof filename === 'string' && path.isAbsolute(filename) && !grants.has(filename)) throw new Error(t('native.error.pathNotGranted'));
}

function documentContext(extra) {
  return { t, fs, budget: readBudget, platform: process.platform, ...extra };
}

function exportRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.documentIds) ||
      value.documentIds.length > workspace.LIMITS.documents ||
      value.documentIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > workspace.LIMITS.id) ||
      typeof value.includeBoard !== 'boolean' || typeof value.includeNotes !== 'boolean') {
    throw nativeError(t('native.error.exportRequestInvalid'), 'EXPORT_INVALID_REQUEST');
  }
  return { key: validateKey(value.boardKey), documentIds: [...value.documentIds], includeBoard: value.includeBoard, includeNotes: value.includeNotes };
}

// "Check, await, act" is a race once the quit intent can arrive in between: every intent that opens a dialog or starts
// work looks at `quitting` again after each awaited step and right before it acts, never only on entry.
function refuseWhenClosing(code, message) {
  if (quitting) throw nativeError(message, code);
}
const exportOpen = () => refuseWhenClosing('EXPORT_CLOSING', t('native.error.exportClosing'));
const boardOpen = () => refuseWhenClosing('BOARD_CLOSING', t('native.error.boardClosing'));
const documentsOpen = () => refuseWhenClosing('DOCUMENT_CLOSING', t('native.error.documentClosing'));
const diagnosticOpen = () => refuseWhenClosing('DIAGNOSTIC_CLOSING', t('native.error.diagnosticClosing'));

async function exportWorkspace(value) {
  const request = exportRequest(value);
  exportOpen();
  const manifest = await loadManifest(request.key);
  exportOpen();
  if (!manifest) throw nativeError(t('native.error.workspaceNotSaved'), 'WORKSPACE_NOT_FOUND');
  const notes = request.includeNotes ? notesValue(await getStore().read(notesName(request.key), { maxBytes: MAX_NOTES_BYTES, missing: [] })) : null;
  const stem = documents.safeFileName(path.parse(manifest.board.name).name, 'workspace');
  exportOpen(); // no await since the notes load: this is the last look before the dialog opens
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: t('native.dialog.exportTitle'), buttonLabel: t('native.dialog.exportButton'),
    defaultPath: path.isAbsolute(manifest.board.path) ? path.join(path.dirname(manifest.board.path), `${stem}-workspace.zip`) : `${stem}-workspace.zip`,
    filters: [{ name: t('native.dialog.exportZipFilter'), extensions: ['zip'] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  // The dialog may have been open when the quit intent arrived; an answer after it starts nothing. From here on the
  // export is registered (exportsInFlight) and the quit waits for it.
  exportOpen();
  const target = /\.zip$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.zip`;
  const work = (async () => {
    let boardFiles = null;
    if (request.includeBoard) {
      const board = await readBoard(manifest.board.path);
      if (board.key !== request.key) throw nativeError(t('native.error.exportBoardChanged'), 'EXPORT_BOARD_CHANGED');
      boardFiles = [
        { name: board.name, path: board.path, primary: true, data: board.data },
        ...Object.entries(board.companions ?? {}).map(([name, data]) => ({ name, path: path.join(path.dirname(board.path), name), data })),
      ];
    }
    return documents.exportBundle({
      manifest, notes, documentIds: request.documentIds, includeBoard: request.includeBoard, boardFiles, target, t, fs, platform: process.platform,
      temporaries: getExportTemporaries(),
    });
  })();
  exportsInFlight.add(work);
  try { return await work; } finally { exportsInFlight.delete(work); }
}

// Readings (docs/READINGS_FORMAT.md). The renderer never names a path: import and export go through dialogs that main opens, the import
// returns the file's base name and text only (the renderer parses it with src/lib/readings and appends the events, which the repair
// store validates natively again), and an export is a pack the renderer built that main validates and writes itself.
const readingsOpen = () => refuseWhenClosing('READINGS_CLOSING', t('native.error.readingsClosing'));
const readingsError = (message, code) => nativeError(message, code);

async function importReadings() {
  readingsOpen();
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: t('native.dialog.readingsImportTitle'), buttonLabel: t('native.dialog.readingsImportButton'), properties: ['openFile'],
    filters: [{ name: t('native.dialog.readingsImportFilter'), extensions: ['json', 'csv', 'tsv', 'txt'] }, { name: t('native.dialog.allFiles'), extensions: ['*'] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  readingsOpen();
  const filename = localAbsolutePath(choice.filePaths[0]);
  if (hasStreamSeparator(filename, process.platform)) throw new Error(t('native.error.invalidPath'));
  let handle;
  let release = null;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw readingsError(t('native.error.notAFile'), 'READINGS_NOT_A_FILE');
    if (stat.size > MAX_READINGS_FILE_BYTES) throw readingsError(t('native.error.fileLimitExceeded'), 'READINGS_FILE_TOO_LARGE');
    release = await readBudget.acquire(stat.size);
    const bytes = await readBounded(handle, stat.size, MAX_READINGS_FILE_BYTES, t);
    const text = readingsFormat.decodeImportText(bytes);
    if (text === null) throw readingsError(t('native.error.readingsNotText'), 'READINGS_NOT_TEXT');
    return { name: path.basename(filename), bytes: bytes.length, text };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('READINGS_')) throw error;
    if (error && typeof error.code === 'string' && error.code.startsWith('STORE_')) throw readingsError(error.message, 'READINGS_FILE_UNREADABLE');
    // A file another program holds open reports EBUSY on Windows (O-07): say so instead of the generic text.
    if (error && error.code === 'EBUSY') throw readingsError(t('native.error.fileInUse'), 'READINGS_FILE_UNREADABLE');
    throw readingsError(t('native.error.readingsFileUnreadable'), 'READINGS_FILE_UNREADABLE');
  } finally {
    if (handle) await handle.close();
    if (release) release();
  }
}

function readingsExportRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['pack', 'csv'].includes(value.format) ||
      (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 120))) {
    throw readingsError(t('native.error.readingsInvalidRequest'), 'READINGS_INVALID_REQUEST');
  }
  // READINGS_INVALID / READINGS_TOO_MANY: the native twin of validatePack, licence marking included.
  return { format: value.format, pack: readingsFormat.validatePack(value.pack), name: value.name };
}

async function exportReadings(value) {
  const request = readingsExportRequest(value);
  const text = request.format === 'csv' ? readingsFormat.packToCsv(request.pack) : readingsFormat.serializePack(request.pack);
  const data = Buffer.from(text, 'utf8');
  if (data.length > MAX_READINGS_FILE_BYTES) throw readingsError(t('native.error.readingsTooLarge', { max: 64 }), 'READINGS_TOO_LARGE');
  readingsOpen();
  const stem = documents.safeFileName(request.name ?? request.pack.board.label ?? request.pack.title ?? 'readings', 'readings');
  const extension = request.format === 'csv' ? 'csv' : 'json';
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: t('native.dialog.readingsExportTitle'), buttonLabel: t('native.dialog.readingsExportButton'),
    defaultPath: request.format === 'csv' ? `${stem}.csv` : `${stem}.trace-readings.json`,
    filters: [{ name: request.format === 'csv' ? t('native.dialog.readingsCsvFilter') : t('native.dialog.readingsPackFilter'), extensions: [extension] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  readingsOpen();
  const chosen = localAbsolutePath(choice.filePath);
  if (hasStreamSeparator(chosen, process.platform)) throw new Error(t('native.error.invalidPath'));
  const target = chosen.toLowerCase().endsWith(`.${extension}`) ? chosen : `${chosen}.${extension}`;
  const work = (async () => {
    const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    const journal = getExportTemporaries();
    let stage = 'write';
    try {
      await journal.record(temporary); // recorded before the file exists (electron/export-temporaries.cjs)
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      stage = 'rename';
      await renameWithRetry(fs, temporary, target);
      await journal.forget(temporary);
    } catch (error) {
      // Forgotten only when the temporary is gone: one that could not be removed stays recorded for the next start.
      if (await fs.unlink(temporary).then(() => true, (unlinkError) => unlinkError?.code === 'ENOENT')) await journal.forget(temporary);
      // A destination another program holds open: EBUSY anywhere, EPERM only from the final rename over it (O-07, as for workspace exports).
      if (error && (error.code === 'EBUSY' || (error.code === 'EPERM' && stage === 'rename'))) throw readingsError(t('native.error.fileInUse'), 'READINGS_SAVE_FAILED');
      throw readingsError(t('native.error.dataSaveFailed'), 'READINGS_SAVE_FAILED');
    }
    return { name: path.basename(target), bytes: data.length, readings: request.pack.readings.length };
  })();
  exportsInFlight.add(work);
  try { return await work; } finally { exportsInFlight.delete(work); }
}

function readingsReadOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || (value.headerOnly !== undefined && typeof value.headerOnly !== 'boolean')) {
    throw readingsError(t('native.error.readingsInvalidRequest'), 'READINGS_INVALID_REQUEST');
  }
  return { headerOnly: value.headerOnly === true };
}

// Close/quit flush (W-fin-lifecycle-02, W-fin-documents-01). The renderer saves the workspace after a 400 ms quiet
// period and owns the timer that retries a failed write; `pagehide` comes too late for app.quit() and a destroyed
// renderer cannot retry. Before the window is destroyed and before the store starts shutting down, main therefore asks
// the renderer to write what it still holds ('trace:flush-request', preload.cjs onFlushRequest) and waits - bounded - for
// its answer ('trace:flush-done') and for the store queue (the rename retry included) to drain. The wait is bounded so
// a hung renderer can never keep the window or the app open; the quit itself still drains the store without a bound.
// 3 s: a save that needs the store's rename retries (about 0.6 s of waiting) takes up to about 1.2 s on Windows, where a freshly written
// file can be held for a moment; a 1 s bound counted such a save as done while it was still in progress (U-04).
const FLUSH_TIMEOUT_MS = 3000;
const flushWaiters = new Map();
let flushSequence = 0;

// Resolves when `work` settles or after `ms`, whichever comes first; never rejects, leaves no timer behind.
function boundedWait(work, ms) {
  let timer;
  return Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

// A renderer that has not started (no board can be open yet) or is gone has nothing to flush.
function rendererFlushable(window) {
  if (!window || mainWindow !== window || !rendererReady || window.isDestroyed()) return false;
  const contents = window.webContents;
  return !(contents.isDestroyed?.() || contents.isCrashed?.());
}

// Resolves 'saved' only when the renderer answered that its pending saves reached the disk (U-04). 'failed': it answered otherwise (an
// answer without the outcome counts as failed). 'unconfirmed': no answer within the bounded wait, or the renderer cannot be reached; nothing
// is claimed then, and the user decides as for a failure. Never rejects.
async function flushForClose(window) {
  const id = ++flushSequence;
  let acknowledge;
  const answered = new Promise((resolve) => { acknowledge = resolve; });
  flushWaiters.set(id, acknowledge);
  let outcome = 'unconfirmed';
  const work = (async () => {
    try {
      window.webContents.send('trace:flush-request', id);
      outcome = (await answered) === true ? 'saved' : 'failed';
    } catch { /* A renderer that cannot be reached: nothing is confirmed. */ }
    if (store) await store.flush(); // The writes the renderer just issued, rename retries included.
    if (repairStore) await repairStore.flush();
  })();
  await boundedWait(work, FLUSH_TIMEOUT_MS);
  flushWaiters.delete(id);
  return outcome;
}

// U-04: what the renderer still held did not reach the disk. The user decides: retry the save (the question comes again when it fails
// again), quit without the unsaved changes (a second question first), or stay. `current()` turns false once an open request cancelled the
// quit (O-31): then nothing more is asked and the answer is 'cancel'.
async function askSaveFailed(parent, outcome, current = () => true) {
  const answer = await dialog.showMessageBox(parent, {
    type: 'warning', title: app.name, noLink: true, defaultId: 0, cancelId: 2,
    buttons: [t('native.dialog.saveRetry'), t('native.dialog.quitWithoutSaving'), t('native.dialog.saveCancel')],
    message: outcome === 'unconfirmed' ? t('native.dialog.saveUnconfirmedMessage') : t('native.dialog.saveFailedMessage'),
    detail: t('native.dialog.saveFailedDetail'),
  });
  if (!current()) return 'cancel';
  if (answer?.response === 0) return 'retry';
  if (answer?.response !== 1) return 'cancel';
  const confirmation = await dialog.showMessageBox(parent, {
    type: 'warning', title: app.name, noLink: true, defaultId: 1, cancelId: 1,
    buttons: [t('native.dialog.quitWithoutSaving'), t('native.dialog.saveCancel')],
    message: t('native.dialog.discardConfirmMessage'), detail: t('native.dialog.discardConfirmDetail'),
  });
  return confirmation?.response === 0 && current() ? 'discard' : 'cancel';
}

// The quit gets this long to drain (the stores, the bug report service, the exports in flight, the record of a board for the relaunch);
// what is still unfinished then is named in quit.log and the application exits anyway (FXQA-20261011-01, PARITY-20261011-09).
const QUIT_DRAIN_MS = 2000;

// Set once will-quit has run, on any path: quitWithSave emits it itself only when it has not (see the guard there).
let willQuitRan = false;
app.on('will-quit', () => { willQuitRan = true; });

// What the quit left unfinished, appended to quit.log in the profile (the store is closed by then, so this is plain file I/O).
function quitLog(message) {
  try { fsSync.appendFileSync(path.join(app.getPath('userData'), 'quit.log'), `${new Date().toISOString()} ${message}\n`); }
  catch (error) { console.warn('TRACE: the quit log could not be written:', error.message); }
}

// The quit (before-quit): the renderer writes what it holds, then the stores close and the application quits. A save that failed keeps
// the application here and the user decides (U-04). Every step checks `token` first: once an open request cancelled this quit (O-31) it
// leaves nothing behind, and the application simply keeps running.
async function quitWithSave(token) {
  for (;;) {
    quitStage = 'flushing';
    const outcome = rendererFlushable(mainWindow) ? await flushForClose(mainWindow) : 'saved';
    if (token !== quitToken) return;
    if (outcome === 'saved') break;
    quitStage = 'deciding';
    const choice = await askSaveFailed(mainWindow, outcome, () => token === quitToken);
    if (token !== quitToken) return;
    if (choice === 'cancel') { quitStage = null; quitting = false; return; }
    if (choice === 'discard') break;
  }
  quitStage = 'closing';
  // A board recorded for the relaunch during the drain is written too (pendingOpenWrite), inside the same bound.
  const drained = Promise.allSettled([
    bugReportService ? bugReportService.beginShutdown() : Promise.resolve(),
    store ? store.beginShutdown() : Promise.resolve(), repairStore ? repairStore.beginShutdown() : Promise.resolve(), ...exportsInFlight,
  ]).then(() => pendingOpenWrite);
  let bound;
  const outcome = await Promise.race([drained.then(() => 'drained'), new Promise((resolve) => { bound = setTimeout(() => resolve('timed-out'), QUIT_DRAIN_MS); })]);
  clearTimeout(bound);
  if (outcome === 'timed-out') {
    const left = store ? store.unfinished() : { queued: 0, writing: [] };
    quitLog(`the quit was not drained within ${QUIT_DRAIN_MS} ms: ${left.queued} store operation(s) not settled, writing: ${left.writing.join(', ') || 'none'}; exports in flight: ${exportsInFlight.size}; the application exits and these may be lost`);
  }
  finalQuit = true;
  relaunchForPendingOpens();
  // app.exit, not app.quit: the stores are drained (or named in quit.log above), and app.exit leaves at once. Electron does not emit will-quit
  // for app.exit, so it is emitted here, before the exit: its listeners (the packaged QA's pre-main observer writes its final snapshot on
  // will-quit) get their last synchronous chance, as on a normal quit. quit is not emitted here: the candidate's shutdown log shows Electron
  // emits it once, after app.exit. app.quit is not used: the shutdown that follows it is what FXQA-20261011-01 measured.
  // The guard: will-quit goes out once per process, whichever path ran it first (willQuitRan).
  if (!willQuitRan) app.emit('will-quit', { preventDefault() {} });
  app.exit(0);
}

// O-31: a board that arrives while the quit waits (for the renderer's save or for the user's answer) cancels that quit before any store
// closes, and the board then opens the usual way. Once the stores started closing nothing can be undone: the quit goes on, and the board
// is recorded for a relaunch instead (boardRequested).
function cancelQuitForBoard() {
  if (quitStage !== 'flushing' && quitStage !== 'deciding') return;
  quitToken++;
  quitStage = null;
  quitting = false;
}

// O-31 after the stores started closing: a board that arrives then cannot be opened by this process, because nothing it would write can be
// saved any more. It is recorded in the profile at once (a crash keeps it), and the application relaunches with the newest recorded board
// after the drain (relaunchForPendingOpens). A relaunch that fails leaves the record for the next start (noticePendingOpens).
const PENDING_OPEN_FILE = 'pending-open.json';
let pendingOpens = [];
let pendingOpenWrite = Promise.resolve(); // the record writes, in order; never rejects

function recordPendingOpen(filename) {
  pendingOpens = [...pendingOpens, filename];
  const directory = app.getPath('userData');
  const file = path.join(directory, PENDING_OPEN_FILE);
  pendingOpenWrite = pendingOpenWrite
    .then(() => fs.mkdir(directory, { recursive: true }))
    .then(() => fs.writeFile(file, `${JSON.stringify({ version: 1, files: pendingOpens }, null, 2)}\n`, 'utf8'))
    .catch((error) => console.warn('TRACE: an open request could not be recorded:', error.message));
}

// Open requests (open-file, second-instance): the board opens as usual, or is recorded once the stores started closing.
function boardRequested(filename) {
  if (quitStage === 'closing') { recordPendingOpen(filename); return; }
  cancelQuitForBoard();
  void deliverBoard(filename);
}

// After the drain, so the new process starts from what this one wrote: the newest recorded board is opened by a relaunch. The
// single-instance lock is released first, or the new process would hand its board to this one, which is already quitting, and exit.
function relaunchForPendingOpens() {
  const newest = pendingOpens.at(-1);
  if (!newest) return;
  try {
    app.releaseSingleInstanceLock();
    app.relaunch({ args: app.isPackaged ? [newest] : [process.argv[1], newest] });
  } catch (error) {
    console.warn('TRACE: the application could not relaunch with the board; it stays recorded for the next start:', error.message);
  }
}

// The start after a closing that recorded boards: the board the process was launched with is opened as usual, every other recorded board
// was not opened. The record moves to an archive file (nothing is deleted) and the user is told about each board that was not opened.
async function noticePendingOpens(launched) {
  const file = path.join(app.getPath('userData'), PENDING_OPEN_FILE);
  let record;
  try { record = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return; } // No record (the usual case) or one that cannot be read
  const files = Array.isArray(record?.files) ? record.files.filter((entry) => typeof entry === 'string') : [];
  const opened = launched ? path.resolve(launched) : null;
  const notOpened = files.filter((entry) => path.resolve(entry) !== opened);
  await fs.rename(file, path.join(app.getPath('userData'), `pending-open.${Date.now()}.json`)).catch(() => {});
  if (notOpened.length > 0) {
    await dialog.showMessageBox({
      type: 'warning', title: app.name, noLink: true, buttons: [t('native.dialog.pendingOpenButton')],
      message: t('native.dialog.pendingOpenMessage'), detail: notOpened.join('\n'),
    });
  }
}

function installIpc() {
  // A file dropped onto the window: the preload asks synchronously (sendSync) so that the grant is in place before the renderer reads it.
  ipcMain.on('trace:grant-dropped', (event, filename) => {
    if (trustedSender(event)) grants.grant(filename, 'drop');
    event.returnValue = true;
  });
  ipcMain.on('trace:flush-done', (event, id, saved) => {
    if (!trustedSender(event) || !Number.isSafeInteger(id)) return;
    flushWaiters.get(id)?.(saved);
  });
  handle('trace:open-board', async () => {
    boardOpen();
    supersedeDeliveries();
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: t('native.dialog.openTitle'), buttonLabel: t('native.dialog.openButton'), properties: ['openFile'],
      filters: formats.dialogFilters(t('native.dialog.openFilter'), t('native.dialog.allFiles'), familyLabel),
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    grants.grant(choice.filePaths[0], 'dialog');
    boardOpen();
    return readBoard(choice.filePaths[0]);
  });
  handle('trace:read-board', (filename) => { requireGranted(filename); supersedeDeliveries(); return readBoard(filename); });
  handle('trace:accept-board', acceptBoard);
  handle('trace:initial-board', () => {
    rendererReady = true;
    if (!initialBoardPromise) {
      initialBoardPromise = (async () => {
        if (startupBoardPath) {
          const requested = startupBoardPath;
          try { return { ...await readBoard(requested), startupSource: 'argument' }; }
          catch (error) {
            // The file named at launch cannot be opened: the renderer gets the error (its start-up toast), the file is forgotten so
            // that a later call restores a recent board like a plain start, and the last readable recent follows right away.
            startupBoardPath = null;
            initialBoardPromise = null;
            void restoreRecentBoard();
            throw error;
          }
        }
        // Skip moved/deleted files when restoring the last available board.
        for (const recent of config.recentBoards) {
          try { return { ...await readBoard(recent.path), startupSource: 'recent' }; } catch { /* Try the next recent. */ }
        }
        return null;
      })();
    }
    if (pendingBoardPath) {
      const pending = pendingBoardPath;
      pendingBoardPath = null;
      void deliverBoard(pending);
    }
    return initialBoardPromise;
  });
  handle('trace:recent-boards', () => config.recentBoards.map((item) => ({ ...item })));
  handle('trace:get-settings', () => { configStale = false; return { ...config.settings }; }); // the renderer read the settings it holds now
  // The stored language before the first paint (TB-041): the preload asks synchronously, so the window's first frame is in the saved language.
  // Only the language string is answered, and only to the app's own window.
  ipcMain.on('trace:initial-language', (event) => { event.returnValue = trustedSender(event) ? savedLanguage : null; });
  handle('trace:config-state', () => ({ state: configState() }));
  handle('trace:save-settings', (settings) => {
    const checked = settingsValue(settings);
    // A locked file takes no save (updateConfig refuses it); the adopted settings wait for the renderer to read them (configStale).
    if (configLocked) throw nativeError(t('native.error.configLocked'), 'CONFIG_LOCKED');
    if (configStale) throw nativeError(t('native.error.configStale'), 'CONFIG_STALE');
    // Native messages and dialogs switch together with the renderer, before the write completes. The macOS menu carries
    // translated labels, so it is built again for the new language.
    const previous = locale;
    locale = checked.language;
    if (process.platform === 'darwin' && locale !== previous) Menu.setApplicationMenu(applicationMenu());
    return updateConfig((current) => ({ ...current, settings: checked }));
  });
  // Linux "Do not ask again" (confirmUnsandboxedStart): Settings reads whether the answer is stored and can take it back, so the question
  // comes again at the next start without the sandbox. Other platforms are never asked; neither call takes an argument.
  handle('trace:get-no-sandbox-consent', () => noSandboxConsent());
  handle('trace:revoke-no-sandbox', async () => {
    if (process.platform === 'linux' && config.noSandboxAccepted === true) {
      // A failed write rejects: the renderer shows that the setting could not be changed, and the stored answer stays as it was.
      await updateConfig(({ noSandboxAccepted, ...rest }) => rest);
    }
    return noSandboxConsent();
  });
  handle('trace:get-notes', async (key) => {
    const name = notesName(key);
    try { return notesValue(await getStore().read(name, { maxBytes: MAX_NOTES_BYTES, missing: [] })); }
    catch { throw new Error(t('native.error.notesUnreadable')); }
  });
  handle('trace:save-notes', async (key, notes) => {
    const name = notesName(key);
    const checked = notesValue(notes);
    const keepRotated = positionalNotesCopy(name, checked);
    try { await getStore().write(name, checked, { maxBytes: MAX_NOTES_BYTES, ...(keepRotated ? { keepRotated } : {}) }); }
    catch (error) {
      if (error && error.code === 'STORE_TOO_LARGE') throw new Error(t('native.error.notesTooLarge', { max: 8 }));
      throw error;
    }
  });
  handle('trace:load-workspace', (key) => loadManifest(validateKey(key)));
  handle('trace:save-workspace', async (key, manifest) => {
    const checkedKey = validateKey(key);
    const checked = workspace.validateManifest(manifest, checkedKey);
    await getStore().write(workspace.manifestName(checkedKey), checked, { maxBytes: MAX_WORKSPACE_BYTES });
  });
  handle('trace:pick-documents', async (options) => {
    const { kinds, multiple } = pickOptions(options);
    documentsOpen();
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: t('native.dialog.attachTitle'), buttonLabel: t('native.dialog.attachButton'),
      properties: multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: documents.dialogFilters(kinds, { t }),
    });
    if (choice.canceled || !choice.filePaths.length) return [];
    for (const filename of choice.filePaths) grants.grant(filename, 'dialog');
    documentsOpen();
    return documents.readSelection(choice.filePaths, documentContext({ kinds }));
  });
  handle('trace:read-document', async (filename, options) => {
    requireGranted(filename);
    const { kinds } = pickOptions(options);
    return (await documents.readSelection([filename], documentContext({ kinds })))[0];
  });
  handle('trace:locate-documents', async (boardFile, requests) => {
    requireGranted(boardFile);
    const located = await documents.locateDocuments(boardFile, requests, documentContext());
    // A document found inside the folder of the granted board is granted: the renderer then reads it by the path it was given. A path outside
    // that folder is never granted here (it needs the user's own choice).
    for (const result of located) if (result && typeof result.path === 'string' && result.relativePath !== undefined) grants.grant(result.path, 'located');
    return located;
  });
  handle('trace:export-workspace', exportWorkspace);
  // Format diagnostic report: the first takes no argument (main opens the dialog), the second only the report object, which is validated again here.
  handle('trace:diagnostic-pick', () => pickDiagnosticFile());
  handle('trace:diagnostic-save', (report) => saveDiagnosticReport(report));
  // Bug reports are prepared and sent by the main process. The renderer can name only a short-lived handle;
  // it cannot provide a URL, request body, headers, report id or app metadata.
  handle('trace:bug-report-prepare', (request) => getBugReportService().prepare(request));
  handle('trace:bug-report-send', (request) => getBugReportService().send(request));
  handle('trace:bug-report-cancel', (request) => getBugReportService().cancel(request));
  handle('trace:bug-report-draft-get', () => getBugReportService().getDraft());
  handle('trace:bug-report-draft-save', (request) => getBugReportService().saveDraft(request));
  handle('trace:bug-report-draft-discard', () => getBugReportService().discardDraft());
  // Readings (repair store): families are named by their 64-hex id; every event is validated natively before it is written.
  handle('trace:list-readings-families', () => getRepairStore().list());
  handle('trace:read-readings', (familyId, options) => getRepairStore().read(familyId, readingsReadOptions(options)));
  handle('trace:append-readings', (familyId, events) => getRepairStore().append(familyId, events));
  handle('trace:import-readings', importReadings);
  handle('trace:export-readings', exportReadings);
  // Library device catalogue: the renderer names roots by the opaque id pickRoot returned, never by a path. Scans are read-only;
  // only the corrections file under userData is ever written. Saving is refused once quitting began. Registered only while the
  // release switch is on (DEVICE_DATABASE_ENABLED): with it off the channels do not exist in the build.
  if (DEVICE_DATABASE_ON) {
    handle('trace:library-pick-root', () => getDeviceBridge().pickRoot());
    handle('trace:library-list-roots', () => getDeviceBridge().listRoots());
    handle('trace:library-remove-root', (request) => getDeviceBridge().removeRoot(request));
    handle('trace:library-scan', (request) => getDeviceBridge().scan(request));
    handle('trace:library-cancel-scan', () => getDeviceBridge().cancelScan());
    handle('trace:library-scan-skip-step', (request) => getDeviceBridge().skipScanStep(request));
    handle('trace:library-list-folders', (request) => getDeviceBridge().listFolders(request));
    handle('trace:library-list-boards', (request) => getDeviceBridge().listBoards(request));
    handle('trace:library-board-detail', (request) => getDeviceBridge().boardDetail(request));
    handle('trace:library-load-corrections', () => getDeviceBridge().loadCorrections());
    handle('trace:library-save-corrections', (document) => {
      refuseWhenClosing('LIBRARY_CLOSING', t('native.error.libraryClosing'));
      return getDeviceBridge().saveCorrections(document);
    });
  }
  // Developer-facing text on purpose: the renderer only ever sends the four fixed ids, so users never see this message.
  handle('trace:open-support-link', async (id) => {
    if (typeof id !== 'string' || !Object.hasOwn(SUPPORT_LINKS, id)) throw new Error('Unknown support link.');
    let url = SUPPORT_LINKS[id];
    if (id === 'stripe') {
      try {
        const reference = await getSupportService().prepare();
        if (reference?.available === true && typeof reference.code === 'string' && /^[a-f0-9]{32}$/.test(reference.code)) url += '?client_reference_id=' + reference.code;
      } catch { /* The fixed Stripe page still opens when local reference storage is unavailable. */ }
    }
    await openExternalUrl(url);
  });
  handle('trace:get-support-status', () => getSupportService().status());
  handle('trace:prepare-support', () => getSupportService().prepare());
  // Only the Verify button asks with { userAction: true }; the flag is read as a boolean, nothing else from the renderer reaches the service.
  handle('trace:check-support', request => getSupportService().check({ userAction: request?.userAction === true }));
  // The automatic check is separately gated here, against the committed preference. The manual Settings action remains available when it is off.
  handle('trace:check-for-startup-updates', () => {
    if (config.settings.updateCheck !== true) return { status: 'unavailable' };
    const wait = nextUpdateRequestAt - Date.now();
    // Inside the cooldown the last answer is repeated. A wait longer than any cooldown ever set can only come from a clock that was set back: it is dropped.
    if (wait > 0 && wait <= UPDATE_MAX_INTERVAL_MS) return lastUpdateAnswer;
    if (!updateRequest) updateRequest = requestUpdateCheck({ userAction: false }).finally(() => { updateRequest = null; });
    return updateRequest;
  });
  handle('trace:check-for-updates', () => {
    const wait = nextUpdateRequestAt - Date.now();
    // Inside the cooldown the last answer is repeated. A wait longer than any cooldown ever set can only come from a clock that was set back: it is dropped.
    if (wait > 0 && wait <= UPDATE_MAX_INTERVAL_MS) return lastUpdateAnswer;
    if (!updateRequest) updateRequest = requestUpdateCheck({ userAction: true }).finally(() => { updateRequest = null; });
    return updateRequest;
  });
  handle('trace:open-update-page', async () => {
    if (!availableUpdateTag) throw new Error('No update available.');
    await openExternalUrl(updates.RELEASE_PAGE_BASE + availableUpdateTag);
  });
  // Network activity (Settings > Network): the registered features and the in-memory log of every request, read-only; the one write is emptying the log.
  // Neither handler reads a renderer argument, and no channel lets the renderer name a URL, a feature or a host.
  handle('trace:get-network-activity', () => ({ features: getEgress().features(), ...getEgress().activity() }));
  handle('trace:clear-network-activity', () => { getEgress().clearLog(); });
  handle('trace:is-maximized', () => mainWindow.isMaximized());
  // The caption close button (its "close application" control) quits the application on every platform (PARITY-MAC-20261011-01): on macOS closing
  // the last window keeps the app running, so the button did nothing there. It takes the Cmd+Q path: app.quit() runs before-quit, which
  // flushes the renderer's pending writes and the store, and only then quits. The window is never closed by the button itself.
  for (const [channel, action] of [
    ['trace:minimize', () => mainWindow.minimize()],
    ['trace:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()],
    ['trace:close', () => app.quit()],
  ]) {
    ipcMain.on(channel, (event) => { if (trustedSender(event)) action(); });
  }
}

// Session-wide policy, installed once like the IPC: the default session outlives every window, so a window created again (macOS
// activate / open-file) must not add another copy of each listener. The sanitized clipboard write is the only permission ever
// granted, and only to the trusted main document; no download ever starts.
function installSession() {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowClipboardWrite(contents, permission, details));
  });
  defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => allowClipboardWrite(contents, permission, details));
  defaultSession.on('will-download', (event) => event.preventDefault());
}

// After a failed start-up file: the first readable recent board reaches the renderer over 'trace:board-opened', as a plain start
// would have restored it, once the renderer holds the rejection of 'trace:initial-board' (the send follows at least one file
// operation, the reply does not). The delivery supersedes nothing: any newer open, external or from the renderer, stops it at its
// next checkpoint, and a recent that is gone is skipped without a dialog.
async function restoreRecentBoard() {
  const targetWindow = mainWindow;
  const generation = boardDeliveryGeneration;
  const current = () => !quitting && generation === boardDeliveryGeneration && rendererReady &&
    Boolean(targetWindow) && mainWindow === targetWindow && !targetWindow.isDestroyed();
  for (const recent of config.recentBoards) {
    if (!current()) return;
    try {
      const payload = await readBoard(recent.path, current);
      if (current()) targetWindow.webContents.send('trace:board-opened', { ...payload, startupSource: 'recent' });
      return;
    } catch (error) {
      if (error.superseded) return;
      // Try the next recent.
    }
  }
}

async function deliverBoard(filename) {
  if (quitting) return;
  const generation = supersedeDeliveries();
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    pendingBoardPath = filename;
    return;
  }
  const targetWindow = mainWindow;
  const current = () => generation === boardDeliveryGeneration && mainWindow === targetWindow && !targetWindow.isDestroyed();
  try {
    // A burst of external opens (second-instance / open-file) is coalesced: latest wins and every older
    // delivery stops at its next checkpoint, before allocating and during the read.
    const payload = await readBoard(filename, current);
    if (current()) targetWindow.webContents.send('trace:board-opened', payload);
  } catch (error) {
    // The failure reaches the renderer as the notice of a failed interactive open (the same text, in the application's language, and
    // no native box): a window still hidden or on its way up keeps it until the user closes it. A delivery that was superseded or
    // outlived the quit intent reports nothing.
    if (current() && !quitting) {
      targetWindow.webContents.send('trace:open-failed', typeof error?.message === 'string' ? error.message : t('native.error.boardReadFailed'));
    }
  }
}

// A window whose page never paints (a renderer gone before its first frame, a document request that never answers) would stay
// hidden for ever while the process holds the single-instance lock: every further launch would exit at once and nothing would
// appear. After this long the window is shown as it is.
const FALLBACK_SHOW_MS = 4000;

// The window icon. X11 task bars and Alt+Tab show it where no installed desktop entry matches the window (an AppImage without desktop
// integration); under Wayland the desktop entry is the only source. On Linux nativeImage decodes PNG (ICO is a Windows format), and
// 256 px keeps the X11 icon property small. Windows keeps the ICO; macOS ignores the option.
function windowIcon() {
  if (process.platform !== 'linux') return path.join(__dirname, '..', 'assets', 'icon.ico');
  const file = path.join(__dirname, '..', 'assets', 'icon.png');
  let image = nativeImage.createFromPath(file);
  // Inside app.asar the path may not decode on every platform; Node's fs reads the archive, so decode the bytes instead.
  if (image.isEmpty() && typeof nativeImage.createFromBuffer === 'function') {
    try { image = nativeImage.createFromBuffer(fsSync.readFileSync(file)); } catch { /* keep the empty image */ }
  }
  return image.isEmpty() ? undefined : image.resize({ width: 256, height: 256, quality: 'best' });
}

function createWindow() {
  rendererReady = false;
  const icon = windowIcon();
  initialBoardPromise = null;
  const developmentUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : null;
  if (developmentUrl) {
    const candidate = new URL(developmentUrl);
    if (candidate.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(candidate.hostname) || candidate.username || candidate.password) {
      throw new Error(t('native.error.devServerNotLocal'));
    }
    trustedPageUrl = candidate.href;
  } else {
    trustedPageUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  }
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 640,
    title: 'TRACE Boardviewer', backgroundColor: '#11161d', frame: false,
    show: false, icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, spellcheck: false,
      // Only the QA switch adds an argument: the renderer shows the device database entry only when the main process has it on.
      additionalArguments: DEVICE_DATABASE_QA ? [deviceSwitch.RENDERER_ARGUMENT] : [],
    },
  });
  const window = mainWindow;
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The navigation policy (electron/navigation.cjs): links, redirects and subframes are prevented; a main-frame navigation that bypassed
  // those events (loadURL, the DevTools protocol) is stopped by the watchdog and the trusted page is loaded again.
  const guard = navigation.createNavigationGuard({ trustedUrl: () => trustedPageUrl });
  mainWindow.webContents.on('will-navigate', (event, url) => guard.willNavigate(event, url));
  mainWindow.webContents.on('will-redirect', (event, url) => guard.willRedirect(event, url));
  mainWindow.webContents.on('will-frame-navigate', (event, url) => guard.willFrameNavigate(event, url));
  mainWindow.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (guard.startNavigation(url, isMainFrame) === 'stop' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.stop();
      mainWindow.loadURL(trustedPageUrl).catch(() => {});
      return;
    }
    if (isMainFrame) bugReportService?.invalidateWindow();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('maximize', () => mainWindow.webContents.send('trace:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('trace:maximized', false));
  mainWindow.on('focus', () => rereadLockedConfigNow());
  const showWindow = () => {
    if (quitting || mainWindow !== window || window.isDestroyed() || window.isVisible()) return;
    window.show();
    // X11 keeps the icon only on a mapped window under some window managers; set it again once the window is shown.
    if (process.platform === 'linux' && icon && typeof window.setIcon === 'function') window.setIcon(icon);
  };
  const fallbackShow = setTimeout(showWindow, FALLBACK_SHOW_MS);
  window.once('ready-to-show', () => { clearTimeout(fallbackShow); showWindow(); });
  const loadPage = () => window.loadURL(trustedPageUrl).catch((error) => {
    // Closing during startup aborts navigation; that is a normal shutdown.
    if (quitting || window.isDestroyed() || mainWindow !== window) return;
    console.error('TRACE: the user interface could not be loaded:', error.message);
    dialog.showErrorBox(t('native.dialog.startupErrorTitle'), t('native.dialog.startupLoadFailed'));
    app.quit();
  });
  // A renderer that is gone (crashed, killed, out of memory) leaves a frameless window with nothing in it and no controls; a clean
  // exit, a window on its way out and a quit in progress are not failures. The user is told, then the page is loaded again with the
  // start-up state reset, so the new renderer announces itself through 'trace:initial-board' like the first one did and an external
  // open that arrives meanwhile waits for it (pendingBoardPath).
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details?.reason === 'clean-exit' || quitting || mainWindow !== window || window.isDestroyed()) return;
    rendererReady = false;
    initialBoardPromise = null;
    void dialog.showMessageBox(window, { type: 'error', title: app.name, message: t('native.dialog.rendererGone') })
      .then(() => { if (!quitting && mainWindow === window && !window.isDestroyed()) void loadPage(); });
  });
  // A renderer that stopped answering (a parser stuck on a hostile file, a huge board on a slow machine) can be given more time or
  // closed. One dialog per hang. Closing a renderer that is still hung skips the close-time flush it could not answer anyway; one
  // that recovered while the dialog was open is flushed like any other.
  let hung = false;
  let hangDialog = null;
  window.webContents.on('responsive', () => { hung = false; });
  window.webContents.on('unresponsive', () => {
    hung = true;
    if (hangDialog || quitting || mainWindow !== window || window.isDestroyed()) return;
    hangDialog = dialog.showMessageBox(window, {
      type: 'warning', title: app.name, message: t('native.dialog.unresponsive'),
      buttons: [t('native.dialog.unresponsiveWait'), t('native.dialog.unresponsiveClose')], defaultId: 0, cancelId: 0, noLink: true,
    }).then((answer) => {
      hangDialog = null;
      if (answer?.response !== 1 || window.isDestroyed()) return;
      if (hung && mainWindow === window) rendererReady = false;
      window.close();
    });
  });
  // The first close request is held back until the renderer's pending saves are written (bounded, see flushForClose), then the window
  // closes for real. A save that failed keeps the window open and the user decides (U-04). A quit in progress (finalQuit) has already flushed.
  let closeApproved = false;
  let closeFlush = null;
  const closeWhenSaved = async () => {
    for (let outcome = await flushForClose(window); outcome !== 'saved'; outcome = await flushForClose(window)) {
      const choice = await askSaveFailed(window, outcome);
      if (choice === 'cancel') return;
      if (choice === 'discard') break;
    }
    closeApproved = true;
    if (!window.isDestroyed()) window.close();
  };
  window.on('close', (event) => {
    if (closeApproved || finalQuit || !rendererFlushable(window)) return;
    event.preventDefault();
    closeFlush ??= closeWhenSaved().finally(() => { closeFlush = null; });
  });
  window.on('closed', () => {
    clearTimeout(fallbackShow);
    bugReportService?.invalidateWindow();
    if (mainWindow === window) { mainWindow = null; rendererReady = false; }
  });
  void loadPage();
}

// The macOS menu (its template is in electron/app-menu.cjs): translated labels, rebuilt when the language changes (trace:save-settings).
// Windows and Linux keep no menu bar.
function applicationMenu() {
  const template = applicationMenuTemplate({ platform: process.platform, appName: app.name, t, openSettings: openSettingsFromMenu });
  return template ? Menu.buildFromTemplate(template) : null;
}
// The Settings… item: the page opens its settings when it hears the window event trace:open-settings (OPEN_SETTINGS_EVENT in
// src/components/workspace/shortcuts.ts, listened to by Shell.tsx). The event must be dispatched in the page's own world, so the
// script runs there through executeJavaScript; it is a constant and nothing from the request enters it.
const OPEN_SETTINGS_SCRIPT = "window.dispatchEvent(new Event('trace:open-settings'));";
function openSettingsFromMenu() {
  if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.webContents.executeJavaScript(OPEN_SETTINGS_SCRIPT).catch(() => {});
}

// Linux sandbox gate. Chromium's OS sandbox (a user and PID namespace, or the SUID helper, plus a seccomp-bpf filter) confines every
// renderer. On Linux it is off exactly when the browser process carries the switch --no-sandbox; without the switch Chromium refuses
// to start where it finds no usable sandbox. The AppImage launcher adds the switch by itself when the system forbids unprivileged user
// namespaces (Ubuntu 23.10 and newer); the .deb keeps the sandbox through an AppArmor profile. The switch is read from Chromium's own
// parsed command line (app.commandLine), the one Chromium acts on, not from process.argv: argv misses the switch Electron adds for
// ELECTRON_DISABLE_SANDBOX and the single-dash spelling, and would count a --no-sandbox after a "--" terminator (checked with
// Electron 44 on Windows, whose process metrics report the sandbox state: hasSwitch matched it in each of these cases).
// Nothing runs unsandboxed without a decision: Quit is the default and the answer to Esc or to closing the box. TRACE_ACCEPT_NO_SANDBOX=1
// (scripts, CI) or an earlier "Do not ask again" (noSandboxAccepted in config.json) skips the question; the warning line is always
// written to stderr. Windows and macOS are never asked.
const NO_SANDBOX_WARNING = 'TRACE: running without the Chromium sandbox (--no-sandbox).';
// 'start': sandboxed or not Linux; 'accepted': unsandboxed and already agreed to; 'ask': unsandboxed, the user decides.
function sandboxGate({ platform, noSandbox, acceptEnvironment, accepted }) {
  if (platform !== 'linux' || noSandbox !== true) return 'start';
  return acceptEnvironment === '1' || accepted === true ? 'accepted' : 'ask';
}
// What Settings shows: whether this platform is ever asked, and whether the answer "Do not ask again" is stored.
function noSandboxConsent() {
  const applicable = process.platform === 'linux';
  return { applicable, saved: applicable && config.noSandboxAccepted === true };
}

// Resolves true when the start-up may go on, false when the user chose to quit. Runs after loadConfig (the stored answer and the
// language) and before any window or IPC exists.
async function confirmUnsandboxedStart() {
  const decision = sandboxGate({
    platform: process.platform, noSandbox: process.platform === 'linux' && app.commandLine.hasSwitch('no-sandbox'),
    acceptEnvironment: process.env.TRACE_ACCEPT_NO_SANDBOX, accepted: config.noSandboxAccepted,
  });
  if (decision === 'start') return true;
  console.warn(NO_SANDBOX_WARNING);
  if (decision === 'accepted') return true;
  const answer = await dialog.showMessageBox({
    type: 'warning', title: app.name, noLink: true, defaultId: 0, cancelId: 0,
    buttons: [t('native.dialog.noSandboxQuit'), t('native.dialog.noSandboxStart')],
    checkboxLabel: t('native.dialog.noSandboxRemember'), checkboxChecked: false,
    message: t('native.dialog.noSandboxMessage'),
    detail: `${t('native.dialog.noSandboxRisk')}\n\n${t('native.dialog.noSandboxAdvice')}`,
  });
  if (answer?.response !== 1) return false;
  if (answer.checkboxChecked === true) {
    // Stored with the settings. A failed write only means that the question comes again at the next start.
    await updateConfig((current) => ({ ...current, noSandboxAccepted: true }))
      .catch((error) => console.warn('TRACE: the answer could not be saved:', error.message));
  }
  return true;
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const filename = findBoardArgument(argv.slice(app.isPackaged ? 1 : 2), workingDirectory);
    if (filename) { grants.grant(filename, 'external'); boardRequested(filename); }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // A window still waiting for its first paint is shown as it is: a second launch must never leave nothing on screen.
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('open-file', (event, filename) => {
    event.preventDefault();
    grants.grant(filename, 'external');
    if (!app.isReady()) startupBoardPath = filename;
    else {
      boardRequested(filename);
      // macOS keeps the process alive without a window: the board waits in pendingBoardPath for the new renderer.
      if (process.platform === 'darwin' && windowsAllowed && !quitting && BrowserWindow.getAllWindows().length === 0) createWindow();
    }
  });
  // A packaged release never opens the DevTools protocol: its switches are refused here (electron/navigation.cjs explains why the fuses
  // do not cover them). The QA flavour keeps them, because its packaged runs attach through them.
  // The build flavour is the flag the QA configs write into the packaged package.json (electron/navigation.cjs). Missing: the release.
  const buildFlavour = (() => { try { return require('../package.json').traceBuildFlavor; } catch { return undefined; } })();
  if (app.isPackaged && navigation.remoteDebuggingRefused({ isPackaged: true, buildFlavour, hasSwitch: (name) => app.commandLine.hasSwitch(name) })) {
    console.error('TRACE Boardviewer refuses a remote debugging switch in a packaged build.');
    app.exit(1);
  }
  app.whenReady().then(async () => {
    const launched = startupBoardPath; // the board this process was started with, before the window can take it
    await loadConfig();
    if (!(await confirmUnsandboxedStart())) { app.quit(); return; }
    Menu.setApplicationMenu(applicationMenu());
    installIpc();
    void getExportTemporaries().sweep(); // the export temporaries of a writer that is gone (electron/export-temporaries.cjs)
    installSession();
    createWindow();
    windowsAllowed = true;
    void noticePendingOpens(launched);
  }).catch((error) => {
    dialog.showErrorBox(t('native.dialog.startupErrorTitle'), error.message || t('native.dialog.startupFailed'));
    app.quit();
  });
  app.on('activate', () => { if (windowsAllowed && !quitting && BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    quitting = true;
    if (finalQuit) return;
    event.preventDefault();
    // With a live renderer the quit first lets it write what it still holds (the debounced workspace snapshot of a
    // direct app.quit()); only then the stores flip to "closing" (new writes are rejected with STORE_CLOSING) and the
    // application quits after every write accepted before that moment has been committed. Without a live renderer
    // the stores close at once, in this very turn. A quit already in progress is not started again (see quitWithSave).
    if (quitStage === null) void quitWithSave(++quitToken);
  });
}
