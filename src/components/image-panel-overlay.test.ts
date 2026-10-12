import { describe, expect, it } from 'vitest';
import { PANEL_OVERLAY_MAX_WIDTH, panelCoversCanvas } from './image-panel-overlay';

describe('image viewer panel overlay', () => {
  it('uses the same 719 px breakpoint as the stylesheet container query', () => {
    expect(PANEL_OVERLAY_MAX_WIDTH).toBe(719);
  });

  it('a viewer at or below 719 px has the panel over the canvas; wider it sits beside it', () => {
    expect(panelCoversCanvas(629.6)).toBe(true); // the packaged SVG scenario: 629.6 px stage
    expect(panelCoversCanvas(719)).toBe(true);
    expect(panelCoversCanvas(720)).toBe(false);
    expect(panelCoversCanvas(1147)).toBe(false);
  });
});
