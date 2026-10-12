import { DEFAULT_LIBRARY_SETTINGS, type LibrarySettings, type RegisteredRoot, type StoredDecision } from '../../lib/library/model';
import { validateMainToService } from '../../lib/library/validate';
import { isStoredDecision, parseDecisionFile } from './decisions';

export const SETTINGS_FILE_NAME = 'library-settings.json';
export const DECISIONS_FILE_NAME = 'library-decisions.json';
const SETTINGS_LIMIT = 8 * 1024 * 1024;
const DECISIONS_LIMIT = 64 * 1024 * 1024;

/** The main process injects its existing queued atomic JSON store, configured with a 64 MiB maximum and the profile directory. */
export interface ProfileJsonStore {
  read(name: string, options: { maxBytes: number }): Promise<unknown>;
  write(name: string, value: unknown, options: { maxBytes: number }): Promise<void>;
  update(name: string, updater: (current: unknown) => unknown, options: { maxBytes: number }): Promise<unknown>;
  flush(): Promise<void>;
  beginShutdown(): Promise<void>;
}

export interface LibraryProfileSettings { version: 1; settings: LibrarySettings; roots: RegisteredRoot[] }
const defaults = (): LibraryProfileSettings => ({ version: 1, settings: { ...DEFAULT_LIBRARY_SETTINGS }, roots: [] });

export class InvalidProfileError extends Error {
  readonly code = 'invalid-profile';
  constructor() { super('Invalid Library profile data'); }
}

function settingsValue(value: unknown): LibraryProfileSettings {
  if (value === null) return defaults();
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) throw new InvalidProfileError();
  const v = value as LibraryProfileSettings;
  if (Object.keys(v).some(k => !['version', 'settings', 'roots'].includes(k)) || v.version !== 1 ||
      !validateMainToService({ version: 1, type: 'configure', settings: v.settings, roots: v.roots, generation: 0 }) ||
      new Set(v.roots.map(r => r.id)).size !== v.roots.length || new Set(v.roots.map(r => r.realpath)).size !== v.roots.length) throw new InvalidProfileError();
  return structuredClone(v);
}

function decisionValue(value: unknown): StoredDecision[] {
  if (value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value) || (value as { version?: unknown }).version !== 1 ||
      Object.keys(value).some(k => k !== 'version' && k !== 'decisions') ||
      !Array.isArray((value as { decisions?: unknown }).decisions)) throw new InvalidProfileError();
  const parsed = parseDecisionFile(JSON.stringify(value));
  if (parsed.dropped) throw new InvalidProfileError();
  return parsed.decisions;
}

function durable(decision: StoredDecision): boolean {
  return isStoredDecision(decision) &&
    (!['merge', 'split', 'label', 'tag'].includes(decision.decision.kind) || decision.targets.length > 0);
}

/** Main-owned user data. The database reads decisions but never writes these files; deleting or rebuilding it preserves both. */
export class LibraryProfileStore {
  constructor(private readonly store: ProfileJsonStore) {}

  async loadSettings(): Promise<LibraryProfileSettings> {
    return settingsValue(await this.store.read(SETTINGS_FILE_NAME, { maxBytes: SETTINGS_LIMIT }));
  }

  saveSettings(value: LibraryProfileSettings): Promise<void> {
    const snapshot = settingsValue(value);
    return this.store.update(SETTINGS_FILE_NAME, current => { settingsValue(current); return snapshot; }, { maxBytes: SETTINGS_LIMIT }).then(() => undefined);
  }

  async loadDecisions(): Promise<StoredDecision[]> {
    return decisionValue(await this.store.read(DECISIONS_FILE_NAME, { maxBytes: DECISIONS_LIMIT }));
  }

  async appendDecision(value: StoredDecision): Promise<void> {
    if (!durable(value)) throw new InvalidProfileError();
    const snapshot = structuredClone(value);
    await this.store.update(DECISIONS_FILE_NAME, current => {
      const decisions = decisionValue(current).filter(d => d.id !== snapshot.id);
      if (decisions.length >= 200_000) throw new InvalidProfileError();
      return { version: 1, decisions: [...decisions, snapshot] };
    }, { maxBytes: DECISIONS_LIMIT });
  }

  /** Call only after the service has stopped and deleted its index. Both user-data files are preserved by default. */
  async forgetData(options: { keepRoots?: boolean; keepCorrections?: boolean } = {}): Promise<void> {
    if (options.keepRoots === false) await this.store.update(SETTINGS_FILE_NAME, current => ({ ...settingsValue(current), roots: [] }), { maxBytes: SETTINGS_LIMIT });
    if (options.keepCorrections === false) await this.store.write(DECISIONS_FILE_NAME, { version: 1, decisions: [] }, { maxBytes: DECISIONS_LIMIT });
  }

  flush(): Promise<void> { return this.store.flush(); }
  beginShutdown(): Promise<void> { return this.store.beginShutdown(); }
}
