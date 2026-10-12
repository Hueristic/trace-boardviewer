import { get, run, type Ctx } from './context';

export function getMeta(ctx: Ctx, key: string): string | undefined {
  return get<{ value: string }>(ctx, 'SELECT value FROM meta WHERE key = ?', key)?.value;
}
export function setMeta(ctx: Ctx, key: string, value: string): void {
  run(ctx, 'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

const numberMeta = (ctx: Ctx, key: string): number => {
  const n = Number(getMeta(ctx, key) ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/**
 * The epoch changes whenever row ids may be reused or change meaning (a root is removed, files are purged, the index is rebuilt).
 * Query cursors are bound to it: a cursor from an earlier epoch is refused, a cursor across ordinary inserts stays valid.
 */
export const epoch = (ctx: Ctx): number => numberMeta(ctx, 'epoch');
export function bumpEpoch(ctx: Ctx): number {
  const next = epoch(ctx) + 1;
  setMeta(ctx, 'epoch', String(next));
  return next;
}

/** Scan numbers only grow; `file.seen_scan` stores the number of the scan that last saw the row. */
export function nextScan(ctx: Ctx): number {
  const next = numberMeta(ctx, 'scan_counter') + 1;
  setMeta(ctx, 'scan_counter', String(next));
  return next;
}
export const currentScan = (ctx: Ctx): number => numberMeta(ctx, 'scan_counter');

/** Per-stage version the index was last brought to (extractor, knowledge, sniff, group). */
export const stageVersionKey = (stage: string): string => `stage_version.${stage}`;
