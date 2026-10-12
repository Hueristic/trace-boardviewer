import { describe, expect, it } from 'vitest';
import { extractIdentity } from './identity';
import { matchFiles, pairKey, WEIGHT, type BoardAnchor, type FileRecord } from './match';

const linux = { platform: 'linux' as const };
const file = (path: string, extra: Partial<Pick<FileRecord, 'contentCode'>> = {}): FileRecord => ({ path, identity: extractIdentity(path, linux), ...extra });
const group: BoardAnchor = {
  id: 'g-q731',
  boardCode: 'MB-Q731',
  revision: extractIdentity('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', linux).revision,
  aliases: ['kestrel'],
};

describe('matching decisions', () => {
  it('gives "probable" for the same board code in a file name, with the weight shown', () => {
    const [association] = matchFiles([group], [file('Alder/Orion-5/MB-Q731_rev2_BIOS.bin')]);
    expect(association).toMatchObject({ state: 'probable', basis: 'names', score: WEIGHT.codeName + WEIGHT.revisionAgree });
    expect(association.signals.map(signal => signal.signal)).toEqual(['revision-agree', 'code-name']);
    expect(association.conflicts).toEqual([]);
    expect(association.missing).toEqual(['content-identity']);
  });

  it('confirms with a unique content identity that equals the group code', () => {
    const [association] = matchFiles([group], [file('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', { contentCode: { code: 'MB-Q731', unique: true } })]);
    // The file also shares the folder alias "kestrel" with the group: 60 + 15 + 8.
    expect(association).toMatchObject({ state: 'confirmed', basis: 'content', score: WEIGHT.codeContent + WEIGHT.revisionAgree + WEIGHT.aliasEach });
  });

  it('never confirms on a content identity that is not unique', () => {
    const [association] = matchFiles([group], [file('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', { contentCode: { code: 'MB-Q731', unique: false } })]);
    expect(association.state).toBe('probable');
  });

  it('vetoes confirmation when two different board codes meet, even one character apart', () => {
    const near: BoardAnchor = { id: 'g-q732', boardCode: 'MB-Q732', aliases: ['kestrel'] };
    const [association] = matchFiles([near], [file('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', { contentCode: { code: 'MB-Q731', unique: true } })]);
    expect(association.state).toBe('review');
    expect(association.basis).toBe('conflict');
    expect(association.conflicts).toEqual([{ field: 'board-code', fileValue: 'MB-Q731', anchorValue: 'MB-Q732' }]);
  });

  it('vetoes on an explicit revision conflict, and keeps the probable name evidence in review', () => {
    const rev1: BoardAnchor = { id: 'g-rev1', boardCode: 'MB-Q731', revision: extractIdentity('x/MB-Q731_rev1.brd', linux).revision, aliases: [] };
    const [association] = matchFiles([rev1], [file('Alder/Orion-5/MB-Q731_rev2_BIOS.bin')]);
    expect(association.state).toBe('review');
    expect(association.conflicts).toEqual([{ field: 'revision', fileValue: '2', anchorValue: '1' }]);
    expect(association.signals.map(signal => signal.signal)).toEqual(['code-name']);
  });

  it('keeps a shared alias alone as "review", never "probable"', () => {
    const [association] = matchFiles([group], [file('Kestrel 14 Plus notes.pdf')]);
    expect(association).toMatchObject({ state: 'review', basis: 'alias', score: WEIGHT.aliasEach });
  });

  it('caps the alias weight', () => {
    const many: BoardAnchor = { id: 'g-many', aliases: ['alpha', 'bravo', 'charlie', 'delta'] };
    const [association] = matchFiles([many], [file('alpha/bravo/charlie/delta/notes.pdf')]);
    expect(association.score).toBe(WEIGHT.aliasMax);
  });

  it('creates no association from generic names only', () => {
    expect(matchFiles([group], [file('misc/mainboard.bin'), file('backup/BIOS.bin')])).toEqual([]);
  });

  it('confirms a durable user link without any evidence, and keeps it in the record', () => {
    const link = pairKey('r1\u0000misc/mainboard.bin', group.id);
    const [association] = matchFiles([group], [{ path: 'r1\u0000misc/mainboard.bin', identity: extractIdentity('misc/mainboard.bin', linux) }], { userLinks: new Set([link]) });
    expect(association).toMatchObject({ state: 'confirmed', basis: 'user', score: 0 });
  });

  it('still vetoes a user link when a code conflict exists', () => {
    const near: BoardAnchor = { id: 'g-q732', boardCode: 'MB-Q732', aliases: [] };
    const path = 'r1\u0000Alder/MB-Q731.fd';
    const [association] = matchFiles([near], [{ path, identity: extractIdentity('Alder/MB-Q731.fd', linux) }], { userLinks: new Set([pairKey(path, near.id)]) });
    expect(association).toMatchObject({ state: 'review', basis: 'conflict' });
  });

  it('suppresses a detached pair, even when the evidence would confirm it', () => {
    const path = 'r1\u0000Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd';
    const records = [{ path, identity: extractIdentity('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd', linux), contentCode: { code: 'MB-Q731', unique: true } }];
    expect(matchFiles([group], records, { detached: new Set([pairKey(path, group.id)]) })).toEqual([]);
    expect(matchFiles([group], records)).toHaveLength(1);
  });

  it('returns associations sorted by file, then by anchor, and shows each role', () => {
    const other: BoardAnchor = { id: 'g-a', boardCode: 'MB-Q731', aliases: [] };
    const out = matchFiles([group, other], [file('Alder/Orion-5/MB-Q731_rev2_BIOS.bin'), file('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd')]);
    expect(out.map(item => `${item.filePath}|${item.anchorId}|${item.role}`)).toEqual([
      'Alder/Orion-5/MB-Q731_rev2_BIOS.bin|g-a|bios-candidate',
      'Alder/Orion-5/MB-Q731_rev2_BIOS.bin|g-q731|bios-candidate',
      'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd|g-a|boardview',
      'Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd|g-q731|boardview',
    ]);
  });

  it('two models of one marketing family with different codes stay separate', () => {
    const q731: BoardAnchor = { id: 'q731', boardCode: 'MB-Q731', aliases: ['kestrel'] };
    const q732: BoardAnchor = { id: 'q732', boardCode: 'MB-Q732', aliases: ['kestrel'] };
    const out = matchFiles([q731, q732], [file('Birchfield/Kestrel-14-R2/board/MB-Q731_rev2.brd')]);
    expect(out.map(item => [item.anchorId, item.state])).toEqual([
      ['q731', 'probable'],
      ['q732', 'review'],
    ]);
  });
});
