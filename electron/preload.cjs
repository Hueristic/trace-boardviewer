'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('The event listener must be a function.'); // Developer-facing; the sandboxed preload stays standalone.
  // Never expose Electron's event object or generic IPC methods to the renderer.
  const receive = (_event, value) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

// Electron delivers a rejected invoke() as a plain Error whose message is "Error invoking remote method
// '<channel>': Error: <text>", and the context bridge then copies an Error into the renderer with its
// message and stack ONLY: `code`, `name` and `cause` are dropped (verified with Electron 44 in
// tests/electron-smoke.cjs). The only channel that reaches the renderer is therefore the message. The main
// process starts the text of an error that has a stable machine code with "[CODE] " (STORE_CLOSING,
// BOARD_MISMATCH, MANIFEST_INVALID, DOCUMENT_*, EXPORT_*, WORKSPACE_*, READINGS_*). Here Electron's wrapper is removed
// so the message is exactly "[CODE] text", and `.code` is set as well (it survives wherever no bridge
// copy is involved, e.g. tests). The renderer reads the code from the message prefix. Any other rejection
// is passed on untouched, and the raw IPC machinery is never exposed.
const CODE_PREFIX = /^(?:Error invoking remote method '[^']*': )?(?:Error: )?(\[([A-Z][A-Z0-9_]{2,47})\] )/;
function call(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const match = error && typeof error.message === 'string' ? CODE_PREFIX.exec(error.message) : null;
    if (!match) throw error;
    throw Object.assign(new Error(error.message.slice(match.index + match[0].length - match[1].length)), { code: match[2] });
  });
}

// Close/quit flush (W-fin-lifecycle-02): before it destroys the window or shuts the store down, the main process
// sends 'trace:flush-request' with a number. Every listener registered through onFlushRequest writes what the
// renderer still holds (the debounced workspace snapshot) and may return a promise; once all of them settled the
// answer 'trace:flush-done' goes back with the same number and whether every one of them succeeded: a listener that
// rejects reports what it holds as not saved, and the main process then keeps the window open and asks (U-04). With
// no listener it answers at once, so a renderer that has not subscribed (yet) never holds the main process up. The
// request is only ever listened to here.
const flushListeners = new Set();
ipcRenderer.on('trace:flush-request', (_event, id) => {
  if (!Number.isSafeInteger(id)) return;
  const pending = [...flushListeners].map((listener) => {
    try { return Promise.resolve(listener()); } catch (error) { return Promise.reject(error); }
  });
  void Promise.allSettled(pending).then((results) => ipcRenderer.send('trace:flush-done', id, results.every((result) => result.status === 'fulfilled')));
});
function onFlushRequest(listener) {
  if (typeof listener !== 'function') throw new TypeError('The flush listener must be a function.'); // Developer-facing; the sandboxed preload stays standalone.
  flushListeners.add(listener);
  return () => { flushListeners.delete(listener); };
}

// The language saved in the settings, read synchronously before the first paint (TB-041): the renderer starts in it instead of the system
// language. null when none is saved (a new profile, or a settings file that could not be read); a failed read also gives null.
const initialLanguage = (() => {
  try {
    const value = ipcRenderer.sendSync('trace:initial-language');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
})();

contextBridge.exposeInMainWorld('traceDesktop', Object.freeze({
  // True only when the main process set the QA switch of the device database for this window (electron/device-switch.cjs).
  qaDeviceDatabase: typeof process !== 'undefined' && process.argv?.includes('--trace-qa-device-database') === true,
  initialLanguage,
  // Board payloads carry the original bytes: structured clone delivers the main-process Uint8Array
  // (and any companion sidecars) to the renderer as Uint8Array values.
  openBoard: () => call('trace:open-board'),
  readBoard: (path) => call('trace:read-board', path),
  acceptBoard: (path, key) => call('trace:accept-board', path, key),
  initialBoard: () => call('trace:initial-board'),
  recentBoards: () => call('trace:recent-boards'),
  getSettings: () => call('trace:get-settings'),
  getConfigState: () => call('trace:config-state'),
  saveSettings: (settings) => call('trace:save-settings', settings),
  getNotes: (boardKey) => call('trace:get-notes', boardKey),
  saveNotes: (boardKey, notes) => call('trace:save-notes', boardKey, notes),
  // Workspace and documents (errors with a stable machine code start their message with "[CODE] ", see call()).
  loadWorkspace: (boardKey) => call('trace:load-workspace', boardKey),
  saveWorkspace: (boardKey, manifest) => call('trace:save-workspace', boardKey, manifest),
  pickDocuments: (options) => call('trace:pick-documents', options),
  readDocument: (path, options) => call('trace:read-document', path, options),
  locateDocuments: (boardPath, requests) => call('trace:locate-documents', boardPath, requests),
  exportWorkspace: (request) => call('trace:export-workspace', request),
  // Format diagnostic report (Help): main opens both dialogs; the first call takes no argument, the second forwards only the report.
  pickDiagnosticFile: () => call('trace:diagnostic-pick'),
  saveDiagnosticReport: (report) => call('trace:diagnostic-save', report),
  prepareBugReport: (request) => call('trace:bug-report-prepare', request),
  sendBugReport: (request) => call('trace:bug-report-send', request),
  cancelBugReport: (request) => call('trace:bug-report-cancel', request),
  getBugReportDraft: () => call('trace:bug-report-draft-get'),
  saveBugReportDraft: (request) => call('trace:bug-report-draft-save', request),
  discardBugReportDraft: () => call('trace:bug-report-draft-discard'),
  // Readings (repair store, docs/READINGS_FORMAT.md): a family is named by its 64-hex id. readReadings hands the readings over as the
  // text of a JSON array (one string crosses the bridge, not 100,000 objects). importReadings and exportReadings open main-owned dialogs:
  // the renderer never sends a path; it gets a base name and the text back, and sends a pack to be validated and written.
  listReadingFamilies: () => call('trace:list-readings-families'),
  readReadings: (familyId, options) => call('trace:read-readings', familyId, options),
  appendReadings: (familyId, events) => call('trace:append-readings', familyId, events),
  importReadings: () => call('trace:import-readings'),
  exportReadings: (request) => call('trace:export-readings', request),
  // Library device catalogue (main process: electron/library/devices-bridge.cjs). Roots are named by the id libraryPickRoot returns; a
  // scan takes ids and step switches only, and the corrections take the document only. No path or URL is ever sent from here.
  libraryPickRoot: () => call('trace:library-pick-root'),
  libraryListRoots: () => call('trace:library-list-roots'),
  libraryRemoveRoot: (request) => call('trace:library-remove-root', request),
  libraryScan: (request) => call('trace:library-scan', request),
  libraryCancelScan: () => call('trace:library-cancel-scan'),
  libraryScanSkipStep: (request) => call('trace:library-scan-skip-step', request),
  libraryListFolders: (request) => call('trace:library-list-folders', request),
  libraryListBoards: (request) => call('trace:library-list-boards', request),
  libraryBoardDetail: (request) => call('trace:library-board-detail', request),
  libraryLoadCorrections: () => call('trace:library-load-corrections'),
  librarySaveCorrections: (document) => call('trace:library-save-corrections', document),
  // Support notice and top bar heart: the renderer names one of three fixed links by id ('stripe' | 'kofi' | 'support'); bug reports stay in-app.
  openSupportLink: (id) => call('trace:open-support-link', id),
  getSupportStatus: () => call('trace:get-support-status'),
  prepareSupport: () => call('trace:prepare-support'),
  // Only the Verify button passes { userAction: true }: the one call that may reach the network while the support opt-in is off.
  checkSupport: (request) => call('trace:check-support', { userAction: request?.userAction === true }),
  // Update notification: startup and manual checks use distinct main-process gates; neither call takes an argument. The renderer never sends a URL or a tag.
  checkForStartupUpdates: () => call('trace:check-for-startup-updates'),
  checkForUpdates: () => call('trace:check-for-updates'),
  openUpdatePage: () => call('trace:open-update-page'),
  // Network activity (Settings > Network): neither call takes an argument (none is forwarded). The log is read-only for the renderer, which can only empty it;
  // it can neither name a URL or a host nor start a request.
  getNetworkActivity: () => call('trace:get-network-activity'),
  clearNetworkActivity: () => call('trace:clear-network-activity'),
  // Linux "Do not ask again" (Settings > Linux): the renderer reads whether the answer is stored and can take it back. No argument is forwarded.
  getNoSandboxConsent: () => call('trace:get-no-sandbox-consent'),
  revokeNoSandboxConsent: () => call('trace:revoke-no-sandbox'),
  minimize: () => ipcRenderer.send('trace:minimize'),
  maximize: () => ipcRenderer.send('trace:maximize'),
  close: () => ipcRenderer.send('trace:close'),
  isMaximized: () => call('trace:is-maximized'),
  onMaximized: (listener) => subscribe('trace:maximized', listener),
  onConfigStateChanged: (listener) => subscribe('trace:config-state-changed', listener),
  onSettingsChanged: (listener) => subscribe('trace:settings-changed', listener), // the settings were read again after a lock ended (main.cjs)
  // The path of a file the user dropped (a real File object only). Main grants it before this returns (see electron/path-grants.cjs).
  droppedFilePath: (file) => {
    try {
      const filename = webUtils.getPathForFile(file);
      if (filename) ipcRenderer.sendSync('trace:grant-dropped', filename);
      return filename;
    } catch { return ''; }
  },
  onOpenBoard: (listener) => subscribe('trace:board-opened', listener),
  // An external open (second instance, open-file) that could not be read: the message, in the application's language.
  onOpenFailed: (listener) => subscribe('trace:open-failed', listener),
  onFlushRequest,
}));
