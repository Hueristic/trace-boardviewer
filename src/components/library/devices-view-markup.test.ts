import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs, createTranslator } from '../../lib/i18n';
import type { Language } from '../../lib/i18n';
import { ALL_STEPS } from '../../lib/library/devices/catalogue';
import { buildTreeRows, folderKey, type DeviceKey } from '../../lib/library/devices/ui-model';
import type { BoardDetail, BoardRow, RootSummary } from '../../lib/library/devices/ui-port';
import { DevicesPanel, type DevicesViewHandlers, type DevicesViewState } from './DevicesView';

/**
 * Markup of the device database view (server-side render, no DOM and no effects): the unavailable state, root and scan panels,
 * the folder tree and motherboard list in every status, the detail with its reasons and the correction form, in all eight
 * languages. Focus, keyboard moves, progress updates and the port calls are covered by ui-model.test.ts and the real-app smoke.
 *
 * Fixtures are invented: folder names, board codes and file names are synthetic.
 */
const roots: RootSummary[] = [
  { rootId: 'r1', label: 'Demo root A', coverage: 'complete', folderCount: 1, fileCount: 3, network: false },
  { rootId: 'r2', label: 'Demo root B', coverage: 'offline', folderCount: 0, fileCount: 1, network: true },
];

const notFound = { availability: { status: 'not-found' as const, rootCount: 1 } };
const foundConfirmed = { availability: { status: 'found' as const, count: 2 }, bestState: 'confirmed' as const, basis: 'content' as const };
const unknownOffline = { availability: { status: 'unknown' as const, reason: 'offline' as const, knownOffline: 1 } };

const board = (overrides: Partial<BoardRow>): BoardRow => ({
  anchorId: 'a1', boardCode: 'MB-Q731', revision: 'REV2', names: ['demo alpha'], models: ['Demo model'],
  boardview: foundConfirmed, schematic: notFound, bios: unknownOffline, ...overrides,
});

const boards: BoardRow[] = [
  board({ anchorId: 'a1' }),
  board({ anchorId: 'a2', boardCode: 'MB-Q732', revision: undefined, boardview: notFound, schematic: notFound, bios: notFound, models: [] }),
  board({ anchorId: 'a3', boardCode: undefined, boardview: unknownOffline, schematic: unknownOffline, bios: unknownOffline }),
];

const detail: BoardDetail = {
  row: boards[0],
  filesTruncated: true,
  files: [
    {
      rootId: 'r1', path: 'alder/demo.brd', role: 'boardview',
      association: {
        anchorId: 'a1', filePath: 'r1\u0000alder/demo.brd', role: 'boardview', state: 'confirmed', basis: 'content', score: 60,
        signals: [{ signal: 'code-content', weight: 60, detail: 'content MB-Q731' }], conflicts: [], missing: [],
      },
    },
    {
      rootId: 'r1', path: 'alder/mainboard.bin', role: 'bios-candidate',
      association: {
        anchorId: 'a1', filePath: 'r1\u0000alder/mainboard.bin', role: 'bios-candidate', state: 'review', basis: 'conflict', score: 40,
        signals: [], conflicts: [{ field: 'revision', fileValue: 'REV1', anchorValue: 'REV2' }], missing: ['file-revision'],
      },
    },
  ],
};

const handlers: DevicesViewHandlers = {
  addRoot: () => undefined, removeRoot: () => undefined, toggleRow: () => undefined, treeKey: () => undefined, focusRow: () => undefined,
  setText: () => undefined, setStatus: () => undefined, selectBoard: () => undefined, loadMore: () => undefined, setStep: () => undefined,
  startScan: () => undefined, pauseScan: () => undefined, resumeScan: () => undefined, cancelScan: () => undefined, skipStep: () => undefined,
  setDraft: () => undefined, saveCorrection: () => undefined, undoCorrection: () => undefined,
};

const expandedRows = buildTreeRows({
  roots,
  cache: new Map([[folderKey('r1', ''), [{ path: 'alder', name: 'Alder', folderCount: 1, fileCount: 2, bytes: 10 }]]]),
  expanded: new Set([folderKey('r1', '')]),
});

function stateOf(overrides: Partial<DevicesViewState> = {}): DevicesViewState {
  return {
    available: true, platform: 'linux', roots, rows: expandedRows, folderNotes: new Map(), focusKey: null, text: '', status: 'all',
    boards, boardTotal: 3, hasMore: true, selectedAnchor: 'a1', detail, phase: 'idle', progress: null, steps: { ...ALL_STEPS },
    feedback: null, draft: { op: 'link', file: undefined, value: '', role: '' }, busy: false, ...overrides,
  };
}

const render = (lang: Language, state: DevicesViewState): string => renderToStaticMarkup(createElement(DevicesPanel, { t: createTranslator(lang), state, handlers }));
const catalog = (lang: Language): Record<string, string> => catalogs[lang] as Record<string, string>;
const text = (key: DeviceKey, lang: Language): string => {
  const value = catalog(lang)[key];
  expect(typeof value, `${lang}:${key}`).toBe('string');
  return value as string;
};
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('device database view markup', () => {
  it('shows only the unavailable note when the service is not provided', () => {
    const html = render('en', stateOf({ available: false, boards: [], rows: [], roots: [], selectedAnchor: null, detail: null }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(escape(text('libraryDevices.error.unavailable', 'en')));
    expect(html).not.toContain('role="tree"');
    expect(html).not.toContain('data-testid="devices-correction"');
  });

  it.each(LANGUAGES)('%s: title, privacy line, panels and buttons come from the catalog, and no raw key is shown', (lang) => {
    const html = render(lang, stateOf({ phase: 'running', progress: { phase: 'running', step: 'matching', fraction: 0.5, files: 12, skipped: [] } }));
    expect(html).toContain(escape(text('libraryDevices.title', lang)));
    expect(html).toContain(escape(text('libraryDevices.privacy', lang)));
    expect(html).toContain(escape(text('libraryDevices.roots.add', lang)));
    expect(html).toContain(escape(text('libraryDevices.scan.cancel', lang)));
    expect(html).toContain(escape(text('libraryDevices.detail.reasons', lang)));
    expect(html).not.toMatch(/libraryDevices\.[a-zA-Z.]+/);
  });

  it('marks every board with its own status: found, not found and unknown are different', () => {
    const html = render('en', stateOf());
    expect([...html.matchAll(/data-status="([a-zA-Z]+)"/g)].map(match => match[1])).toEqual(['found', 'notFound', 'unknown']);
    expect(html).toContain(escape(text('libraryDevices.slot.notFound', 'en')));
    expect(html).toContain(escape(text('libraryDevices.slot.reason.offline', 'en')));
    expect(html).toContain(escape(text('libraryDevices.slot.knownOffline', 'en').replace('{count}', '1')));
  });

  it('shows the confidence and the basis of a found slot, and says when a candidate needs review', () => {
    const html = render('en', stateOf());
    expect(html).toContain(escape(text('libraryDevices.confidence.confirmed', 'en')));
    expect(html).toContain(escape(text('libraryDevices.basis.conflict', 'en')));
    expect(html).toContain(escape(text('libraryDevices.confidence.review', 'en')));
  });

  it('keeps the BIOS candidate caveat next to every BIOS file, and never calls it proven', () => {
    const html = render('en', stateOf());
    expect(html).toContain(escape(text('libraryDevices.role.biosCandidate', 'en')));
    expect(html).toContain(escape(text('libraryDevices.bios.notProven', 'en')));
    expect(html).not.toMatch(/proven BIOS|verified BIOS/i);
  });

  it('shows the reasons with both conflict values, and the missing evidence', () => {
    const html = render('en', stateOf());
    expect(html).toContain('REV1');
    expect(html).toContain('REV2');
    expect(html).toContain(escape(text('libraryDevices.detail.missingItem.fileRevision', 'en')));
  });

  it('renders the tree with roles, levels and expansion, and a loading note for an expanded folder without children', () => {
    const html = render('en', stateOf({ rows: buildTreeRows({ roots, cache: new Map(), expanded: new Set([folderKey('r1', '')]) }) }));
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem" aria-level="1" aria-expanded="true"');
    expect(html).toContain(escape(text('libraryDevices.tree.loading', 'en')));
  });

  it('exposes the scan as a progress bar with its value and the cancel and skip controls while a step runs', () => {
    const html = render('en', stateOf({
      phase: 'running',
      progress: { phase: 'running', step: 'nameIdentity', fraction: 0.456, files: 1200, skipped: ['biosCandidates'] },
    }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="46"');
    expect(html).toContain(escape(text('libraryDevices.scan.skip', 'en')));
    expect(html).toContain(escape(text('libraryDevices.scan.skipped', 'en').replace('{count}', '1')));
    expect(html).toMatch(new RegExp(`<button type="button" class="primary-button" disabled="">${escape(text('libraryDevices.scan.start', 'en'))}</button>`));
  });

  it('shows the start button disabled and resume only while the scan is paused', () => {
    const idle = render('en', stateOf({ roots: [] }));
    expect(idle).toMatch(new RegExp(`<button type="button" class="primary-button" disabled="" data-testid|<button type="button" class="primary-button" disabled=""`));
    const paused = render('en', stateOf({ phase: 'paused', progress: { phase: 'paused', fraction: 0.2, files: 5, skipped: [] } }));
    expect(paused).toContain(escape(text('libraryDevices.scan.resume', 'en')));
    expect(paused).toContain(escape(text('libraryDevices.scan.paused', 'en')));
  });

  it('explains why a step that needs the folder hierarchy cannot run while that step is off', () => {
    const html = render('en', stateOf({ steps: { ...ALL_STEPS, folderMap: false } }));
    expect(html).toContain(escape(text('libraryDevices.scan.stepNeedsFolders', 'en')));
    expect(html).toContain(escape(text('libraryDevices.scan.stepNeedsNames', 'en')));
  });

  it('offers the file correction operations, a role choice and a note that corrections are kept', () => {
    const html = render('en', stateOf());
    expect(html).toContain('data-testid="devices-correction"');
    expect(html).toContain(escape(text('libraryDevices.correction.op.link', 'en')));
    expect(html).toContain(escape(text('libraryDevices.correction.op.boardCode', 'en')));
    expect(html).toContain(escape(text('libraryDevices.correction.hint', 'en')));
  });

  it('lists the board files under their role, in the fixed order, with the root label', () => {
    const html = render('en', stateOf());
    const order = [...html.matchAll(/devices-file-role">([^<]*)</g)].map(match => match[1]);
    expect(order).toEqual([escape(text('libraryDevices.role.boardview', 'en')), escape(text('libraryDevices.role.biosCandidate', 'en'))]);
    expect(html).toContain('Demo root A');
  });

  it('marks an online-only board file with its own label; the other files carry no such mark', () => {
    const online = { ...detail, files: [{ ...detail.files[0], online: true as const }, detail.files[1]] };
    const html = render('en', stateOf({ detail: online }));
    expect(html.split(escape(text('libraryDevices.file.onlineOnly', 'en'))).length - 1).toBe(1);
    expect(html).toContain('devices-file-online');
  });

  it('states that more files exist when the detail is truncated', () => {
    const html = render('en', stateOf());
    expect(html).toContain(escape(text('libraryDevices.detail.truncated', 'en').replace('{count}', '2')));
  });

  it('shows the empty detail prompt when no motherboard is selected', () => {
    const html = render('en', stateOf({ selectedAnchor: null, detail: null }));
    expect(html).toContain(escape(text('libraryDevices.detail.empty', 'en')));
    expect(html).not.toContain('data-testid="devices-correction"');
  });
});
