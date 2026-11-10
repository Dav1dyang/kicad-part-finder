import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE_ID,
  PALETTES,
  contrast,
  findPalette,
  hexToOklch,
  mistOver,
  neutrals,
  oklchToHex,
  paletteVars,
} from '../palettes';

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
      const n = neutrals(palette, scheme);
      // Card and field surfaces, derived from this palette.
      const SURFACES = { [scheme]: [n['--surface-1'], n['--surface-2']] } as Record<typeof scheme, string[]>;
      describe(`${palette.name} ${scheme}`, () => {
        it('body text and secondary text read at 4.5:1 on the ground and every surface', () => {
          for (const bg of ['--bg', '--surface-1', '--surface-2', '--surface-3']) {
            expect(contrast(n['--text'], n[bg])).toBeGreaterThanOrEqual(4.5);
            expect(contrast(n['--text-dim'], n[bg])).toBeGreaterThanOrEqual(4.5);
          }
          for (const bg of ['--bg', '--surface-1', '--surface-2']) {
            expect(contrast(n['--text-faint'], n[bg])).toBeGreaterThanOrEqual(4.5);
          }
        });
        it('ground and surfaces take the main colour\'s hue', () => {
          const want = c.hue ?? hexToOklch(c.main)[2];
          for (const name of ['--bg', '--surface-2', '--surface-3']) {
            const [, chroma, hue] = hexToOklch(n[name]);
            expect(chroma).toBeGreaterThan(0.008);
            expect(Math.abs(((hue - want + 540) % 360) - 180)).toBeLessThan(12);
          }
        });
        it('the ground uses the main colour only, never the accent', () => {
          const ground = paletteVars(palette, scheme)['--ground'];
          expect(ground).toContain(c.main);
          expect(ground).not.toContain(c.accent);
        });
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

  it('round-trips colours through OKLCH', () => {
    for (const hex of ['#c8e4a2', '#bed0f4', '#2a372c', '#ffffff', '#000000', '#d06e58']) {
      expect(oklchToHex(...hexToOklch(hex))).toBe(hex);
    }
  });

  it('pulls out-of-gamut colours back into sRGB', () => {
    expect(oklchToHex(0.9, 0.4, 264)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps Apple identical to the original stylesheet', () => {
    expect(neutrals(findPalette('apple'), 'dark')['--bg']).toBe('#2a372c');
    expect(neutrals(findPalette('apple'), 'light')['--surface-1']).toBe('#fafcf6');
  });

  it('gives Lake a blue ground, not a green one', () => {
    const [, , hue] = hexToOklch(neutrals(findPalette('lake'), 'light')['--bg']);
    expect(hue).toBeGreaterThan(240);
    expect(hue).toBeLessThan(290);
  });

  it('sets the variables the stylesheet reads', () => {
    const vars = paletteVars(findPalette('lake'), 'light');
    expect(vars['--btn-primary']).toBe('#bed0f4');
    expect(vars['--accent']).toBe(findPalette('lake').light.accent);
    expect(vars['--tile']).toMatch(/^linear-gradient\(180deg in oklab, #f0f4fc 0%/);
    expect(vars['--mark']).toMatch(/^url\("data:image\/svg\+xml;utf8,.*%23a3bcef/);
    expect(vars['--mark']).not.toContain('#');
  });
});
