'use strict';

/**
 * Navigation policy of the main window: the one trusted page (the packaged dist/index.html, or the local development server
 * the environment names) is the only page it may show, whichever way a navigation starts. Pure: main.cjs wires the handlers to
 * the webContents events and passes the trusted URL in; tests call the handlers with fake events.
 *
 * Electron's will-navigate and will-redirect cover links and scripts in the page. They do NOT cover programmatic navigations
 * (webContents.loadURL) or navigations sent over the DevTools protocol, which is why did-start-navigation has a watchdog too.
 * Subframes are covered by will-frame-navigate.
 */

/** Same origin, path and query as the trusted page (the fragment is ignored: it never loads another document). */
function isTrustedUrl(value, trustedUrl) {
  try {
    const received = new URL(value);
    const expected = new URL(trustedUrl);
    return received.protocol === expected.protocol && received.origin === expected.origin &&
      received.pathname === expected.pathname && received.search === expected.search;
  } catch { return false; }
}

/**
 * The handlers. `trustedUrl` is a function returning the URL of the trusted page (it is read at each event, after createWindow set it).
 * Each handler returns what it did, so a test can check it: 'blocked' for a navigation prevented, 'stop' for one to cancel, 'allowed' otherwise.
 */
function createNavigationGuard({ trustedUrl }) {
  const trusted = (url) => {
    const expected = trustedUrl();
    return typeof expected === 'string' && expected !== '' && isTrustedUrl(url, expected);
  };
  const prevent = (event, url) => {
    if (trusted(url)) return 'allowed';
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    return 'blocked';
  };
  return Object.freeze({
    isTrusted: trusted,
    /** Links and page scripts that navigate the main frame. */
    willNavigate: (event, url) => prevent(event, url),
    /** Server redirects of a navigation that was allowed to start. */
    willRedirect: (event, url) => prevent(event, url),
    /** Iframes and other subframes of the page. */
    willFrameNavigate: (event, url) => prevent(event, url),
    /**
     * The watchdog: a main-frame navigation to a URL that is not the trusted page, started without will-navigate (loadURL, DevTools).
     * Returns 'stop' for the caller to cancel it (webContents.stop(), then loads the trusted page again), 'allowed' otherwise.
     */
    startNavigation: (url, isMainFrame) => (isMainFrame && !trusted(url) ? 'stop' : 'allowed'),
  });
}

/**
 * Remote debugging over the Chromium DevTools protocol is not controlled by the Electron fuses (the fuse only switches the Node
 * inspector). A packaged release therefore refuses the switches that open it. The QA flavour keeps them, because its runs attach through them.
 * The flavour is a build-time flag, written into the packaged package.json (extraMetadata.traceBuildFlavor, see config/electron-builder.qa*.yml).
 * It is never taken from the product name, which a packaged package.json does not necessarily carry. A missing or unknown flag is the release:
 * closed. A development run (not packaged) is never refused.
 */
const REMOTE_DEBUGGING_SWITCHES = Object.freeze(['remote-debugging-port', 'remote-debugging-pipe']);
function remoteDebuggingRefused({ isPackaged, buildFlavour, hasSwitch }) {
  if (!isPackaged) return false;
  if (buildFlavour === 'qa') return false;
  if (typeof hasSwitch !== 'function') return false;
  return REMOTE_DEBUGGING_SWITCHES.some((name) => hasSwitch(name) === true);
}

module.exports = Object.freeze({ isTrustedUrl, createNavigationGuard, remoteDebuggingRefused, REMOTE_DEBUGGING_SWITCHES });
