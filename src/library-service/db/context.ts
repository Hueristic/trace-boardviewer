import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { IdSource } from './ids';
import type { BatchWriter } from './writer';

export type Bind = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

/** Storage limits that keep the index inside its budget: low-value postings are dropped first and the summary says so (`truncated`). */
export interface StoragePolicy { maxPostingsPerContent: number }
export const DEFAULT_POLICY: Readonly<StoragePolicy> = Object.freeze({ maxPostingsPerContent: 96 });

/** Shared state of one open database: the connection, id source, clock, bounded writer and statement cache. */
export interface Ctx {
  readonly db: DatabaseSync;
  readonly ids: IdSource;
  readonly now: () => number;
  readonly writer: BatchWriter;
  readonly policy: StoragePolicy;
  readonly statements: Map<string, StatementSync>;
}

export function stmt(ctx: Ctx, sql: string): StatementSync {
  let s = ctx.statements.get(sql);
  if (!s) { s = ctx.db.prepare(sql); ctx.statements.set(sql, s); }
  return s;
}
export function get<T = Row>(ctx: Ctx, sql: string, ...params: Bind[]): T | undefined { return stmt(ctx, sql).get(...params) as T | undefined; }
export function all<T = Row>(ctx: Ctx, sql: string, ...params: Bind[]): T[] { return stmt(ctx, sql).all(...params) as T[]; }
export function run(ctx: Ctx, sql: string, ...params: Bind[]): { changes: number; lastInsertRowid: number } {
  const r = stmt(ctx, sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}
/** Executes a statement that is built per call (dynamic search SQL): not cached. */
export function dynamicAll<T = Row>(ctx: Ctx, sql: string, params: Bind[]): T[] { return ctx.db.prepare(sql).all(...params) as T[]; }
export function dynamicRun(ctx: Ctx, sql: string, params: Bind[]): number { return Number(ctx.db.prepare(sql).run(...params).changes); }

export const text = (v: unknown): string => (typeof v === 'string' ? v : '');
export const int = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);
export const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

/** Runs `fn` inside one bounded transaction unit and commits at once: nothing stays open after the call. */
export function atomic<T>(ctx: Ctx, fn: () => T, units = 1): T { return ctx.writer.atomic(units, fn); }

/** JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
export const jsonIds = (ids: readonly (number | string)[]): string => JSON.stringify(ids);
