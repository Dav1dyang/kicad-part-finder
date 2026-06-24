/**
 * Unit tests for the footprint preview's pure parser + bbox helpers.
 *
 * DOM-free: only {@link parseFootprint} (and the shared bbox helpers it uses)
 * are exercised here — the SVG rendering is left to manual/visual checks since
 * it needs a DOM. The fixture below is trimmed from the converter's real
 * `.kicad_mod` output for C3235557 (TPS2116, SOT-583) so the shapes are honest.
 */
import { describe, it, expect } from 'vitest';
import { parseFootprint } from '../preview-footprint.js';
import { emptyBbox, growBbox, isFiniteBbox } from '../preview-svg.js';

const FOOTPRINT = `(footprint "SOT-583-8" (version 20211014) (generator easyeda2kicad)
  (layer "F.Cu")
  (attr smd)
  (fp_text reference "REF**" (at 0.000 -4.640) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_line (start 1.1430 0.5080) (end 1.1430 -0.5080) (layer "F.SilkS") (width 0.2540))
  (fp_circle (center -1.0500 0.8000) (end -1.0200 0.8000) (layer "F.SilkS") (width 0.0600))
  (pad "1" smd rect (at -0.7501 0.6401 0.00) (size 0.2800 0.6800) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd roundrect (at -0.2499 0.6401) (size 0.2800 0.6800) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "3" thru_hole circle (at 0.2499 -0.6401 90) (size 0.9 0.9) (drill 0.5) (layers "*.Cu" "*.Mask"))
  (fp_line (start 1.0500 0.6000) (end 1.0500 -0.6000) (layer "F.CrtYd") (width 0.05))
  (fp_poly (pts (xy -0.1 -0.1) (xy 0.1 -0.1) (xy 0.1 0.1)) (stroke (width 0) (type solid)) (fill solid) (layer "F.SilkS"))
)`;

describe('parseFootprint', () => {
  const model = parseFootprint(FOOTPRINT)!;

  it('parses a footprint root (vs. returning null)', () => {
    expect(model).not.toBeNull();
    expect(model.name).toBe('SOT-583-8');
  });

  it('reads every pad with number, shape, position, size', () => {
    expect(model.pads).toHaveLength(3);
    const p1 = model.pads[0];
    expect(p1).toMatchObject({ number: '1', shape: 'rect', x: -0.7501, y: 0.6401, w: 0.28, h: 0.68 });
  });

  it('handles a pad whose (at …) omits the rotation', () => {
    const p2 = model.pads[1];
    expect(p2.number).toBe('2');
    expect(p2.shape).toBe('roundrect');
    expect(p2.rot).toBe(0);
  });

  it('flags a through-hole pad and reads its drill', () => {
    const p3 = model.pads[2];
    expect(p3.thruHole).toBe(true);
    expect(p3.shape).toBe('circle');
    expect(p3.drill).toBe(0.5);
    expect(p3.rot).toBe(90);
  });

  it('classifies graphics by layer (silk / courtyard / fab)', () => {
    const silk = model.segs.filter((s) => s.layer === 'silk');
    const crtyd = model.segs.filter((s) => s.layer === 'courtyard');
    expect(silk.length).toBeGreaterThanOrEqual(1);
    expect(crtyd.length).toBe(1);
    expect(model.circles[0].layer).toBe('silk');
    expect(model.polys[0].layer).toBe('silk');
    expect(model.polys[0].pts).toHaveLength(3);
  });

  it('derives a circle radius from center→rim distance', () => {
    // center (-1.05, 0.80), rim (-1.02, 0.80) → r = 0.03.
    expect(model.circles[0].r).toBeCloseTo(0.03, 4);
  });

  it('computes a finite bbox that covers the pads', () => {
    expect(isFiniteBbox(model.bbox)).toBe(true);
    // Pad 1 left edge ≈ -0.7501 - 0.14 = -0.8901; courtyard reaches -1.05.
    expect(model.bbox.minX).toBeLessThanOrEqual(-1.0499);
    expect(model.bbox.maxX).toBeGreaterThanOrEqual(1.05 - 1e-6);
  });

  it('returns null for non-footprint text', () => {
    expect(parseFootprint('(kicad_symbol_lib (symbol "X"))')).toBeNull();
    expect(parseFootprint('not an s-expr')).toBeNull();
    expect(parseFootprint('')).toBeNull();
  });

  it('accepts the legacy (module …) root', () => {
    const legacy = parseFootprint('(module "R0603" (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))');
    expect(legacy).not.toBeNull();
    expect(legacy!.pads).toHaveLength(1);
  });

  it('parses a custom pad with a gr_poly primitive into a polygon outline', () => {
    const custom = parseFootprint(
      '(footprint "X" (pad "1" smd custom (at 1 2) (size 0.01 0.01) (layers "F.Cu") (primitives (gr_poly (pts (xy -0.5 -0.5) (xy 0.5 -0.5) (xy 0.5 0.5) (xy -0.5 0.5)) (width 0.1)))))',
    )!;
    const pad = custom.pads[0];
    expect(pad.shape).toBe('custom');
    expect(pad.poly).toHaveLength(4);
    // Placeholder size replaced by polygon extent (1×1).
    expect(pad.w).toBeCloseTo(1, 4);
    expect(pad.h).toBeCloseTo(1, 4);
  });
});

describe('bbox helpers', () => {
  it('starts empty and is not finite until grown', () => {
    const b = emptyBbox();
    expect(isFiniteBbox(b)).toBe(false);
    growBbox(b, 2, 3);
    growBbox(b, -1, -4);
    expect(isFiniteBbox(b)).toBe(true);
    expect(b).toMatchObject({ minX: -1, minY: -4, maxX: 2, maxY: 3 });
  });

  it('ignores non-finite points', () => {
    const b = emptyBbox();
    growBbox(b, NaN, 5);
    growBbox(b, Infinity, 5);
    expect(isFiniteBbox(b)).toBe(false);
    growBbox(b, 1, 1);
    expect(b).toMatchObject({ minX: 1, maxX: 1, minY: 1, maxY: 1 });
  });
});
