/**
 * The image viewer's side panel (bookmarks and notes) is laid OVER the canvas, not beside it, when the viewer is narrower than this
 * many pixels (image-viewer.css: `@container imgv (max-width:719px)`). A panel over the canvas takes the clicks that a drawing tool needs.
 */
export const PANEL_OVERLAY_MAX_WIDTH = 719;

export function panelCoversCanvas(containerWidth: number): boolean {
  return containerWidth <= PANEL_OVERLAY_MAX_WIDTH;
}
