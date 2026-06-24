/**
 * Pure, DOM-free bounds math for the in-page overlay panel
 * (src/content/overlay.ts). Kept in its own module — imported ONLY by overlay.ts
 * — so rollup inlines it into the self-contained overlay content script rather
 * than splitting it into a shared chunk a classic content script can't import.
 *
 * Clamps the draggable/resizable panel to the viewport so it can never be dragged
 * fully off-screen or sized smaller/larger than is usable. Unit-tested directly.
 */

/** Persisted overlay panel geometry (chrome.storage.local `overlayBounds`). */
export interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  minimized: boolean;
}

/** Viewport the panel is clamped into. */
export interface Viewport {
  width: number;
  height: number;
}

/** Min/max panel size constraints (px). Width is the spec's ~460px target. */
export const OVERLAY_MIN_WIDTH = 320;
export const OVERLAY_MAX_WIDTH = 760;
export const OVERLAY_MIN_HEIGHT = 200;
/** Header height kept on-screen so a minimized / off-dragged panel is grabbable. */
export const OVERLAY_HEADER_KEEP = 40;
/** Horizontal sliver kept on-screen so the panel can always be grabbed back. */
export const OVERLAY_EDGE_KEEP = 80;

/** The default panel geometry for a viewport (top-right, ~460px wide). */
export function defaultOverlayBounds(viewport: Viewport): OverlayBounds {
  const width = clampNumber(460, OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, viewport.width));
  const height = clampNumber(
    640,
    OVERLAY_MIN_HEIGHT,
    Math.max(OVERLAY_MIN_HEIGHT, viewport.height - 24),
  );
  // Default: 16px in from the top-right corner.
  const left = Math.max(0, viewport.width - width - 16);
  const top = 16;
  return { left, top, width, height, minimized: false };
}

/** Clamp a number into [min, max]; tolerates max < min by preferring min. */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const hi = Math.max(min, max);
  return Math.min(Math.max(value, min), hi);
}

/**
 * Clamp a (possibly stale / partial / out-of-range) bounds object so the panel
 * stays usable inside `viewport`:
 *  - width/height constrained to [min, max-that-fits-the-viewport];
 *  - the panel kept on-screen by at least an edge sliver horizontally and the
 *    header strip vertically, so it can always be grabbed and dragged back.
 *
 * Non-finite / missing fields fall back to the viewport default. Pure.
 */
export function clampOverlayBounds(
  bounds: Partial<OverlayBounds> | null | undefined,
  viewport: Viewport,
): OverlayBounds {
  const fallback = defaultOverlayBounds(viewport);
  const b = bounds ?? {};

  const maxW = Math.max(OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, viewport.width));
  const width = clampNumber(numberOr(b.width, fallback.width), OVERLAY_MIN_WIDTH, maxW);

  const maxH = Math.max(OVERLAY_MIN_HEIGHT, viewport.height);
  const height = clampNumber(numberOr(b.height, fallback.height), OVERLAY_MIN_HEIGHT, maxH);

  // Horizontal: keep at least OVERLAY_EDGE_KEEP px of the panel on-screen on
  // either side (never let it slide fully past the left/right edge).
  const minLeft = OVERLAY_EDGE_KEEP - width;
  const maxLeft = viewport.width - OVERLAY_EDGE_KEEP;
  const left = clampNumber(numberOr(b.left, fallback.left), minLeft, Math.max(minLeft, maxLeft));

  // Vertical: top never above 0; keep the header strip on-screen at the bottom.
  const maxTop = Math.max(0, viewport.height - OVERLAY_HEADER_KEEP);
  const top = clampNumber(numberOr(b.top, fallback.top), 0, maxTop);

  return { left, top, width, height, minimized: b.minimized === true };
}

/** Coerce to a finite number, else the fallback. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
