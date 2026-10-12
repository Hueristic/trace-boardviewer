import { randomBytes } from 'node:crypto';

/** Prefix letters of the opaque public identifiers: root, content, file, group, duplicate set, decision. */
export type IdKind = 'r' | 'c' | 'f' | 'g' | 'd' | 'x';

export interface IdSource { next(kind: IdKind): string }

/** Random 80-bit identifiers in base64url: they match the `[A-Za-z0-9_-]{1,64}` rule of the transport validators and reveal nothing about a path. */
export function randomIds(): IdSource {
  return { next: kind => `${kind}${randomBytes(10).toString('base64url')}` };
}

/** Deterministic identifiers (`f1`, `f2`, ...) for tests. */
export function sequentialIds(): IdSource {
  const counters = new Map<string, number>();
  return { next: kind => { const n = (counters.get(kind) ?? 0) + 1; counters.set(kind, n); return `${kind}${n}`; } };
}
