/** A sensitive span in the original description, using JavaScript UTF-16 offsets. */
export type SensitiveDescriptionDetail = Readonly<{
  start: number;
  end: number;
  kind: 'path' | 'url' | 'private-key' | 'credential';
}>;

/** The longest description the contract accepts, counted in code points (an emoji or accented letter counts once). */
export const MAX_DESCRIPTION_CODE_POINTS = 2000;
/** The largest description the draft store and the receiver accept, in UTF-16 units (the contract's raw limit). */
export const MAX_DESCRIPTION_RAW_CODE_UNITS = 8192;

const MAX_UTF8_BYTES = 8192;
const MAX_REPLACEMENT_CODE_POINTS = 128;
const UNSUPPORTED_TEXT = 'Unsupported description text.';

type Candidate = { start: number; end: number; kind: SensitiveDescriptionDetail['kind'] };

/** Counts the characters the form shows: code points, so one emoji counts once. */
export function countDescriptionCodePoints(text: string): number {
  return Array.from(text).length;
}

/** True when the text is longer than the review and send limit. The text is never changed or cut. */
export function isDescriptionOverLimit(text: string): boolean {
  return countDescriptionCodePoints(text) > MAX_DESCRIPTION_CODE_POINTS;
}

/** True when the text is too large to save as a draft. Such text is always over the review limit too. */
export function isDescriptionTooLargeToSave(text: string): boolean {
  return text.length > MAX_DESCRIPTION_RAW_CODE_UNITS;
}

/**
 * Enforces the description boundary without normalizing it. CR, LF, and tab are
 * retained as entered; other control characters and unpaired surrogates fail
 * with one fixed, content-free error.
 */
function validateText(text: string, maxCodePoints = MAX_DESCRIPTION_CODE_POINTS): void {
  if (typeof text !== 'string') throw new TypeError(UNSUPPORTED_TEXT);
  let bytes = 0;
  let points = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(UNSUPPORTED_TEXT);
      index += 1;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(UNSUPPORTED_TEXT);
    } else {
      if ((unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) || (unit >= 0x7f && unit <= 0x9f)) {
        throw new TypeError(UNSUPPORTED_TEXT);
      }
      bytes += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
    }
    points += 1;
    if (points > maxCodePoints || bytes > MAX_UTF8_BYTES) throw new RangeError(UNSUPPORTED_TEXT);
  }
}

function trimPathEnd(text: string, start: number, end: number): number {
  while (end > start && /[),.;!?\]}]/.test(text[end - 1])) end -= 1;
  return end;
}

function addMatches(candidates: Candidate[], text: string, pattern: RegExp, kind: Candidate['kind'], capture = 0): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index + (capture ? match[0].lastIndexOf(match[capture] ?? '') : 0);
    const value = capture ? match[capture] : match[0];
    if (!value) continue;
    let end = start + value.length;
    if (kind === 'path' || kind === 'url') end = trimPathEnd(text, start, end);
    if (end > start) candidates.push({ start, end, kind });
    // Every expression is non-empty, but keep this guard explicit if one changes.
    if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + match[0].length + 1;
  }
}

// Path grammar. A name holds no whitespace and no character that a file name cannot have. A space may join the words
// of a directory name, but only after an anchor (drive, server, "~", or a root such as /home/) and only when a separator
// closes the name. A path therefore ends where its last name ends, and the sentence after it is kept.
const NAME = String.raw`[^\\/:*?"<>|\r\n\t\s]+`;
const DIRECTORY = String.raw`${NAME}(?: ${NAME})*[\\/]`;
// A file name ends at a short extension ("My Board Rev B.brd"), so the text after it is kept. A name without an extension
// ("Customer Board") takes up to ten words: over-redaction is preferred to a name that leaks.
// A later word of a name without an extension stops at a comma, a semicolon, a question or exclamation mark, or a full stop.
const NAME_WORD = String.raw`[^\\/:*?"<>|\r\n\t\s,;!?.]+`;
const LEAF = String.raw`(?:${NAME}(?: ${NAME}){0,3}?\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_])|${NAME}(?: ${NAME_WORD}){0,9})`;
const POSIX_NAME = String.raw`[^\/\s<>"'|?*]+`;
const POSIX_WORD = String.raw`[^\/\s<>"'|?*,;!?.]+`;
const POSIX_DIRECTORY = String.raw`${POSIX_NAME}(?: ${POSIX_NAME})*\/`;
const POSIX_LEAF = String.raw`(?:${POSIX_NAME}(?: ${POSIX_NAME}){0,3}?\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_])|${POSIX_NAME}(?: ${POSIX_WORD}){0,9})`;
// Drive-less relative paths have no anchor, so their names take no key=value or list punctuation: otherwise
// "password=dir/file" would be read as one path. Up to three words may join a directory name ("Dell Boards\A123.brd").
// A file needs an extension of at least two letters or digits ("i.e" is not one). Two separators without an extension count too.
// "~" never belongs to a relative name (it starts a home path). A directory name either has no space, or has exactly two words
// that both start with a capital letter or a digit ("Dell Boards"), so "in Boards" keeps its "in". A word with a space in a
// file name must also start with a capital letter or a digit; a lower-case word after a space ends the file name.
const RELATIVE_NAME = String.raw`[^\\/:*?"<>|\r\n\t\s=&,;'()\[\]{}~]+`;
const RELATIVE_CAPITAL = String.raw`[A-Z0-9][^\\/:*?"<>|\r\n\t\s=&,;'()\[\]{}~.]*`;
const RELATIVE_DIRECTORY = String.raw`(?:${RELATIVE_NAME}|${RELATIVE_CAPITAL} ${RELATIVE_CAPITAL})[\\/]`;
const RELATIVE_FILE = String.raw`${RELATIVE_NAME}(?: ${RELATIVE_CAPITAL}){0,2}?\.[A-Za-z0-9]{2,8}(?![A-Za-z0-9_])`;
// A schemeless host followed by a path ("www.site.com/a/b"). It is not a file path: the whole token is one detail, host included.
const SCHEMELESS_HOST = String.raw`[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\/`;

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const WINDOWS_PATH = new RegExp(String.raw`\b[A-Za-z]:\\(?:${DIRECTORY})*${LEAF}?`, 'g');
const UNC_PATH = new RegExp(String.raw`(?:\\\\|(?<!:)\/\/)${NAME}[\\/](?:${DIRECTORY})*${LEAF}`, 'g');
const POSIX_HOME_PATH = new RegExp(String.raw`(?:^|[\s("'=])(\/(?:home|Users|user|root|private|Volumes|mnt|media|tmp|var|opt)\/(?:${POSIX_DIRECTORY})*${POSIX_LEAF})`, 'gm');
const HOME_PATH = new RegExp(String.raw`(?<![\w.~])~[\\/](?:${DIRECTORY})*${LEAF}`, 'g');
// Two directories without an extension need a letter in the last name, so a date such as 10/11/2026 is not a path.
const RELATIVE_PATH = new RegExp(String.raw`(?<![\w.~\-\\/:=])(?=[A-Za-z_])(?!${SCHEMELESS_HOST})(?:(?:${RELATIVE_DIRECTORY}){2,}(?=[^\\/:*?"<>|\r\n\t\s=&,;'()\[\]{}~]*[A-Za-z_])${RELATIVE_NAME}|${RELATIVE_DIRECTORY}${RELATIVE_FILE})`, 'g');
const SCHEMELESS_URL = new RegExp(String.raw`(?<![\w.@\/:\\-])${SCHEMELESS_HOST}[^\s<>"'\\]*`, 'g');
const CREDENTIAL_ASSIGNMENT = /\b(?:password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|client[_-]?secret|authorization)\b\s*[:=]\s*(["']?)([^\s"'&,;]{8,})/gi;
const KNOWN_TOKEN = /\b(?:[sr]k[_-](?:live|test|ant|proj|svcacct)[_-]|gh[pousr]_|github_pat[_-]|xox[baprs]-)[A-Za-z0-9_-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[A-Za-z0-9_-]{30,}\b/g;

const KIND_ORDER: Record<Candidate['kind'], number> = { path: 0, url: 0, credential: 1, 'private-key': 2 };

function collectDetails(text: string): SensitiveDescriptionDetail[] {
  const candidates: Candidate[] = [];
  addMatches(candidates, text, PRIVATE_KEY, 'private-key');
  addMatches(candidates, text, WINDOWS_PATH, 'path');
  addMatches(candidates, text, UNC_PATH, 'path');
  addMatches(candidates, text, POSIX_HOME_PATH, 'path', 1);
  addMatches(candidates, text, HOME_PATH, 'path');
  addMatches(candidates, text, SCHEMELESS_URL, 'url');
  // A drive-less relative match is kept only where no anchored path or URL already covers its text, so it never extends one.
  const relative: Candidate[] = [];
  addMatches(relative, text, RELATIVE_PATH, 'path');
  for (const candidate of relative) {
    if (!candidates.some(other => candidate.start < other.end && other.start < candidate.end)) candidates.push(candidate);
  }
  addMatches(candidates, text, CREDENTIAL_ASSIGNMENT, 'credential', 2);
  addMatches(candidates, text, KNOWN_TOKEN, 'credential');
  candidates.sort((left, right) => left.start - right.start || right.end - left.end || KIND_ORDER[right.kind] - KIND_ORDER[left.kind]);

  const merged: Candidate[] = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    if (previous && candidate.start < previous.end) {
      previous.end = Math.max(previous.end, candidate.end);
      if (KIND_ORDER[candidate.kind] > KIND_ORDER[previous.kind]) previous.kind = candidate.kind;
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged.map(({ start, end, kind }) => Object.freeze({ start, end, kind }));
}

/** Finds obvious local paths, PEM private-key blocks, and credential-like values. */
export function findSensitiveDescriptionDetails(text: string): readonly SensitiveDescriptionDetail[] {
  validateText(text);
  return Object.freeze(collectDetails(text));
}

/** Replaces only detected spans; all text outside those spans is preserved exactly. */
export function removeSensitiveDescriptionDetails(text: string, replacement: string): string {
  validateText(text);
  validateText(replacement, MAX_REPLACEMENT_CODE_POINTS);
  const details = collectDetails(text);
  if (details.length === 0) return text;

  const parts: string[] = [];
  let cursor = 0;
  for (const detail of details) {
    parts.push(text.slice(cursor, detail.start), replacement);
    cursor = detail.end;
  }
  parts.push(text.slice(cursor));
  const result = parts.join('');
  validateText(result);
  return result;
}
