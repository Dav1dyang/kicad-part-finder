/**
 * Unit tests for the symbol preview's pure parser.
 *
 * DOM-free: exercises {@link parseSymbol} only (rendering needs a DOM). The
 * fixture is trimmed from the converter's real `.kicad_sym` output for C3235557
 * (TPS2116) — a body rectangle + a polarity circle + a couple of pins.
 */
import { describe, it, expect } from 'vitest';
import { parseSymbol } from '../preview-symbol.js';
import { isFiniteBbox } from '../preview-svg.js';

const SYMBOL = `(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)
  (symbol "TPS2116DRLR" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
    (property "Reference" "U" (id 0) (at 0 2.54 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Value" "TPS2116DRLR" (id 1) (at 0 -2.54 0)
      (effects (font (size 1.27 1.27)))
    )
    (symbol "TPS2116DRLR_0_1"
      (rectangle (start -8.8900 6.3500) (end 8.8900 -6.3500)
        (stroke (width 0.254) (type default) (color 0 0 0 0))
        (fill (type none))
      )
      (circle (center -7.6200 5.0800) (radius 0.3810)
        (stroke (width 0.254) (type default) (color 0 0 0 0))
        (fill (type none))
      )
      (polyline (pts (xy -8 0) (xy -6 0) (xy -6 2)) (stroke (width 0.2) (type default)) (fill (type none)))
    )
    (symbol "TPS2116DRLR_1_1"
      (pin passive line (at -11.4300 3.8100 0) (length 2.5400)
        (name "GND" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))
      )
      (pin passive line (at 11.4300 3.8100 180) (length 2.5400)
        (name "ST" (effects (font (size 1.27 1.27))))
        (number "8" (effects (font (size 1.27 1.27))))
      )
    )
  )
)`;

describe('parseSymbol', () => {
  const model = parseSymbol(SYMBOL)!;

  it('parses a symbol library and names the part (not the _0_1 sub-symbol)', () => {
    expect(model).not.toBeNull();
    expect(model.name).toBe('TPS2116DRLR');
  });

  it('reads the body rectangle', () => {
    expect(model.rects).toHaveLength(1);
    expect(model.rects[0]).toMatchObject({ x1: -8.89, y1: 6.35, x2: 8.89, y2: -6.35 });
  });

  it('reads circles and polylines', () => {
    expect(model.circles).toHaveLength(1);
    expect(model.circles[0]).toMatchObject({ cx: -7.62, cy: 5.08, r: 0.381 });
    expect(model.polylines).toHaveLength(1);
    expect(model.polylines[0].pts).toHaveLength(3);
  });

  it('reads pins with position, angle, length, name, number', () => {
    expect(model.pins).toHaveLength(2);
    expect(model.pins[0]).toMatchObject({
      x: -11.43,
      y: 3.81,
      angle: 0,
      length: 2.54,
      name: 'GND',
      number: '1',
    });
    expect(model.pins[1]).toMatchObject({ angle: 180, name: 'ST', number: '8' });
  });

  it('computes a finite bbox spanning the body + pin tips', () => {
    expect(isFiniteBbox(model.bbox)).toBe(true);
    expect(model.bbox.minX).toBeLessThanOrEqual(-11.43);
    expect(model.bbox.maxX).toBeGreaterThanOrEqual(11.43);
  });

  it('accepts a bare (symbol …) root, not just a full library', () => {
    const bare = parseSymbol('(symbol "X_0_1" (rectangle (start -1 1) (end 1 -1)))');
    expect(bare).not.toBeNull();
    expect(bare!.rects).toHaveLength(1);
  });

  it('returns null for non-symbol text', () => {
    expect(parseSymbol('(footprint "X")')).toBeNull();
    expect(parseSymbol('garbage')).toBeNull();
    expect(parseSymbol('')).toBeNull();
  });
});
