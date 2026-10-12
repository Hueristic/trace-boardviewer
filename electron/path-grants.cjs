'use strict';

/**
 * The paths the renderer may ask the main process to read. A path is granted only when
 *  - the user chose it: an open dialog ('dialog'), a file dropped onto the window ('drop');
 *  - the system or a second launch named it: the command line, a file opened from the system, a second launch ('external');
 *  - the profile remembers it as a recent board ('recent');
 *  - a document was located inside the folder of a granted board ('located').
 * Any other path is refused before the file is touched, so a compromised renderer cannot read an arbitrary file by name.
 * Pure: main.cjs keeps one registry and calls grant/has at each place a path enters or is read.
 */

const path = require('node:path');

const SOURCES = Object.freeze(['dialog', 'drop', 'external', 'recent', 'located']);
const MAX_PATH_LENGTH = 32767;

function createPathGrants({ platform = process.platform } = {}) {
  const granted = new Map();
  // Windows paths are case-insensitive, so the key ignores case there only; elsewhere the spelling is the identity.
  const keyOf = (filename) => {
    const resolved = path.resolve(filename);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const usable = (filename) => typeof filename === 'string' && filename.length > 0 && filename.length <= MAX_PATH_LENGTH &&
    !filename.includes('\0') && path.isAbsolute(filename);

  /** Grants one path from one source. Returns true when it was granted; an unusable path is refused (false), an unknown source throws. */
  function grant(filename, source) {
    if (!SOURCES.includes(source)) throw new TypeError(`unknown grant source: ${String(source)}`);
    if (!usable(filename)) return false;
    granted.set(keyOf(filename), { path: path.resolve(filename), source });
    return true;
  }

  /** True only for a path that was granted by one of the sources above; any other value is false. */
  function has(filename) {
    return usable(filename) && granted.has(keyOf(filename));
  }

  /** The source that granted a path, or null. For tests and for the activity log: never a path from the renderer. */
  function sourceOf(filename) {
    return usable(filename) ? granted.get(keyOf(filename))?.source ?? null : null;
  }

  return Object.freeze({ grant, has, sourceOf, sources: SOURCES });
}

module.exports = Object.freeze({ createPathGrants, SOURCES });
