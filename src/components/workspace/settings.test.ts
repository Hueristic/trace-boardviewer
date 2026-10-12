import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savedSettings, defaults, startupLanguage } from './settings';

/**
 * Renderer-side settings normalization (the browser-only dev mode keeps the same object in localStorage, and the desktop app runs whatever the main process
 * returns through it). The main process validates the same field in electron/main.cjs; tests/desktop-checks.cjs covers that half.
 */
beforeEach(() => { vi.stubGlobal('navigator', { languages: ['en-US'] }); });
afterEach(() => { vi.unstubAllGlobals(); });

const stored = { language: 'de', theme: 'light', layout: 'focus', motion: false, showLabels: false, showConnections: false };

describe('startupLanguage: the first frame is in the saved language (TB-041)', () => {
  it('a saved language wins over the system language, so the first paint does not flash the detected one', () => {
    expect(startupLanguage('de', ['hu-HU'])).toBe('de');
    expect(startupLanguage('pl', ['en-GB'])).toBe('pl');
  });

  it('without a saved language (a new profile, or a file that could not be read) the system language is used', () => {
    expect(startupLanguage(null, ['pl-PL'])).toBe('pl');
    expect(startupLanguage(undefined, ['pl-PL'])).toBe('pl');
  });

  it('an unusable saved value falls back to the system language, never to an invented one', () => {
    expect(startupLanguage('xx', ['de-DE'])).toBe('de');
    expect(startupLanguage(42, ['de-DE'])).toBe('de');
  });
});

describe('updateCheck', () => {
  it('is off by default, and the first-start question is not yet asked, in the defaults and for a fresh profile', () => {
    expect(defaults.updateCheck).toBe(false);
    expect(defaults.updateCheckAsked).toBe(false);
    expect(savedSettings({}, true).updateCheck).toBe(false);
    expect(savedSettings(undefined).updateCheck).toBe(false);
    expect(savedSettings(null).updateCheckAsked).toBe(false);
  });

  it('a profile saved before this release has neither field and gets false for both; every other stored setting is kept', () => {
    expect(savedSettings(stored)).toEqual({ ...stored, updateCheck: false, updateCheckAsked: false });
  });

  it('a stored boolean is kept, true and false alike, for the check and for the answered question', () => {
    expect(savedSettings({ ...stored, updateCheck: false, updateCheckAsked: true })).toEqual({ ...stored, updateCheck: false, updateCheckAsked: true });
    expect(savedSettings({ ...stored, updateCheck: true, updateCheckAsked: true })).toEqual({ ...stored, updateCheck: true, updateCheckAsked: true });
  });

  it('a damaged stored value falls back to its default (false) WITHOUT resetting the other settings', () => {
    for (const bad of ['false', 'true', 'yes', 0, 1, null, [], {}, NaN]) {
      expect(savedSettings({ ...stored, updateCheck: bad }), String(JSON.stringify(bad))).toEqual({ ...stored, updateCheck: false, updateCheckAsked: false });
      expect(savedSettings({ ...stored, updateCheckAsked: bad }), String(JSON.stringify(bad))).toEqual({ ...stored, updateCheck: false, updateCheckAsked: false });
    }
  });

  it('a damaged value elsewhere does not touch it (each field is checked on its own)', () => {
    expect(savedSettings({ ...stored, theme: 'purple', motion: 'yes', updateCheck: true, updateCheckAsked: true })).toEqual({ ...stored, theme: 'dark', motion: true, updateCheck: true, updateCheckAsked: true });
  });

  it('a stored value that is not an object at all gives the defaults, update check included', () => {
    for (const value of ['text', 42, [], [{ updateCheck: true }], true]) {
      expect(savedSettings(value).updateCheck, JSON.stringify(value)).toBe(false);
      expect(savedSettings(value).updateCheckAsked, JSON.stringify(value)).toBe(false);
    }
  });

  it('the settings object has exactly the six old fields plus updateCheck and updateCheckAsked', () => {
    expect(Object.keys(savedSettings({})).sort()).toEqual(['language', 'layout', 'motion', 'showConnections', 'showLabels', 'theme', 'updateCheck', 'updateCheckAsked']);
  });

  it('main.cjs and the renderer agree on the defaults (check off, question not asked)', () => {
    const main = readFileSync(new URL('../../../electron/main.cjs', import.meta.url), 'utf8');
    expect(main).toMatch(/DEFAULT_SETTINGS = Object\.freeze\(\{[^}]*updateCheck: false, updateCheckAsked: false[^}]*\}\)/);
  });
});
