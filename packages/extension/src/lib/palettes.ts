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
    dark: { main: '#d2e9ab', mainInk: '#16261b', accent: '#d9b08c', accentInk: '#e7c8aa', accentWash: '#4b3e2f', tile: ['#22301f', '#3d6b3c', '#6c9a45'], markTile: '#a9d38c' },
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

/** The CSS custom properties a palette sets for one scheme. */
export function paletteVars(palette: Palette, scheme: Scheme): Record<string, string> {
  const c = palette[scheme];
  const wall = scheme === 'light' ? '#f8faf4' : '#ecf2e6';
  return {
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
