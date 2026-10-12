/**
 * Platform-aware relative paths for the device catalogue. Pure: no Node imports, so the same code runs in the library service,
 * in the sandboxed indexer page and in tests.
 *
 * Separators: "/" separates segments on every platform. "\" separates segments only on win32; on darwin and linux a backslash
 * is an ordinary character of a file name. Stored paths are canonical "/"-joined segments relative to the selected root; the
 * original spelling of each name is kept by the caller. Identity keys are for comparison only and never replace the name.
 */

export type DevicePlatform = 'win32' | 'darwin' | 'linux';

/** A path deeper than this is refused rather than walked; the walker also stops at its own depth limit. */
export const MAX_RELATIVE_SEGMENTS = 64;
/** Text longer than this is not normalised for search; the caller gets a truncated key instead of an unbounded scan. */
const MAX_SEARCH_TEXT = 1024;

export type RelativePathResult =
  | { ok: true; segments: string[] }
  | { ok: false; reason: 'empty' | 'absolute' | 'drive' | 'escapes-root' | 'too-deep' };

/**
 * Splits a relative path into segments. Empty and "." segments are dropped. A ".." segment, a leading separator, a Windows drive
 * prefix (win32 only) or more than MAX_RELATIVE_SEGMENTS segments is refused, so the result always stays inside its root.
 */
export function parseRelativePath(input: string, platform: DevicePlatform): RelativePathResult {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'empty' };
  const win = platform === 'win32';
  if (input.startsWith('/') || (win && input.startsWith('\\'))) return { ok: false, reason: 'absolute' };
  if (win && /^[A-Za-z]:/.test(input)) return { ok: false, reason: 'drive' };
  const parts = win ? input.split(/[\\/]/) : input.split('/');
  const segments: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') return { ok: false, reason: 'escapes-root' };
    segments.push(part);
  }
  if (segments.length === 0) return { ok: false, reason: 'empty' };
  if (segments.length > MAX_RELATIVE_SEGMENTS) return { ok: false, reason: 'too-deep' };
  return { ok: true, segments };
}

/** The canonical stored form of a relative path: segments joined with "/". */
export function canonicalPath(segments: readonly string[]): string {
  return segments.join('/');
}

/**
 * Comparison key of a relative path. Only win32 folds case: NTFS never keeps two names that differ only by case in one folder.
 * darwin and linux compare exactly. A darwin volume may be case-sensitive (APFS can be), and the code cannot know the volume's
 * policy, so folding there would merge two different files. On a case-insensitive darwin volume the stored spelling of each entry
 * is stable, so exact keys still identify each file. The key is never shown as a name and never used to open a file.
 *
 * Decision (D8): darwin keys stay exact. A correction that names a spelling of an existing file which differs only
 * by letter case or Unicode normalisation is not redirected and not reported as missing either: it is a case-collision that needs
 * a manual confirmation (see `spellingKey` and catalogue.ts). win32 and linux are unchanged.
 */
export function identityKey(segments: readonly string[], platform: DevicePlatform): string {
  const joined = canonicalPath(segments);
  return platform === 'win32' ? joined.toLowerCase() : joined;
}

/**
 * A coarse spelling key of a canonical path: Unicode NFC, then lower case. Used only to find candidate files for a correction whose
 * exact target is missing on darwin. It never decides identity (that is `identityKey`), so two files that share it stay separate.
 */
export function spellingKey(canonical: string): string {
  return canonical.normalize('NFC').toLowerCase();
}

/**
 * Keys that two or more distinct paths share. Such entries are collisions: the caller keeps each of them as its own state and
 * never merges, matches or overwrites one of them through the shared key. A path listed twice is not a collision. Linear.
 */
export function collidingKeys(entries: Iterable<{ key: string; path: string }>): Set<string> {
  const first = new Map<string, string>();
  const colliding = new Set<string>();
  for (const entry of entries) {
    const seen = first.get(entry.key);
    if (seen === undefined) first.set(entry.key, entry.path);
    else if (seen !== entry.path) colliding.add(entry.key);
  }
  return colliding;
}

/**
 * Search key of free text (folder, file or alias names): NFKD, combining marks removed (accents), the Polish stroke letters ł and Ł
 * folded to l and L (NFKD does not decompose them), lower case, and separators (space, "_", "-", ".", slashes) unified to one
 * space. Linear in the length of the text, which is cut at MAX_SEARCH_TEXT.
 */
export function searchKey(text: string): string {
  if (typeof text !== 'string') return '';
  const cut = text.length > MAX_SEARCH_TEXT ? text.slice(0, MAX_SEARCH_TEXT) : text;
  return cut.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[łŁ]/g, 'l').toLowerCase().replace(/[\s_\-./\\]+/g, ' ').trim();
}

/** The last segment (file or folder name) of a canonical path. */
export function baseName(canonical: string): string {
  const index = canonical.lastIndexOf('/');
  return index < 0 ? canonical : canonical.slice(index + 1);
}

/** Lower-cased extension without the dot; "" when the name has none (a leading dot is not an extension). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}
