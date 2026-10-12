import { describe, expect, it } from 'vitest';
import { catalogs } from '../../i18n';
import type { SlotAvailability } from './availability';
import type { Association } from './match';
import type { BoardRow, BoardFile, FolderSummary, RootSummary, ScanProgressView, SlotInput } from './ui-port';
import {
  BASIS_KEY, COVERAGE_KEY, CONFIDENCE_KEY, OP_KEY, PHASE_KEY, ROLE_KEY, SLOT_REASON_KEY, STEP_KEY, boardStatus, buildCorrection, buildTreeRows,
  confidenceOf, folderKey, matchesStatus, nextScanPhase, normalizeSteps, pendingFolderLoads, progressView, reasonLines, slotView, sortBoardFiles,
  treeKeyAction, needsFile,
} from './ui-model';
import type { CorrectionDraft, DeviceKey, TreeRow } from './ui-model';

/** Synthetic fixtures only: invented names, board codes and folders. */
const roots: RootSummary[] = [
  { rootId: 'r1', label: 'Demo root A', coverage: 'complete', folderCount: 2, fileCount: 3, network: false },
  { rootId: 'r2', label: 'Demo root B', coverage: 'offline', folderCount: 0, fileCount: 1, network: true },
];

const folder = (path: string, name: string, folderCount: number, fileCount = 0): FolderSummary => ({ path, name, folderCount, fileCount, bytes: 0 });

const cacheOf = (entries: Array<[string, FolderSummary[]]>): Map<string, FolderSummary[]> => new Map(entries);

const foundSlot = (count: number, bestState?: Association['state'], basis?: Association['basis']): SlotInput => ({
  availability: { status: 'found', count },
  bestState,
  basis,
});
const notFoundSlot = (): SlotInput => ({ availability: { status: 'not-found', rootCount: 1 } });
const unknownSlot = (reason: Extract<SlotAvailability, { status: 'unknown' }>['reason']): SlotInput => ({
  availability: { status: 'unknown', reason, knownOffline: 0 },
});

const rowOf = (overrides: Partial<BoardRow> = {}): BoardRow => ({
  anchorId: 'a1',
  boardCode: 'MB-Q731',
  revision: 'REV2',
  names: ['demo alpha'],
  models: ['Demo model'],
  boardview: notFoundSlot(),
  schematic: notFoundSlot(),
  bios: notFoundSlot(),
  ...overrides,
});

describe('folder tree rows', () => {
  it('shows only the roots while nothing is expanded, with a folder key per root', () => {
    const rows = buildTreeRows({ roots, cache: new Map(), expanded: new Set() });
    expect(rows.map(row => [row.label, row.depth, row.parentIndex, row.expanded])).toEqual([
      ['Demo root A', 0, -1, false],
      ['Demo root B', 0, -1, false],
    ]);
    expect(rows[0].key).toBe(folderKey('r1', ''));
  });

  it('marks an expanded folder without cached children as loading, and asks for exactly that load', () => {
    const rows = buildTreeRows({ roots, cache: new Map(), expanded: new Set([folderKey('r1', '')]) });
    expect(rows[0].loading).toBe(true);
    expect(pendingFolderLoads(rows)).toEqual([{ key: folderKey('r1', ''), rootId: 'r1', path: '' }]);
  });

  it('lists the cached children under their parent with depth and parent index in display order', () => {
    const cache = cacheOf([
      [folderKey('r1', ''), [folder('Alder', 'Alder', 1, 2), folder('Birch', 'Birch', 0, 1)]],
      [folderKey('r1', 'Alder'), [folder('Alder/Orion-5', 'Orion-5', 0, 4)]],
    ]);
    const expanded = new Set([folderKey('r1', ''), folderKey('r1', 'Alder')]);
    const rows = buildTreeRows({ roots, cache, expanded });
    expect(rows.map(row => [row.label, row.depth, row.parentIndex])).toEqual([
      ['Demo root A', 0, -1],
      ['Alder', 1, 0],
      ['Orion-5', 2, 1],
      ['Birch', 1, 0],
      ['Demo root B', 0, -1],
    ]);
    expect(rows[1].hasChildren).toBe(true);
    expect(rows[3].hasChildren).toBe(false);
    expect(pendingFolderLoads(rows)).toEqual([]);
  });

  it('never expands a folder that has no subfolders, even when the key is in the expanded set', () => {
    const cache = cacheOf([[folderKey('r1', ''), [folder('Birch', 'Birch', 0, 1)]]]);
    const rows = buildTreeRows({ roots: [roots[0]], cache, expanded: new Set([folderKey('r1', ''), folderKey('r1', 'Birch')]) });
    expect(rows[1].expanded).toBe(false);
    expect(rows[1].loading).toBe(false);
  });
});

describe('folder tree keys', () => {
  const rows: TreeRow[] = [
    { key: 'a', rootId: 'r', path: '', label: 'Root', depth: 0, parentIndex: -1, expanded: true, hasChildren: true, loading: false, folderCount: 1, fileCount: 0 },
    { key: 'b', rootId: 'r', path: 'Alder', label: 'Alder', depth: 1, parentIndex: 0, expanded: false, hasChildren: true, loading: false, folderCount: 1, fileCount: 0 },
    { key: 'c', rootId: 'r', path: 'Birch', label: 'Birch', depth: 1, parentIndex: 0, expanded: false, hasChildren: false, loading: false, folderCount: 0, fileCount: 2 },
  ];

  it('moves up, down, Home and End without leaving the list', () => {
    expect(treeKeyAction(rows, 1, 'ArrowDown')).toEqual({ type: 'focus', index: 2 });
    expect(treeKeyAction(rows, 2, 'ArrowDown')).toEqual({ type: 'none' });
    expect(treeKeyAction(rows, 1, 'ArrowUp')).toEqual({ type: 'focus', index: 0 });
    expect(treeKeyAction(rows, 0, 'ArrowUp')).toEqual({ type: 'none' });
    expect(treeKeyAction(rows, 1, 'Home')).toEqual({ type: 'focus', index: 0 });
    expect(treeKeyAction(rows, 0, 'End')).toEqual({ type: 'focus', index: 2 });
  });

  it('opens a closed folder with Right, steps into an open one, and closes or steps out with Left', () => {
    expect(treeKeyAction(rows, 1, 'ArrowRight')).toEqual({ type: 'toggle', index: 1, expand: true });
    expect(treeKeyAction(rows, 2, 'ArrowRight')).toEqual({ type: 'none' });
    expect(treeKeyAction(rows, 0, 'ArrowRight')).toEqual({ type: 'focus', index: 1 });
    expect(treeKeyAction(rows, 0, 'ArrowLeft')).toEqual({ type: 'toggle', index: 0, expand: false });
    expect(treeKeyAction(rows, 2, 'ArrowLeft')).toEqual({ type: 'focus', index: 0 });
  });

  it('toggles with Enter and Space only on folders that have children', () => {
    expect(treeKeyAction(rows, 1, 'Enter')).toEqual({ type: 'toggle', index: 1, expand: true });
    expect(treeKeyAction(rows, 0, ' ')).toEqual({ type: 'toggle', index: 0, expand: false });
    expect(treeKeyAction(rows, 2, 'Enter')).toEqual({ type: 'none' });
  });

  it('does nothing on an empty list or an index outside it', () => {
    expect(treeKeyAction([], 0, 'ArrowDown')).toEqual({ type: 'none' });
    expect(treeKeyAction(rows, 5, 'ArrowDown')).toEqual({ type: 'none' });
  });
});

describe('slot status and confidence', () => {
  it('shows found with its count and the confidence of the best candidate', () => {
    expect(slotView(foundSlot(2, 'confirmed', 'content'))).toEqual({ kind: 'found', count: 2, confidence: 'confirmed', basis: 'content' });
    expect(slotView(foundSlot(1, 'probable', 'names'))).toMatchObject({ kind: 'found', confidence: 'probable' });
    expect(slotView(foundSlot(1, 'review', 'alias'))).toMatchObject({ kind: 'found', confidence: 'review' });
  });

  it('shows a found candidate without an association state as needing review, never as confirmed', () => {
    expect(slotView(foundSlot(1))).toMatchObject({ kind: 'found', confidence: 'review', basis: undefined });
    expect(confidenceOf(undefined)).toBe('review');
  });

  it('keeps not found and unknown apart, and maps every unknown reason to its catalog text', () => {
    expect(slotView(notFoundSlot())).toEqual({ kind: 'not-found' });
    const reasons: Array<[Extract<SlotAvailability, { status: 'unknown' }>['reason'], string]> = [
      ['no-root', 'noRoot'], ['stage-skipped', 'stageSkipped'], ['incomplete', 'incomplete'],
      ['offline', 'offline'], ['denied', 'denied'], ['stale-generation', 'stale'],
    ];
    for (const [reason, mapped] of reasons) {
      expect(slotView(unknownSlot(reason))).toEqual({ kind: 'unknown', reason: mapped, knownOffline: 0 });
    }
  });

  it('keeps the known-offline count of an unknown slot', () => {
    const view = slotView({ availability: { status: 'unknown', reason: 'offline', knownOffline: 4 } });
    expect(view).toEqual({ kind: 'unknown', reason: 'offline', knownOffline: 4 });
  });
});

describe('motherboard status', () => {
  it('is found when any kind is found, unknown when none is found but one is unknown, else not found', () => {
    expect(boardStatus(rowOf({ boardview: foundSlot(1, 'confirmed', 'content') }))).toBe('found');
    expect(boardStatus(rowOf({ bios: unknownSlot('offline') }))).toBe('unknown');
    expect(boardStatus(rowOf({ bios: unknownSlot('offline'), boardview: foundSlot(1) }))).toBe('found');
    expect(boardStatus(rowOf())).toBe('notFound');
  });

  it('filters by status, and "all" keeps every row', () => {
    const found = rowOf({ boardview: foundSlot(1, 'probable', 'names') });
    const missing = rowOf({ anchorId: 'a2' });
    expect(matchesStatus(found, 'found')).toBe(true);
    expect(matchesStatus(found, 'notFound')).toBe(false);
    expect(matchesStatus(missing, 'notFound')).toBe(true);
    expect(matchesStatus(missing, 'all')).toBe(true);
  });
});

describe('reason lines', () => {
  const association = (overrides: Partial<Association>): Association => ({
    anchorId: 'a1', filePath: 'r1\u0000alder/demo.brd', role: 'boardview', state: 'probable', basis: 'names', score: 40,
    signals: [], conflicts: [], missing: [], ...overrides,
  });

  it('lists each signal with its detail, in order', () => {
    const lines = reasonLines(association({
      signals: [{ signal: 'code-name', weight: 40, detail: 'name MB-Q731' }, { signal: 'alias', weight: 8, detail: 'demo' }],
    }));
    expect(lines).toEqual([
      { key: 'libraryDevices.detail.signal.codeName', params: { detail: 'name MB-Q731' }, itemKeys: [] },
      { key: 'libraryDevices.detail.signal.alias', params: { detail: 'demo' }, itemKeys: [] },
    ]);
  });

  it('keeps both values of a conflict, and lists missing evidence as catalog keys', () => {
    const lines = reasonLines(association({
      state: 'review', basis: 'conflict',
      conflicts: [{ field: 'revision', fileValue: 'REV1', anchorValue: 'REV2' }],
      missing: ['content-identity', 'file-revision'],
    }));
    expect(lines[0]).toEqual({ key: 'libraryDevices.detail.conflict.revision', params: { fileValue: 'REV1', anchorValue: 'REV2' }, itemKeys: [] });
    expect(lines[1]).toEqual({
      key: 'libraryDevices.detail.missing', params: {},
      itemKeys: ['libraryDevices.detail.missingItem.contentIdentity', 'libraryDevices.detail.missingItem.fileRevision'],
    });
  });

  it('is empty when the association has no signal, conflict or gap', () => {
    expect(reasonLines(association({}))).toEqual([]);
  });
});

describe('file list order', () => {
  const file = (role: BoardFile['role'], path: string, rootId = 'r1'): BoardFile => ({ rootId, path, role });

  it('orders by role in the fixed role order, then root and path', () => {
    const sorted = sortBoardFiles([
      file('other', 'z.txt'),
      file('bios-candidate', 'b/2.bin'),
      file('boardview', 'b/a.brd', 'r2'),
      file('boardview', 'a/z.brd'),
      file('schematic', 'docs/s.pdf'),
    ]);
    expect(sorted.map(item => `${item.role}:${item.rootId}:${item.path}`)).toEqual([
      'boardview:r1:a/z.brd',
      'boardview:r2:b/a.brd',
      'schematic:r1:docs/s.pdf',
      'bios-candidate:r1:b/2.bin',
      'other:r1:z.txt',
    ]);
  });

  it('does not change the input array', () => {
    const input = [file('other', 'b'), file('boardview', 'a')];
    sortBoardFiles(input);
    expect(input[0].path).toBe('b');
  });
});

describe('scan state', () => {
  it('follows the scan states: start, pause, resume, cancel and finish', () => {
    expect(nextScanPhase('idle', 'start')).toBe('running');
    expect(nextScanPhase('running', 'pause')).toBe('paused');
    expect(nextScanPhase('paused', 'resume')).toBe('running');
    expect(nextScanPhase('running', 'cancel')).toBe('stopping');
    expect(nextScanPhase('paused', 'cancel')).toBe('stopping');
    expect(nextScanPhase('stopping', 'start')).toBeUndefined();
    expect(nextScanPhase('running', 'finish')).toBe('done');
    expect(nextScanPhase('cancelled', 'start')).toBe('running');
  });

  it('refuses events that make no sense in the current phase', () => {
    expect(nextScanPhase('idle', 'pause')).toBeUndefined();
    expect(nextScanPhase('idle', 'cancel')).toBeUndefined();
    expect(nextScanPhase('running', 'start')).toBeUndefined();
    expect(nextScanPhase('done', 'resume')).toBeUndefined();
  });

  it('turns progress into a whole percentage clamped to 0..100, with the running step', () => {
    const base: ScanProgressView = { phase: 'running', step: 'matching', fraction: 0.456, files: 1234, skipped: [] };
    expect(progressView(base)).toEqual({ percent: 46, phaseKey: PHASE_KEY.running, stepKey: STEP_KEY.matching, files: 1234 });
    expect(progressView({ ...base, fraction: 1.7, step: undefined }).percent).toBe(100);
    expect(progressView({ ...base, fraction: -0.2 }).percent).toBe(0);
    expect(progressView({ ...base, fraction: Number.NaN }).percent).toBe(0);
    expect(progressView({ ...base, fraction: 0.5, step: undefined }).stepKey).toBeUndefined();
  });
});

describe('step switches', () => {
  it('runs every step by default', () => {
    expect(normalizeSteps({})).toEqual({
      steps: { folderMap: true, nameIdentity: true, biosCandidates: true, matching: true, corrections: true },
      forcedOff: [],
    });
  });

  it('turns off the steps that need a switched-off step, and says which ones', () => {
    const result = normalizeSteps({ folderMap: false });
    expect(result.steps).toMatchObject({ folderMap: false, nameIdentity: false, biosCandidates: false, matching: false, corrections: true });
    expect(result.forcedOff).toEqual(['nameIdentity', 'biosCandidates', 'matching']);
  });

  it('keeps corrections on when the folder hierarchy is off, and reports matching as forced off when names are off', () => {
    const result = normalizeSteps({ nameIdentity: false });
    expect(result.steps.corrections).toBe(true);
    expect(result.steps.matching).toBe(false);
    expect(result.forcedOff).toEqual(['biosCandidates', 'matching']);
  });

  it('does not report a step that the user had switched off', () => {
    expect(normalizeSteps({ matching: false }).forcedOff).toEqual([]);
  });
});

describe('correction drafts', () => {
  const file = 'file-1';
  const draft = (overrides: Partial<CorrectionDraft>): CorrectionDraft => ({ op: 'link', file, value: '', role: '', ...overrides });

  it('links and detaches a file of the chosen root and path', () => {
    expect(buildCorrection('a1', draft({ op: 'link' }), 'linux')).toEqual({ ok: true, correction: { op: 'link', fileId: file, boardAnchorId: 'a1' } });
    expect(buildCorrection('a1', draft({ op: 'unlink' }), 'linux')).toEqual({ ok: true, correction: { op: 'unlink', fileId: file, boardAnchorId: 'a1' } });
  });

  it('needs a file for link, unlink and role, and a value for an alias', () => {
    expect(buildCorrection('a1', draft({ op: 'link', file: undefined }), 'linux')).toEqual({ ok: false, reason: 'needsFile' });
    expect(buildCorrection('a1', draft({ op: 'role', file: undefined, role: 'bios-candidate' }), 'linux')).toEqual({ ok: false, reason: 'needsFile' });
    expect(buildCorrection('a1', draft({ op: 'aliasAdd', value: '   ' }), 'linux')).toEqual({ ok: false, reason: 'needsValue' });
  });

  it('sets a file role, and an empty role means the automatic one', () => {
    expect(buildCorrection('a1', draft({ op: 'role', role: 'bios-candidate' }), 'linux')).toEqual({ ok: true, correction: { op: 'role', fileId: file, role: 'bios-candidate' } });
    expect(buildCorrection('a1', draft({ op: 'role', role: '' }), 'linux')).toEqual({ ok: true, correction: { op: 'role', fileId: file, role: null } });
  });

  it('adds or removes a name in its search form', () => {
    expect(buildCorrection('a1', draft({ op: 'aliasAdd', value: '  Kestrel Plus ' }), 'linux')).toEqual({
      ok: true, correction: { op: 'alias', boardAnchorId: 'a1', alias: 'kestrel plus', remove: false },
    });
    expect(buildCorrection('a1', draft({ op: 'aliasRemove', value: 'Kestrel' }), 'linux')).toEqual({
      ok: true, correction: { op: 'alias', boardAnchorId: 'a1', alias: 'kestrel', remove: true },
    });
  });

  it('sets a board code in upper case, and an empty code clears it', () => {
    expect(buildCorrection('a1', draft({ op: 'boardCode', value: ' mb-q731 ' }), 'linux')).toEqual({
      ok: true, correction: { op: 'board-code', boardAnchorId: 'a1', code: 'MB-Q731' },
    });
    expect(buildCorrection('a1', draft({ op: 'boardCode', value: '' }), 'linux')).toEqual({
      ok: true, correction: { op: 'board-code', boardAnchorId: 'a1', code: null },
    });
  });

  it('refuses a board code the store would drop, and never saves it', () => {
    expect(buildCorrection('a1', draft({ op: 'boardCode', value: 'bad code!' }), 'linux')).toEqual({ ok: false, reason: 'invalid' });
    expect(buildCorrection('a1', draft({ op: 'boardCode', value: 'X' }), 'linux')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('sets a revision that the store reads, and refuses text without a revision', () => {
    expect(buildCorrection('a1', draft({ op: 'revision', value: 'REV3' }), 'linux')).toEqual({
      ok: true, correction: { op: 'revision', boardAnchorId: 'a1', revision: 'REV3' },
    });
    expect(buildCorrection('a1', draft({ op: 'revision', value: '' }), 'linux')).toEqual({
      ok: true, correction: { op: 'revision', boardAnchorId: 'a1', revision: null },
    });
    expect(buildCorrection('a1', draft({ op: 'revision', value: '!!!' }), 'linux')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('tells which operations need a file', () => {
    expect(needsFile('link')).toBe(true);
    expect(needsFile('role')).toBe(true);
    expect(needsFile('boardCode')).toBe(false);
  });
});

describe('catalog keys of the view', () => {
  const all: DeviceKey[] = [
    ...Object.values(COVERAGE_KEY), ...Object.values(CONFIDENCE_KEY), ...Object.values(BASIS_KEY), ...Object.values(ROLE_KEY),
    ...Object.values(SLOT_REASON_KEY), ...Object.values(OP_KEY), ...Object.values(STEP_KEY), ...Object.values(PHASE_KEY),
  ];

  it('every key the view can show exists in the English catalog, with a text', () => {
    const english = catalogs.en as Record<string, unknown>;
    const missing = all.filter(key => typeof english[key] !== 'string' && typeof english[key] !== 'object');
    expect(missing).toEqual([]);
  });

  it('every key exists in all eight languages', () => {
    for (const key of all) {
      for (const language of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
        expect(catalogs[language], `${language}:${key}`).toHaveProperty([key]);
      }
    }
  });
});
