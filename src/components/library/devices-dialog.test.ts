import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../lib/i18n';
import { ALL_STEPS } from '../../lib/library/devices/catalogue';
import { createBridgeDevicePort, type LibraryBridge } from '../../lib/library/devices/bridge-port';
import type { DeviceDatabasePort, ScanProgressView } from '../../lib/library/devices/ui-port';
import DevicesView, { DevicesPanel, type DevicesViewHandlers, type DevicesViewState } from './DevicesView';
import type { RejectReason } from '../../lib/library/devices/corrections';
import { needsClassification, rejectionLines } from '../../lib/library/devices/ui-model';
import type { BoardDetail, BoardFile } from '../../lib/library/devices/ui-port';
import type { TreeRow } from '../../lib/library/devices/ui-model';

/** Server-side markup only (no effects): the dialog entry, the unavailable state, and the scan result with its controls. */
const noopHandlers: DevicesViewHandlers = {
  addRoot: () => undefined, removeRoot: () => undefined, toggleRow: () => undefined, treeKey: () => undefined, focusRow: () => undefined,
  setText: () => undefined, setStatus: () => undefined, selectBoard: () => undefined, loadMore: () => undefined, setStep: () => undefined,
  startScan: () => undefined, pauseScan: () => undefined, resumeScan: () => undefined, cancelScan: () => undefined, skipStep: () => undefined,
  setDraft: () => undefined, saveCorrection: () => undefined, undoCorrection: () => undefined,
};

const doneProgress: ScanProgressView = {
  phase: 'done', fraction: 1, files: 7, skipped: ['biosCandidates'],
  result: { fileCount: 7, associationCount: 3, missingTargetCount: 1, excludedFirmwareCount: 2, collisionCount: 0, needsManualCount: 0, notRead: 4 },
};

function stateWith(progress: ScanProgressView | null, capabilities: DevicesViewState['capabilities']): DevicesViewState {
  return {
    available: true, platform: 'linux', roots: [], rows: [], folderNotes: new Map(), focusKey: null, text: '', status: 'all', boards: [],
    boardTotal: 0, hasMore: false, selectedAnchor: null, detail: null, phase: progress?.phase ?? 'idle', progress, steps: { ...ALL_STEPS },
    feedback: null, draft: { op: 'link', file: undefined, value: '', role: '' }, busy: false, capabilities,
  };
}

describe('device database view entry', () => {
  it('without a window bridge the view shows the unavailable note, in the chosen language', () => {
    const markup = renderToStaticMarkup(createElement(DevicesView, { t: createTranslator('hu'), port: null }));
    expect(markup).toContain('data-testid="devices-view"');
    expect(markup).toContain(createTranslator('hu')('libraryDevices.error.unavailable'));
    expect(markup).not.toContain('libraryDevices.');
  });

  it('with a port the dialog renders the scan controls, and no optional control the port does not offer', () => {
    const bridge: LibraryBridge = {
      libraryPickRoot: async () => null,
      libraryScan: async () => { throw new Error('not called in markup'); },
      libraryLoadCorrections: async () => ({ status: 'empty', document: { version: 1, platform: 'linux', corrections: [] }, dropped: 0 }),
      librarySaveCorrections: async () => ({ status: 'saved', bytes: 0 }),
    };
    const port: DeviceDatabasePort | null = createBridgeDevicePort(bridge, 'linux');
    const markup = renderToStaticMarkup(createElement(DevicesView, { t: createTranslator('en'), port }));
    expect(markup).toContain('Start scan');
    expect(markup).not.toContain('>Pause<');
  });
});

describe('scan result summary', () => {
  it('shows the counts of a finished scan, and no path', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, {
      t: createTranslator('en'), state: stateWith(doneProgress, { pauseScan: false, skipStep: false, removeRoot: false }), handlers: noopHandlers,
    }));
    expect(markup).toContain('Scan result');
    expect(markup).toContain('Links found: 3');
    expect(markup).toContain('Corrections whose file is not in this scan: 1');
    expect(markup).toContain('Firmware files left out of the BIOS check: 2');
    expect(markup).toContain('Path collisions: 0');
    expect(markup).toContain('Not read: 4');
  });

  it('TB-065: a quarantined corrections file is named in the scan result; a healthy one is not', () => {
    const render = (correctionsStatus: string) => renderToStaticMarkup(createElement(DevicesPanel, {
      t: createTranslator('en'),
      state: stateWith({ ...doneProgress, result: { ...doneProgress.result, correctionsStatus } } as ScanProgressView, { pauseScan: false, skipStep: false, removeRoot: false }),
      handlers: noopHandlers,
    }));
    const note = createTranslator('en')('libraryDevices.result.quarantined');
    expect(render('quarantined')).toContain(note);
    expect(render('ok')).not.toContain(note);
  });

  it('a running scan without a result shows no summary', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, {
      t: createTranslator('en'),
      state: stateWith({ phase: 'running', fraction: 0.4, files: 2, skipped: [] }, { pauseScan: false, skipStep: false, removeRoot: false }),
      handlers: noopHandlers,
    }));
    expect(markup).not.toContain('Scan result');
  });

  it('offers pause only when the port can pause', () => {
    const running: ScanProgressView = { phase: 'running', fraction: 0.1, files: 1, skipped: [] };
    const without = renderToStaticMarkup(createElement(DevicesPanel, { t: createTranslator('en'), state: stateWith(running, { pauseScan: false, skipStep: false, removeRoot: false }), handlers: noopHandlers }));
    const withPause = renderToStaticMarkup(createElement(DevicesPanel, { t: createTranslator('en'), state: stateWith(running, { pauseScan: true, skipStep: false, removeRoot: false }), handlers: noopHandlers }));
    expect(without).not.toContain('>Pause<');
    expect(withPause).toContain('>Pause<');
  });
});

describe('unclassified files and refused corrections', () => {
  const noRoot = { availability: { status: 'not-found' as const, rootCount: 1 } };
  const detailWith = (role: BoardFile['role']): BoardDetail => ({
    row: { anchorId: 'a1', names: [], models: [], boardview: noRoot, schematic: noRoot, bios: noRoot },
    files: [{ rootId: 'root-a', path: 'synthetic/unknown-file.pdf', role }],
    filesTruncated: false,
  });
  const withDetail = (detail: BoardDetail | null, rejections: RejectReason[]): DevicesViewState => ({
    ...stateWith(null, { pauseScan: false, skipStep: false, removeRoot: false }), selectedAnchor: 'a1', detail, rejections,
  });
  const handlersWith = (confirmRole?: (file: BoardFile) => void): DevicesViewHandlers => ({ ...noopHandlers, confirmRole });

  it('a document file says it needs a manual classification and offers the confirmation, with no guessed label', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, {
      t: createTranslator('en'), state: withDetail(detailWith('document'), []), handlers: handlersWith(() => undefined),
    }));
    expect(markup).toContain('Needs manual classification');
    expect(markup).toContain('Confirm this file type');
    expect(markup).not.toMatch(/datasheet|service.manual/i);
  });

  it('without a confirmation handler the file still says it needs a classification, but offers no button', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, { t: createTranslator('en'), state: withDetail(detailWith('document'), []), handlers: handlersWith() }));
    expect(markup).toContain('Needs manual classification');
    expect(markup).not.toContain('Confirm this file type');
  });

  it('a classified file shows no classification note', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, { t: createTranslator('en'), state: withDetail(detailWith('boardview'), []), handlers: handlersWith(() => undefined) }));
    expect(markup).not.toContain('Needs manual classification');
  });

  it('refused correction entries are listed once each, in the closed order, with the localized text and no raw message', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, {
      t: createTranslator('en'), state: withDetail(null, ['too-many', 'unknown-role', 'unknown-role']), handlers: handlersWith(),
    }));
    expect(markup).toContain('Entries left out of your corrections');
    const unknown = markup.indexOf('does not exist');
    const many = markup.indexOf('more corrections than the limit');
    expect(unknown).toBeGreaterThan(-1);
    expect(many).toBeGreaterThan(unknown);
    expect(markup.split('does not exist').length - 1).toBe(1);
  });

  it('no refused entries means no notice', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, { t: createTranslator('en'), state: withDetail(null, []), handlers: handlersWith() }));
    expect(markup).not.toContain('Entries left out of your corrections');
  });

  it('the classification rule follows the store mapping: only the document role needs a manual classification', () => {
    expect(needsClassification('document')).toBe(true);
    for (const role of ['boardview', 'schematic', 'board-pdf', 'bios-candidate', 'ec-firmware', 'me-firmware', 'saved-dump', 'other'] as const) {
      expect(needsClassification(role)).toBe(false);
    }
  });

  it('rejection lines follow the closed order and ignore anything else', () => {
    expect(rejectionLines(['too-many', 'invalid-entry', 'bogus'])).toEqual(['libraryDevices.rejection.invalidEntry', 'libraryDevices.rejection.tooMany']);
  });
});

describe('folder read state in the tree', () => {
  const rowOf = (overrides: Partial<TreeRow>): TreeRow => ({
    key: 'r1\u0000f1', rootId: 'r1', path: 'f1', label: 'Synthetic folder', depth: 0, parentIndex: -1, expanded: false,
    hasChildren: false, loading: false, folderCount: 0, fileCount: 0, ...overrides,
  });
  const panelWith = (rows: TreeRow[]) => renderToStaticMarkup(createElement(DevicesPanel, {
    t: createTranslator('en'),
    state: { ...stateWith(null, { pauseScan: false, skipStep: false, removeRoot: false, skipFolders: false }), rows },
    handlers: noopHandlers,
  }));

  it('an unreadable folder shows its name, its state and its code, not the empty counts', () => {
    const markup = panelWith([rowOf({ readState: 'unreadable', code: 'EACCES' })]);
    expect(markup).toContain('Synthetic folder');
    expect(markup).toContain('Not readable');
    expect(markup).toContain('Code: EACCES');
    expect(markup).not.toContain('0 folders, 0 files');
  });

  it('a skipped or not yet read folder is said so, and a listed folder keeps its counts', () => {
    const skipped = panelWith([rowOf({ readState: 'skipped' })]);
    const pending = panelWith([rowOf({ readState: 'pending' })]);
    const listed = panelWith([rowOf({ readState: 'listed', folderCount: 1, fileCount: 2 })]);
    expect(skipped).toContain('Not read (skipped)');
    expect(pending).toContain('Not read yet');
    expect(listed).toContain('1 folders, 2 files');
    expect(listed).not.toContain('Not readable');
  });
});

describe('W14 contract in the view: step skips while running, file basenames', () => {
  it('while a scan runs and the port can skip, each step still on has its own skip button', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, {
      t: createTranslator('en'),
      state: { ...stateWith({ phase: 'running', fraction: 0.2, files: 3, skipped: ['biosCandidates'] }, { pauseScan: false, skipStep: true, removeRoot: false, skipFolders: false }), phase: 'running' },
      handlers: noopHandlers,
    }));
    expect(markup).toContain('Skip this step: Folder hierarchy');
    expect(markup).toContain('Skip this step: Motherboard matching');
    expect(markup).not.toContain('Skip this step: BIOS candidates');
  });

  it('without the skip capability no step can be skipped', () => {
    const markup = renderToStaticMarkup(createElement(DevicesPanel, {
      t: createTranslator('en'),
      state: { ...stateWith({ phase: 'running', fraction: 0.2, files: 3, skipped: [] }, { pauseScan: false, skipStep: false, removeRoot: false, skipFolders: false }), phase: 'running' },
      handlers: noopHandlers,
    }));
    expect(markup).not.toContain('Skip this step');
  });
});

describe('board count under a filter', () => {
  const row = (anchorId: string) => ({
    anchorId, names: [], models: [],
    boardview: { presence: 'confirmed' as const, complete: true },
    schematic: { presence: 'unknown' as const, complete: true },
    bios: { presence: 'none' as const, complete: true },
  });
  const withBoards = (text: string, status: 'all' | 'found', boardTotal: number, boards: ReturnType<typeof row>[]) => ({
    ...stateWith(null, { pauseScan: false, skipStep: false, removeRoot: false, skipFolders: false }),
    text, status, boards, boardTotal,
  });
  const panel = (state: DevicesViewState) => renderToStaticMarkup(createElement(DevicesPanel, { t: createTranslator('en'), state, handlers: noopHandlers }));

  it('without a filter the count is the total of the list', () => {
    const markup = panel(withBoards('', 'all', 10, [row('a1'), row('a2')]));
    expect(markup).toContain('Motherboards: 10');
    expect(markup).not.toContain('on the loaded page');
  });

  it('under a text or status filter the count is the loaded, matching rows, and says it is the loaded page', () => {
    const byText = panel(withBoards('beta', 'all', 10, [row('a2')]));
    expect(byText).toContain('1 matches on the loaded page');
    expect(byText).not.toContain('Motherboards: 10');
    const byStatus = panel(withBoards('', 'found', 10, [row('a1'), row('a2')]));
    expect(byStatus).toContain('2 matches on the loaded page');
  });
});
