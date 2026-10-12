import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIBRARY_SETTINGS, type StoredDecision } from '../../lib/library/model';
import { LibraryProfileStore, InvalidProfileError, type ProfileJsonStore } from './settings';
import { LibraryDb, libraryDbPath } from './index';
import { syntheticRoot } from './synthetic';

const { createJsonStore } = createRequire(import.meta.url)('../../../electron/store.cjs');
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function profile() {
  const directory = mkdtempSync(join(tmpdir(), 'trace-lib-profile-'));
  directories.push(directory);
  const store: ProfileJsonStore = createJsonStore({ directory, trusted: true, maxBytes: 64 * 1024 * 1024 });
  return { directory, store, profile: new LibraryProfileStore(store) };
}
const correction = (id: string): StoredDecision => ({ id, at: 1, targets: [], decision: { kind: 'hide', target: { kind: 'file', rootId: 'r1', relativePath: 'board.brd' }, hidden: true } });

describe('main-owned Library profile', () => {
  it('loads defaults without creating files and preserves independent roots and corrections across deletion', async () => {
    const p = profile();
    expect(await p.profile.loadSettings()).toEqual({ version: 1, settings: DEFAULT_LIBRARY_SETTINGS, roots: [] });
    expect(await p.profile.loadDecisions()).toEqual([]);
    const settings = { version: 1 as const, settings: { ...DEFAULT_LIBRARY_SETTINGS }, roots: [syntheticRoot('r1', join(p.directory, 'originals'))] };
    await p.profile.saveSettings(settings);
    await p.profile.appendDecision(correction('x1'));
    const before = readFileSync(join(p.directory, 'library-decisions.json'));
    const db = LibraryDb.open({ path: libraryDbPath(p.directory) });
    db.deleteIndex();
    await p.profile.forgetData();
    expect(await p.profile.loadSettings()).toEqual(settings);
    expect(readFileSync(join(p.directory, 'library-decisions.json'))).toEqual(before);
    await p.profile.forgetData({ keepRoots: false, keepCorrections: false });
    expect((await p.profile.loadSettings()).roots).toEqual([]);
    expect(await p.profile.loadDecisions()).toEqual([]);
  });

  it('queues concurrent decisions without lost updates and drains on shutdown', async () => {
    const p = profile();
    const writes = Array.from({ length: 20 }, (_, i) => p.profile.appendDecision(correction(`x${i}`)));
    const closed = p.profile.beginShutdown();
    await Promise.all(writes);
    await closed;
    expect(await p.profile.loadDecisions()).toHaveLength(20);
    await expect(p.profile.appendDecision(correction('late'))).rejects.toMatchObject({ code: 'STORE_CLOSING' });
  });

  it('refuses invalid settings and ephemeral group-only decisions before writing', async () => {
    const p = profile();
    expect(() => p.profile.saveSettings({ version: 2 } as never)).toThrow(InvalidProfileError);
    await expect(p.profile.appendDecision({ id: 'x1', at: 1, targets: [], decision: { kind: 'label', groupId: 'g1', label: 'Board' } })).rejects.toThrow(InvalidProfileError);
    writeFileSync(join(p.directory, 'library-decisions.json'), '{"version":2,"decisions":[]}');
    await expect(p.profile.appendDecision(correction('x1'))).rejects.toThrow(InvalidProfileError);
    expect(readFileSync(join(p.directory, 'library-decisions.json'), 'utf8')).toBe('{"version":2,"decisions":[]}');
    writeFileSync(join(p.directory, 'library-settings.json'), '{"version":2}');
    await expect(p.profile.saveSettings({ version: 1, settings: { ...DEFAULT_LIBRARY_SETTINGS }, roots: [] })).rejects.toThrow(InvalidProfileError);
    expect(readFileSync(join(p.directory, 'library-settings.json'), 'utf8')).toBe('{"version":2}');
  });
});
