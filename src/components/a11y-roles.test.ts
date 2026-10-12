import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Screen-reader roles. The board canvas and the schematic canvas take keyboard input of their own (arrow keys pan,
 * +/- zoom, Backspace goes up a level). For that the ARIA role is "application": with role "img" the keys are not passed
 * to the canvas, and an aria-label on a canvas without any role is ignored by many screen readers.
 */
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('screen-reader roles of the interactive canvases', () => {
  it('the board canvas is an application region with its catalog name', () => {
    expect(read('src/components/BoardCanvas.tsx')).toMatch(/className="board-canvas"\s+role="application"/);
  });

  it('the schematic canvas is an application region, not an image', () => {
    const source = read('src/components/SchematicViewer.tsx');
    expect(source).toMatch(/className="schv-canvas" role="application"/);
    expect(source).not.toMatch(/className="schv-canvas" role="img"/);
  });
});
