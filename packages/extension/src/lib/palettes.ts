/**
 * Colour combinations the user can pick in Settings: a main colour (Install,
 * Search, the house mark) and an accent (whatever is selected or highlighted).
 * Status colours (green ok, honey "check", plum error) never change, so
 * they always mean the same thing. Pure and DOM-free; contrast is unit-tested.
 */

export type Scheme = 'light' | 'dark';

export interface PaletteColours {
  /** Main action: a pastel field and the dark ink on it. */
  main: string;
  mainInk: string;
  /** Accent for selected things: solid, text on wash, and the wash itself. */
  accent: string;
  accentInk: string;
  accentWash: string;
  /** Three stops for the soft 3D tile, top to bottom. */
  tile: [string, string, string];
  /** The house mark's tile. */
  markTile: string;
  /** Hue (OKLCH degrees) for ground, surfaces and ink. Defaults to the main colour's hue. */
  hue?: number;
}

export interface Palette {
  id: string;
  name: string;
  light: PaletteColours;
  dark: PaletteColours;
}

export const PALETTES: readonly Palette[] = [
  {
    id: 'apple',
    name: 'Apple',
    light: { main: '#c8e4a2', mainInk: '#1f3a1c', accent: '#8a5a3b', accentInk: '#6b4126', accentWash: '#f1e5d8', tile: ['#f6f8ee', '#dcebb4', '#a9d38c'], markTile: '#b5d98f' },
    dark: { main: '#d2e9ab', mainInk: '#16261b', accent: '#d9b08c', accentInk: '#e7c8aa', accentWash: '#4b3e2f', tile: ['#22301f', '#3d6b3c', '#6c9a45'], markTile: '#a9d38c', hue: 150 },
  },
  {
    id: 'lake',
    name: 'Lake',
    light: { main: '#bed0f4', mainInk: '#1b2d5e', accent: '#d06e58', accentInk: '#9a3a26', accentWash: '#f9e1d9', tile: ['#f0f4fc', '#cddbf6', '#a8c0f0'], markTile: '#a3bcef' },
    dark: { main: '#b9cdf6', mainInk: '#101a33', accent: '#f4a28e', accentInk: '#f8bcab', accentWash: '#553a31', tile: ['#1f2d55', '#2d4888', '#4466bd'], markTile: '#8eaaea' },
  },
  {
    id: 'moss',
    name: 'Moss',
    light: { main: '#d4e0aa', mainInk: '#2b3912', accent: '#7a9335', accentInk: '#48600c', accentWash: '#eef3d6', tile: ['#f1f4e6', '#d8e3b0', '#b2c67e'], markTile: '#b2c67e' },
    dark: { main: '#dbe7b0', mainInk: '#1e2a10', accent: '#c4dc6a', accentInk: '#d6e893', accentWash: '#46542b', tile: ['#1e2e1f', '#344f2f', '#5b7a3a'], markTile: '#a3bd62' },
  },
  {
    id: 'mist',
    name: 'Mist',
    light: { main: '#cfe3df', mainInk: '#163c37', accent: '#3c988b', accentInk: '#0d5f57', accentWash: '#dcf0ec', tile: ['#f1f5f4', '#d3e6e1', '#a6cdc5'], markTile: '#8fc4ba' },
    dark: { main: '#cbe6e0', mainInk: '#122824', accent: '#6fd0c2', accentInk: '#97e0d5', accentWash: '#2c4c47', tile: ['#1b2725', '#24433f', '#2f6a61'], markTile: '#5fbfb1' },
  },
  {
    id: 'peach',
    name: 'Peach',
    light: { main: '#f5d0bb', mainInk: '#5a2412', accent: '#3e96a1', accentInk: '#145761', accentWash: '#d9eef0', tile: ['#fbf1ea', '#f2d3be', '#e4ac8a'], markTile: '#eab394' },
    dark: { main: '#f4c7ae', mainInk: '#2a140c', accent: '#86d2dc', accentInk: '#a8e0e7', accentWash: '#2c4b50', tile: ['#3a2418', '#6a3a24', '#a85d38'], markTile: '#e0a07c' },
  },
];

export const DEFAULT_PALETTE_ID = 'apple';

export function findPalette(id: unknown): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** A small house on a coloured tile, as a CSS url(). */
export function houseMark(tile: string, wall: string, roof: string): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
    `<rect width='16' height='16' rx='4' fill='${tile}'/><rect x='4' y='8' width='8' height='5' fill='${wall}'/>` +
    `<path d='M3 8.4 8 4l5 4.4z' fill='${roof}'/><rect x='7' y='10' width='2' height='3' fill='${roof}'/></svg>`;
  return `url("data:image/svg+xml;utf8,${svg.replace(/#/g, '%23')}")`;
}

// --- OKLCH ---------------------------------------------------------------------

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** A hex colour as OKLCH: lightness 0..1, chroma, hue in degrees. */
export function hexToOklch(hex: string): [number, number, number] {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(n.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** OKLCH to hex. Chroma is reduced until the colour fits in sRGB. */
export function oklchToHex(L: number, C: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  for (let c = C; ; c *= 0.9) {
    const A = c * Math.cos(rad);
    const B = c * Math.sin(rad);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (c < 1e-4 || rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      return (
        '#' +
        rgb
          .map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.max(0, v)))) * 255).toString(16).padStart(2, '0'))
          .join('')
      );
    }
  }
}

/**
 * Ground, surfaces and ink, as [lightness, chroma] in OKLCH. Each takes the
 * main colour's hue, so the whole panel is one colour family: Lake is a blue
 * paper, Peach a warm one. Levels were measured from the original Apple set.
 */
const NEUTRALS: Record<Scheme, Record<string, [number, number]>> = {
  light: {
    '--bg': [0.958, 0.014],
    '--surface-1': [0.988, 0.008],
    '--surface-2': [0.958, 0.016],
    '--surface-3': [0.931, 0.022],
    '--text': [0.259, 0.03],
    '--text-dim': [0.417, 0.028],
    '--text-faint': [0.47, 0.025],
    groundTop: [0.976, 0.012],
    groundBottom: [0.948, 0.02],
  },
  dark: {
    '--bg': [0.321, 0.026],
    '--surface-1': [0.359, 0.027],
    '--surface-2': [0.396, 0.028],
    '--surface-3': [0.438, 0.03],
    '--text': [0.955, 0.014],
    '--text-dim': [0.872, 0.022],
    '--text-faint': [0.804, 0.026],
    groundTop: [0.342, 0.03],
    groundBottom: [0.302, 0.024],
  },
};

/** How strongly the main colour glows in the ground's top corner. */
const GROUND_GLOW: Record<Scheme, number> = { light: 34, dark: 16 };

/** Ground, surface and ink colours for one palette and scheme, as hex. */
export function neutrals(palette: Palette, scheme: Scheme): Record<string, string> {
  const c = palette[scheme];
  const hue = c.hue ?? hexToOklch(c.main)[2];
  return Object.fromEntries(
    Object.entries(NEUTRALS[scheme]).map(([name, [L, C]]) => [name, oklchToHex(L, C, hue)]),
  );
}

/** The CSS custom properties a palette sets for one scheme. */
export function paletteVars(palette: Palette, scheme: Scheme): Record<string, string> {
  const c = palette[scheme];
  const n = neutrals(palette, scheme);
  const wall = scheme === 'light' ? '#f8faf4' : '#ecf2e6';
  return {
    '--bg': n['--bg'],
    '--surface-1': n['--surface-1'],
    '--surface-2': n['--surface-2'],
    '--surface-3': n['--surface-3'],
    '--text': n['--text'],
    '--text-dim': n['--text-dim'],
    '--text-faint': n['--text-faint'],
    '--line': `color-mix(in oklab, ${n['--text']} 13%, transparent)`,
    '--line-strong': `color-mix(in oklab, ${n['--text']} 32%, transparent)`,
    // One colour only: a soft glow of the main colour over a wash of its hue.
    '--ground':
      `radial-gradient(75% 40% at 100% 0% in oklab, color-mix(in oklab, ${c.main} ${GROUND_GLOW[scheme]}%, transparent), transparent 70%), ` +
      `linear-gradient(180deg in oklab, ${n.groundTop} 0%, ${n['--bg']} 45%, ${n.groundBottom} 100%)`,
    '--btn-primary': c.main,
    '--btn-primary-ink': c.mainInk,
    '--accent': c.accent,
    '--accent-edge': c.accent,
    '--accent-bright': c.accentInk,
    '--accent-ink': c.accentInk,
    '--accent-wash': c.accentWash,
    '--tile': `linear-gradient(180deg in oklab, ${c.tile[0]} 0%, ${c.tile[1]} 55%, ${c.tile[2]} 100%)`,
    '--mark': houseMark(c.markTile, wall, c.accent),
  };
}

// --- Contrast (WCAG 2) -------------------------------------------------------

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(n.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Blend white over a colour, as the misty top of a block does. */
export function mistOver(hex: string, alpha: number): string {
  const n = hex.replace('#', '');
  return (
    '#' +
    [0, 2, 4]
      .map((i) => Math.round(parseInt(n.slice(i, i + 2), 16) * (1 - alpha) + 255 * alpha).toString(16).padStart(2, '0'))
      .join('')
  );
}
