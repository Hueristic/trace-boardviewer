import { afterEach, describe, expect, it } from 'vitest';
import { LibraryDb } from './index';
import { buildFixture, type Fixture } from './fixture';
import { groupOf } from './synthetic';

const live: LibraryDb[] = [];
afterEach(() => { for (const db of live.splice(0)) if (db.isOpen) db.close(); });
const fixture = (): Fixture => { const fx = buildFixture(); live.push(fx.db); return fx; };

describe('group detail', () => {
  it('returns the group, its files with roles, revisions, duplicate sets and summaries', () => {
    const { db, f } = fixture();
    const detail = db.getGroup('g1')!;
    expect(detail.group).toMatchObject({ id: 'g1', label: 'Aurelia LX100', boardNumber: 'LX-Z123', vendor: 'Aurelia', model: 'LX100', deviceType: 'laptop', tags: ['bench'] });
    expect(detail.group.members.map(m => [m.contentId, m.role, m.tier])).toEqual([
      [f.rev1.contentId, 'board', 'automatic'], [f.rev2.contentId, 'board', 'automatic'], [f.schematic.contentId, 'schematic', 'automatic'], [f.datasheet.contentId, 'datasheet', 'automatic'], [f.photo.contentId, 'photo', 'automatic'],
    ]);
    expect(detail.group.members[0].evidence[0]).toMatchObject({ kind: 'fingerprint', strength: 'strong' });
    expect(detail.files.map(x => x.relativePath).sort()).toEqual([
      'copies/lx100_rev1_copy.brd', 'datasheets/tps51225.pdf', 'laptops/aurelia/lx100_rev1.brd', 'laptops/aurelia/lx100_rev2.brd', 'laptops/aurelia/lx100_schematic.pdf', 'photos/lx100_top.jpg',
    ]);
    expect(detail.files.find(x => x.id === f.datasheet.fileId)).toMatchObject({ role: 'datasheet', kind: 'pdf', rootId: 'rootB' });
    expect(detail.revisions.map(r => [r.label, r.order, r.basis])).toEqual([['REV 1', 1, 'token'], ['REV 2', 2, 'token']]);
    expect(detail.revisions[1]).toMatchObject({ addedParts: 1, removedParts: 0, changedValues: 0 });
    expect(detail.duplicates).toHaveLength(1);
    expect(detail.boards).toHaveLength(2);
    expect(detail.documents).toHaveLength(2);
    expect(db.getGroup('missing')).toBeUndefined();
  });

  it('never exposes a path outside a root-relative location', () => {
    const { db } = fixture();
    expect(JSON.stringify(db.getGroup('g1'))).not.toContain('/synthetic');
    expect(JSON.stringify(db.getGroup('g2'))).not.toContain(':\\');
  });

  it('returns a single file by its public id and nothing for an unknown id', () => {
    const { db, f } = fixture();
    expect(db.getFile(f.spare.fileId)).toMatchObject({ entryPath: 'inside/spare.brd', containerId: f.zip.fileId, relativePath: 'zips/pack.zip', kind: 'board', state: 'indexed' });
    expect(db.getFile(f.rev1.fileId)).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), quickKey: expect.stringMatching(/^[0-9a-f]{32}$/), seenScan: expect.any(String) });
    expect(db.getFile('nope')).toBeUndefined();
    expect(db.getFile(f.encrypted.fileId)).toMatchObject({ state: 'encrypted' });
  });

  it('replaces members and revisions when a group is stored again, and ignores unknown contents', () => {
    const { db, f } = fixture();
    const stored = db.putGroup(groupOf('g1', 'Renamed', [{ contentId: f.rev1.contentId, role: 'board' }, { contentId: 'no-such-content', role: 'board' }], { updated: 9 }));
    expect(stored).toBe(1);
    const detail = db.getGroup('g1')!;
    expect(detail.group.members).toHaveLength(1);
    expect(detail.group.label).toBe('Renamed');
    expect(db.putRevisions('g1', [{ contentId: f.rev1.contentId, label: 'A', scheme: 'letter', order: 0, basis: 'user' }, { contentId: 'nope', label: 'B', scheme: 'letter', basis: 'unknown' }])).toBe(1);
    expect(db.removeGroup('g1')).toBe(true);
    expect(db.removeGroup('g1')).toBe(false);
    expect(db.getGroup('g1')).toBeUndefined();
    expect(Number((db.connection.prepare('SELECT count(*) AS n FROM revision').get() as { n: number }).n)).toBe(0);
  });

  it('drops duplicate sets that lose all their files', () => {
    const { db, f } = fixture();
    expect(db.removeDuplicateSets(['d1'])).toBe(1);
    expect(db.getGroup('g1')!.duplicates).toEqual([]);
    db.putDuplicateSet({ id: 'd2', kind: 'name-clash', fileIds: [f.tb200.fileId, 'nope'], contentIds: [f.tb200.contentId, 'nope'], evidence: [] });
    expect(db.getGroup('g2')!.duplicates.map(d => [d.id, d.kind, d.fileIds.length, d.contentIds.length])).toEqual([['d2', 'name-clash', 1, 1]]);
    db.removeRoot('rootA');
    expect(db.getGroup('g2')!.duplicates).toEqual([]);
    expect(Number((db.connection.prepare('SELECT count(*) AS n FROM duplicate_set').get() as { n: number }).n)).toBe(0);
  });
});

describe('similar groups', () => {
  it('follows stored layout suggestions in both directions', () => {
    const { db } = fixture();
    expect(db.similar('g1', 'layout')).toEqual([{ groupId: 'g2', score: 0.4, basis: 'layout' }]);
    expect(db.similar('g2', 'layout')).toEqual([{ groupId: 'g1', score: 0.4, basis: 'layout' }]);
    expect(db.similar('nope', 'layout')).toEqual([]);
  });

  it('weighs shared known parts by how rare they are', () => {
    const { db } = fixture();
    // g1 holds four known parts (weights 1, 1, 1 and 1/2 for the one it shares with g2): the shared half is 0.5 of 3.5.
    const similar = db.similar('g1', 'parts');
    expect(similar.map(s => [s.groupId, s.basis])).toEqual([['g2', 'parts']]);
    expect(similar[0].score).toBeCloseTo(0.5 / 3.5, 6);
    // g2's only known part is its own, so nothing is similar from its side.
    expect(db.similar('g2', 'parts')).toEqual([]);
    expect(db.similar('nope', 'parts')).toEqual([]);
  });

  it('removes suggestions with the contents they join', () => {
    const { db, f } = fixture();
    expect(db.removeSuggestionsFor(f.tb200.contentId)).toBe(1);
    expect(db.similar('g1', 'layout')).toEqual([]);
    expect(db.putSuggestions([{ a: f.rev1.contentId, b: f.rev1.contentId, kind: 'proximity', score: 1, evidence: [] }, { a: 'nope', b: f.rev1.contentId, kind: 'proximity', score: 1, evidence: [] }])).toBe(0);
  });
});
