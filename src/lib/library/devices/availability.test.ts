import { describe, expect, it } from 'vitest';
import { slotAvailability, type RootCoverage, type RootStatus, type SlotInput } from './availability';

const roots = (entries: Array<[string, RootCoverage, number?]>): Map<string, RootStatus> =>
  new Map(entries.map(([rootId, coverage, generation = 7]) => [rootId, { rootId, coverage, generation }]));

const base: SlotInput = { relevantRootIds: ['a', 'b'], roots: roots([['a', 'complete'], ['b', 'complete']]), generation: 7, foundOnline: 0, knownOffline: 0, stageRan: true };

describe('slot availability', () => {
  it('reports the real count of found candidates, even when a root is incomplete', () => {
    expect(slotAvailability({ ...base, foundOnline: 3, roots: roots([['a', 'partial'], ['b', 'complete']]) })).toEqual({ status: 'found', count: 3 });
  });

  it('reports not-found only when every relevant root is complete, online, current and the stage ran', () => {
    expect(slotAvailability(base)).toEqual({ status: 'not-found', rootCount: 2 });
  });

  it.each<[RootCoverage, string]>([
    ['partial', 'incomplete'],
    ['paused', 'incomplete'],
    ['cancelled', 'incomplete'],
    ['offline', 'offline'],
    ['denied', 'denied'],
    ['skipped', 'stage-skipped'],
  ])('a %s root makes the answer unknown (%s)', (coverage, reason) => {
    expect(slotAvailability({ ...base, roots: roots([['a', coverage], ['b', 'complete']]) })).toEqual({ status: 'unknown', reason, knownOffline: 0 });
  });

  it('a root that was never scanned is unknown, not absent', () => {
    expect(slotAvailability({ ...base, roots: roots([['a', 'complete']]) })).toEqual({ status: 'unknown', reason: 'incomplete', knownOffline: 0 });
  });

  it('a root from another generation is stale and makes the answer unknown', () => {
    expect(slotAvailability({ ...base, roots: roots([['a', 'complete', 6], ['b', 'complete']]) })).toEqual({ status: 'unknown', reason: 'stale-generation', knownOffline: 0 });
  });

  it('keeps indexed-but-offline files as a separate count and never calls them found', () => {
    const out = slotAvailability({ ...base, foundOnline: 0, knownOffline: 2, roots: roots([['a', 'offline'], ['b', 'complete']]) });
    expect(out).toEqual({ status: 'unknown', reason: 'offline', knownOffline: 2 });
  });

  it('a stage that did not run is unknown, even when every root is complete', () => {
    expect(slotAvailability({ ...base, stageRan: false })).toEqual({ status: 'unknown', reason: 'stage-skipped', knownOffline: 0 });
  });

  it('with no relevant root the answer is unknown', () => {
    expect(slotAvailability({ ...base, relevantRootIds: [] })).toEqual({ status: 'unknown', reason: 'no-root', knownOffline: 0 });
  });
});
