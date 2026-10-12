import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Keyboard focus indicators. Each element below takes keyboard focus (tabIndex 0). It must show a visible focus ring
 * through :focus-visible. A rule that removes the outline without a replacement hides focus from keyboard users.
 * These are source checks: the app has no DOM environment in the unit tests.
 */
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('keyboard focus indicators', () => {
  it('the board canvas, which takes focus, shows a ring through :focus-visible and never removes its outline inline', () => {
    expect(read('src/components/BoardCanvas.tsx')).not.toMatch(/outline: 'none'/);
    const styles = read('src/styles.css');
    expect(styles).not.toMatch(/\.board-canvas\{outline:none\}/);
    expect(styles).toMatch(/\.board-canvas:focus-visible\{outline:2px solid var\(--net\);outline-offset:-2px\}/);
  });

  it('the PDF pages region, which takes focus, shows a ring through :focus-visible', () => {
    const css = read('src/components/pdf-viewer.css');
    expect(css).toMatch(/\.pdfv-scroller:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--net\)/);
  });

  it('the schematic canvas, which takes focus, shows a ring through :focus-visible', () => {
    const css = read('src/components/schematic-viewer.css');
    expect(css).toMatch(/\.schv-canvas:focus-visible\{[^}]*(outline:\s*2px solid var\(--net\)|box-shadow:\s*inset 0 0 0 2px var\(--net\))/);
  });
});
