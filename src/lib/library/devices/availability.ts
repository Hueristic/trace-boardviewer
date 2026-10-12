/**
 * Availability of one file role for one motherboard: found, not found, or unknown.
 *
 * "Not found" is a claim about the whole selected scope, so it is made only when every relevant root finished the current scan
 * generation as complete, online and readable, and the role's stage ran. Any partial, paused, cancelled, denied, offline, skipped or
 * stale root makes the answer unknown. Indexed files on an offline root are a separate count, never "currently available".
 * Counts are real candidate counts; a missing file is never counted from an expected inventory.
 */

export type RootCoverage = 'complete' | 'partial' | 'paused' | 'cancelled' | 'offline' | 'denied' | 'skipped';
export interface RootStatus { rootId: string; coverage: RootCoverage; generation: number }

export type SlotAvailability =
  | { status: 'found'; count: number }
  | { status: 'not-found'; rootCount: number }
  | { status: 'unknown'; reason: 'no-root' | 'stage-skipped' | 'incomplete' | 'offline' | 'denied' | 'stale-generation'; knownOffline: number };

export interface SlotInput {
  relevantRootIds: readonly string[];
  roots: ReadonlyMap<string, RootStatus>;
  /** The scan generation the answer is about. A root from another generation makes the answer unknown. */
  generation: number;
  /** Candidates of this role found in readable, online roots of the current generation. */
  foundOnline: number;
  /** Candidates of this role indexed under offline roots: known, but not currently available. */
  knownOffline: number;
  /** False when the stage that detects this role was disabled or did not finish. */
  stageRan: boolean;
}

export function slotAvailability(input: SlotInput): SlotAvailability {
  if (input.foundOnline > 0) return { status: 'found', count: input.foundOnline };
  if (input.relevantRootIds.length === 0) return { status: 'unknown', reason: 'no-root', knownOffline: input.knownOffline };
  if (!input.stageRan) return { status: 'unknown', reason: 'stage-skipped', knownOffline: input.knownOffline };
  let reason: 'incomplete' | 'offline' | 'denied' | 'stage-skipped' | 'stale-generation' | undefined;
  for (const rootId of input.relevantRootIds) {
    const status = input.roots.get(rootId);
    if (status === undefined) { reason ??= 'incomplete'; continue; }
    if (status.generation !== input.generation) { reason ??= 'stale-generation'; continue; }
    switch (status.coverage) {
      case 'complete':
        break;
      case 'offline':
        reason ??= 'offline';
        break;
      case 'denied':
        reason ??= 'denied';
        break;
      case 'skipped':
        reason ??= 'stage-skipped';
        break;
      default:
        reason ??= 'incomplete';
    }
  }
  if (reason !== undefined) return { status: 'unknown', reason, knownOffline: input.knownOffline };
  return { status: 'not-found', rootCount: input.relevantRootIds.length };
}
