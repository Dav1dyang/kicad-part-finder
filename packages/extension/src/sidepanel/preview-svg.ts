/**
 * Tiny shared geometry helpers for the SVG previews (footprint + symbol).
 *
 * Just an axis-aligned bounding-box accumulator plus the SVG namespace. Pure +
 * DOM-free (the namespace constant is a plain string), so the bbox helpers are
 * unit-tested directly.
 */

/** The SVG XML namespace, for `document.createElementNS`. */
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** An axis-aligned bounding box. Starts "empty" (min > max) until grown. */
export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A fresh, empty bbox (infinite min / -infinite max so the first point wins). */
export function emptyBbox(): Bbox {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
}

/** Expand `box` in place to include the point (x, y). Ignores non-finite input. */
export function growBbox(box: Bbox, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < box.minX) box.minX = x;
  if (y < box.minY) box.minY = y;
  if (x > box.maxX) box.maxX = x;
  if (y > box.maxY) box.maxY = y;
}

/** Whether the box has been grown to a real, finite extent (≥ one point). */
export function isFiniteBbox(box: Bbox): boolean {
  return (
    Number.isFinite(box.minX) &&
    Number.isFinite(box.minY) &&
    Number.isFinite(box.maxX) &&
    Number.isFinite(box.maxY) &&
    box.maxX >= box.minX &&
    box.maxY >= box.minY
  );
}
