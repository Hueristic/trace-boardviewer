import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import libraryLimits from '../../../../shared/library-limits.json';
import { MAX_PATH_TEXT, parseCorrections } from './corrections';
import { pathSegments } from '../knowledge/names';

/**
 * One path limit for every Library layer (TB-068): shared/library-limits.json is read by the codec (TypeScript) and by the main-process
 * bundle (electron/library/devices-core.cjs, generated from the same source). A relative path of exactly the limit is kept, one unit more
 * is refused with the explicit reason 'path-too-long' in both layers, and no segment of a path is cut.
 */
const bundle = createRequire(import.meta.url)('../../../../electron/library/devices-core.cjs') as typeof import('./corrections');

function documentWith(path: string): string {
  return JSON.stringify({ version: 1, platform: 'win32', corrections: [{ op: 'link', file: { rootId: 'r', path }, anchorId: 'g1' }] });
}

describe('one Library path limit (TB-068)', () => {
  it('the limit is the shared value, read by the codec', () => {
    expect(MAX_PATH_TEXT).toBe(libraryLimits.maxRelativePathUnits);
    expect(MAX_PATH_TEXT).toBe(32_767);
  });

  it('the TypeScript codec and the main-process bundle agree: the limit is kept, one unit more is refused with a reason, never truncated', () => {
    for (const parse of [parseCorrections, bundle.parseCorrections]) {
      const atLimit = 'n'.repeat(MAX_PATH_TEXT);
      const kept = parse(documentWith(atLimit));
      expect(kept.rejections).toEqual([]);
      expect(kept.document.corrections[0]).toMatchObject({ file: { path: atLimit } });
      const over = parse(documentWith('n'.repeat(MAX_PATH_TEXT + 1)));
      expect(over.document.corrections).toEqual([]);
      expect(over.rejections).toEqual([{ index: 0, reason: 'path-too-long' }]);
    }
  });

  it('no segment is cut: a segment well over the old 260 units is read whole', () => {
    const long = 'y'.repeat(600);
    expect(pathSegments(`a/${long}/b.brd`)).toEqual(['a', long, 'b.brd']);
  });
});
