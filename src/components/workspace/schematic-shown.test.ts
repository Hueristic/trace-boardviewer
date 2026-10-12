import { describe, expect, it } from 'vitest';
import { shownSchematicId } from './schematic-shown';

const ids = new Set(['known', 'eagle', 'hier']);

describe('shownSchematicId', () => {
  it('a fresh pick from the document list wins over the stale cross-probe of the earlier schematic', () => {
    expect(shownSchematicId('eagle', 'known', 'eagle', ids, 'known')).toBe('eagle');
  });
  it('without a pick, the cross-probe decides over the selected document', () => {
    expect(shownSchematicId(null, 'known', 'hier', ids, 'eagle')).toBe('known');
  });
  it('without a pick or probe, the selected document decides over the first schematic', () => {
    expect(shownSchematicId(null, null, 'hier', ids, 'known')).toBe('hier');
  });
  it('falls back to the first schematic when nothing usable is selected', () => {
    expect(shownSchematicId(null, null, null, ids, 'known')).toBe('known');
  });
  it('ignores ids that are no longer schematics (removed or non-schematic documents)', () => {
    expect(shownSchematicId('pdf-1', 'gone', 'pdf-1', ids, 'known')).toBe('known');
  });
  it('returns null when there is no schematic at all', () => {
    expect(shownSchematicId('x', 'y', 'z', new Set(), null)).toBeNull();
  });
});
