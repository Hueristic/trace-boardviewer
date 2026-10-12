import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { FILE_ROLES as CANONICAL_ROLES } from '../model';
import { validateLibraryArgs } from '../validate';
import { applyCorrections, CANONICAL_ROLE_OF, compactCorrections, FILE_ROLES, fileRefOf, MAX_CORRECTIONS, MAX_PATH_TEXT, parseCorrections, patchAnchors, REJECTION_REASONS, serializeCorrections, confirmCaseCollision, type Correction, type CorrectionDocument } from './corrections';
import { pairKey, type BoardAnchor } from './match';

const require = createRequire(import.meta.url);
const cjsValidate = require('../../../../electron/library/validate.cjs') as typeof import('../validate');

const target = (path: string, rootId = 'root-a') => ({ rootId, path });
const anchors: BoardAnchor[] = [{ id: 'g1', boardCode: 'MB-Q731', aliases: ['kestrel'] }];

describe('correction document', () => {
  it('round-trips deterministically and keeps every valid entry', () => {
    const corrections: Correction[] = [
      { op: 'link', file: target('Alder/Orion-5/EC-Q731.bin'), anchorId: 'g1' },
      { op: 'role', file: target('Alder/Orion-5/EC-Q731.bin'), role: 'ec-firmware' },
      { op: 'alias', anchorId: 'g1', alias: 'Kestrel 14 Plus', remove: false },
      { op: 'board-code', anchorId: 'g1', code: 'MB-Q731' },
      { op: 'revision', anchorId: 'g1', revision: 'REV3' },
    ];
    const text = serializeCorrections({ version: 1, platform: 'win32', corrections });
    expect(serializeCorrections({ version: 1, platform: 'win32', corrections })).toBe(text);
    const parsed = parseCorrections(text);
    expect(parsed.dropped).toBe(0);
    expect(parsed.error).toBeUndefined();
    expect(parsed.document.corrections).toEqual(corrections.map(item => (item.op === 'alias' ? { ...item, alias: 'kestrel 14 plus' } : item)));
    expect(parsed.document.platform).toBe('win32');
  });

  it('drops invalid entries and counts them, keeping the valid ones', () => {
    const source = JSON.stringify({
      version: 1,
      platform: 'linux',
      corrections: [
        { op: 'link', file: { rootId: 'r', path: 'a.brd' }, anchorId: 'g1' },
        { op: 'teleport', file: { rootId: 'r', path: 'a.brd' } },
        { op: 'role', file: { rootId: 'r', path: 'a.brd' }, role: 'pirate' },
        { op: 'board-code', anchorId: 'g1', code: 'bad code!' },
        { op: 'revision', anchorId: 'g1', revision: '' },
        { op: 'alias', anchorId: 'g1', alias: 'x', remove: false },
        { op: 'link', file: { rootId: 'r' }, anchorId: 'g1' },
        'not an object',
      ],
    });
    const parsed = parseCorrections(source);
    expect(parsed.document.corrections).toHaveLength(1);
    expect(parsed.dropped).toBe(7);
  });

  it('reports a damaged or foreign document as an error with no corrections', () => {
    expect(parseCorrections('{not json')).toMatchObject({ error: 'not-json', dropped: 0 });
    expect(parseCorrections(JSON.stringify({ version: 2, platform: 'linux', corrections: [] }))).toMatchObject({ error: 'wrong-version' });
    expect(parseCorrections(JSON.stringify({ version: 1, platform: 'amiga', corrections: [] }))).toMatchObject({ error: 'bad-platform' });
    expect(parseCorrections('null')).toMatchObject({ error: 'wrong-version' });
    expect(parseCorrections(JSON.stringify({ version: 1, platform: 'linux' })).document.corrections).toEqual([]);
  });
});

describe('compaction and file references', () => {
  it('keeps the last correction for each target', () => {
    const link: Correction = { op: 'link', file: target('a.brd'), anchorId: 'g1' };
    const unlink: Correction = { op: 'unlink', file: target('a.brd'), anchorId: 'g1' };
    expect(compactCorrections([link, unlink], 'linux')).toEqual([unlink]);
    const roleA: Correction = { op: 'role', file: target('a.brd'), role: 'schematic' };
    const roleB: Correction = { op: 'role', file: target('a.brd'), role: null };
    expect(compactCorrections([roleA, link, roleB], 'linux')).toEqual([link, roleB]);
  });

  it('matches a file by identity key only on platforms that fold case', () => {
    expect(fileRefOf(target('Alder/Orion-5/MB.bin'), 'win32')).toBe(fileRefOf(target('alder/orion-5/mb.bin'), 'win32'));
    expect(fileRefOf(target('Alder/Orion-5/MB.bin'), 'linux')).not.toBe(fileRefOf(target('alder/orion-5/mb.bin'), 'linux'));
  });

  it('separates the same relative path under different roots', () => {
    expect(fileRefOf(target('a.brd', 'root-a'), 'linux')).not.toBe(fileRefOf(target('a.brd', 'root-b'), 'linux'));
  });
});

describe('applying corrections', () => {
  const present = new Set([fileRefOf(target('Alder/Orion-5/MB-Q731.fd'), 'linux'), fileRefOf(target('misc/mainboard.bin'), 'linux')]);

  it('turns a link into a user link, and an unlink into a detached pair', () => {
    const applied = applyCorrections(
      [
        { op: 'link', file: target('misc/mainboard.bin'), anchorId: 'g1' },
        { op: 'unlink', file: target('Alder/Orion-5/MB-Q731.fd'), anchorId: 'g1' },
      ],
      'linux',
      present,
    );
    expect(applied.decisions.userLinks).toEqual(new Set([pairKey(fileRefOf(target('misc/mainboard.bin'), 'linux'), 'g1')]));
    expect(applied.decisions.detached).toEqual(new Set([pairKey(fileRefOf(target('Alder/Orion-5/MB-Q731.fd'), 'linux'), 'g1')]));
    expect(applied.missingTargets).toEqual([]);
  });

  it('reports a correction whose file is absent, and never redirects it', () => {
    const missing: Correction = { op: 'link', file: target('moved/elsewhere.bin'), anchorId: 'g1' };
    const applied = applyCorrections([missing], 'linux', present);
    expect(applied.missingTargets).toEqual([missing]);
    expect(applied.decisions.userLinks?.size).toBe(0);
  });

  it('collects role overrides and anchor patches separately from file targets', () => {
    const applied = applyCorrections(
      [
        { op: 'role', file: target('Alder/Orion-5/MB-Q731.fd'), role: 'saved-dump' },
        { op: 'alias', anchorId: 'g1', alias: 'kestrel plus', remove: false },
        { op: 'alias', anchorId: 'g1', alias: 'kestrel', remove: true },
        { op: 'board-code', anchorId: 'g1', code: 'MB-Q732' },
        { op: 'revision', anchorId: 'g1', revision: 'REV3' },
      ],
      'linux',
      present,
    );
    expect(applied.roleOverrides.get(fileRefOf(target('Alder/Orion-5/MB-Q731.fd'), 'linux'))).toBe('saved-dump');
    expect(applied.anchorPatches.get('g1')).toEqual({ aliasAdd: ['kestrel plus'], aliasRemove: ['kestrel'], boardCode: 'MB-Q732', revision: 'REV3' });
  });

  it('patches anchors into a copy and keeps the input unchanged', () => {
    const applied = applyCorrections(
      [
        { op: 'alias', anchorId: 'g1', alias: 'kestrel plus', remove: false },
        { op: 'board-code', anchorId: 'g1', code: 'MB-Q732' },
        { op: 'revision', anchorId: 'g1', revision: 'REV3' },
      ],
      'linux',
      present,
    );
    const patched = patchAnchors(anchors, applied.anchorPatches);
    expect(patched[0]).toMatchObject({ id: 'g1', boardCode: 'MB-Q732', aliases: ['kestrel', 'kestrel plus'] });
    expect(patched[0].revision?.normalized).toBe('3');
    expect(anchors[0]).toEqual({ id: 'g1', boardCode: 'MB-Q731', aliases: ['kestrel'] });
    expect(patchAnchors(anchors, new Map())).toEqual(anchors);
  });

  it('clears a board code or revision with null', () => {
    const applied = applyCorrections([{ op: 'board-code', anchorId: 'g1', code: null }, { op: 'revision', anchorId: 'g1', revision: null }], 'linux', present);
    const [patched] = patchAnchors(anchors, applied.anchorPatches);
    expect(patched.boardCode).toBeUndefined();
    expect(patched.revision).toBeUndefined();
  });

  it('keeps the same decision across a rescan of the same root (identity, not generation)', () => {
    const decision: Correction[] = [{ op: 'link', file: target('misc/mainboard.bin'), anchorId: 'g1' }];
    const firstScan = new Set([fileRefOf(target('misc/mainboard.bin'), 'win32')]);
    const rescan = new Set([fileRefOf(target('MISC/MainBoard.BIN'), 'win32')]);
    expect(applyCorrections(decision, 'win32', firstScan).decisions.userLinks?.size).toBe(1);
    expect(applyCorrections(decision, 'win32', rescan).decisions.userLinks?.size).toBe(1);
  });
});

const libraryQuery = { text: 'part:TPS51225', mode: 'boards', filters: {}, sort: 'relevance', direction: 'asc', limit: 200 };
const roleQuery = (role: string) => ({ ...libraryQuery, filters: { roles: [role] } });
const CANONICAL_EXPECTED = ['board', 'schematic', 'board-pdf', 'datasheet', 'service-manual', 'bom', 'photo', 'thermal', 'firmware', 'other'];

describe('catalogue roles mapped to the canonical Library roles', () => {
  // The documented mapping table (corrections.ts, CANONICAL_ROLE_OF). A change here is a format decision, not a refactor.
  const DOCUMENTED_MAPPING = {
    boardview: 'board',
    schematic: 'schematic',
    'board-pdf': 'board-pdf',
    document: 'unknown',
    'bios-candidate': 'firmware',
    'ec-firmware': 'firmware',
    'me-firmware': 'firmware',
    'saved-dump': 'firmware',
    other: 'other',
  };
  const storedRole = (path: string, role: unknown) => JSON.stringify({ version: 1, platform: 'linux', corrections: [{ op: 'role', file: { rootId: 'r', path }, role }] });

  it('maps every catalogue role explicitly, to a canonical role or to the manual state', () => {
    expect(FILE_ROLES).toHaveLength(9);
    expect(Object.keys(CANONICAL_ROLE_OF).sort()).toEqual([...FILE_ROLES].sort());
    for (const role of FILE_ROLES) {
      expect(Object.prototype.hasOwnProperty.call(CANONICAL_ROLE_OF, role), role).toBe(true);
      const canonical = CANONICAL_ROLE_OF[role];
      expect(canonical === 'unknown' || CANONICAL_EXPECTED.includes(canonical), role).toBe(true);
    }
  });

  it('matches the documented mapping table exactly', () => {
    expect(CANONICAL_ROLE_OF).toEqual(DOCUMENTED_MAPPING);
  });

  it('marks only document as manual classification, and never invents a datasheet or a service manual', () => {
    expect(FILE_ROLES.filter(role => CANONICAL_ROLE_OF[role] === 'unknown')).toEqual(['document']);
    expect(Object.values(CANONICAL_ROLE_OF)).not.toContain('datasheet');
    expect(Object.values(CANONICAL_ROLE_OF)).not.toContain('service-manual');
  });

  it('matches the canonical Library list, and the Library validators accept every canonical role the catalogue produces', () => {
    expect([...CANONICAL_ROLES]).toEqual(CANONICAL_EXPECTED);
    const produced = [...new Set(FILE_ROLES.map(role => CANONICAL_ROLE_OF[role]).filter(role => role !== 'unknown'))].sort();
    expect(produced).toEqual(['board', 'board-pdf', 'firmware', 'other', 'schematic']);
    for (const role of produced) {
      expect(validateLibraryArgs('query', roleQuery(role)), role).toBe(true);
      expect(cjsValidate.validateLibraryArgs('query', roleQuery(role)), role).toBe(true);
    }
    expect(validateLibraryArgs('query', roleQuery('bios-candidate'))).toBe(false);
    expect(cjsValidate.validateLibraryArgs('query', roleQuery('bios-candidate'))).toBe(false);
  });

  it('keeps a stored document correction as document, explicitly, and never rewrites it to a canonical role', () => {
    const parsed = parseCorrections(storedRole('notes.pdf', 'document'));
    expect(parsed.dropped).toBe(0);
    expect(parsed.rejections).toEqual([]);
    expect(parsed.document.corrections).toEqual([{ op: 'role', file: { rootId: 'r', path: 'notes.pdf' }, role: 'document' }]);
  });

  it('refuses an unknown role with a reason and never rewrites it to a near name', () => {
    const source = JSON.stringify({
      version: 1,
      platform: 'linux',
      corrections: [
        { op: 'role', file: { rootId: 'r', path: 'a.brd' }, role: 'board' },
        { op: 'role', file: { rootId: 'r', path: 'a.brd' }, role: 'pirate' },
        { op: 'role', file: { rootId: 'r', path: 'a.brd' }, role: null },
      ],
    });
    const parsed = parseCorrections(source);
    expect(parsed.rejections).toEqual([
      { index: 0, reason: 'unknown-role' },
      { index: 1, reason: 'unknown-role' },
    ]);
    expect(parsed.dropped).toBe(2);
    expect(parsed.document.corrections).toEqual([{ op: 'role', file: { rootId: 'r', path: 'a.brd' }, role: null }]);
  });

  it('refuses canonical names that are not catalogue roles, so no canonical name enters version 1 by accident', () => {
    for (const name of ['datasheet', 'service-manual', 'bom', 'photo', 'thermal']) {
      expect(parseCorrections(storedRole('a.pdf', name)).rejections, name).toEqual([{ index: 0, reason: 'unknown-role' }]);
    }
  });

  it('refuses a role that is not a string with invalid-entry, not unknown-role', () => {
    expect(parseCorrections(storedRole('a.pdf', 7)).rejections).toEqual([{ index: 0, reason: 'invalid-entry' }]);
  });
});

describe('long Windows paths', () => {
  const linkWith = (path: string) => JSON.stringify({ version: 1, platform: 'win32', corrections: [{ op: 'link', file: { rootId: 'r', path }, anchorId: 'g1' }] });

  it('keeps a valid 600-character path unchanged', () => {
    const path = `${'n'.repeat(596)}.brd`;
    expect(path.length).toBe(600);
    const parsed = parseCorrections(linkWith(path));
    expect(parsed.dropped).toBe(0);
    expect(parsed.rejections).toEqual([]);
    expect(parsed.document.corrections).toEqual([{ op: 'link', file: { rootId: 'r', path }, anchorId: 'g1' }]);
  });

  it('keeps a relative path of exactly MAX_PATH_TEXT units and refuses one unit more with an explicit reason', () => {
    expect(MAX_PATH_TEXT).toBe(32_767);
    const atLimit = `${'n'.repeat(MAX_PATH_TEXT)}`;
    const over = `${'n'.repeat(MAX_PATH_TEXT + 1)}`;
    const parsed = parseCorrections(JSON.stringify({
      version: 1,
      platform: 'win32',
      corrections: [
        { op: 'link', file: { rootId: 'r', path: atLimit }, anchorId: 'g1' },
        { op: 'link', file: { rootId: 'r', path: over }, anchorId: 'g1' },
      ],
    }));
    expect(parsed.document.corrections).toEqual([{ op: 'link', file: { rootId: 'r', path: atLimit }, anchorId: 'g1' }]);
    expect(parsed.rejections).toEqual([{ index: 1, reason: 'path-too-long' }]);
  });

  it('refuses a 40000-character path with an explicit reason, never a silent truncation', () => {
    const parsed = parseCorrections(linkWith('n'.repeat(40_000)));
    expect(parsed.document.corrections).toEqual([]);
    expect(parsed.rejections).toEqual([{ index: 0, reason: 'path-too-long' }]);
    expect(parsed.dropped).toBe(1);
  });

  it('reports entries beyond the cap as too-many, with their index', () => {
    const entry = { op: 'board-code', anchorId: 'g1', code: 'MB-1' };
    const parsed = parseCorrections(JSON.stringify({ version: 1, platform: 'win32', corrections: Array.from({ length: MAX_CORRECTIONS + 1 }, () => entry) }));
    expect(parsed.document.corrections).toHaveLength(MAX_CORRECTIONS);
    expect(parsed.rejections).toEqual([{ index: MAX_CORRECTIONS, reason: 'too-many' }]);
    expect(parsed.dropped).toBe(1);
  });
});

describe('relative target validation, closed reason codes and lossless round trip', () => {
  const linkAt = (path: string) => JSON.stringify({ version: 1, platform: 'linux', corrections: [{ op: 'link', file: { rootId: 'r', path }, anchorId: 'g1' }] });

  it.each([
    ['absolute POSIX path', '/etc/passwd.bin'],
    ['drive-letter path', 'C:/Alder/MB.bin'],
    ['drive-relative path', 'C:MB.bin'],
    ['UNC path with backslashes', '\\\\server\\share\\MB.bin'],
    ['parent segment', '../MB.bin'],
    ['parent segment in the middle', 'Alder/../MB.bin'],
    ['current-directory segment', './MB.bin'],
    ['empty middle segment', 'Alder//MB.bin'],
    ['trailing slash', 'Alder/'],
    ['only a slash', '/'],
    ['backslash separator', 'Alder\\MB.bin'],
    ['alternate data stream colon', 'MB.bin:stream'],
    ['control character', 'MB\u0001.bin'],
  ])('refuses %s with invalid-relative-path, never truncates or rewrites it', (_label, path) => {
    const parsed = parseCorrections(linkAt(path));
    expect(parsed.document.corrections).toEqual([]);
    expect(parsed.rejections).toEqual([{ index: 0, reason: 'invalid-relative-path' }]);
  });

  it.each(['...foo.brd', 'a..b.brd', 'a. b.brd', 'Ähre/ΜΒ 1.brd', 'folder name/rev B.brd'])('accepts the valid relative path %s unchanged', path => {
    const parsed = parseCorrections(linkAt(path));
    expect(parsed.rejections).toEqual([]);
    expect(parsed.document.corrections).toEqual([{ op: 'link', file: { rootId: 'r', path }, anchorId: 'g1' }]);
  });

  it('gives every reason in the closed list a case that produces it', () => {
    expect(REJECTION_REASONS).toEqual(['invalid-entry', 'unknown-role', 'path-too-long', 'invalid-relative-path', 'too-many']);
    const seen = new Set<string>();
    seen.add(parseCorrections(JSON.stringify({ version: 1, platform: 'linux', corrections: [{ op: 'teleport' }] })).rejections[0].reason);
    seen.add(parseCorrections(JSON.stringify({ version: 1, platform: 'linux', corrections: [{ op: 'role', file: { rootId: 'r', path: 'a.brd' }, role: 'pirate' }] })).rejections[0].reason);
    seen.add(parseCorrections(linkAt('n'.repeat(MAX_PATH_TEXT + 1))).rejections[0].reason);
    seen.add(parseCorrections(linkAt('../a.brd')).rejections[0].reason);
    seen.add(parseCorrections(JSON.stringify({ version: 1, platform: 'linux', corrections: Array.from({ length: MAX_CORRECTIONS + 1 }, () => ({ op: 'board-code', anchorId: 'g1', code: 'MB-1' })) })).rejections.at(-1)!.reason);
    expect([...seen].sort()).toEqual([...REJECTION_REASONS].sort());
  });

  it('round-trips every operation, unicode and dotted names, and the explicit document role without loss', () => {
    const corrections: Correction[] = [
      { op: 'link', file: target('Ähre/ΜΒ 1.brd'), anchorId: 'g1' },
      { op: 'unlink', file: target('...foo.brd'), anchorId: 'g2' },
      { op: 'role', file: target('a..b/notes.pdf'), role: 'document' },
      { op: 'role', file: target('a..b/notes.pdf'), role: null },
      { op: 'role', file: target('fw/ec.bin'), role: 'ec-firmware' },
      { op: 'alias', anchorId: 'g1', alias: 'kestrel 14', remove: false },
      { op: 'alias', anchorId: 'g1', alias: 'old name', remove: true },
      { op: 'board-code', anchorId: 'g1', code: 'MB-Q731' },
      { op: 'board-code', anchorId: 'g2', code: null },
      { op: 'revision', anchorId: 'g1', revision: 'REV B' },
      { op: 'link', file: target(`${'n'.repeat(596)}.brd`), anchorId: 'g3' },
    ];
    const text = serializeCorrections({ version: 1, platform: 'win32', corrections });
    const parsed = parseCorrections(text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.dropped).toBe(0);
    expect(parsed.rejections).toEqual([]);
    expect(parsed.document.corrections).toEqual(corrections);
    expect(serializeCorrections(parsed.document)).toBe(text);
  });
});

describe('confirming a case-collision never stores a path the codec would refuse', () => {
  const stored = (path: string): CorrectionDocument => ({ version: 1, platform: 'linux', corrections: [{ op: 'link', file: { rootId: 'r', path: 'Old/MB.brd' }, anchorId: 'g1' }] });
  const item = (candidate: string) => ({ correction: { op: 'link' as const, file: { rootId: 'r', path: 'Old/MB.brd' }, anchorId: 'g1' }, candidatePaths: [candidate] });

  it('leaves the document unchanged when the candidate has a character Windows refuses', () => {
    const document = stored('');
    const candidate = 'Old/mb?.brd';
    expect(confirmCaseCollision(document, item(candidate), candidate)).toBe(document);
  });

  it('matches the stored correction whatever the order of its keys', () => {
    const reordered = { anchorId: 'g1', file: { path: 'Old/MB.brd', rootId: 'r' }, op: 'link' } as unknown as Correction;
    const document: CorrectionDocument = { version: 1, platform: 'linux', corrections: [reordered] };
    const next = confirmCaseCollision(document, item('Old/mb.brd'), 'Old/mb.brd');
    expect(next.corrections).toEqual([{ op: 'link', file: { rootId: 'r', path: 'Old/mb.brd' }, anchorId: 'g1' }]);
  });

  it('stores a valid candidate at the same place', () => {
    const next = confirmCaseCollision(stored(''), item('Old/mb.brd'), 'Old/mb.brd');
    expect(next.corrections).toEqual([{ op: 'link', file: { rootId: 'r', path: 'Old/mb.brd' }, anchorId: 'g1' }]);
  });
});

describe('Windows-invalid names are refused on every platform', () => {
  const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
  const linkOn = (platform: string, path: string) => JSON.stringify({ version: 1, platform, corrections: [{ op: 'link', file: { rootId: 'r', path }, anchorId: 'g1' }] });

  describe.each(PLATFORMS)('on %s', platform => {
    it.each(['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'NUL.txt', 'con.tar.gz', 'dir/NUL.txt', 'dir/COM3.bin', 'COM¹.bin', 'LPT²'])('refuses the device name %s', path => {
      const parsed = parseCorrections(linkOn(platform, path));
      expect(parsed.document.corrections).toEqual([]);
      expect(parsed.rejections).toEqual([{ index: 0, reason: 'invalid-relative-path' }]);
    });

    it.each(['trailing-dot.', 'trailing-space ', 'dir/name. ', 'dir/name.', 'a<b.brd', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a:b', 'a\b.brd', 'tab\tname.brd'])('refuses the name %j', path => {
      const parsed = parseCorrections(linkOn(platform, path));
      expect(parsed.document.corrections).toEqual([]);
      expect(parsed.rejections).toEqual([{ index: 0, reason: 'invalid-relative-path' }]);
    });

    it.each(['COM0.bin', 'LPT0', 'CONSOLE.brd', 'NULL.brd', 'dir/CON2.bin', 'a.NUL', 'a. b.brd', '...foo.brd'])('accepts the name %j', path => {
      const parsed = parseCorrections(linkOn(platform, path));
      expect(parsed.rejections).toEqual([]);
      expect(parsed.document.corrections).toEqual([{ op: 'link', file: { rootId: 'r', path }, anchorId: 'g1' }]);
    });
  });

  it('gives the same verdict for the same names on every platform', () => {
    const samples = ['NUL.txt', 'CON', 'a:b', 'x.', 'ok.brd', '../a', 'COM1.bin', 'dir/LPT9', 'CONSOLE.brd', 'Ähre/ΜΒ 1.brd', 'a\b'];
    const verdicts = PLATFORMS.map(platform => samples.map(path => parseCorrections(linkOn(platform, path)).rejections));
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
  });
});
