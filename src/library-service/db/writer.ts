import type { DatabaseSync } from 'node:sqlite';

export const MAX_UNITS_PER_TRANSACTION = 500;

export interface WriterHooks {
  /** Runs inside the open transaction, immediately before COMMIT. Tests use it to stop a process half way through a batch. */
  beforeCommit?(info: { batch: number; units: number }): void;
  afterCommit?(info: { batch: number; units: number }): void;
}

/**
 * Bounded transactions. `run(units, fn)` executes `fn` inside the open transaction (BEGIN IMMEDIATE is issued lazily) and commits once
 * the transaction has accumulated `maxUnits` units. A batch is committed before an operation would cross the bound.
 * One operation (a stage's outputs together with its state row) is never split over two transactions.
 * A failure rolls back the open transaction only; earlier committed batches stay.
 */
export class BatchWriter {
  readonly maxUnits: number;
  private readonly db: DatabaseSync;
  private readonly hooks: WriterHooks;
  private active = false;
  private units = 0;
  private batches = 0;
  private depth = 0;
  private failed = false;

  constructor(db: DatabaseSync, maxUnits: number = MAX_UNITS_PER_TRANSACTION, hooks: WriterHooks = {}) {
    if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > MAX_UNITS_PER_TRANSACTION) throw new RangeError('maxUnits must be 1..500');
    this.db = db;
    this.maxUnits = maxUnits;
    this.hooks = hooks;
  }

  get open(): boolean { return this.active; }
  get committed(): number { return this.batches; }

  run<T>(units: number, fn: () => T): T {
    this.validateUnits(units);
    if (this.depth > 0) {
      if (this.units + units > this.maxUnits) throw new RangeError('Transaction exceeds the file batch limit');
      this.units += units;
      return fn();
    }
    if (this.active && this.units + units > this.maxUnits) this.commit();
    if (!this.active) { this.db.exec('BEGIN IMMEDIATE'); this.active = true; this.units = 0; }
    let result: T;
    try { result = fn(); } catch (error) { this.rollback(); throw error; }
    this.units += units;
    if (this.units >= this.maxUnits) this.commit();
    return result;
  }

  /**
   * One operation that must reach the disk as a whole: runs `fn` and commits at once. A call made while another `atomic` operation is
   * running joins that operation (it neither counts units nor commits), so the outer operation stays all-or-nothing.
   */
  atomic<T>(units: number, fn: () => T): T {
    if (this.depth > 0) return fn();
    this.validateUnits(units);
    this.commit();
    this.db.exec('BEGIN IMMEDIATE');
    this.active = true;
    this.units = 0;
    this.failed = false;
    this.depth++;
    try {
      const result = fn();
      if (this.failed) throw new Error('A nested operation failed');
      this.units = Math.max(units, this.units);
      this.flush();
      return result;
    } catch (error) {
      this.rollbackNow();
      throw error;
    } finally { this.depth--; }
  }

  commit(): void {
    if (this.depth > 0) return;
    this.flush();
  }

  private validateUnits(units: number): void {
    if (!Number.isInteger(units) || units < 1 || units > this.maxUnits) throw new RangeError('units must fit the file batch limit');
  }

  private flush(): void {
    if (!this.active) return;
    const info = { batch: this.batches + 1, units: this.units };
    try {
      this.hooks.beforeCommit?.(info);
      this.db.exec('COMMIT');
    } catch (error) { this.rollback(); throw error; }
    this.active = false;
    this.batches++;
    this.units = 0;
    this.hooks.afterCommit?.(info);
  }

  rollback(): void {
    if (this.depth > 0) { this.failed = true; return; }
    this.rollbackNow();
  }

  private rollbackNow(): void {
    if (!this.active) return;
    this.active = false;
    this.units = 0;
    try { this.db.exec('ROLLBACK'); } catch { /* the connection may already have rolled back */ }
  }
}
