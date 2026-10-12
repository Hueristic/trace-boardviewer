import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceApi } from '../../app/api';
import type { BoardNetTarget, BoardTarget, Mapping, MappingReason, SchematicNetTarget } from '../../lib/crossprobe';
import { LANGUAGES, catalogs, createFormatters, createTranslator, renderMessage, translate, type Language } from '../../lib/i18n';
import { BoardMappingBanner, BoardNetBanner, SchematicNetSection, mappingReasons } from './InspectorSections';
import { UiContext, type UiContextValue } from './ui-context';

// The board-net banner, the schematic-net section and the mapping reasons take their texts from the catalogs (O-03).
// Each language renders its own text, and no English heading survives outside English.
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const uiFor = (lang: Language): UiContextValue => ({ t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: message => renderMessage(lang, message), copy: () => {} });
const render = (lang: Language, node: ReactElement): string => decode(renderToStaticMarkup(createElement(UiContext.Provider, { value: uiFor(lang) }, node)));

const REASONS: Array<[MappingReason, string]> = [
  ['several-schematic-placements', 'schematic.boardMapping.reason.severalSchematicPlacements'],
  ['several-board-parts', 'schematic.boardMapping.reason.severalBoardParts'],
  ['alias-merged-parts', 'schematic.boardMapping.reason.aliasMergedParts'],
  ['unannotated-schematic-reference', 'schematic.boardMapping.reason.unannotatedReference'],
  ['duplicate-annotation', 'schematic.boardMapping.reason.duplicateAnnotation'],
  ['schematic-pin-nets-conflict', 'schematic.boardMapping.reason.schematicPinNetsConflict'],
  ['board-pin-nets-conflict', 'schematic.boardMapping.reason.boardPinNetsConflict'],
  ['no-schematic-part', 'schematic.boardMapping.reason.noSchematicPart'],
  ['no-board-component', 'schematic.boardMapping.reason.noBoardComponent'],
  ['pin-missing-on-schematic', 'schematic.boardMapping.reason.pinMissingOnSchematic'],
  ['pin-missing-on-board', 'schematic.boardMapping.reason.pinMissingOnBoard'],
  ['unknown-component', 'schematic.boardMapping.reason.unknownComponent'],
  ['unknown-pin', 'schematic.boardMapping.reason.unknownPin'],
  ['unknown-symbol', 'schematic.boardMapping.reason.unknownSymbol'],
  ['virtual-symbol', 'schematic.boardMapping.reason.virtualSymbol'],
  ['unknown-net', 'schematic.boardMapping.reason.unknownNet'],
  ['several-schematic-nets', 'schematic.boardMapping.reason.severalSchematicNets'],
  ['several-board-nets', 'schematic.boardMapping.reason.severalBoardNets'],
  ['no-schematic-net', 'schematic.boardMapping.reason.noSchematicNet'],
  ['no-board-net', 'schematic.boardMapping.reason.noBoardNet'],
];
const NET_KEYS = [
  'title', 'unique', 'ambiguous', 'missing', 'scopeGlobal', 'scopeLocal', 'scopeHierarchical', 'allSheets', 'rootSheet', 'sheetPage', 'connections',
  'useNet', 'showNet', 'linkPanel', 'aliasHint', 'boardAmbiguous', 'boardMissing', 'flagged', 'viaAlias', 'viaCase', 'autoNamed', 'moreCandidates',
].map(name => `schematic.netSection.${name}`);

const schematicDoc = { record: { id: 'sch', kind: 'schematic', name: 'board.sch', path: '/x/board.sch', size: 1 }, status: 'ready', design: {} };
const netApi = (schematicNetMapping: unknown) => ({ state: { documents: [schematicDoc], probe: { schematicNetMapping } }, actions: { chooseSchematicNet: () => {} }, sheetsOf: () => [] }) as unknown as WorkspaceApi;
const netAt = (over: Partial<SchematicNetTarget>): SchematicNetTarget => ({ documentId: 'sch', netKey: 'k', netId: 'n', name: 'GND', auto: false, scope: 'global', memberCount: 4, via: 'exact', ...over });
const uniqueNet = { status: 'unique', total: 1, truncated: false, reasons: [], caseInsensitive: [], candidates: [netAt({})] };
const ambiguousNet = { status: 'ambiguous', total: 2, truncated: false, reasons: [], caseInsensitive: [], candidates: [netAt({ netKey: 'k1', scope: 'local', scopePath: 'Sheet1', memberCount: 2 }), netAt({ netKey: 'k2', scope: 'hierarchical', memberCount: 1, via: 'alias' })] };
const missingNet = { status: 'missing', total: 0, truncated: false, reasons: ['no-schematic-net'], caseInsensitive: [], candidates: [] };
const ambiguousBoardNet = { status: 'ambiguous', total: 2, truncated: false, reasons: ['several-board-nets'], caseInsensitive: [], candidates: [{ name: 'SIGA', id: null, pinCount: 1, via: 'exact' }, { name: 'SIGB', id: null, pinCount: 3, via: 'alias' }] } as unknown as Mapping<BoardNetTarget>;
const missingBoardPart = { status: 'missing', total: 0, truncated: false, reasons: ['no-board-component'], caseInsensitive: [], candidates: [] } as unknown as Mapping<BoardTarget>;

describe('O-03 net texts: catalog keys in all eight languages', () => {
  it('every net section and reason key exists in every language', () => {
    for (const key of [...NET_KEYS, ...REASONS.map(([, name]) => name)]) {
      for (const lang of LANGUAGES) {
        expect((catalogs[lang] as Record<string, unknown>)[key], `${lang} ${key}`).toBeDefined();
      }
    }
  });
  it('covers every mapping reason exactly once', () => {
    expect(new Set(REASONS.map(([reason]) => reason)).size).toBe(20);
  });
  it('plural forms follow the rules of each language', () => {
    expect(translate('en', 'schematic.netSection.connections', { count: 1 })).toBe('1 connection');
    expect(translate('en', 'schematic.netSection.connections', { count: 2 })).toBe('2 connections');
    expect(translate('hu', 'schematic.netSection.connections', { count: 2 })).toBe('2 kapcsolat');
    expect(translate('en', 'unit.pins', { count: 1 })).toBe('1 pin');
    expect(translate('pl', 'unit.pins', { count: 2 })).toBe('2 piny');
    expect(translate('pl', 'unit.pins', { count: 5 })).toBe('5 pinów');
    expect(translate('uk', 'unit.pins', { count: 2 })).toBe('2 піни');
  });
});

describe('O-03 net texts: each language renders its own text', () => {
  it('every mapping reason is its own catalog text', () => {
    for (const lang of LANGUAGES) {
      for (const [reason, key] of REASONS) {
        expect(mappingReasons([reason], createTranslator(lang)), `${lang} ${reason}`).toBe(translate(lang, key));
      }
    }
  });
  it('the board-net banner drops its English heading and reasons outside English', () => {
    for (const lang of LANGUAGES) {
      const html = render(lang, createElement(BoardNetBanner, { mapping: ambiguousBoardNet, onChoose: () => {} }));
      expect(html, lang).toContain(translate(lang, 'schematic.netSection.boardAmbiguous'));
      expect(html, lang).toContain(translate(lang, 'schematic.boardMapping.reason.severalBoardNets'));
      expect(html, lang).toContain(translate(lang, 'unit.pins', { count: 1 }));
      if (lang !== 'en') {
        expect(html).not.toContain('Several board nets match this schematic net');
        expect(html).not.toContain('Several board nets carry this name');
      }
    }
  });
  it('the schematic-net section renders its unique, ambiguous and missing states in each language', () => {
    for (const lang of LANGUAGES) {
      const unique = render(lang, createElement(SchematicNetSection, { api: netApi(uniqueNet), onShow: () => {}, onLink: () => {} }));
      expect(unique, lang).toContain(translate(lang, 'schematic.netSection.title'));
      expect(unique, lang).toContain(translate(lang, 'schematic.netSection.unique'));
      expect(unique, lang).toContain(translate(lang, 'schematic.netSection.showNet'));
      expect(unique, lang).toContain(translate(lang, 'schematic.netSection.scopeGlobal'));
      expect(unique, lang).toContain(translate(lang, 'schematic.netSection.connections', { count: 4 }));

      const ambiguous = render(lang, createElement(SchematicNetSection, { api: netApi(ambiguousNet), onShow: () => {}, onLink: () => {} }));
      expect(ambiguous, lang).toContain(translate(lang, 'schematic.netSection.ambiguous'));
      expect(ambiguous, lang).toContain(translate(lang, 'schematic.netSection.useNet'));
      expect(ambiguous, lang).toContain(translate(lang, 'schematic.netSection.scopeLocal'));
      expect(ambiguous, lang).toContain(translate(lang, 'schematic.netSection.scopeHierarchical'));
      expect(ambiguous, lang).toContain(translate(lang, 'schematic.netSection.allSheets'));

      const missing = render(lang, createElement(SchematicNetSection, { api: netApi(missingNet), onShow: () => {}, onLink: () => {} }));
      expect(missing, lang).toContain(translate(lang, 'schematic.netSection.missing'));
      expect(missing, lang).toContain(translate(lang, 'schematic.netSection.aliasHint'));
      expect(missing, lang).toContain(translate(lang, 'schematic.netSection.linkPanel'));
      expect(missing, lang).toContain(translate(lang, 'schematic.boardMapping.reason.noSchematicNet'));
      if (lang !== 'en') {
        expect(unique).not.toContain('Linked to one schematic net');
        expect(ambiguous).not.toContain('Several schematic nets carry this name');
        expect(missing).not.toContain('No schematic net has this name');
      }
    }
  });
  it('the part banner translates its reasons (its own heading stays with its banner texts)', () => {
    for (const lang of LANGUAGES) {
      const html = render(lang, createElement(BoardMappingBanner, { mapping: missingBoardPart, onChoose: () => {} }));
      expect(html, lang).toContain(translate(lang, 'schematic.boardMapping.reason.noBoardComponent'));
    }
  });
});
