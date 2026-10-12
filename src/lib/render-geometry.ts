import type { Bounds2, Point2 } from './geometry';
import type { BoardPin } from './types';

interface PadPath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  closePath(): void;
}

/**
 * Level of detail: a pad whose display half-size is below this many screen pixels is drawn as an axis-aligned square point with the same
 * area as the pad it replaces, so the tone of a dense pad array stays the same. Below one and a half pixels a curve and its rotation are
 * invisible; from this size up, a pad is drawn exactly as before (so a close zoom is unchanged).
 */
export const PAD_POINT_PX = 1.5;

/** A square point centred on (x, y), as an open subpath (a fill closes it): four segments instead of a curve. */
function appendPadPoint(path: PadPath, x: number, y: number, half: number): void {
  path.moveTo(x - half, y - half);
  path.lineTo(x + half, y - half);
  path.lineTo(x + half, y + half);
  path.lineTo(x - half, y + half);
}

/** Half-side of the square with the area of a circle of this radius. */
const pointHalfOfCircle = (radius: number) => radius * Math.sqrt(Math.PI) / 2;

/** Same display markers as the individual pad renderer, without per-pad context transforms. */
export function appendPadPath(path: PadPath, pin: BoardPin, scale: number, markerPixels: number): void {
  const radius = Math.max(pin.radius, markerPixels / scale);
  if (pin.shape === 'round' || !(pin.width || pin.height)) {
    if (radius * scale < PAD_POINT_PX) { appendPadPoint(path, pin.x, pin.y, pointHalfOfCircle(radius)); return; }
    // A separate subpath prevents a fill from joining neighbouring circles.
    path.moveTo(pin.x + radius, pin.y);
    path.arc(pin.x, pin.y, radius, 0, Math.PI * 2);
    // Filling closes the full circle implicitly. Native closePath on a large
    // compound path repeatedly scans its contours and makes zooming quadratic.
    return;
  }
  const halfWidth = Math.max(pin.width ?? radius * 2, 1.5 / scale) / 2;
  const halfHeight = Math.max(pin.height ?? radius * 2, 1.5 / scale) / 2;
  if (Math.max(halfWidth, halfHeight) * scale < PAD_POINT_PX) { appendPadPoint(path, pin.x, pin.y, Math.sqrt(halfWidth * halfHeight)); return; }
  const angle = (pin.rotation ?? 0) * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const corners = [
    [-halfWidth, -halfHeight], [halfWidth, -halfHeight],
    [halfWidth, halfHeight], [-halfWidth, halfHeight],
  ];
  for (let index = 0; index < corners.length; index++) {
    const [x, y] = corners[index];
    const px = pin.x + x * c - y * s, py = pin.y + x * s + y * c;
    if (index === 0) path.moveTo(px, py); else path.lineTo(px, py);
  }
  path.closePath();
}

/** Clips an exact logical segment, including crossings with both endpoints offscreen. */
export function clipSegmentToBounds(from: Point2, to: Point2, bounds: Bounds2): { from: Point2; to: Point2 } | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  let start = 0, end = 1;
  if (dx === 0) {
    if (from.x < bounds.minX || from.x > bounds.maxX) return null;
  } else {
    const a = (bounds.minX - from.x) / dx, b = (bounds.maxX - from.x) / dx;
    start = Math.max(start, Math.min(a, b)); end = Math.min(end, Math.max(a, b));
  }
  if (dy === 0) {
    if (from.y < bounds.minY || from.y > bounds.maxY) return null;
  } else {
    const a = (bounds.minY - from.y) / dy, b = (bounds.maxY - from.y) / dy;
    start = Math.max(start, Math.min(a, b)); end = Math.min(end, Math.max(a, b));
  }
  if (start > end) return null;
  return {
    from: start === 0 ? from : { x: from.x + dx * start, y: from.y + dy * start },
    to: end === 1 ? to : { x: from.x + dx * end, y: from.y + dy * end },
  };
}
