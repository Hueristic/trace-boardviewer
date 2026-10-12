import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { countDescriptionCodePoints, findSensitiveDescriptionDetails, isDescriptionOverLimit, isDescriptionTooLargeToSave, MAX_DESCRIPTION_CODE_POINTS, MAX_DESCRIPTION_RAW_CODE_UNITS, removeSensitiveDescriptionDetails } from './bug-report-description';

const contract = createRequire(import.meta.url)('../../shared/bug-report-contract.cjs') as { MAX_DESCRIPTION_CODE_POINTS: number; MAX_DESCRIPTION_RAW_CODE_UNITS: number };

describe('bug report description privacy helper', () => {
  it('finds common full local paths across Windows, UNC, and POSIX forms', () => {
    const text = 'Windows: C:\\Users\\tech name\\Boards\\A123.brd\nUNC: \\\\fileserver\\share\\repair\\boardview.brd\nMac: /Users/tech/Library/Boards/A123.brd\nLinux: /home/tech/projects/A123.kicad_pcb.';
    const details = findSensitiveDescriptionDetails(text);
    expect(details.map(({ kind }) => kind)).toEqual(['path', 'path', 'path', 'path']);
    expect(details.map(({ start, end }) => text.slice(start, end))).toEqual([
      'C:\\Users\\tech name\\Boards\\A123.brd',
      '\\\\fileserver\\share\\repair\\boardview.brd',
      '/Users/tech/Library/Boards/A123.brd',
      '/home/tech/projects/A123.kicad_pcb',
    ]);
  });

  it('finds complete PEM private key blocks and credential assignments without exposing their contents', () => {
    const privateKey = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_CANARY_27\n-----END PRIVATE KEY-----';
    const text = `key:\n${privateKey}\npassword=synthetic-password-canary-123 token: synthetic-token-canary-456`;
    const details = findSensitiveDescriptionDetails(text);
    expect(details.map(({ kind }) => kind)).toEqual(['private-key', 'credential', 'credential']);
    expect(details.map(({ start, end }) => text.slice(start, end))).toEqual([
      privateKey,
      'synthetic-password-canary-123',
      'synthetic-token-canary-456',
    ]);
    const cleaned = removeSensitiveDescriptionDetails(text, '[removed]');
    expect(cleaned).not.toContain('SYNTHETIC_PRIVATE_CANARY_27');
    expect(cleaned).not.toContain('synthetic-password-canary-123');
    expect(cleaned).not.toContain('synthetic-token-canary-456');
    expect(cleaned).toContain('key:\n[removed]');
  });

  it('recognizes standalone GitHub token prefixes and merges overlapping spans deterministically', () => {
    const githubTokens = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_']
      .map((prefix) => `${prefix}abcdefghijklmnopqrstuvwx`);
    const text = `${githubTokens.join(' ')} then /root/tech/private.txt`;
    const details = findSensitiveDescriptionDetails(text);
    expect(details).toHaveLength(githubTokens.length + 1);
    expect(details.map(({ kind }) => kind)).toEqual([...githubTokens.map(() => 'credential'), 'path']);
    expect(details.map(({ start, end }) => text.slice(start, end))).toEqual([
      ...githubTokens, '/root/tech/private.txt',
    ]);

    const overlap = 'password=/Users/tech/customer-data';
    expect(findSensitiveDescriptionDetails(overlap)).toEqual([
      { start: 9, end: overlap.length, kind: 'credential' },
    ]);
    expect(removeSensitiveDescriptionDetails(overlap, 'x')).toBe('password=x');
  });

  it('uses UTF-16 offsets and preserves Unicode and CRLF exactly', () => {
    const text = '🙂 first\r\nsecond /Users/üser/板子.brd\r\nlast';
    const [detail] = findSensitiveDescriptionDetails(text);
    expect(detail.start).toBe(text.indexOf('/Users/'));
    expect(text.slice(detail.start, detail.end)).toBe('/Users/üser/板子.brd');
    expect(removeSensitiveDescriptionDetails(text, '[redacted]')).toBe('🙂 first\r\nsecond [redacted]\r\nlast');
  });

  it('keeps ordinary references, filenames, commands, and informal descriptions unchanged', () => {
    const examples = [
      'The board U123 rev B has no power.',
      'Please inspect boardview.brd and schematic.pdf.',
      'Run npm test, then open the board again.',
      'I tried a password reset and the screen still freezes.',
      'The URL is https://example.test/help?token=short.',
    ];
    for (const text of examples) {
      expect(findSensitiveDescriptionDetails(text)).toEqual([]);
      expect(removeSensitiveDescriptionDetails(text, '[removed]')).toBe(text);
    }
  });

  it('handles empty text and no matches without changing content', () => {
    expect(findSensitiveDescriptionDetails('')).toEqual([]);
    expect(removeSensitiveDescriptionDetails('', '[removed]')).toBe('');
    expect(findSensitiveDescriptionDetails('The board freezes on startup.')).toEqual([]);
  });

  it('rejects text beyond either documented input limit with a fixed content-free error', () => {
    for (const text of ['x'.repeat(2001), 'é'.repeat(4097)]) {
      expect(() => findSensitiveDescriptionDetails(text)).toThrowError('Unsupported description text.');
      expect(() => removeSensitiveDescriptionDetails(text, '[removed]')).toThrowError('Unsupported description text.');
    }
    expect(() => findSensitiveDescriptionDetails('🙂'.repeat(2001))).toThrowError('Unsupported description text.');
    expect(findSensitiveDescriptionDetails('🙂'.repeat(2000))).toEqual([]);
  });

  it('rejects unsupported control characters and unpaired surrogates predictably', () => {
    for (const text of ['nul\u0000byte', 'delete\u007f', 'lone high \ud800', 'lone low \udc00']) {
      expect(() => findSensitiveDescriptionDetails(text)).toThrowError('Unsupported description text.');
    }
    expect(findSensitiveDescriptionDetails('tab\there\r\nnext line')).toEqual([]);
  });

  it('bounds adversarial text before applying the simple scanners', () => {
    const bounded = `${'x'.repeat(1900)}${'C:\\'.repeat(30)}`;
    expect(() => findSensitiveDescriptionDetails(bounded)).not.toThrow();
    expect(() => findSensitiveDescriptionDetails('x'.repeat(8193))).toThrowError('Unsupported description text.');
  });

  it('removes only the detected path and keeps the sentence around it', () => {
    const cases: Array<[string, string]> = [
      ['Board C:\\Users\\tech\\A123.brd does not power on.', 'Board [removed] does not power on.'],
      ['Saved to /home/tech/projects/A123.brd, please check.', 'Saved to [removed], please check.'],
      ['Share \\\\fileserver\\share\\repair\\boardview.brd then retry', 'Share [removed] then retry'],
      ['Stored at C:\\Users\\tech name\\Boards\\My Board Rev B.brd today', 'Stored at [removed] today'],
      ['Folder C:\\Users\\tech\\Boards\\ is empty', 'Folder [removed] is empty'],
    ];
    for (const [text, expected] of cases) {
      expect(removeSensitiveDescriptionDetails(text, '[removed]'), text).toBe(expected);
    }
  });

  it('detects home-relative and drive-less relative paths', () => {
    const cases: Array<[string, string]> = [
      ['Copy ~/Boards/A123.brd to the bench.', '~/Boards/A123.brd'],
      ['Use ~\\Boards\\A123.brd today', '~\\Boards\\A123.brd'],
      ['Look in Boards\\Dell\\A123.brd and retry.', 'Boards\\Dell\\A123.brd'],
      ['Missing files: boards/A123/notes.txt', 'boards/A123/notes.txt'],
      ['Try boards/A123.brd once.', 'boards/A123.brd'],
    ];
    for (const [text, value] of cases) {
      const details = findSensitiveDescriptionDetails(text);
      expect(details.map(({ kind }) => kind), text).toEqual(['path']);
      expect(text.slice(details[0].start, details[0].end), text).toBe(value);
    }
  });

  it('does not redact ordinary slash-separated words, ratios, dates, or times', () => {
    const texts = [
      'Read/write mode and I/O errors on the TCP/IP stack.',
      'Ask and/or call the tech at 9:30 on 10/11/2026 or 3/4 load.',
      'The file is only named boardview.brd and nothing else.',
      'Press ~ then c/o the lab; see 2.1/3.4 and e.g. the manual.',
    ];
    for (const text of texts) {
      expect(findSensitiveDescriptionDetails(text), text).toEqual([]);
      expect(removeSensitiveDescriptionDetails(text, '[removed]'), text).toBe(text);
    }
  });

  it('counts code points against the contract limits and never changes the text', () => {
    expect(MAX_DESCRIPTION_CODE_POINTS).toBe(contract.MAX_DESCRIPTION_CODE_POINTS);
    expect(MAX_DESCRIPTION_RAW_CODE_UNITS).toBe(contract.MAX_DESCRIPTION_RAW_CODE_UNITS);
    const overLimit = '🙂'.repeat(MAX_DESCRIPTION_CODE_POINTS + 1);
    expect(countDescriptionCodePoints(overLimit)).toBe(MAX_DESCRIPTION_CODE_POINTS + 1);
    expect(isDescriptionOverLimit(overLimit)).toBe(true);
    expect(isDescriptionOverLimit('🙂'.repeat(MAX_DESCRIPTION_CODE_POINTS))).toBe(false);
    expect(isDescriptionOverLimit('short text')).toBe(false);
    // 2001 emoji are 4002 UTF-16 units: over the review limit, but still allowed as a saved draft.
    expect(isDescriptionTooLargeToSave(overLimit)).toBe(false);
    expect(isDescriptionTooLargeToSave('x'.repeat(MAX_DESCRIPTION_RAW_CODE_UNITS))).toBe(false);
    expect(isDescriptionTooLargeToSave('x'.repeat(MAX_DESCRIPTION_RAW_CODE_UNITS + 1))).toBe(true);
    // The helpers only report; the text they examine is still whole.
    expect(overLimit).toHaveLength(2 * (MAX_DESCRIPTION_CODE_POINTS + 1));
  });

  // Privacy: over-redacting is preferred to leaking. Each shape is checked on Windows, macOS and Linux forms.
  it.each([
    ['Windows absolute, no extension', 'Saved to C:\\Users\\tech\\Customer Board, please check.', 'Saved to [removed], please check.'],
    ['macOS absolute, no extension', 'Copied to /Users/tech/Customer Board, please check.', 'Copied to [removed], please check.'],
    ['Linux absolute, no extension', 'Copied to /home/tech/Customer Board, please check.', 'Copied to [removed], please check.'],
    ['UNC share, no extension at end of text', 'Share \\\\fileserver\\share\\Customer Board', 'Share [removed]'],
    // A name without an extension runs up to ten words, so the lower-case "now" is taken too: over-redaction, not a leak.
    ['home-relative, no extension', 'Open ~/My Boards/Customer Board now', 'Open [removed]'],
    ['Windows relative, spaced directory', 'See Dell Boards\\A123.brd and retry', 'See [removed] and retry'],
    ['POSIX-style relative, spaced directory', 'See Dell Boards/A123.brd and retry', 'See [removed] and retry'],
  ])('redacts the whole spaced name: %s', (_name, text, expected) => {
    expect(removeSensitiveDescriptionDetails(text, '[removed]')).toBe(expected);
  });

  it('detects a schemeless URL host with a path as a whole, but not as a file path', () => {
    const cases: Array<[string, string]> = [
      ['Open www.site.com/a/b now', 'Open [removed] now'],
      ['Visit example.test/help/page.html for details', 'Visit [removed] for details'],
    ];
    for (const [text, expected] of cases) {
      expect(removeSensitiveDescriptionDetails(text, '[removed]'), text).toBe(expected);
      const details = findSensitiveDescriptionDetails(text);
      expect(details.map(({ kind }) => kind), text).toEqual(['url']);
    }
  });

  it('keeps a scheme URL unchanged, as the contract examples require', () => {
    expect(findSensitiveDescriptionDetails('Open https://www.site.com/a/b now')).toEqual([]);
  });

  it('still detects a slash-separated file name with an extension as a path, on purpose', () => {
    const text = 'Read input/output.log after the run.';
    const details = findSensitiveDescriptionDetails(text);
    expect(details.map(({ kind }) => kind)).toEqual(['path']);
    expect(text.slice(details[0].start, details[0].end)).toBe('input/output.log');
  });

  it('keeps abbreviations, ratios and version pairs that only look like hosts', () => {
    for (const text of ['Compare 2.1/3.4 and e.g./i.e. values, version 1.0/2.0.', 'Read input/output.log after the run.']) {
      const details = findSensitiveDescriptionDetails(text);
      expect(details.every(({ kind }) => kind !== 'url'), text).toBe(true);
    }
    expect(findSensitiveDescriptionDetails('Compare 2.1/3.4 and e.g./i.e. values.')).toEqual([]);
  });
});
