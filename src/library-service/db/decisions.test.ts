import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionTarget, LibraryDecision, StoredDecision } from '../../lib/library/model';
import { LibraryDb, parseDecisionFile, retargetDecisions } from './index';
import { buildFixture, SHA_REV1, type Fixture } from './fixture';
import { sha256Of } from './synthetic';

const live: LibraryDb[] = [];
afterEach(() => { for (const db of live.splice(0)) if (db.isOpen) db.close(); });
const fixture = (): Fixture => { const fx = buildFixture(); live.push(fx.db); return fx; };

const stored = (id: string, decision: LibraryDecision, targets: DecisionTarget[] = []): StoredDecision => ({ id, at: 1, decision, targets });
const query = (db: LibraryDb, text = '', mode: 'boards' | 'files' = 'boards') => db.query({ text, mode, filters: {}, sort: 'label', direction: 'asc', limit: 50 });

describe('decision targets', () => {
  it('resolves group and content ids to durable targets: hash first, location otherwise', () => {
    const { db, f } = fixture();
    const label = db.resolveDecisionTargets({ kind: 'label', groupId: 'g1', label: 'Mine' })!;
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(8);
    expect(label[0]).toEqual({ kind: 'content', sha256: SHA_REV1 });
    // Contents without a confirmed hash fall back to a root, a relative location and the archive entry.
    expect(db.resolveDecisionTargets({ kind: 'split', groupId: 'g2', contents: [f.tb200.contentId] })).toEqual([{ kind: 'file', rootId: 'rootA', relativePath: 'tablets/tb200.brd' }]);
    expect(db.resolveDecisionTargets({ kind: 'split', groupId: 'g2', contents: [f.spare.contentId] })).toEqual([{ kind: 'file', rootId: 'rootA', relativePath: 'zips/pack.zip', entryPath: 'inside/spare.brd' }]);
    expect(db.resolveDecisionTargets({ kind: 'merge', groups: ['g1', 'g2'] })).toHaveLength(2);
    expect(db.resolveDecisionTargets({ kind: 'merge', groups: ['g1', 'nope'] })).toBeUndefined();
    expect(db.resolveDecisionTargets({ kind: 'label', groupId: 'nope', label: 'x' })).toBeUndefined();
    const same: LibraryDecision = { kind: 'same', a: { kind: 'content', sha256: SHA_REV1 }, b: { kind: 'content', sha256: sha256Of(1) } };
    expect(db.resolveDecisionTargets(same)).toEqual([same.a, same.b]);
  });

  it('never exposes a database row id in a target', () => {
    const { db } = fixture();
    const json = JSON.stringify(db.resolveDecisionTargets({ kind: 'merge', groups: ['g1', 'g2'] }));
    expect(json).not.toMatch(/"(?:id|rowid|contentId)"/);
  });
});

describe('replaying decisions', () => {
  it('relabels and tags a group found by its member targets, and ignores a group the targets cannot find', () => {
    const { db } = fixture();
    const targets = db.resolveDecisionTargets({ kind: 'label', groupId: 'g1', label: 'x' })!;
    const report = db.applyDecisions([
      stored('d1', { kind: 'label', groupId: 'g1', label: 'My Aurelia' }, targets),
      stored('d2', { kind: 'tag', groupId: 'g1', tag: 'priority', enabled: true }, targets),
      stored('d3', { kind: 'tag', groupId: 'g1', tag: 'bench', enabled: false }, targets),
      stored('d4', { kind: 'label', groupId: 'gone', label: 'Lost' }, [{ kind: 'content', sha256: sha256Of(9999) }]),
    ]);
    expect(report).toMatchObject({ applied: 3, unresolved: 1 });
    expect(db.getGroup('g1')!.group).toMatchObject({ label: 'My Aurelia', tags: ['priority'] });
    expect(query(db).rows.map(r => r.label)).toEqual(['Bexley TB200', 'My Aurelia']);
  });

  it('returns pair, merge and split decisions as constraints for the grouping stage', () => {
    const { db, f } = fixture();
    const a: DecisionTarget = { kind: 'content', sha256: SHA_REV1 }, b: DecisionTarget = { kind: 'file', rootId: 'rootA', relativePath: 'tablets/tb200.brd' };
    const report = db.applyDecisions([
      stored('p1', { kind: 'same', a, b }, [a, b]),
      stored('p2', { kind: 'different', a, b }, [a, b]),
      stored('m1', { kind: 'merge', groups: ['g1', 'g2'] }, [a, b]),
      stored('s1', { kind: 'split', groupId: 'g1', contents: [f.photo.contentId] }, [{ kind: 'file', rootId: 'rootB', relativePath: 'photos/lx100_top.jpg' }]),
      stored('p3', { kind: 'same', a, b: { kind: 'content', sha256: sha256Of(424242) } }, [a, { kind: 'content', sha256: sha256Of(424242) }]),
    ]);
    expect(report.applied).toBe(4);
    expect(report.unresolved).toBe(1);
    expect(report.grouping).toEqual([
      { kind: 'same', a: f.rev1.contentId, b: f.tb200.contentId },
      { kind: 'different', a: f.rev1.contentId, b: f.tb200.contentId },
      { kind: 'merge', contents: [f.rev1.contentId, f.tb200.contentId] },
      { kind: 'split', contents: [f.photo.contentId] },
    ]);
  });

  it('applies the decisions in order and each replay starts from nothing', () => {
    const { db } = fixture();
    const photo: DecisionTarget = { kind: 'file', rootId: 'rootB', relativePath: 'photos/lx100_top.jpg' };
    db.applyDecisions([stored('h1', { kind: 'hide', target: photo, hidden: true }, [photo]), stored('h2', { kind: 'hide', target: photo, hidden: false }, [photo])]);
    expect(query(db, 'lx100_top', 'files').rows).toHaveLength(1);
    db.applyDecisions([stored('h3', { kind: 'hide', target: photo, hidden: true }, [photo])]);
    expect(query(db, 'lx100_top', 'files').rows).toHaveLength(0);
    db.applyDecisions([]);
    expect(query(db, 'lx100_top', 'files').rows).toHaveLength(1);
  });

  it('keeps a decision whose target does not exist yet, and applies it once the file appears', () => {
    const { db } = fixture();
    const later: DecisionTarget = { kind: 'file', rootId: 'rootA', relativePath: 'later/arrives.brd' };
    const decision = stored('h1', { kind: 'hide', target: later, hidden: true }, [later]);
    expect(db.applyDecisions([decision])).toMatchObject({ applied: 0, unresolved: 1 });
    db.upsertFiles('rootA', db.beginScan(), [{ dir: 'later', name: 'arrives.brd', size: 10 }]);
    expect(db.applyDecisions([decision])).toMatchObject({ applied: 1, unresolved: 0 });
    expect(query(db, 'arrives', 'files').rows).toHaveLength(0);
  });

  it('does not let a hidden flag follow a reused row id after the file was removed', () => {
    const { db } = fixture();
    const target: DecisionTarget = { kind: 'file', rootId: 'rootA', relativePath: 'misc/loose_notes.pdf' };
    db.applyDecisions([stored('h1', { kind: 'hide', target, hidden: true }, [target])]);
    db.upsertFiles('rootA', db.beginScan(), [{ dir: 'misc', name: 'other.pdf', size: 1 }]);
    const s = db.beginScan();
    db.markMissing('rootA', s, 1);
    db.removeMissingNow('rootA');
    const fresh = db.upsertFiles('rootA', db.beginScan(), [{ dir: 'misc2', name: 'fresh.pdf', size: 1 }]);
    expect(fresh[0].status).toBe('new');
    expect(Number((db.connection.prepare('SELECT count(*) AS n FROM temp.hidden_file').get() as { n: number }).n)).toBe(0);
  });

  it('follows a moved file when the location targets are rewritten after the move is confirmed', () => {
    const from = { rootId: 'rootA', relativePath: 'misc/loose_notes.pdf' }, to = { rootId: 'rootA', relativePath: 'archive/loose_notes.pdf' };
    const target: DecisionTarget = { kind: 'file', ...from };
    const other: DecisionTarget = { kind: 'content', sha256: SHA_REV1 };
    const list = [stored('h1', { kind: 'hide', target, hidden: true }, [target]), stored('p1', { kind: 'same', a: target, b: other }, [target, other]), stored('l1', { kind: 'label', groupId: 'g1', label: 'x' }, [other])];
    const next = retargetDecisions(list, from, to);
    expect(JSON.stringify(next)).not.toContain('misc/loose_notes.pdf');
    expect(next[0].targets).toEqual([{ kind: 'file', rootId: 'rootA', relativePath: 'archive/loose_notes.pdf' }]);
    expect(next[2]).toEqual(list[2]);
    expect(list[0].targets).toEqual([target]);
  });
});

describe('the decisions file', () => {
  const good = stored('a1', { kind: 'label', groupId: 'g1', label: 'Kept' }, [{ kind: 'content', sha256: sha256Of(1) }]);

  it('keeps valid entries and counts the dropped ones', () => {
    const raw = JSON.stringify({ version: 1, decisions: [good, { id: 'bad id!', at: 1, decision: { kind: 'label', groupId: 'g', label: 'x' }, targets: [] }, { id: 'a2', at: 1, decision: { kind: 'explode' }, targets: [] }, 7, null, { ...good, extra: true }] });
    const parsed = parseDecisionFile(raw);
    expect(parsed.decisions).toEqual([good]);
    expect(parsed.dropped).toBe(5);
  });

  it('is total on garbage', () => {
    for (const raw of ['', 'not json', '[]', '{}', '{"version":2,"decisions":[]}', '{"version":1}', '{"version":1,"decisions":"x"}', 'null', '"text"']) {
      expect(() => parseDecisionFile(raw), raw).not.toThrow();
      expect(parseDecisionFile(raw).decisions).toEqual([]);
    }
  });
});
