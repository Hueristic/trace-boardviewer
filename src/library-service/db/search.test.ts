import { afterEach, describe, expect, it } from 'vitest';
import type { QueryFilters, QueryRequest } from '../../lib/library/query';
import { QUERY_MODES, QUERY_SORTS } from '../../lib/library/query';
import type { QueryPage } from '../../lib/library/protocol';
import { InvalidCursorError, LibraryDb } from './index';
import { buildFixture, SHA_REV1, type Fixture } from './fixture';

const live: LibraryDb[] = [];
afterEach(() => { for (const db of live.splice(0)) if (db.isOpen) db.close(); });
const fixture = (): Fixture => { const fx = buildFixture(); live.push(fx.db); return fx; };

const request = (text: string, extra: Partial<QueryRequest> = {}): QueryRequest => ({ text, mode: 'boards', filters: {}, sort: 'label', direction: 'asc', limit: 50, ...extra });
const ids = (page: QueryPage): string[] => page.rows.map(r => r.id);
const labels = (page: QueryPage): string[] => page.rows.map(r => r.label);

function pageAll(db: LibraryDb, req: QueryRequest): { rows: QueryPage['rows']; pages: number; total: number } {
  const rows: QueryPage['rows'] = [];
  let cursor: string | undefined, pages = 0, total = -1;
  do {
    const page = db.query({ ...req, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    total = page.total;
    cursor = page.cursor;
    pages++;
  } while (cursor && pages < 100);
  return { rows, pages, total };
}

describe('boards mode', () => {
  it('normalizes and folds Unicode in short literal filename searches', () => {
    const { db } = fixture();
    db.upsertFiles('rootA', db.beginScan(), [{ dir: 'unicode', name: 'É.brd', size: 1 }, { dir: 'unicode', name: 'Ｅ.brd', size: 1 }]);
    expect(labels(db.query(request('file:é', { mode: 'files' })))).toEqual(['É.brd']);
    expect(labels(db.query(request('file:e', { mode: 'files' })))).toContain('Ｅ.brd');
  });
  it('sorts and pages complete labels with a shared long prefix', () => {
    const { db } = fixture();
    const prefix = '長'.repeat(150);
    db.upsertFiles('rootA', db.beginScan(), ['z', 'a', 'm'].map(suffix => ({ dir: 'long', name: `${prefix}${suffix}.pdf`, size: 1 })));
    const result = pageAll(db, request(`file:${prefix.slice(0, 5)}`, { mode: 'files', limit: 1 }));
    expect(result.rows.map(r => r.label)).toEqual(['a', 'm', 'z'].map(suffix => `${prefix}${suffix}.pdf`));
    const first = db.query(request(`file:${prefix.slice(0, 5)}`, { mode: 'files', limit: 1 }));
    expect(first.cursor!.length).toBeLessThanOrEqual(512);
  });
  it('lists every group with its file count, sorted by label', () => {
    const { db } = fixture();
    const page = db.query(request(''));
    expect(page.total).toBe(2);
    expect(labels(page)).toEqual(['Aurelia LX100', 'Bexley TB200']);
    expect(page.rows.map(r => [r.id, r.kind, r.fileCount])).toEqual([['g1', 'group', 6], ['g2', 'group', 2]]);
    expect(page.cursor).toBeUndefined();
    expect(db.query(request('', { direction: 'desc' })).rows.map(r => r.id)).toEqual(['g2', 'g1']);
  });

  it('finds an exact part number and says how: tier, source, references and pages', () => {
    const { db, f } = fixture();
    const page = db.query(request('part:TPS51225RUKR'));
    expect(ids(page)).toEqual(['g1']);
    const matches = page.rows[0].matches;
    expect(matches.every(m => m.tier === 'exact' && m.term.value === 'TPS51225RUKR')).toBe(true);
    const bySchematic = matches.find(m => m.contentId === f.schematic.contentId)!;
    expect(bySchematic).toMatchObject({ source: 'schematic', refs: ['U7000'], pages: [3, 4] });
    expect(matches.map(m => m.contentId).sort()).toEqual([f.rev1.contentId, f.rev2.contentId, f.schematic.contentId].sort());
    expect(ids(db.query(request('exact:tps51225rukr')))).toEqual(['g1']);
    expect(ids(db.query(request('part:TPS51225')))).toEqual(['g1']);
    expect(ids(db.query(request('part:NOSUCH123')))).toEqual([]);
  });

  it('matches base, prefix and family parts at their own tier', () => {
    const { db } = fixture();
    const base = db.query(request('base:TPS51225'));
    expect(ids(base)).toEqual(['g1']);
    expect(new Set(base.rows[0].matches.map(m => m.tier))).toEqual(new Set(['base']));
    expect(ids(db.query(request('prefix:TPS5')))).toEqual([]);
    expect(db.query(request('prefix:TPS5')).issues).toEqual(['short-prefix']);
    expect(ids(db.query(request('prefix:TPS51')))).toEqual(['g1']);
    expect(ids(db.query(request('prefix:tps512')))).toEqual(['g1']);
    expect(ids(db.query(request('part:TPS65*')))).toEqual(['g2']);
    expect(db.query(request('part:TPS65*')).rows[0].matches[0].tier).toBe('prefix');
    expect(ids(db.query(request('family:buck-ctl')))).toEqual(['g1']);
    expect(ids(db.query(request('family:usb-pd')))).toEqual(['g2']);
    expect(ids(db.query(request('family:BUCK-CTL')))).toEqual(['g1']);
    expect(ids(db.query(request('family:nothing')))).toEqual([]);
  });

  it('matches board numbers and rails', () => {
    const { db } = fixture();
    expect(ids(db.query(request('board:LX-Z123')))).toEqual(['g1']);
    expect(ids(db.query(request('board:lx-z123')))).toEqual(['g1']);
    expect(ids(db.query(request('board:TB-200')))).toEqual(['g2']);
    expect(ids(db.query(request('rail:+3V3_S5')))).toEqual(['g1']);
    expect(ids(db.query(request('rail:+5v_s0')))).toEqual(['g1', 'g2']);
    expect(ids(db.query(request('rail:+12V')))).toEqual([]);
  });

  it('matches file names by substring, including one and two character values', () => {
    const { db } = fixture();
    expect(ids(db.query(request('file:lx100')))).toEqual(['g1']);
    expect(ids(db.query(request('file:LX100_REV')))).toEqual(['g1']);
    expect(ids(db.query(request('file:"service.pdf"')))).toEqual(['g2']);
    expect(ids(db.query(request('file:lx')))).toEqual(['g1']);
    expect(ids(db.query(request('file:tb')))).toEqual(['g2']);
    expect(ids(db.query(request('file:q')))).toEqual([]);
    expect(ids(db.query(request('file:nosuchfile')))).toEqual([]);
  });

  it('answers a bare term from the part, name, board number, rail and label indexes', () => {
    const { db } = fixture();
    expect(ids(db.query(request('TPS51225RUKR')))).toEqual(['g1']);
    expect(ids(db.query(request('lx100')))).toEqual(['g1']);
    expect(ids(db.query(request('LX-Z123')))).toEqual(['g1']);
    expect(ids(db.query(request('+3V3_S5')))).toEqual(['g1']);
    expect(ids(db.query(request('aurelia')))).toEqual(['g1']);
    expect(ids(db.query(request('bexley')))).toEqual(['g2']);
    expect(ids(db.query(request('TPS51225')))).toEqual(['g1']);
    expect(ids(db.query(request('synchronous')))).toEqual(['g1']);
    expect(ids(db.query(request('lx')))).toEqual(['g1']);
  });

  it('combines terms with AND across the files of one group', () => {
    const { db } = fixture();
    expect(ids(db.query(request('part:TPS51225RUKR rail:+5V_S0')))).toEqual(['g1']);
    expect(ids(db.query(request('part:TPS51225RUKR family:usb-pd')))).toEqual([]);
    expect(ids(db.query(request('part:BQ24715RGRR rail:+5V_S0')))).toEqual(['g1', 'g2']);
    expect(ids(db.query(request('part:TPS65982 board:LX-Z123')))).toEqual([]);
    expect(ids(db.query(request('lx100 part:TPS65982')))).toEqual([]);
  });

  it('answers ref: only inside a group', () => {
    const { db } = fixture();
    const alone = db.query(request('ref:U7000'));
    expect(alone.rows).toEqual([]);
    expect(alone.issues).toEqual(['ref-needs-group']);
    const inGroup = db.query(request('ref:u7000', { filters: { groupId: 'g1' } }));
    expect(ids(inGroup)).toEqual(['g1']);
    expect(inGroup.rows[0].matches.every(m => m.source === 'refs' && m.refs[0] === 'U7000')).toBe(true);
    expect(ids(db.query(request('ref:U100', { filters: { groupId: 'g1' } })))).toEqual([]);
    expect(ids(db.query(request('ref:U100', { filters: { groupId: 'g2' } })))).toEqual(['g2']);
  });

  it('returns nothing for an empty parse, an oversized query and non-string text', () => {
    const { db } = fixture();
    expect(db.query(request('part:')).rows).toEqual([]);
    expect(db.query(request('part:')).issues).toEqual(['missing-value']);
    expect(db.query(request('x'.repeat(201))).issues).toEqual(['too-long']);
    expect(db.query(request('x'.repeat(201))).total).toBe(0);
    expect(db.query({ ...request(''), text: 42 as unknown as string }).total).toBe(2);
  });

  it('is not injectable: search text never reaches SQL or FTS syntax', () => {
    const { db } = fixture();
    const nasty = ['"', '""', '" OR "', 'lx100" OR name:*', 'NEAR(lx100 aurelia)', '*', 'a*b', "'; DROP TABLE file; --", 'file:"\\"', 'name_fts MATCH', '-lx100', 'lx100 -aurelia', '(lx100)', '{name}: lx100', 'file:^lx', 'file:%', 'file:_x_', 'part:%', 'base:\u0000', 'ü', 'file:\ud800'];
    for (const text of nasty) {
      for (const mode of QUERY_MODES) expect(() => db.query(request(text, { mode })), text).not.toThrow();
    }
    expect(db.counts()).toMatchObject({ files: 15, entries: 1 });
    expect(ids(db.query(request('file:%')))).toEqual([]);
    expect(ids(db.query(request('file:_x_')))).toEqual([]);
  });
});

describe('files mode', () => {
  it('lists files with root-relative locations and never an absolute path', () => {
    const { db } = fixture();
    const page = db.query(request('', { mode: 'files', limit: 200 }));
    expect(page.total).toBe(16);
    const paths = page.rows.map(r => r.relativePath);
    expect(paths).toContain('laptops/aurelia/lx100_rev1.brd');
    expect(paths).toContain('zips/pack.zip');
    expect(paths.every(p => p !== undefined && !p.startsWith('/') && !p.includes(':'))).toBe(true);
    expect(JSON.stringify(page)).not.toContain('/synthetic');
    expect(page.rows.every(r => r.kind === 'file' && r.fileCount === 1 && typeof r.rootLabel === 'string')).toBe(true);
    const member = page.rows.find(r => r.label === 'spare.brd')!;
    expect(member.relativePath).toBe('zips/pack.zip');
  });

  it('finds the files of a matching content, including duplicates', () => {
    const { db, f } = fixture();
    const page = db.query(request('part:TPS51225RUKR', { mode: 'files' }));
    expect(page.rows.map(r => r.label)).toEqual(['lx100_rev1.brd', 'lx100_rev1_copy.brd', 'lx100_rev2.brd', 'lx100_schematic.pdf']);
    expect(page.rows.map(r => r.id)).toEqual([f.rev1.fileId, f.copy.fileId, f.rev2.fileId, f.schematic.fileId]);
  });

  it('finds files by name only in files that carry the text', () => {
    const { db } = fixture();
    expect(db.query(request('copy', { mode: 'files' })).rows.map(r => r.label)).toEqual(['lx100_rev1_copy.brd']);
    // A member's name index row carries its archive's location, so a search for the archive finds its members too.
    expect(db.query(request('pack.zip', { mode: 'files' })).rows.map(r => r.label)).toEqual(['pack.zip', 'spare.brd']);
    expect(db.query(request('file:inside', { mode: 'files' })).rows.map(r => r.label)).toEqual([]);
  });

  it('lists the problem files in problems mode, with their states', () => {
    const { db, f } = fixture();
    const page = db.query(request('', { mode: 'problems' }));
    expect(page.rows.map(r => r.label)).toEqual(['damaged.brd', 'locked.zip', 'secret.fz', 'shortcut.brd', 'unknown.bin']);
    expect(db.getFile(f.damaged.fileId)!.state).toBe('damaged');
    expect(db.getFile(f.locked.fileId)!.state).toBe('locked');
    expect(db.getFile(f.encrypted.fileId)!.state).toBe('encrypted');
    expect(db.getFile(f.linked.fileId)!.state).toBe('link');
    expect(db.getFile(f.unknown.fileId)!.state).toBe('unknown');
    expect(db.query(request('', { mode: 'problems', filters: { states: ['damaged', 'link'] } })).rows.map(r => r.label)).toEqual(['damaged.brd', 'shortcut.brd']);
  });

  it('lists indexed or identified files outside any group in unsorted mode', () => {
    const { db } = fixture();
    expect(db.query(request('', { mode: 'unsorted' })).rows.map(r => r.label)).toEqual(['loose_notes.pdf', 'pack.zip', 'spare.brd']);
    expect(db.query(request('max98357', { mode: 'unsorted' })).rows.map(r => r.label)).toEqual(['loose_notes.pdf']);
  });

  it('lists duplicate sets with the files they join', () => {
    const { db } = fixture();
    const page = db.query(request('', { mode: 'duplicates' }));
    expect(page.rows.map(r => [r.id, r.kind, r.fileCount])).toEqual([['d1', 'duplicate', 2]]);
    expect(db.query(request('copy', { mode: 'duplicates' })).rows.map(r => r.id)).toEqual(['d1']);
    expect(db.query(request('part:TPS51225RUKR', { mode: 'duplicates' })).rows.map(r => r.id)).toEqual(['d1']);
    expect(db.query(request('part:TPS65982', { mode: 'duplicates' })).rows).toEqual([]);
    expect(db.getGroup('g1')!.duplicates.map(d => [d.id, d.kind, d.fileIds.length, d.contentIds.length])).toEqual([['d1', 'identical', 2, 1]]);
  });
});

describe('filters and facets', () => {
  it('filters groups by root, kind, role, format, vendor, device and what they contain', () => {
    const { db } = fixture();
    const q = (filters: QueryFilters): string[] => ids(db.query(request('', { filters })));
    expect(q({ roots: ['rootA'] })).toEqual(['g1', 'g2']);
    expect(q({ kinds: ['image'] })).toEqual(['g1']);
    expect(q({ roles: ['service-manual'] })).toEqual(['g2']);
    expect(q({ roles: ['photo'] })).toEqual(['g1']);
    expect(q({ vendors: ['Bexley'] })).toEqual(['g2']);
    expect(q({ vendors: ['Bexley', 'Aurelia'] })).toEqual(['g1', 'g2']);
    expect(q({ deviceTypes: ['laptop'] })).toEqual(['g1']);
    expect(q({ has: ['schematic'] })).toEqual(['g1']);
    expect(q({ has: ['documents'] })).toEqual(['g1', 'g2']);
    expect(q({ has: ['schematic', 'documents'] })).toEqual(['g1']);
    expect(q({ states: ['indexed'] })).toEqual(['g1', 'g2']);
    expect(q({ states: ['damaged'] })).toEqual([]);
    expect(q({ formats: ['jpeg', 'png'] })).toEqual(['g1']);
    expect(q({ roots: ['nowhere'] })).toEqual([]);
    expect(q({ kinds: ['not-a-kind' as never] })).toEqual(['g1', 'g2']);
  });

  it('applies filters to the files of a search match', () => {
    const { db } = fixture();
    expect(ids(db.query(request('part:TPS51225RUKR', { filters: { roots: ['rootB'] } })))).toEqual(['g1']);
    expect(ids(db.query(request('part:TPS51225RUKR', { filters: { vendors: ['Bexley'] } })))).toEqual([]);
    expect(db.query(request('', { mode: 'files', filters: { kinds: ['pdf'] } })).rows.map(r => r.label)).toEqual(['loose_notes.pdf', 'tb200_service.pdf', 'tps51225.pdf']);
    expect(db.query(request('', { mode: 'files', filters: { roles: ['datasheet'] } })).rows.map(r => r.label)).toEqual(['tps51225.pdf']);
    expect(db.query(request('', { mode: 'files', filters: { vendors: ['Bexley'] } })).rows.map(r => r.label)).toEqual(['tb200.brd', 'tb200_service.pdf']);
    expect(db.query(request('', { mode: 'files', filters: { groupId: 'g2' } })).rows.map(r => r.label)).toEqual(['tb200.brd', 'tb200_service.pdf']);
    expect(db.query(request('', { mode: 'files', filters: { roots: ['rootB'], kinds: ['pdf', 'image'] } })).rows.map(r => r.label)).toEqual(['lx100_top.jpg', 'tb200_service.pdf', 'tps51225.pdf']);
  });

  it('counts facets over the rows, leaving out the dimension being counted', () => {
    const { db } = fixture();
    const page = db.query(request(''));
    const f = page.facets;
    const toMap = (list: { value: string; count: number }[]): Record<string, number> => Object.fromEntries(list.map(x => [x.value, x.count]));
    expect(toMap(f.roots)).toEqual({ rootA: 2, rootB: 2 });
    expect(toMap(f.kinds)).toEqual({ board: 2, schematic: 1, pdf: 2, image: 1 });
    expect(toMap(f.roles)).toEqual({ board: 2, schematic: 1, datasheet: 1, 'service-manual': 1, photo: 1 });
    expect(toMap(f.formats).pdf).toBe(2);
    expect(Object.values(toMap(f.formats)).length).toBeGreaterThanOrEqual(3);
    const narrowed = db.query(request('', { filters: { kinds: ['image'] } })).facets;
    expect(toMap(narrowed.roles)).toEqual({ photo: 1 });
    expect(toMap(narrowed.kinds)).toEqual({ board: 2, schematic: 1, pdf: 2, image: 1 });
    expect(page.facets.kinds.map(x => x.count)).toEqual([...page.facets.kinds.map(x => x.count)].sort((a, b) => b - a));
    const files = db.query(request('', { mode: 'files', limit: 200 })).facets;
    expect(toMap(files.kinds).board).toBe(8);
  });
});

describe('sorting and paging', () => {
  it('sorts groups by every closed sort key', () => {
    const { db } = fixture();
    const order = (sort: QueryRequest['sort'], direction: 'asc' | 'desc' = 'asc'): string[] => ids(db.query(request('', { sort, direction })));
    expect(order('label')).toEqual(['g1', 'g2']);
    expect(order('board-number')).toEqual(['g1', 'g2']);
    expect(order('vendor')).toEqual(['g1', 'g2']);
    expect(order('recent', 'desc')).toEqual(['g1', 'g2']);
    expect(order('recent', 'asc')).toEqual(['g2', 'g1']);
    expect(order('documents', 'desc')).toEqual(['g1', 'g2']);
    expect(order('completeness', 'desc')).toEqual(['g1', 'g2']);
    for (const s of QUERY_SORTS) expect(order(s)).toHaveLength(2);
  });

  it('ranks the stronger match first when sorted by relevance', () => {
    const { db } = fixture();
    expect(ids(db.query(request('BQ24715RGRR', { sort: 'relevance', direction: 'desc' })))).toEqual(['g1', 'g2']);
    expect(ids(db.query(request('BQ24715RGRR', { sort: 'relevance', direction: 'asc' })))).toEqual(['g2', 'g1']);
  });

  it('pages through every mode, sort and direction without losing or repeating a row', () => {
    const { db } = fixture();
    for (const mode of QUERY_MODES) {
      for (const sort of QUERY_SORTS) {
        for (const direction of ['asc', 'desc'] as const) {
          const everything = pageAll(db, request('', { mode, sort, direction, limit: 200 }));
          const paged = pageAll(db, request('', { mode, sort, direction, limit: 2 }));
          expect(paged.rows.map(r => r.id), `${mode}/${sort}/${direction}`).toEqual(everything.rows.map(r => r.id));
          expect(new Set(paged.rows.map(r => r.id)).size).toBe(paged.rows.length);
          expect(paged.total).toBe(everything.rows.length);
        }
      }
    }
    expect(pageAll(db, request('', { mode: 'files', limit: 3 })).pages).toBe(6);
  });

  it('pages a search the same way', () => {
    const { db } = fixture();
    const whole = pageAll(db, request('part:TPS51225RUKR', { mode: 'files', limit: 200 }));
    const paged = pageAll(db, request('part:TPS51225RUKR', { mode: 'files', limit: 1 }));
    expect(paged.rows.map(r => r.id)).toEqual(whole.rows.map(r => r.id));
    expect(paged.pages).toBe(4);
  });

  it('clamps the limit to 1..200', () => {
    const { db } = fixture();
    expect(db.query(request('', { mode: 'files', limit: 0 })).rows).toHaveLength(1);
    expect(db.query(request('', { mode: 'files', limit: 99999 })).rows).toHaveLength(16);
    expect(db.query(request('', { mode: 'files', limit: 1.5 })).rows.length).toBe(16);
  });

  it('refuses a cursor that was altered, issued for another request, or issued before the index changed', () => {
    const { db } = fixture();
    const first = db.query(request('', { mode: 'files', limit: 2 }));
    expect(first.cursor).toBeDefined();
    const [payload, mac] = first.cursor!.split('.');
    expect(() => db.query(request('', { mode: 'files', limit: 2, cursor: `${payload}.${mac.slice(1)}A` }))).toThrow(InvalidCursorError);
    expect(() => db.query(request('', { mode: 'files', limit: 2, cursor: first.cursor!.replace(payload, Buffer.from('[1,0,"x","a","b",1]').toString('base64url')) }))).toThrow(InvalidCursorError);
    expect(() => db.query(request('', { mode: 'files', limit: 2, direction: 'desc', cursor: first.cursor }))).toThrow(InvalidCursorError);
    expect(() => db.query(request('copy', { mode: 'files', limit: 2, cursor: first.cursor }))).toThrow(InvalidCursorError);
    expect(() => db.query(request('', { mode: 'files', limit: 2, cursor: 'garbage' }))).toThrow(InvalidCursorError);
    expect(() => db.query(request('', { mode: 'files', limit: 2, cursor: 'a.'.repeat(300) }))).toThrow(InvalidCursorError);
    expect(db.query(request('', { mode: 'files', limit: 2, cursor: first.cursor })).rows).toHaveLength(2);
    // Ordinary inserts keep a cursor valid; removing rows does not.
    db.upsertFiles('rootA', db.beginScan(), [{ dir: 'new', name: 'zzz.brd', size: 1 }]);
    expect(db.query(request('', { mode: 'files', limit: 2, cursor: first.cursor })).rows).toHaveLength(2);
    db.removeRoot('rootB');
    expect(() => db.query(request('', { mode: 'files', limit: 2, cursor: first.cursor }))).toThrow(InvalidCursorError);
  });

  it('does not honour a cursor from another database instance', () => {
    const a = fixture(), b = fixture();
    const first = a.db.query(request('', { mode: 'files', limit: 2 }));
    expect(() => b.db.query(request('', { mode: 'files', limit: 2, cursor: first.cursor }))).toThrow(InvalidCursorError);
  });
});

describe('decisions in queries', () => {
  it('hides a file by location and a content by hash, and overrides a role', () => {
    const { db, f } = fixture();
    const report = db.applyDecisions([
      { id: 'x1', at: 1, decision: { kind: 'hide', target: { kind: 'file', rootId: 'rootA', relativePath: 'misc/loose_notes.pdf' }, hidden: true }, targets: [{ kind: 'file', rootId: 'rootA', relativePath: 'misc/loose_notes.pdf' }] },
      { id: 'x2', at: 2, decision: { kind: 'hide', target: { kind: 'content', sha256: SHA_REV1 }, hidden: true }, targets: [{ kind: 'content', sha256: SHA_REV1 }] },
      { id: 'x3', at: 3, decision: { kind: 'role', target: { kind: 'file', rootId: 'rootB', relativePath: 'photos/lx100_top.jpg' }, role: 'thermal' }, targets: [{ kind: 'file', rootId: 'rootB', relativePath: 'photos/lx100_top.jpg' }] },
    ]);
    expect(report).toMatchObject({ applied: 3, unresolved: 0 });
    expect(db.query(request('', { mode: 'unsorted' })).rows.map(r => r.label)).toEqual(['pack.zip', 'spare.brd']);
    expect(db.query(request('part:TPS51225RUKR', { mode: 'files' })).rows.map(r => r.label)).toEqual(['lx100_rev2.brd', 'lx100_schematic.pdf']);
    expect(db.query(request('', { filters: { roles: ['thermal'] } })).rows.map(r => r.id)).toEqual(['g1']);
    expect(db.query(request('', { filters: { roles: ['photo'] } })).rows).toEqual([]);
    expect(db.getFile(f.photo.fileId)!.role).toBe('thermal');
    expect(db.getGroup('g1')!.files.map(x => x.id)).not.toContain(f.rev1.fileId);
    expect(db.query(request('', { mode: 'files', limit: 200 })).total).toBe(16 - 3);
    // Replaying with fewer decisions un-hides what is no longer decided.
    db.applyDecisions([]);
    expect(db.query(request('', { mode: 'unsorted' })).rows).toHaveLength(3);
  });
});
