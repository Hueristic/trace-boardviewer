import { describe, expect, it, vi } from 'vitest';
import type { LibraryScanSummary } from '../../types';
import type { CorrectionDocument } from './corrections';
import type { PortCorrection } from './ui-port';
import {
  BridgePortError, coverageOf, createBridgeDevicePort, devicePlatformOf, resultOf, skippedStepsOf, windowDevicePort,
  type LibraryBridge,
} from './bridge-port';
import type { DeviceEvent, ScanProgressView } from './ui-port';

/** Synthetic fixtures only: root ids and file names are invented. */
const ROOT_A = 'root-a';
const ROOT_B = 'root-b';

function summary(overrides: Partial<LibraryScanSummary> = {}): LibraryScanSummary {
  return {
    steps: { folderMap: 'ran', nameIdentity: 'ran', biosCandidates: 'skipped', matching: 'ran', corrections: 'ran' },
    roots: [
      { rootId: ROOT_A, complete: true, scanned: true, folderCount: 2, fileCount: 5, skippedCount: 1 },
      { rootId: ROOT_B, complete: false, scanned: true, folderCount: 1, fileCount: 2, skippedCount: 0 },
    ],
    fileCount: 7,
    associationCount: 3,
    missingTargetCount: 1,
    excludedFirmwareCount: 2,
    collisionCount: 0,
    needsManualCount: 0,
    stats: { folders: 3, files: 7, entries: 9, match: { files: 7, candidates: 4, judgments: 4, linkSteps: 2 } },
    correctionsStatus: 'ok',
    scanId: 'synthetic-scan',
    skippedByRequest: [],
    complete: true,
    anchorCount: 0,
    manualClassificationCount: 0,
    ...overrides,
  };
}

const EMPTY_DOCUMENT: CorrectionDocument = { version: 1, platform: 'linux', corrections: [] };
const LINK: PortCorrection = { op: 'link', fileId: 'file-1', boardAnchorId: 'anchor-1' };
const ROLE: PortCorrection = { op: 'role', fileId: 'file-1', role: 'boardview' };

/** A bridge whose scan waits for the test to settle it. */
function fakeBridge(overrides: Partial<LibraryBridge> = {}) {
  let stored: CorrectionDocument | null = null;
  let settleScan: ((value: LibraryScanSummary) => void) | undefined;
  let rejectScan: ((error: Error) => void) | undefined;
  const bridge = {
    libraryPickRoot: vi.fn(async () => ({ rootId: ROOT_A, label: 'Synthetic folder' })),
    libraryScan: vi.fn(() => new Promise<LibraryScanSummary>((resolve, reject) => { settleScan = resolve; rejectScan = reject; })),
    libraryCancelScan: vi.fn(async () => ({ cancelled: true })),
    // The stored document is remembered, as the store does: a load returns the last saved document.
    libraryLoadCorrections: vi.fn(async () => ({ status: stored === null ? 'empty' : 'ok', document: stored ?? EMPTY_DOCUMENT, dropped: 0, rejections: [] })),
    librarySaveCorrections: vi.fn(async (document: CorrectionDocument) => { stored = document; return { status: 'saved' as const, bytes: 10 }; }),
    ...overrides,
  };
  return {
    bridge,
    finishScan: (value: LibraryScanSummary) => settleScan?.(value),
    failScan: (error: Error) => rejectScan?.(error),
  };
}

// Lets the promise callbacks of the adapter run (a microtask flush, not a timing wait).
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('platform and coverage helpers', () => {
  it.each([
    [{ platform: 'Win32' }, 'win32'],
    [{ platform: 'win32' }, 'win32'],
    [{ userAgentData: { platform: 'Windows' } }, 'win32'],
    [{ platform: 'darwin' }, 'darwin'],
    [{ platform: 'Darwin' }, 'darwin'],
    [{ userAgentData: { platform: 'macOS' } }, 'darwin'],
    [{ platform: 'MacIntel' }, 'darwin'],
    [{ platform: 'Linux x86_64' }, 'linux'],
    [undefined, 'linux'],
  ] as const)('maps %j to %s', (source, expected) => {
    expect(devicePlatformOf(source)).toBe(expected);
  });

  it('maps the scan flags of a root to its coverage', () => {
    expect(coverageOf(true, true)).toBe('complete');
    expect(coverageOf(true, false)).toBe('partial');
    expect(coverageOf(false, false)).toBe('pending');
  });

  it('sums the not-read entries and lists the steps that did not run', () => {
    expect(resultOf(summary())).toEqual({ fileCount: 7, associationCount: 3, missingTargetCount: 1, excludedFirmwareCount: 2, collisionCount: 0, needsManualCount: 0, notRead: 1, complete: true, correctionsStatus: 'ok' });
    expect(skippedStepsOf(summary())).toEqual(['biosCandidates']);
  });

  it('TB-065: the quarantine signal and the needs-manual count reach the view', () => {
    expect(resultOf(summary({ correctionsStatus: 'quarantined', needsManualCount: 3 }))).toMatchObject({ correctionsStatus: 'quarantined', needsManualCount: 3 });
  });
});

describe('port construction', () => {
  it('is null when the window bridge is absent, so the view reports the service as unavailable', () => {
    expect(createBridgeDevicePort(undefined, 'linux')).toBeNull();
    expect(windowDevicePort(undefined, { platform: 'Linux' })).toBeNull();
  });

  it('is null when one of the four bridge members is missing (an older preload)', () => {
    const { bridge } = fakeBridge({ librarySaveCorrections: undefined });
    expect(createBridgeDevicePort(bridge, 'linux')).toBeNull();
  });

  it('offers only the controls the bridge has a channel for', () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'win32');
    expect(port).not.toBeNull();
    expect(port?.platform).toBe('win32');
    expect(port?.capabilities).toEqual({ pauseScan: false, skipStep: false, removeRoot: false, skipFolders: false });
    expect(port?.listFolders).toBeUndefined();
    expect(port?.listBoards).toBeUndefined();
    expect(port?.boardDetail).toBeUndefined();
  });

  it('offers the folder tree, the board list and removal when the bridge has their channels', () => {
    const { bridge } = fakeBridge({
      libraryListFolders: vi.fn(async () => ({ generation: 1, scanned: false, complete: false, skippedCount: 0, folders: [], total: 0 })),
      libraryListBoards: vi.fn(async () => ({ generation: 1, scanned: false, complete: false, indexedFileCount: 0, manualClassificationCount: 0, missingTargetCount: 'unknown' as const, collisionCount: 0, boards: [], total: 0 })),
      libraryBoardDetail: vi.fn(),
      libraryRemoveRoot: vi.fn(async () => ({ removed: true as const })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(port?.capabilities).toEqual({ pauseScan: false, skipStep: false, removeRoot: true, skipFolders: true });
    expect(port?.listFolders).toBeDefined();
    expect(port?.listBoards).toBeDefined();
    expect(port?.boardDetail).toBeDefined();
  });
});

describe('roots', () => {
  it('records the root the native chooser returned, with only its id and its own name', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    const picked = await port?.pickRoot();
    expect(picked).toEqual({ rootId: ROOT_A, label: 'Synthetic folder' });
    expect(await port?.listRoots()).toEqual([
      { rootId: ROOT_A, label: 'Synthetic folder', coverage: 'pending', folderCount: 0, fileCount: 0 },
    ]);
  });

  it('keeps the root list empty when the chooser is cancelled', async () => {
    const { bridge } = fakeBridge({ libraryPickRoot: vi.fn(async () => null) });
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(await port?.pickRoot()).toBeNull();
    expect(await port?.listRoots()).toEqual([]);
  });

  it('refuses removal, which the bridge has no channel for', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await expect(port?.removeRoot(ROOT_A)).rejects.toBeInstanceOf(BridgePortError);
  });
});

describe('scan', () => {
  it('starts in the background and reports running, then done with counts, and fires changed', async () => {
    const { bridge, finishScan } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    const events: DeviceEvent[] = [];
    port?.subscribe(event => events.push(event));
    await port?.startScan({ rootIds: [ROOT_A], steps: { biosCandidates: false } });
    expect(bridge.libraryScan).toHaveBeenCalledWith(expect.objectContaining({ rootIds: [ROOT_A], steps: { biosCandidates: false } }));
    expect(events.at(-1)).toEqual({ type: 'progress', progress: { phase: 'running', fraction: 0, files: 0, skipped: [] } });

    finishScan(summary());
    await flush();
    const done = events.filter(event => event.type === 'progress').at(-1);
    expect(done).toEqual({
      type: 'progress',
      progress: {
        phase: 'done', fraction: 1, files: 7, skipped: ['biosCandidates'],
        result: { fileCount: 7, associationCount: 3, missingTargetCount: 1, excludedFirmwareCount: 2, collisionCount: 0, needsManualCount: 0, notRead: 1, complete: true, correctionsStatus: 'ok' },
      },
    });
    expect(events.at(-1)).toEqual({ type: 'changed', generation: 1 });
    expect(await port?.listRoots()).toEqual([
      expect.objectContaining({ rootId: ROOT_A, coverage: 'complete', folderCount: 2, fileCount: 5 }),
    ]);
  });

  it('refuses a scan without roots and a second scan while one is in flight', async () => {
    const { bridge, finishScan } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    await expect(port?.startScan({ rootIds: [], steps: {} })).rejects.toMatchObject({ code: 'no-roots' });
    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    await expect(port?.startScan({ rootIds: [ROOT_A], steps: {} })).rejects.toMatchObject({ code: 'busy' });
    finishScan(summary());
    await flush();
  });

  it('cancel drops the result, and a new scan waits until the main pass has ended', async () => {
    const { bridge, finishScan } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    const events: DeviceEvent[] = [];
    port?.subscribe(event => events.push(event));
    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    await port?.cancelScan();
    expect(bridge.libraryCancelScan).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: 'progress', progress: { phase: 'stopping', fraction: 0, files: 0, skipped: [] } });

    // Until the main process has really ended the scan, a new scan is refused.
    await expect(port?.startScan({ rootIds: [ROOT_A], steps: {} })).rejects.toMatchObject({ code: 'busy' });
    finishScan(summary());
    await flush();
    expect(events.at(-1)).toEqual({ type: 'progress', progress: { phase: 'cancelled', fraction: 0, files: 0, skipped: [] } });
    expect(events.some(event => event.type === 'changed')).toBe(false);
    expect(await port?.listRoots()).toEqual([expect.objectContaining({ coverage: 'pending' })]);

    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    expect(bridge.libraryScan).toHaveBeenCalledTimes(2);
  });

  it('refuses cancel when the bridge has no cancel channel, instead of pretending to stop', async () => {
    const { bridge } = fakeBridge({ libraryCancelScan: undefined });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    await expect(port?.cancelScan()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reports a failed scan as an event with no detail, and returns to idle', async () => {
    const { bridge, failScan } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    const events: DeviceEvent[] = [];
    port?.subscribe(event => events.push(event));
    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    failScan(new Error('a path that must not leak'));
    await flush();
    expect(events.at(-1)).toEqual({ type: 'failed' });
    expect(events.filter(event => event.type === 'progress').at(-1)).toEqual({ type: 'progress', progress: { phase: 'idle', fraction: 0, files: 0, skipped: [] } });
  });

  it('refuses pause and resume, and refuses a step skip when no scan is running', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await expect(port?.pauseScan()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(port?.resumeScan()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(port?.skipStep('matching')).rejects.toMatchObject({ code: 'no-scan' });
  });

  it('gives a view that opens during a scan the current progress at once', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    const seen: ScanProgressView[] = [];
    port?.subscribe(event => { if (event.type === 'progress') seen.push(event.progress); });
    expect(seen).toEqual([{ phase: 'running', fraction: 0, files: 0, skipped: [] }]);
  });
});

describe('corrections', () => {
  it('saves a correction as the whole document, with the platform the store reported', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(await port?.saveCorrection(LINK)).toEqual({});
    expect(bridge.librarySaveCorrections).toHaveBeenCalledWith({ version: 1, platform: 'linux', corrections: [LINK] });
  });

  it('keeps the later decision for one file, as the store does', async () => {
    const { bridge } = fakeBridge({
      libraryLoadCorrections: vi.fn(async () => ({ status: 'ok', document: { version: 1, platform: 'linux', corrections: [LINK] }, dropped: 0 })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.saveCorrection(ROLE);
    const saved = bridge.librarySaveCorrections.mock.calls[0]?.[0] as CorrectionDocument;
    expect(saved.corrections).toEqual([LINK, ROLE]);
  });

  it('never writes over a document the store cannot use', async () => {
    const { bridge } = fakeBridge({
      libraryLoadCorrections: vi.fn(async () => ({ status: 'newer-schema', document: null, dropped: 0 })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await expect(port?.saveCorrection(LINK)).rejects.toMatchObject({ code: 'corrections-unusable' });
    expect(bridge.librarySaveCorrections).not.toHaveBeenCalled();
  });

  it('undo restores the document as it was before the last save, and reports nothing to undo otherwise', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(await port?.undoLastCorrection()).toBe(false);
    await port?.saveCorrection(LINK);
    await port?.saveCorrection(ROLE);
    expect(await port?.undoLastCorrection()).toBe(true);
    expect(bridge.librarySaveCorrections).toHaveBeenLastCalledWith({ version: 1, platform: 'linux', corrections: [LINK] });
    expect(await port?.undoLastCorrection()).toBe(true);
    expect(bridge.librarySaveCorrections).toHaveBeenLastCalledWith({ version: 1, platform: 'linux', corrections: [] });
    expect(await port?.undoLastCorrection()).toBe(false);
  });

  it('a failed save changes nothing in the session', async () => {
    const { bridge } = fakeBridge({
      librarySaveCorrections: vi.fn(async () => { throw new Error('[LIBRARY_CORRECTIONS_FAILED] the corrections could not be saved'); }),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await expect(port?.saveCorrection(LINK)).rejects.toThrow();
    expect(await port?.undoLastCorrection()).toBe(false);
  });
});

describe('refused correction entries', () => {
  it('lists each reason once, dropping anything outside the closed list', async () => {
    const { bridge } = fakeBridge({
      libraryLoadCorrections: vi.fn(async () => ({
        status: 'ok', document: EMPTY_DOCUMENT, dropped: 3, rejections: [
          { index: 0, reason: 'unknown-role', messageKey: 'libraryDevices.rejection.unknownRole' },
          { index: 1, reason: 'unknown-role', messageKey: 'libraryDevices.rejection.unknownRole' },
          { index: 2, reason: 'too-many', messageKey: 'libraryDevices.rejection.tooMany' },
        ],
      })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(await port?.correctionRejections?.()).toEqual(['unknown-role', 'too-many']);
  });

  it('is empty when the stored document is unusable, so nothing is explained entry by entry', async () => {
    const { bridge } = fakeBridge({
      libraryLoadCorrections: vi.fn(async () => ({ status: 'newer-schema', document: null, dropped: 0, rejections: [] })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(await port?.correctionRejections?.()).toEqual([]);
  });
});

describe('scan start that throws synchronously', () => {
  it('reports the failure and releases the busy flag, so the next start is not refused', async () => {
    const { bridge } = fakeBridge();
    bridge.libraryScan.mockImplementationOnce((): Promise<LibraryScanSummary> => { throw new Error('synchronous failure'); });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    const events: DeviceEvent[] = [];
    port?.subscribe(event => events.push(event));
    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    expect(events.at(-1)).toEqual({ type: 'failed' });

    // The next start reaches the bridge again instead of being refused as busy.
    await expect(port?.startScan({ rootIds: [ROOT_A], steps: {} })).resolves.toBeUndefined();
    expect(bridge.libraryScan).toHaveBeenCalledTimes(2);
  });
});

describe('bridge channels: persisted roots, folder tree, board list and detail', () => {
  const listed = {
    roots: [
      { rootId: ROOT_A, label: 'Synthetic folder', online: true, network: 'unknown' as const, scanned: true, complete: 'unknown' as const },
      { rootId: ROOT_B, label: 'Other folder', online: false, network: 'unknown' as const, scanned: false, complete: 'unknown' as const },
    ],
    total: 2,
  };
  const folderPage = (overrides: Record<string, unknown>) => ({ generation: 1, scanned: true, complete: true, skippedCount: 0, folders: [], total: 0, ...overrides });
  const boardPage = (boards: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => ({
    generation: 1, scanned: true, complete: true, indexedFileCount: 1, manualClassificationCount: 0, missingTargetCount: 'unknown' as const,
    collisionCount: 0, boards, total: boards.length, ...overrides,
  });

  it('lists the persisted roots with their coverage, and leaves the network flag out when the bridge does not measure it', async () => {
    const { bridge } = fakeBridge({ libraryListRoots: vi.fn(async () => listed) });
    const port = createBridgeDevicePort(bridge, 'linux');
    const roots = await port?.listRoots();
    expect(roots).toEqual([
      { rootId: ROOT_A, label: 'Synthetic folder', coverage: 'partial', folderCount: 0, fileCount: 0 },
      { rootId: ROOT_B, label: 'Other folder', coverage: 'pending', folderCount: 0, fileCount: 0 },
    ]);
  });

  it('removes a root through the bridge and does not touch the files', async () => {
    const remove = vi.fn(async () => ({ removed: true as const }));
    const { bridge } = fakeBridge({ libraryListRoots: vi.fn(async () => listed), libraryRemoveRoot: remove });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.removeRoot(ROOT_A);
    expect(remove).toHaveBeenCalledWith({ rootId: ROOT_A });
  });

  it('pages the folder tree one level at a time, and asks nothing of a root that no scan has covered', async () => {
    const pages = [
      folderPage({ skippedCount: 1, folders: [{ folderId: 'f1', folderCount: 3, fileCount: 4, bytes: 10, childFolderCount: 2 }], nextCursor: 'c1' }),
      folderPage({ folders: [{ folderId: 'f2', folderCount: 0, fileCount: 1, bytes: 2, childFolderCount: 0 }] }),
    ];
    const listFoldersFn = vi.fn(async () => pages.shift() ?? folderPage({}));
    const { bridge } = fakeBridge({ libraryListRoots: vi.fn(async () => listed), libraryListFolders: listFoldersFn });
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(await port?.listFolders?.(ROOT_B, '')).toEqual({ folders: [], notRead: 0, complete: false });
    expect(listFoldersFn).not.toHaveBeenCalled();

    await port?.listRoots();
    const top = await port?.listFolders?.(ROOT_A, '');
    expect(top?.folders.map(folder => folder.path)).toEqual(['f1', 'f2']);
    expect(top?.complete).toBe(true);
    expect(top?.notRead).toBe(0);
    expect(listFoldersFn).toHaveBeenNthCalledWith(1, { rootId: ROOT_A, limit: 200 });
    expect(listFoldersFn).toHaveBeenNthCalledWith(2, { rootId: ROOT_A, cursor: 'c1', limit: 200 });

    listFoldersFn.mockImplementationOnce(async () => folderPage({ folders: [] }));
    await port?.listFolders?.(ROOT_A, 'f1');
    expect(listFoldersFn).toHaveBeenLastCalledWith({ rootId: ROOT_A, parentId: 'f1', limit: 200 });
  });

  it('lists the boards of every scanned root in pages whose cursor names the root', async () => {
    const boardOf = (boardId: string, boardview: string) => ({ boardId, fileCount: 1, confirmed: 1, probable: 0, review: 0, boardview, bios: 'none' });
    const listBoardsFn = vi.fn(async (request: { rootId: string; limit: number }) => (
      request.rootId === ROOT_A ? boardPage([boardOf('b1', 'confirmed')], { total: 1 }) : boardPage([boardOf('b2', 'candidate')], { total: 1 })
    ));
    const { bridge } = fakeBridge({ libraryListRoots: vi.fn(async () => ({ ...listed, roots: [listed.roots[0], { ...listed.roots[0], rootId: ROOT_B, scanned: true }] })), libraryListBoards: listBoardsFn });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.listRoots();
    const first = await port?.listBoards?.({ text: '', status: 'all', limit: 1 });
    expect(first?.rows.map(row => row.anchorId)).toEqual(['b1']);
    expect(first?.rows[0].boardview).toEqual({ presence: 'confirmed', complete: true });
    expect(first?.rows[0].schematic).toEqual({ presence: 'unknown', complete: true });
    expect(first?.total).toBe(2);
    expect(first?.cursor).toBe('1|');

    const second = await port?.listBoards?.({ text: '', status: 'all', limit: 1, cursor: first?.cursor });
    expect(second?.rows.map(row => row.anchorId)).toEqual(['b2']);
    expect(second?.cursor).toBeUndefined();
  });

  it('shows one board: its code, revision, presence and file roles, with the bridge state as the confidence', async () => {
    const { bridge } = fakeBridge({
      libraryBoardDetail: vi.fn(async () => ({
        generation: 1, boardId: 'b1', boardCode: 'MB-SYN1', revision: null, boardview: 'confirmed', bios: 'candidate', complete: true,
        files: [
          { fileId: 'x', rootId: ROOT_A, role: 'boardview', state: 'confirmed' },
          { fileId: 'y', rootId: ROOT_A, role: 'datasheet', state: 'review' },
        ],
        filesTruncated: false,
      })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    const detail = await port?.boardDetail?.('b1');
    expect(detail?.row.boardCode).toBe('MB-SYN1');
    expect(detail?.row.revision).toBeUndefined();
    expect(detail?.row.bios).toEqual({ presence: 'candidate', complete: true });
    expect(detail?.files.map(file => [file.role, file.confidence, file.path])).toEqual([['boardview', 'confirmed', ''], ['other', 'review', '']]);
  });

  it('passes the folders the user leaves out to the next scan', async () => {
    const { bridge, finishScan } = fakeBridge({ libraryListFolders: vi.fn(async () => folderPage({})) });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.pickRoot();
    await port?.startScan({ rootIds: [ROOT_A], steps: {}, skipFolders: ['f1'] });
    expect(bridge.libraryScan).toHaveBeenCalledWith(expect.objectContaining({ skipFolders: ['f1'] }));
    finishScan(summary());
    await flush();
  });
});

describe('folder read state', () => {
  it('carries the name, the read state and the closed code of each folder to the tree', async () => {
    const page = {
      generation: 1, scanned: true, complete: false, skippedCount: 1, total: 2,
      folders: [
        { folderId: 'f1', name: 'Birchfield', readState: 'unreadable' as const, code: 'EACCES', folderCount: 0, fileCount: 0, bytes: 0, childFolderCount: 0 },
        { folderId: 'f2', name: 'Other', readState: 'listed' as const, folderCount: 1, fileCount: 2, bytes: 3, childFolderCount: 1 },
      ],
    };
    const { bridge } = fakeBridge({
      libraryListRoots: vi.fn(async () => ({ roots: [{ rootId: ROOT_A, label: 'Synthetic', online: true, network: 'unknown' as const, scanned: true, complete: false }], total: 1 })),
      libraryListFolders: vi.fn(async () => page),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.listRoots();
    const folders = await port?.listFolders?.(ROOT_A, '');
    expect(folders?.complete).toBe(false);
    expect(folders?.folders).toEqual([
      { path: 'f1', name: 'Birchfield', readState: 'unreadable', code: 'EACCES', folderCount: 0, fileCount: 0, bytes: 0 },
      { path: 'f2', name: 'Other', readState: 'listed', folderCount: 1, fileCount: 2, bytes: 3 },
    ]);
  });
});

describe('W14 contract: step skip, board anchors and file ids, text filter by basename', () => {
  const boardOf = (boardId: string, boardAnchorId: string) => ({
    boardId, boardAnchorId, fileCount: 1, confirmed: 1, probable: 0, review: 0, boardview: 'confirmed' as const, bios: 'none' as const,
  });

  it('skips a step of the running scan with the scan id the window chose, and maps the bridge refusals', async () => {
    const skip = vi.fn(async (request: { scanId: string; step: string }) => ({ scanId: request.scanId, step: request.step, accepted: true as const, complete: false as const }));
    const { bridge, finishScan } = fakeBridge({ libraryScanSkipStep: skip as never });
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(port?.capabilities?.skipStep).toBe(true);
    await port?.pickRoot();
    await expect(port?.skipStep('matching')).rejects.toMatchObject({ code: 'no-scan' });

    await port?.startScan({ rootIds: [ROOT_A], steps: {} });
    const scanId = (bridge.libraryScan.mock.calls[0]?.[0] as { scanId: string }).scanId;
    await port?.skipStep('matching');
    expect(skip).toHaveBeenCalledWith({ scanId, step: 'matching' });

    skip.mockImplementationOnce(async () => { throw Object.assign(new Error('[LIBRARY_NO_SCAN] no scan'), { code: 'LIBRARY_NO_SCAN' }); });
    await expect(port?.skipStep('matching')).rejects.toMatchObject({ code: 'no-scan' });
    skip.mockImplementationOnce(async () => { throw Object.assign(new Error('[LIBRARY_INVALID_REQUEST] bad'), { code: 'LIBRARY_INVALID_REQUEST' }); });
    await expect(port?.skipStep('matching')).rejects.toMatchObject({ code: 'invalid-request' });
    finishScan(summary());
    await flush();
  });

  it('a port without the skip channel does not offer skipping', () => {
    const { bridge } = fakeBridge();
    expect(createBridgeDevicePort(bridge, 'linux')?.capabilities?.skipStep).toBe(false);
  });

  it('keeps the board anchor and the file ids and names the bridge sends', async () => {
    const { bridge } = fakeBridge({
      libraryListRoots: vi.fn(async () => ({ roots: [{ rootId: ROOT_A, label: 'Synthetic', online: true, network: 'unknown' as const, scanned: true, complete: true }], total: 1 })),
      libraryListBoards: vi.fn(async () => ({ generation: 1, scanned: true, complete: true, indexedFileCount: 1, manualClassificationCount: 0, missingTargetCount: 'unknown' as const, collisionCount: 0, boards: [boardOf('b1', 'anchor-1')], total: 1 })),
      libraryBoardDetail: vi.fn(async () => ({
        generation: 1, boardId: 'b1', boardAnchorId: 'anchor-1', boardCode: 'MB-SYN1', revision: 'R2', boardview: 'confirmed', bios: 'none', complete: true,
        files: [{ fileId: 'file-1', name: 'synthetic-board.brd', rootId: ROOT_A, role: 'boardview', state: 'confirmed' }],
        filesTruncated: false,
      })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.listRoots();
    const page = await port?.listBoards?.({ text: '', status: 'all', limit: 10 });
    expect(page?.rows[0].boardAnchorId).toBe('anchor-1');
    const detail = await port?.boardDetail?.('b1');
    expect(detail?.row.boardAnchorId).toBe('anchor-1');
    expect(detail?.files[0]).toEqual({ fileId: 'file-1', rootId: ROOT_A, path: '', name: 'synthetic-board.brd', role: 'boardview', confidence: 'confirmed' });
  });

  it('a text is matched against the file basenames of the boards on the page', async () => {
    const { bridge } = fakeBridge({
      libraryListRoots: vi.fn(async () => ({ roots: [{ rootId: ROOT_A, label: 'Synthetic', online: true, network: 'unknown' as const, scanned: true, complete: true }], total: 1 })),
      libraryListBoards: vi.fn(async () => ({ generation: 1, scanned: true, complete: true, indexedFileCount: 2, manualClassificationCount: 0, missingTargetCount: 'unknown' as const, collisionCount: 0, boards: [boardOf('b1', 'a1'), boardOf('b2', 'a2')], total: 2 })),
      libraryBoardDetail: vi.fn(async (request: { boardId: string }) => ({
        generation: 1, boardId: request.boardId, boardAnchorId: request.boardId === 'b1' ? 'a1' : 'a2', boardCode: null, revision: null, boardview: 'confirmed', bios: 'none', complete: true,
        files: [{ fileId: `f-${request.boardId}`, name: request.boardId === 'b1' ? 'alpha-board.brd' : 'beta-board.brd', rootId: ROOT_A, role: 'boardview', state: 'confirmed' }],
        filesTruncated: false,
      })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.listRoots();
    const found = await port?.listBoards?.({ text: 'Beta', status: 'all', limit: 10 });
    expect(found?.rows.map(row => row.anchorId)).toEqual(['b2']);
    const none = await port?.listBoards?.({ text: 'nothing-here', status: 'all', limit: 10 });
    expect(none?.rows).toEqual([]);
  });
});

describe('correction refusals by the bridge (id form)', () => {
  it('a stale file id is reported as unknown-file, the correction is not kept, and nothing can be undone', async () => {
    const { bridge } = fakeBridge({
      librarySaveCorrections: vi.fn(async () => { throw Object.assign(new Error('[LIBRARY_UNKNOWN_FILE] the file id is not known'), { code: 'LIBRARY_UNKNOWN_FILE' }); }),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await expect(port?.saveCorrection(LINK)).rejects.toMatchObject({ code: 'unknown-file' });
    expect(await port?.undoLastCorrection()).toBe(false);
  });

  it('an undo whose snapshot names a file of a root removed since is refused once, and the next undo is not stuck on it', async () => {
    const STALE: PortCorrection = { op: 'role', fileId: 'stale-file', role: 'document' };
    let rootRemoved = false;
    const { bridge } = fakeBridge({
      libraryLoadCorrections: vi.fn(async () => ({ status: 'ok' as const, document: { version: 1, platform: 'linux', corrections: [STALE] }, dropped: 0, rejections: [] })),
      librarySaveCorrections: vi.fn(async (document: { corrections: readonly PortCorrection[] }) => {
        if (rootRemoved && document.corrections.some(entry => 'fileId' in entry && entry.fileId === 'stale-file')) {
          throw Object.assign(new Error('[LIBRARY_UNKNOWN_FILE] the file id is not known or its root was removed'), { code: 'LIBRARY_UNKNOWN_FILE' });
        }
        return { status: 'saved' as const, bytes: 10 };
      }),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.saveCorrection(LINK);
    rootRemoved = true;
    await expect(port?.undoLastCorrection()).rejects.toMatchObject({ code: 'unknown-file' });
    expect(await port?.undoLastCorrection()).toBe(false);
  });

  it('a malformed request is reported as invalid-request and nothing is written', async () => {
    const { bridge } = fakeBridge({
      librarySaveCorrections: vi.fn(async () => { throw Object.assign(new Error('[LIBRARY_INVALID_REQUEST] bad'), { code: 'LIBRARY_INVALID_REQUEST' }); }),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    await expect(port?.saveCorrection(LINK)).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('the document sent to the bridge carries ids only, never a path or a file object', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    await port?.saveCorrection(ROLE);
    const sent = JSON.stringify(bridge.librarySaveCorrections.mock.calls[0]?.[0]);
    expect(sent).toContain('file-1');
    expect(sent).not.toContain('path');
    expect(sent).not.toContain('"file"');
  });
});

describe('quarantine reported on save', () => {
  it('reports the base name and the count of the entries the store set aside, never a path', async () => {
    const { bridge } = fakeBridge({
      librarySaveCorrections: vi.fn(async () => ({ status: 'saved' as const, bytes: 10, quarantine: 'corrections.quarantine-2026-10-10T00-00-00-000Z-abc.json', quarantinedEntries: 2 })),
    });
    const port = createBridgeDevicePort(bridge, 'linux');
    expect(await port?.saveCorrection(LINK)).toEqual({ quarantine: { name: 'corrections.quarantine-2026-10-10T00-00-00-000Z-abc.json', entries: 2 } });
  });

  it('strips a directory from a quarantine name, whatever the separator', async () => {
    const { bridge } = fakeBridge({
      librarySaveCorrections: vi.fn(async () => ({ status: 'saved' as const, bytes: 10, quarantine: 'C:\\Users\\Synthetic\\corrections.quarantine-x.json', quarantinedEntries: 1 })),
    });
    const port = createBridgeDevicePort(bridge, 'win32');
    const result = await port?.saveCorrection(LINK);
    expect(result?.quarantine).toEqual({ name: 'corrections.quarantine-x.json', entries: 1 });
  });

  it('reports no quarantine when the store set nothing aside', async () => {
    const { bridge } = fakeBridge();
    const port = createBridgeDevicePort(bridge, 'linux');
    expect((await port?.saveCorrection(LINK))?.quarantine).toBeUndefined();
  });
});

// Undo against a store that keeps what it saves and refuses a snapshot holding the id of a removed root's file. Removing the root
// makes the store mint a new id for that file on load, as the bridge does; the old id is refused.
const STALE_FILE = 'stale-file';
const FRESH_FILE = 'fresh-file';
const STALE: PortCorrection = { op: 'role', fileId: STALE_FILE, role: 'document' };
const LINK_2: PortCorrection = { op: 'link', fileId: 'file-2', boardAnchorId: 'anchor-2' };

function storeOfRemovableFile() {
  let stored: CorrectionDocument = EMPTY_DOCUMENT;
  let removed = false;
  let held: Promise<void> | null = null;
  const saves: PortCorrection[][] = [];
  const fresh = (corrections: readonly PortCorrection[]): PortCorrection[] => corrections.map(entry => (
    removed && 'fileId' in entry && entry.fileId === STALE_FILE ? { ...entry, fileId: FRESH_FILE } : entry
  ));
  const { bridge } = fakeBridge({
    libraryLoadCorrections: vi.fn(async () => ({ status: 'ok' as const, document: { ...stored, corrections: fresh(stored.corrections) }, dropped: 0, rejections: [] })),
    librarySaveCorrections: vi.fn(async (document: CorrectionDocument) => {
      saves.push([...document.corrections]);
      if (held !== null) { const gate = held; held = null; await gate; }
      if (removed && document.corrections.some(entry => 'fileId' in entry && entry.fileId === STALE_FILE)) {
        throw Object.assign(new Error('[LIBRARY_UNKNOWN_FILE] the file id is not known or its root was removed'), { code: 'LIBRARY_UNKNOWN_FILE' });
      }
      stored = document;
      return { status: 'saved' as const, bytes: 1 };
    }),
  });
  return {
    bridge,
    saves,
    remove: () => { removed = true; },
    // The next save waits until the returned function is called.
    hold: (): (() => void) => {
      let release: () => void = () => undefined;
      held = new Promise<void>(resolve => { release = () => resolve(); });
      return () => release();
    },
    stored: (): CorrectionDocument => stored,
  };
}

function portOf(bridge: LibraryBridge) {
  const port = createBridgeDevicePort(bridge, 'linux');
  if (port === null) throw new Error('the port is not available');
  return port;
}

describe('undo against a store that refuses a removed root\'s file', () => {
  it('an undo refused as unknown-file writes nothing: the stored document is the same as before', async () => {
    const store = storeOfRemovableFile();
    const port = portOf(store.bridge);
    await port.saveCorrection(STALE);
    await port.saveCorrection(LINK);
    store.remove();
    const before = structuredClone(store.stored());
    const attempts = store.saves.length;
    await expect(port.undoLastCorrection()).rejects.toMatchObject({ code: 'unknown-file' });
    expect(store.saves.length).toBe(attempts + 1);
    expect(store.stored()).toEqual(before);
  });

  it('an older valid snapshot survives a dropped top snapshot, and the next undos restore it and the one before', async () => {
    const store = storeOfRemovableFile();
    const port = portOf(store.bridge);
    await port.saveCorrection(LINK);
    await port.saveCorrection(STALE);
    await port.saveCorrection(LINK_2);
    store.remove();
    await expect(port.undoLastCorrection()).rejects.toMatchObject({ code: 'unknown-file' });
    expect(await port.undoLastCorrection()).toBe(true);
    expect(store.saves[store.saves.length - 1]).toEqual([LINK]);
    expect(store.stored().corrections).toEqual([LINK]);
    expect(await port.undoLastCorrection()).toBe(true);
    expect(store.saves[store.saves.length - 1]).toEqual([]);
    expect(await port.undoLastCorrection()).toBe(false);
  });

  it('a newer snapshot added while an undo is in flight stays on the stack (success)', async () => {
    const store = storeOfRemovableFile();
    const port = portOf(store.bridge);
    await port.saveCorrection(LINK);
    const release = store.hold();
    const undoing = port.undoLastCorrection();
    await port.saveCorrection(LINK_2);
    release();
    expect(await undoing).toBe(true);
    expect(await port.undoLastCorrection()).toBe(true);
    expect(store.saves[store.saves.length - 1]).toEqual([LINK]);
  });

  it('a newer snapshot added while a refused undo is in flight stays on the stack (unknown-file)', async () => {
    const store = storeOfRemovableFile();
    const port = portOf(store.bridge);
    await port.saveCorrection(STALE);
    await port.saveCorrection(LINK);
    store.remove();
    const release = store.hold();
    const undoing = port.undoLastCorrection();
    await port.saveCorrection(LINK_2);
    release();
    await expect(undoing).rejects.toMatchObject({ code: 'unknown-file' });
    expect(await port.undoLastCorrection()).toBe(true);
    expect(store.saves[store.saves.length - 1]).toEqual([{ op: 'role', fileId: FRESH_FILE, role: 'document' }, LINK]);
  });
});

// Undo against a store that refuses a write. A snapshot holding a malformed entry is an invalid request, which the store refuses for
// good; a refused write (the store wrote nothing) may succeed later.
const MALFORMED_FILE = 'malformed-file';
const MALFORMED: PortCorrection = { op: 'role', fileId: MALFORMED_FILE, role: 'document' };

function storeRefusingWrites() {
  let stored: CorrectionDocument = EMPTY_DOCUMENT;
  let refuseMalformed = false;
  let refuseNext = false;
  const { bridge } = fakeBridge({
    libraryLoadCorrections: vi.fn(async () => ({ status: 'ok' as const, document: { ...stored }, dropped: 0, rejections: [] })),
    librarySaveCorrections: vi.fn(async (document: CorrectionDocument) => {
      if (refuseNext) {
        refuseNext = false;
        return { status: 'refused' as const, rejections: [] };
      }
      if (refuseMalformed && document.corrections.some(entry => 'fileId' in entry && entry.fileId === MALFORMED_FILE)) {
        throw Object.assign(new Error('[LIBRARY_INVALID_REQUEST] the request is malformed'), { code: 'LIBRARY_INVALID_REQUEST' });
      }
      stored = document;
      return { status: 'saved' as const, bytes: 1 };
    }),
  });
  return {
    bridge,
    refuseMalformed: () => { refuseMalformed = true; },
    refuseNext: () => { refuseNext = true; },
    stored: (): CorrectionDocument => stored,
  };
}

describe('undo against a store that refuses a snapshot', () => {
  it('an undo refused as an invalid request drops its snapshot, so the next undo restores the older one', async () => {
    const store = storeRefusingWrites();
    const port = portOf(store.bridge);
    await port.saveCorrection(MALFORMED);
    await port.saveCorrection(LINK);
    store.refuseMalformed();
    await expect(port.undoLastCorrection()).rejects.toMatchObject({ code: 'invalid-request' });
    expect(await port.undoLastCorrection()).toBe(true);
    expect(store.stored().corrections).toEqual([]);
    expect(await port.undoLastCorrection()).toBe(false);
  });

  it('a refused write keeps its snapshot, so a later undo can restore it once the store accepts again', async () => {
    const store = storeRefusingWrites();
    const port = portOf(store.bridge);
    await port.saveCorrection(LINK);
    await port.saveCorrection(LINK_2);
    store.refuseNext();
    await expect(port.undoLastCorrection()).rejects.toMatchObject({ code: 'refused' });
    expect(await port.undoLastCorrection()).toBe(true);
    expect(store.stored().corrections).toEqual([LINK]);
  });
});

describe('undo after a refusal other than unknown-file or invalid-request (E-27)', () => {
  it('the snapshot stays on the stack, so the next undo restores it', async () => {
    const store = storeOfRemovableFile();
    const save = store.bridge.librarySaveCorrections;
    let refuseOnce = false;
    store.bridge.librarySaveCorrections = vi.fn(async (document: CorrectionDocument) => {
      if (refuseOnce) { refuseOnce = false; throw Object.assign(new Error('[LIBRARY_CORRECTIONS_FAILED] refused for now'), { code: 'LIBRARY_CORRECTIONS_FAILED' }); }
      return save(document);
    });
    const port = portOf(store.bridge);
    await port.saveCorrection(LINK);
    await port.saveCorrection(LINK_2);
    refuseOnce = true;
    await expect(port.undoLastCorrection()).rejects.toThrow();
    expect(store.stored().corrections).toEqual([LINK, LINK_2]);
    expect(await port.undoLastCorrection()).toBe(true);
    expect(store.stored().corrections).toEqual([LINK]);
  });
});
