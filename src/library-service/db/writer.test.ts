import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { BatchWriter, MAX_UNITS_PER_TRANSACTION } from './writer';

const open = (): DatabaseSync => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE t(x INTEGER)'); return db; };
const count = (db: DatabaseSync): number => Number((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n);

describe('BatchWriter', () => {
  it('commits every 500 units and never holds more than the bound in one transaction', () => {
    const db = open();
    const sizes: number[] = [];
    const writer = new BatchWriter(db, 500, { beforeCommit: info => sizes.push(info.units) });
    for (let i = 0; i < 1250; i++) writer.run(1, () => db.prepare('INSERT INTO t VALUES(?)').run(i));
    expect(sizes).toEqual([500, 500]);
    expect(writer.open).toBe(true);
    writer.commit();
    expect(sizes).toEqual([500, 500, 250]);
    expect(count(db)).toBe(1250);
    expect(writer.committed).toBe(3);
  });

  it('rejects bounds outside 1..500', () => {
    const db = open();
    for (const bad of [0, -1, 501, 1.5, Number.NaN]) expect(() => new BatchWriter(db, bad)).toThrow(RangeError);
    expect(MAX_UNITS_PER_TRANSACTION).toBe(500);
  });

  it('rolls back only the open transaction when an operation fails', () => {
    const db = open();
    const writer = new BatchWriter(db, 2);
    writer.run(1, () => db.exec('INSERT INTO t VALUES(1)'));
    writer.run(1, () => db.exec('INSERT INTO t VALUES(2)'));
    expect(writer.open).toBe(false);
    writer.run(1, () => db.exec('INSERT INTO t VALUES(3)'));
    expect(() => writer.run(1, () => { throw new Error('operation failed'); })).toThrow('operation failed');
    expect(writer.open).toBe(false);
    expect(count(db)).toBe(2);
  });

  it('keeps one operation whole: a nested atomic call joins the outer one and commits once', () => {
    const db = open();
    const batches: number[] = [];
    const writer = new BatchWriter(db, 500, { afterCommit: info => batches.push(info.batch) });
    writer.atomic(1, () => {
      db.exec('INSERT INTO t VALUES(1)');
      writer.atomic(1, () => db.exec('INSERT INTO t VALUES(2)'));
      expect(writer.open).toBe(true);
      db.exec('INSERT INTO t VALUES(3)');
    });
    expect(batches).toEqual([1]);
    expect(count(db)).toBe(3);
  });

  it('rolls the whole outer operation back when a nested one fails', () => {
    const db = open();
    const writer = new BatchWriter(db, 500);
    expect(() => writer.atomic(1, () => {
      db.exec('INSERT INTO t VALUES(1)');
      writer.atomic(1, () => { throw new Error('inner'); });
    })).toThrow('inner');
    expect(count(db)).toBe(0);
    writer.atomic(1, () => db.exec('INSERT INTO t VALUES(9)'));
    expect(count(db)).toBe(1);
  });

  it('rolls back when the commit hook fails', () => {
    const db = open();
    const writer = new BatchWriter(db, 500, { beforeCommit: () => { throw new Error('hook'); } });
    expect(() => writer.atomic(1, () => db.exec('INSERT INTO t VALUES(1)'))).toThrow('hook');
    expect(count(db)).toBe(0);
    expect(writer.open).toBe(false);
  });

  it('commits before a multi-unit operation would cross the bound', () => {
    const db = open(), sizes: number[] = [];
    const writer = new BatchWriter(db, 3, { afterCommit: info => sizes.push(info.units) });
    writer.run(2, () => db.exec('INSERT INTO t VALUES(1)'));
    writer.run(2, () => db.exec('INSERT INTO t VALUES(2)'));
    writer.commit();
    expect(sizes).toEqual([2, 2]);
    for (const bad of [0, -1, 4, 1.5, NaN]) expect(() => writer.run(bad, () => {})).toThrow(RangeError);
    db.close();
  });

  it('keeps bulk operations and their explicit commits inside an outer transaction', () => {
    const db = open(), batches: number[] = [];
    const writer = new BatchWriter(db, 3, { afterCommit: info => batches.push(info.units) });
    expect(() => writer.atomic(1, () => {
      writer.run(1, () => db.exec('INSERT INTO t VALUES(1)'));
      writer.commit();
      writer.run(1, () => db.exec('INSERT INTO t VALUES(2)'));
      throw new Error('later failure');
    })).toThrow('later failure');
    expect(count(db)).toBe(0);
    expect(batches).toEqual([]);
    expect(() => writer.atomic(1, () => {
      for (let i = 0; i < 4; i++) writer.run(1, () => db.exec('INSERT INTO t VALUES(3)'));
    })).toThrow(RangeError);
    expect(count(db)).toBe(0);
    db.close();
  });
});
