/**
 * Tests for the pure overlay-panel bounds math (clamping a draggable/resizable
 * panel into the viewport). No DOM — clampOverlayBounds / defaultOverlayBounds /
 * clampNumber take plain objects.
 */
import { describe, it, expect } from 'vitest';
import {
  clampNumber,
  clampOverlayBounds,
  defaultOverlayBounds,
  OVERLAY_MIN_WIDTH,
  OVERLAY_MAX_WIDTH,
  OVERLAY_MIN_HEIGHT,
  OVERLAY_HEADER_KEEP,
  OVERLAY_EDGE_KEEP,
} from '../overlay-bounds.js';

const VP = { width: 1200, height: 800 };

describe('clampNumber', () => {
  it('returns the value when within range', () => {
    expect(clampNumber(50, 0, 100)).toBe(50);
  });
  it('clamps below the min', () => {
    expect(clampNumber(-10, 0, 100)).toBe(0);
  });
  it('clamps above the max', () => {
    expect(clampNumber(999, 0, 100)).toBe(100);
  });
  it('prefers min when max < min (degenerate range)', () => {
    expect(clampNumber(5, 100, 0)).toBe(100);
  });
  it('falls back to min for any non-finite input (NaN / ±Infinity)', () => {
    expect(clampNumber(NaN, 7, 100)).toBe(7);
    expect(clampNumber(Infinity, 7, 100)).toBe(7);
    expect(clampNumber(-Infinity, 7, 100)).toBe(7);
  });
});

describe('defaultOverlayBounds', () => {
  it('produces a ~460px-wide panel near the top-right', () => {
    const b = defaultOverlayBounds(VP);
    expect(b.width).toBe(460);
    expect(b.top).toBe(16);
    // 16px in from the right edge.
    expect(b.left).toBe(VP.width - 460 - 16);
    expect(b.minimized).toBe(false);
  });
  it('shrinks the width to fit a narrow viewport', () => {
    const b = defaultOverlayBounds({ width: 380, height: 800 });
    expect(b.width).toBeLessThanOrEqual(380);
    expect(b.width).toBeGreaterThanOrEqual(OVERLAY_MIN_WIDTH);
    expect(b.left).toBeGreaterThanOrEqual(0);
  });
  it('never returns a height below the minimum on a short viewport', () => {
    const b = defaultOverlayBounds({ width: 1200, height: 120 });
    expect(b.height).toBeGreaterThanOrEqual(OVERLAY_MIN_HEIGHT);
  });
});

describe('clampOverlayBounds', () => {
  it('passes through in-range bounds unchanged', () => {
    const input = { left: 100, top: 50, width: 460, height: 600, minimized: false };
    expect(clampOverlayBounds(input, VP)).toEqual(input);
  });

  it('falls back to the default when given null/undefined', () => {
    expect(clampOverlayBounds(null, VP)).toEqual(defaultOverlayBounds(VP));
    expect(clampOverlayBounds(undefined, VP)).toEqual(defaultOverlayBounds(VP));
  });

  it('fills missing fields from the default', () => {
    const out = clampOverlayBounds({ left: 200 }, VP);
    const def = defaultOverlayBounds(VP);
    expect(out.left).toBe(200);
    expect(out.width).toBe(def.width);
    expect(out.height).toBe(def.height);
    expect(out.top).toBe(def.top);
  });

  it('clamps width to [MIN, min(MAX, viewport)]', () => {
    expect(clampOverlayBounds({ width: 10 }, VP).width).toBe(OVERLAY_MIN_WIDTH);
    expect(clampOverlayBounds({ width: 5000 }, VP).width).toBe(OVERLAY_MAX_WIDTH);
    // Viewport narrower than MAX wins.
    expect(clampOverlayBounds({ width: 5000 }, { width: 500, height: 800 }).width).toBe(500);
  });

  it('clamps height to at least the minimum and at most the viewport height', () => {
    expect(clampOverlayBounds({ height: 10 }, VP).height).toBe(OVERLAY_MIN_HEIGHT);
    expect(clampOverlayBounds({ height: 99999 }, VP).height).toBe(VP.height);
  });

  it('keeps the panel grabbable when dragged off the right edge', () => {
    // left far past the right edge → clamped so EDGE_KEEP px stay on-screen.
    const out = clampOverlayBounds({ left: 5000, top: 50, width: 460, height: 600 }, VP);
    expect(out.left).toBe(VP.width - OVERLAY_EDGE_KEEP);
  });

  it('keeps the panel grabbable when dragged off the left edge', () => {
    const out = clampOverlayBounds({ left: -5000, top: 50, width: 460, height: 600 }, VP);
    // At least EDGE_KEEP px of the panel remains visible past the left edge.
    expect(out.left).toBe(OVERLAY_EDGE_KEEP - 460);
    expect(out.left + 460).toBeGreaterThanOrEqual(OVERLAY_EDGE_KEEP);
  });

  it('never lets the top go above 0 or past the bottom header strip', () => {
    expect(clampOverlayBounds({ top: -200 }, VP).top).toBe(0);
    const low = clampOverlayBounds({ top: 99999 }, VP);
    expect(low.top).toBe(VP.height - OVERLAY_HEADER_KEEP);
  });

  it('coerces a truthy-but-non-boolean minimized to false (only true is true)', () => {
    expect(clampOverlayBounds({ minimized: undefined }, VP).minimized).toBe(false);
    expect(clampOverlayBounds({ minimized: true }, VP).minimized).toBe(true);
    expect(clampOverlayBounds({ minimized: 1 as unknown as boolean }, VP).minimized).toBe(false);
  });

  it('ignores non-finite stored coordinates (uses the default instead)', () => {
    const out = clampOverlayBounds(
      { left: NaN, top: Infinity, width: NaN, height: -Infinity },
      VP,
    );
    const def = defaultOverlayBounds(VP);
    expect(out).toEqual(def);
  });
});
