import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, PALETTES, contrast, findPalette, mistOver, paletteVars } from '../palettes';

// Card and field surfaces from styles.css, per scheme.
const SURFACES = { light: ['#fafcf6', '#eff3e8'], dark: ['#334136', '#3c4b3f'] } as const;
// The misty top of a block, per scheme (see --mist in styles.css).
const MIST = { light: 0.6, dark: 0.1 } as const;
const BUTTON_MIST = 0.16;

describe('palettes', () => {
  it('has a default and unique ids', () => {
    expect(findPalette(DEFAULT_PALETTE_ID).id).toBe(DEFAULT_PALETTE_ID);
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(PALETTES.length);
  });

  it('falls back to the default for unknown or missing ids', () => {
    expect(findPalette('nope').id).toBe(DEFAULT_PALETTE_ID);
    expect(findPalette(undefined).id).toBe(DEFAULT_PALETTE_ID);
  });

  for (const palette of PALETTES) {
    for (const scheme of ['light', 'dark'] as const) {
      const c = palette[scheme];
      describe(`${palette.name} ${scheme}`, () => {
        it('button text reads at 4.5:1, also under its faint mist', () => {
          expect(contrast(c.mainInk, c.main)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(c.mainInk, mistOver(c.main, BUTTON_MIST))).toBeGreaterThanOrEqual(4.5);
        });
        it('accent text reads at 4.5:1 on its wash, also under the mist', () => {
          expect(contrast(c.accentInk, c.accentWash)).toBeGreaterThanOrEqual(4.5);
          if (scheme === 'dark') expect(contrast(c.accentInk, mistOver(c.accentWash, MIST.dark))).toBeGreaterThanOrEqual(4.5);
        });
        it('accent marks (radio dots, switches, icons) reach 3:1 on cards', () => {
          for (const surface of SURFACES[scheme]) expect(contrast(c.accent, surface)).toBeGreaterThanOrEqual(3);
        });
        it('the main field is visibly distinct from cards; its label carries the contrast', () => {
          for (const surface of SURFACES[scheme]) expect(contrast(c.main, surface)).toBeGreaterThanOrEqual(1.15);
        });
      });
    }
  }

  it('sets the variables the stylesheet reads', () => {
    const vars = paletteVars(findPalette('lake'), 'light');
    expect(vars['--btn-primary']).toBe('#bed0f4');
    expect(vars['--accent']).toBe(findPalette('lake').light.accent);
    expect(vars['--tile']).toMatch(/^linear-gradient\(180deg in oklab, #f0f4fc 0%/);
    expect(vars['--mark']).toMatch(/^url\("data:image\/svg\+xml;utf8,.*%23a3bcef/);
    expect(vars['--mark']).not.toContain('#');
  });
});
