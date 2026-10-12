import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source contract for the Documents-list click (Shell.pickDocument). The node test environment has no DOM and no click, so this pins the binding a
// regression would break: a schematic picked from the list must go through pickSchematic, which sets the picked schematic that schematicShown reads
// before the cross-probe. A list click that only reveals the tab leaves the cross-probed schematic on screen. This is NOT the native run: the click
// itself is proven by the packaged viewers scenario ("a Documents-list pick of the second schematic ...").

const shell = readFileSync(new URL('./Shell.tsx', import.meta.url), 'utf8');

/** The source of one `const name = useCallback(...)` of Shell: from its declaration up to the next declaration of the component body. */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  if (start < 0) return '';
  const next = source.indexOf('\n  const ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

describe('Documents-list pick binding in Shell (W-settlement: second schematic after a cross-probe)', () => {
  const pickDocument = callbackBody(shell, 'pickDocument');
  const pickSchematic = callbackBody(shell, 'pickSchematic');

  it('a schematic picked from the Documents list goes through pickSchematic', () => {
    expect(pickDocument).toMatch(/kind === 'schematic'\)\s*pickSchematic\(id\)/);
  });

  it('the list click does not only reveal the schematic tab (that left the cross-probed board on screen)', () => {
    expect(pickDocument).not.toMatch(/reveal\(doc\.record\.kind === 'schematic'/);
  });

  it('pickSchematic makes the picked schematic the fresh pick that schematicShown reads first', () => {
    expect(pickSchematic).toMatch(/setPickedSchematic\(id\)/);
    expect(shell).toMatch(/shownSchematicId\(pickedSchematic, probeSchematic, rightId, schematicIds, firstSchematic\?\.record\.id \?\? null\)/);
  });

  it('the Schematic tab shows exactly the resolved schematic', () => {
    expect(shell).toMatch(/<SchematicTab api=\{api\} shownId=\{schematicShown\}/);
  });
});
