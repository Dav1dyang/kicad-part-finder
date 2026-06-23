// Adapted from hulryung/easyeda2kicad-web (MIT per its README). https://github.com/hulryung/easyeda2kicad-web
//
// Pure-JS EasyEDA -> KiCad footprint + symbol converter. Vendored verbatim from
// the upstream `lib/kicad-parser.ts`; the only change is the type import path
// (`@/types/easyeda` -> `./types`). No React, no Node-only APIs — safe to run in
// a browser service worker. See ../../../THIRD_PARTY.md for attribution.

import { KiCadPinType, ParsedFootprint, ParsedSchematic } from './types';

// Safe parseFloat that returns a default value if NaN
function safeParseFloat(value: string | undefined, defaultValue: number = 0): number {
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

// Extract 3D model UUID from SVGNODE in shape data
export function extract3DModelUUID(dataStr: string | any): string | null {
  try {
    let data = dataStr;
    if (typeof dataStr === 'string') {
      data = JSON.parse(dataStr);
    }

    if (data.shape && Array.isArray(data.shape)) {
      for (const shape of data.shape) {
        let shapeStr: string;
        if (typeof shape === 'string') {
          shapeStr = shape;
        } else if (shape.gge) {
          shapeStr = shape.gge;
        } else {
          continue;
        }

        if (shapeStr.startsWith('SVGNODE')) {
          const parts = shapeStr.split('~');
          if (parts.length > 1) {
            try {
              const svgData = JSON.parse(parts[1]);
              if (svgData.attrs && svgData.attrs.uuid) {
                return svgData.attrs.uuid;
              }
            } catch (e) {
              // Continue to next shape if JSON parse fails
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error extracting 3D model UUID:', error);
  }

  return null;
}

export function parseEasyEDAFootprint(dataStr: string | any): ParsedFootprint {
  const footprint: ParsedFootprint = {
    name: '',
    pads: [],
    lines: [],
    circles: [],
    arcs: [],
    texts: [],
    solidRegions: [],
  };

  try {
    // Handle both cases where dataStr is already an object or a string
    let data = dataStr;
    if (typeof dataStr === 'string') {
      data = JSON.parse(dataStr);
    }

    if (data.head?.c_para?.package) {
      footprint.name = data.head.c_para.package;
    }

    // Extract origin from head (used by easyeda2kicad.py for coordinate normalization)
    if (data.head?.x !== undefined) {
      footprint.originX = parseFloat(data.head.x);
    }
    if (data.head?.y !== undefined) {
      footprint.originY = parseFloat(data.head.y);
    }

    if (data.shape && Array.isArray(data.shape)) {
      for (const shape of data.shape) {
        // When shape is a string (e.g., "PAD~RECT~...")
        let parts: string[];
        if (typeof shape === 'string') {
          parts = shape.split('~');
        } else if (shape.gge) {
          // When shape is an object and has a gge property
          parts = shape.gge.split('~');
        } else {
          continue;
        }

        const type = parts[0];

        switch (type) {
          case 'PAD':
            footprint.pads.push(parsePad(parts));
            break;
          case 'TRACK':
            // TRACK can have multiple points, create line segments
            const trackLines = parseTrack(parts);
            footprint.lines.push(...trackLines);
            break;
          case 'CIRCLE':
            footprint.circles.push(parseCircle(parts));
            break;
          case 'ARC':
            footprint.arcs.push(parseArc(parts));
            break;
          case 'TEXT':
            footprint.texts.push(parseText(parts));
            break;
          case 'SOLIDREGION':
            footprint.solidRegions.push(parseSolidRegion(parts));
            break;
        }
      }
    }
  } catch (error) {
    console.error('Error parsing footprint:', error);
  }

  return footprint;
}

function parsePad(parts: string[]) {
  // EasyEDA PAD format (easyeda2kicad.py EeFootprintPad, 18 fields after "PAD~"):
  // shape, center_x, center_y, width, height, layer_id, net, number, hole_radius,
  // points, rotation, id, hole_length, slot_outline, is_plated, is_locked, (...)
  // After split, parts[0]="PAD", so fields shift by +1.
  const shape = parts[1] || 'RECT';
  const x = safeParseFloat(parts[2]);
  const y = safeParseFloat(parts[3]);
  const width = safeParseFloat(parts[4]);
  const height = safeParseFloat(parts[5]);
  const layerId = parseInt(parts[6] || '1', 10) || 1;
  const number = parts[8] || '';
  const holeRadius = safeParseFloat(parts[9]) || 0;
  const points = parts[10] || '';
  const rotation = safeParseFloat(parts[11]) || 0;
  const holeLength = safeParseFloat(parts[13]) || 0;

  // Determine type by hole_radius (matches easyeda2kicad.py behavior)
  const type = holeRadius > 0 ? 'through-hole' : 'smd';

  return {
    number,
    type,
    shape: shape.toUpperCase(),
    x,
    y,
    width,
    height,
    drill: holeRadius > 0 ? holeRadius * 2 : undefined,
    holeLength: holeLength > 0 ? holeLength : undefined,
    rotation,
    layerId,
    points,
  };
}

function parseTrack(parts: string[]) {
  // EasyEDA TRACK format: TRACK~width~layer~~x1 y1 x2 y2 ...~id~...
  // TRACK can be a polyline with multiple points
  const width = safeParseFloat(parts[1]);
  const layer = parts[2] || '1';

  // Coordinates are in parts[4] as space-separated values
  const coords = (parts[4] || '').trim().split(/\s+/);
  const lines = [];

  // Create line segments from consecutive points
  // Each pair of (x, y) coordinates represents a point
  for (let i = 0; i < coords.length - 2; i += 2) {
    const x1 = safeParseFloat(coords[i]);
    const y1 = safeParseFloat(coords[i + 1]);
    const x2 = safeParseFloat(coords[i + 2]);
    const y2 = safeParseFloat(coords[i + 3]);

    if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
      lines.push({
        x1,
        y1,
        x2,
        y2,
        width,
        layer,
      });
    }
  }

  // If no valid lines were created, return empty array
  return lines.length > 0 ? lines : [{
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    width,
    layer,
  }];
}

function parseCircle(parts: string[]) {
  return {
    x: safeParseFloat(parts[1]),
    y: safeParseFloat(parts[2]),
    radius: safeParseFloat(parts[3]),
    width: safeParseFloat(parts[4]),
    layer: parts[5] || '1',
  };
}

function parseArc(parts: string[]) {
  return {
    x: safeParseFloat(parts[2]),
    y: safeParseFloat(parts[3]),
    startX: safeParseFloat(parts[4]),
    startY: safeParseFloat(parts[5]),
    angle: safeParseFloat(parts[6]),
    width: safeParseFloat(parts[1]),
    layer: parts[7] || '1',
  };
}

function parseText(parts: string[]) {
  return {
    text: parts[1] || '',
    x: safeParseFloat(parts[2]),
    y: safeParseFloat(parts[3]),
    size: safeParseFloat(parts[5], 12),
    layer: parts[6] || '1',
  };
}

function parseSolidRegion(parts: string[]) {
  // EasyEDA SOLIDREGION format: SOLIDREGION~layer~unused~path~fill_type~id~...
  return {
    layer: parts[1] || '1',
    path: parts[3] || '', // SVG path data
    fillType: parts[4] || 'solid',
  };
}

export function convertMillToPixels(mm: number, scale: number = 10): number {
  return mm * scale;
}

// Convert EasyEDA coordinates to KiCad mm (EasyEDA uses 10mil units)
function convertToKiCadMm(easyedaValue: number): number {
  return easyedaValue * 0.254; // 10mil to mm conversion
}

// Mirrors easyeda2kicad.py KI_LAYERS (parameters_kicad_footprint.py).
// Layer 11 is "Multi-Layer" — only valid for pads (see KI_PAD_LAYER below),
// so it's intentionally absent here.
const KI_LAYERS: Record<number, string> = {
  1: 'F.Cu',
  2: 'B.Cu',
  3: 'F.SilkS',
  4: 'B.SilkS',
  5: 'F.Paste',
  6: 'B.Paste',
  7: 'F.Mask',
  8: 'B.Mask',
  10: 'Edge.Cuts',
  12: 'Cmts.User',
  13: 'F.Fab',
  14: 'B.Fab',
  15: 'Dwgs.User',
  99: 'F.CrtYd',
  100: 'F.Fab',
  101: 'F.SilkS',
};

const KI_PAD_LAYER: Record<number, string> = {
  1: 'F.Cu F.Paste F.Mask',
  2: 'B.Cu B.Paste B.Mask',
  3: 'F.SilkS',
  11: '*.Cu *.Paste *.Mask',
  13: 'F.Fab',
  15: 'Dwgs.User',
};

const KI_PAD_LAYER_THT: Record<number, string> = {
  1: 'F.Cu F.Mask',
  2: 'B.Cu B.Mask',
  3: 'F.SilkS',
  11: '*.Cu *.Mask',
  13: 'F.Fab',
  15: 'Dwgs.User',
};

const KI_PAD_SHAPE: Record<string, string> = {
  ELLIPSE: 'circle',
  RECT: 'rect',
  OVAL: 'oval',
  POLYGON: 'custom',
};

function convertLayer(layerId: string | number): string {
  const id = typeof layerId === 'number' ? layerId : parseInt(layerId, 10);
  return KI_LAYERS[id] ?? 'F.Fab';
}

// Matches easyeda2kicad.py angle_to_ki: normalizes rotation to (-180, 180].
function angleToKi(rotation: number): number {
  if (isNaN(rotation)) return 0;
  return rotation > 180 ? -(360 - rotation) : rotation;
}

// Layers on which SOLIDREGION is imported (mirrors easyeda2kicad.py).
// Layer 99 (ComponentShapeLayer) renders as F.CrtYd outline; others as filled fp_poly.
// Layers 100 (lead shapes), 101 (polarity), 5/6 (paste) are intentionally skipped.
const SOLID_REGION_LAYERS = new Set<number>([3, 4, 13, 14, 99]);

// Parse an EasyEDA SOLIDREGION SVG path into mm points relative to (originX, originY).
// Supports M, L, H, V, A (arc endpoint only), Z — same coverage as
// easyeda2kicad.py _parse_solid_region_path.
function parseSolidRegionPath(path: string, originX: number, originY: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let curX = 0;
  let curY = 0;
  const tokens = path.trim().split(/(?=[MLHVAZmlhvaz])/);
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    const cmd = token[0];
    const args = token
      .slice(1)
      .trim()
      .split(/[,\s]+/)
      .filter(Boolean);
    if (cmd === 'M' && args.length >= 2) {
      curX = parseFloat(args[0]);
      curY = parseFloat(args[1]);
      points.push([convertToKiCadMm(curX - originX), convertToKiCadMm(curY - originY)]);
    } else if (cmd === 'L' && args.length >= 2) {
      curX = parseFloat(args[0]);
      curY = parseFloat(args[1]);
      points.push([convertToKiCadMm(curX - originX), convertToKiCadMm(curY - originY)]);
    } else if (cmd === 'H' && args.length >= 1) {
      curX = parseFloat(args[0]);
      points.push([convertToKiCadMm(curX - originX), convertToKiCadMm(curY - originY)]);
    } else if (cmd === 'V' && args.length >= 1) {
      curY = parseFloat(args[0]);
      points.push([convertToKiCadMm(curX - originX), convertToKiCadMm(curY - originY)]);
    } else if (cmd === 'A' && args.length >= 7) {
      curX = parseFloat(args[5]);
      curY = parseFloat(args[6]);
      points.push([convertToKiCadMm(curX - originX), convertToKiCadMm(curY - originY)]);
    } else if (cmd === 'Z' && points.length > 0) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        points.push([first[0], first[1]]);
      }
    }
  }
  return points;
}

// Matches easyeda2kicad.py drill_to_ki for oval slots.
function drillToKi(holeRadius: number, holeLength: number | undefined, padHeight: number, padWidth: number): string {
  if (holeRadius <= 0) return '';
  if (holeLength && holeLength !== 0) {
    const maxDistanceHole = Math.max(holeRadius * 2, holeLength);
    const pos0 = padHeight - maxDistanceHole;
    const pos90 = padWidth - maxDistanceHole;
    if (pos0 >= pos90) {
      return ` (drill oval ${(holeRadius * 2).toFixed(4)} ${holeLength.toFixed(4)})`;
    }
    return ` (drill oval ${holeLength.toFixed(4)} ${(holeRadius * 2).toFixed(4)})`;
  }
  return ` (drill ${(holeRadius * 2).toFixed(4)})`;
}

/**
 * Component metadata the symbol exporter stamps into KiCad properties. Mirrors
 * the relevant subset of {@link ConvertMeta} (in easyeda.ts) but kept local so
 * kicad-parser.ts stays free of any cross-module/runtime dependency.
 */
export interface SymbolMeta {
  mpn?: string;
  manufacturer?: string;
  datasheet?: string;
  lcsc?: string;
  package?: string;
}

// KiCad symbols live on a 50mil grid. 50mil = 1.27mm; in raw EasyEDA units
// (10mil pixels) that's 5 px. Snapping the normalization origin to 5 px and the
// pin coordinates to 1.27mm keeps everything on-grid in the schematic editor.
const SYMBOL_GRID_MM = 1.27;
const EASYEDA_GRID_PX = 5;

/** Round a millimetre value to the nearest KiCad 50mil (1.27mm) grid step. */
function snapMmToGrid(mm: number): number {
  return Math.round(mm / SYMBOL_GRID_MM) * SYMBOL_GRID_MM;
}

/** Escape characters that would break a KiCad quoted string. */
function escapeKiStr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Sanitize a string for use as a KiCad symbol/library id. KiCad forbids quotes,
 * parens, and whitespace in a symbol name; collapse anything unsafe to '_'.
 */
function sanitizeSymbolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.+-]/g, '_');
}

/**
 * Compute the normalization origin (in raw EasyEDA units) to subtract from every
 * symbol coordinate so the body ends up centered on the KiCad origin.
 *
 * Prefers EasyEDA's recorded canvas center (`head.x`/`head.y`, surfaced as
 * `schematic.bbox`), snapped to the 5px grid. When that's missing we fall back
 * to the center of the bounding box of the pins + rectangles so the symbol is
 * still re-centered rather than left at its raw ~400,300 offset.
 */
function computeSymbolOrigin(schematic: ParsedSchematic): { x: number; y: number } {
  if (schematic.bbox) {
    return {
      x: Math.round(schematic.bbox.x / EASYEDA_GRID_PX) * EASYEDA_GRID_PX,
      y: Math.round(schematic.bbox.y / EASYEDA_GRID_PX) * EASYEDA_GRID_PX,
    };
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const pin of schematic.pins) {
    if (Number.isFinite(pin.x)) xs.push(pin.x);
    if (Number.isFinite(pin.y)) ys.push(pin.y);
  }
  for (const rect of schematic.rectangles) {
    xs.push(rect.x, rect.x + rect.width);
    ys.push(rect.y, rect.y + rect.height);
  }
  if (xs.length === 0 || ys.length === 0) return { x: 0, y: 0 };

  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return {
    x: Math.round(cx / EASYEDA_GRID_PX) * EASYEDA_GRID_PX,
    y: Math.round(cy / EASYEDA_GRID_PX) * EASYEDA_GRID_PX,
  };
}

/**
 * Map an EasyEDA pin rotation to a KiCad pin orientation angle.
 *
 * KiCad's pin angle points from the pin's free endpoint back toward the body —
 * the opposite of EasyEDA's convention — so the two differ by 180 degrees:
 * EasyEDA 0->180, 90->270, 180->0, 270->90.
 */
function pinAngleToKi(rotation: number | undefined): number {
  const r = Number.isFinite(rotation) ? (rotation as number) : 0;
  return (((180 + r) % 360) + 360) % 360;
}

/**
 * Convert a parsed EasyEDA schematic symbol to KiCad `.kicad_sym` text.
 *
 * Milestone-4 polish vs. the original passthrough:
 *  - Reference prefix comes from EasyEDA `pre` (e.g. "U?"->"U"), default "U".
 *  - Value + symbol name = the MPN (not the package string).
 *  - Pins carry their real EasyEDA NAME text, a mapped electrical type, and a
 *    proper orientation; body + pins are normalized to the KiCad origin/grid.
 *  - Footprint / Datasheet / Manufacturer / MPN / LCSC properties are populated.
 *
 * @param schematic Parsed EasyEDA symbol (see {@link ParsedSchematic}).
 * @param meta Optional component metadata for the stamped properties.
 */
export function convertToKiCadSymbol(schematic: ParsedSchematic, meta: SymbolMeta = {}): string {
  const lines: string[] = [];

  // Value/name = MPN; fall back through the parsed MPN, then the package, then a
  // generic literal so we never emit an empty symbol name.
  const mpn = (meta.mpn || schematic.mpn || '').trim();
  const valueText = mpn || schematic.name || 'Symbol';
  const symbolName = sanitizeSymbolName(valueText) || 'Symbol';

  // Reference prefix from EasyEDA `pre` ("?" already stripped upstream); KiCad's
  // generic fallback designator is "U".
  const reference = (schematic.prefix || '').trim() || 'U';

  const origin = computeSymbolOrigin(schematic);
  // Convert a raw EasyEDA coordinate to KiCad mm relative to the origin. KiCad
  // inverts Y. `snap` rounds onto the 50mil grid (used for pins, not graphics).
  const kx = (v: number, snap = false): number => {
    const mm = convertToKiCadMm(v - origin.x);
    return snap ? snapMmToGrid(mm) : mm;
  };
  const ky = (v: number, snap = false): number => {
    const mm = -convertToKiCadMm(v - origin.y);
    return snap ? snapMmToGrid(mm) : mm;
  };

  lines.push('(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)');
  lines.push(`  (symbol "${escapeKiStr(symbolName)}" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)`);
  lines.push(`    (property "Reference" "${escapeKiStr(reference)}" (id 0) (at 0 2.54 0)`);
  lines.push('      (effects (font (size 1.27 1.27)))');
  lines.push('    )');
  lines.push(`    (property "Value" "${escapeKiStr(valueText)}" (id 1) (at 0 -2.54 0)`);
  lines.push('      (effects (font (size 1.27 1.27)))');
  lines.push('    )');
  lines.push(`    (property "Footprint" "${escapeKiStr(meta.package ?? '')}" (id 2) (at 0 0 0)`);
  lines.push('      (effects (font (size 1.27 1.27)) hide)');
  lines.push('    )');
  lines.push(`    (property "Datasheet" "${escapeKiStr(meta.datasheet ?? '')}" (id 3) (at 0 0 0)`);
  lines.push('      (effects (font (size 1.27 1.27)) hide)');
  lines.push('    )');

  // Extra (hidden) properties, only when the source value is non-empty.
  let propId = 4;
  const extraProps: Array<[string, string | undefined]> = [
    ['Manufacturer', meta.manufacturer],
    ['MPN', mpn || undefined],
    ['LCSC', meta.lcsc],
  ];
  for (const [name, value] of extraProps) {
    const v = (value ?? '').trim();
    if (!v) continue;
    lines.push(`    (property "${escapeKiStr(name)}" "${escapeKiStr(v)}" (id ${propId}) (at 0 0 0)`);
    lines.push('      (effects (font (size 1.27 1.27)) hide)');
    lines.push('    )');
    propId += 1;
  }

  // Symbol graphic items
  lines.push('    (symbol "' + escapeKiStr(symbolName) + '_0_1"');

  // Convert polylines
  schematic.polylines.forEach((polyline) => {
    if (polyline.points.length >= 2) {
      for (let i = 0; i < polyline.points.length - 1; i++) {
        const x1 = kx(polyline.points[i].x);
        const y1 = ky(polyline.points[i].y); // Y is inverted in KiCad
        const x2 = kx(polyline.points[i + 1].x);
        const y2 = ky(polyline.points[i + 1].y);
        const width = convertToKiCadMm(polyline.strokeWidth);

        lines.push(`      (polyline`);
        lines.push(`        (pts`);
        lines.push(`          (xy ${x1.toFixed(4)} ${y1.toFixed(4)})`);
        lines.push(`          (xy ${x2.toFixed(4)} ${y2.toFixed(4)})`);
        lines.push(`        )`);
        lines.push(`        (stroke (width ${width.toFixed(4)}) (type default) (color 0 0 0 0))`);
        lines.push(`        (fill (type none))`);
        lines.push(`      )`);
      }
    }
  });

  // Convert rectangles
  schematic.rectangles.forEach((rect) => {
    const x1 = kx(rect.x);
    const y1 = ky(rect.y);
    const x2 = kx(rect.x + rect.width);
    const y2 = ky(rect.y + rect.height);

    lines.push(`      (rectangle (start ${x1.toFixed(4)} ${y1.toFixed(4)}) (end ${x2.toFixed(4)} ${y2.toFixed(4)})`);
    lines.push(`        (stroke (width 0.254) (type default) (color 0 0 0 0))`);
    lines.push(`        (fill (type none))`);
    lines.push(`      )`);
  });

  // Convert circles
  schematic.circles.forEach((circle) => {
    const cx = kx(circle.x);
    const cy = ky(circle.y);
    const r = convertToKiCadMm(circle.radius);

    lines.push(`      (circle (center ${cx.toFixed(4)} ${cy.toFixed(4)}) (radius ${r.toFixed(4)})`);
    lines.push(`        (stroke (width 0.254) (type default) (color 0 0 0 0))`);
    lines.push(`        (fill (type none))`);
    lines.push(`      )`);
  });

  lines.push('    )');

  // Add pins
  if (schematic.pins && schematic.pins.length > 0) {
    lines.push('    (symbol "' + escapeKiStr(symbolName) + '_1_1"');

    schematic.pins.forEach((pin, index) => {
      const x = kx(pin.x, true);
      const y = ky(pin.y, true);
      const pinName = (pin.name && pin.name.trim()) || pin.number || '~';
      const pinNumber = pin.number || String(index + 1);
      const pinType: KiCadPinType = pin.electricType ?? 'passive';
      const angle = pinAngleToKi(pin.rotation);
      // Pin length from the EasyEDA path (in 10mil px), snapped to grid; default
      // to one grid step when EasyEDA gave nothing sane.
      const lengthMm = pin.length ? snapMmToGrid(convertToKiCadMm(pin.length)) : SYMBOL_GRID_MM;
      const length = lengthMm > 0 ? lengthMm : SYMBOL_GRID_MM;

      lines.push(`      (pin ${pinType} line (at ${x.toFixed(4)} ${y.toFixed(4)} ${angle}) (length ${length.toFixed(4)})`);
      lines.push(`        (name "${escapeKiStr(pinName)}" (effects (font (size 1.27 1.27))))`);
      lines.push(`        (number "${escapeKiStr(pinNumber)}" (effects (font (size 1.27 1.27))))`);
      lines.push(`      )`);
    });

    lines.push('    )');
  }

  lines.push('  )');
  lines.push(')');

  return lines.join('\n');
}

export function convertToKiCadFootprint(
  footprint: ParsedFootprint,
  originX?: number,
  originY?: number,
  lcscId?: string,
): string {
  const lines: string[] = [];

  // Keep the EasyEDA package name (dots and all) — matches easyeda2kicad.py,
  // which uses ee_data_info["package"] verbatim. Only strip characters that
  // would break KiCad s-expression parsing (quotes/parens).
  const footprintName = (footprint.name || 'Footprint').replace(/["()]/g, '_');

  // Default origin to head.x/head.y (in EU) if not supplied.
  const normOriginX = originX ?? 0;
  const normOriginY = originY ?? 0;

  // Reference/Value Y placement mirrors easyeda2kicad.py:
  //   y_low = min(pad.pos_y) - 4mm,  y_high = max(pad.pos_y) + 4mm
  // Pad positions here are in mm relative to origin (after convertToKiCadMm).
  const padYs: number[] = [];
  footprint.pads.forEach((pad) => {
    if (!isNaN(pad.y)) padYs.push(convertToKiCadMm(pad.y - normOriginY));
  });
  const yLow = padYs.length ? Math.min(...padYs) : 0;
  const yHigh = padYs.length ? Math.max(...padYs) : 0;
  const refY = yLow - 4;
  const valY = yHigh + 4;

  lines.push(`(footprint "${footprintName}" (version 20211014) (generator easyeda2kicad)`);
  lines.push('  (layer "F.Cu")');

  // Determine if SMD or through-hole
  const hasThroughHole = footprint.pads.some(pad => pad.type === 'through-hole');
  lines.push(`  (attr ${hasThroughHole ? 'through_hole' : 'smd'})`);

  // Reference / value / fab-ref texts (KI_REFERENCE / KI_PACKAGE_VALUE / KI_FAB_REF).
  lines.push(`  (fp_text reference "REF**" (at 0.000 ${refY.toFixed(3)}) (layer "F.SilkS")`);
  lines.push('    (effects (font (size 1 1) (thickness 0.15)))');
  lines.push('  )');

  lines.push(`  (fp_text value "${footprintName}" (at 0.000 ${valY.toFixed(3)}) (layer "F.Fab")`);
  lines.push('    (effects (font (size 1 1) (thickness 0.15)))');
  lines.push('  )');

  lines.push('  (fp_text user %R (at 0 0) (layer "F.Fab")');
  lines.push('    (effects (font (size 1 1) (thickness 0.15)))');
  lines.push('  )');

  if (lcscId) {
    lines.push(`  (property "LCSC Part" "${lcscId}")`);
  }

  // Add lines (silkscreen/fab)
  footprint.lines.forEach((line, i) => {
    const x1 = convertToKiCadMm(line.x1 - normOriginX);
    const y1 = convertToKiCadMm(line.y1 - normOriginY);
    const x2 = convertToKiCadMm(line.x2 - normOriginX);
    const y2 = convertToKiCadMm(line.y2 - normOriginY);
    const width = convertToKiCadMm(line.width);
    const layer = convertLayer(line.layer);

    lines.push(`  (fp_line (start ${x1.toFixed(4)} ${y1.toFixed(4)}) (end ${x2.toFixed(4)} ${y2.toFixed(4)}) (layer "${layer}") (width ${width.toFixed(4)}))`);
  });

  // Add circles
  footprint.circles.forEach((circle, i) => {
    const cx = convertToKiCadMm(circle.x - normOriginX);
    const cy = convertToKiCadMm(circle.y - normOriginY);
    const r = convertToKiCadMm(circle.radius);
    const width = convertToKiCadMm(circle.width);
    const layer = convertLayer(circle.layer);

    lines.push(`  (fp_circle (center ${cx.toFixed(4)} ${cy.toFixed(4)}) (end ${(cx + r).toFixed(4)} ${cy.toFixed(4)}) (layer "${layer}") (width ${width.toFixed(4)}))`);
  });

  // Add arcs
  footprint.arcs.forEach((arc, i) => {
    const cx = convertToKiCadMm(arc.x - normOriginX);
    const cy = convertToKiCadMm(arc.y - normOriginY);
    const startX = convertToKiCadMm(arc.startX - normOriginX);
    const startY = convertToKiCadMm(arc.startY - normOriginY);
    const width = convertToKiCadMm(arc.width);
    const layer = convertLayer(arc.layer);

    // Calculate end point based on angle
    const radius = Math.sqrt(Math.pow(arc.startX - arc.x, 2) + Math.pow(arc.startY - arc.y, 2));
    const startAngle = Math.atan2(arc.startY - arc.y, arc.startX - arc.x);
    const endAngle = startAngle + (arc.angle * Math.PI / 180);
    const endX = convertToKiCadMm((arc.x - normOriginX) + radius * Math.cos(endAngle));
    const endY = convertToKiCadMm((arc.y - normOriginY) + radius * Math.sin(endAngle));

    lines.push(`  (fp_arc (start ${startX.toFixed(4)} ${startY.toFixed(4)}) (mid ${cx.toFixed(4)} ${cy.toFixed(4)}) (end ${endX.toFixed(4)} ${endY.toFixed(4)}) (layer "${layer}") (width ${width.toFixed(4)}))`);
  });

  // Add pads
  footprint.pads.forEach((pad) => {
    const padType = pad.type === 'through-hole' ? 'thru_hole' : 'smd';
    const shape = KI_PAD_SHAPE[pad.shape] ?? 'custom';
    const isCustomShape = shape === 'custom';

    // Layer lookup mirrors easyeda2kicad.py (KI_PAD_LAYER / KI_PAD_LAYER_THT).
    // SMD uses *.Paste, THT omits it.
    const layerTable = pad.drill ? KI_PAD_LAYER_THT : KI_PAD_LAYER;
    const layers = layerTable[pad.layerId] ?? '';
    if (!layers) {
      // Unknown EasyEDA pad layer — skip rather than emit invalid KiCad.
      return;
    }

    // EasyEDA-mm-equivalent position (pad center relative to origin)
    const posX = convertToKiCadMm(pad.x - normOriginX);
    const posY = convertToKiCadMm(pad.y - normOriginY);
    let width = convertToKiCadMm(pad.width);
    let height = convertToKiCadMm(pad.height);
    let orientation = angleToKi(pad.rotation || 0);

    // Pad number normalization: EasyEDA sometimes uses "name(number)".
    let number = pad.number;
    if (number.includes('(') && number.includes(')')) {
      number = number.split('(')[1].split(')')[0];
    }

    let polygonClause = '';
    if (isCustomShape) {
      // Polygon points already have rotation baked in by EasyEDA.
      orientation = 0;
      width = 0.005;
      height = 0.005;
      const rawPoints = (pad.points || '').trim().split(/\s+/).filter(Boolean);
      const segments: string[] = [];
      for (let k = 0; k + 1 < rawPoints.length; k += 2) {
        const px = convertToKiCadMm(safeParseFloat(rawPoints[k]) - normOriginX) - posX;
        const py = convertToKiCadMm(safeParseFloat(rawPoints[k + 1]) - normOriginY) - posY;
        segments.push(`(xy ${px.toFixed(6)} ${py.toFixed(6)})`);
      }
      if (segments.length > 0) {
        polygonClause = ` (primitives (gr_poly (pts ${segments.join(' ')}) (width 0.1)))`;
      }
    }

    const drillClause = drillToKi(
      pad.drill ? convertToKiCadMm(pad.drill / 2) : 0,
      pad.holeLength ? convertToKiCadMm(pad.holeLength) : undefined,
      height,
      width,
    );

    // Quote each layer token for KiCad v6+ syntax.
    const layerTokens = layers.split(/\s+/).map((t) => `"${t}"`).join(' ');

    lines.push(
      `  (pad "${number}" ${padType} ${shape} (at ${posX.toFixed(4)} ${posY.toFixed(4)} ${orientation.toFixed(2)}) (size ${width.toFixed(4)} ${height.toFixed(4)})${drillClause} (layers ${layerTokens})${polygonClause})`,
    );
  });

  // Add custom texts
  footprint.texts.forEach((text, i) => {
    const x = convertToKiCadMm(text.x - normOriginX);
    const y = convertToKiCadMm(text.y - normOriginY);
    const size = convertToKiCadMm(text.size);
    const layer = convertLayer(text.layer);

    lines.push(`  (fp_text user "${text.text}" (at ${x.toFixed(4)} ${y.toFixed(4)}) (layer "${layer}")`);
    lines.push(`    (effects (font (size ${size.toFixed(4)} ${size.toFixed(4)}) (thickness ${(size * 0.15).toFixed(4)})))`);
    lines.push('  )');
  });

  // Solid regions: layer 99 → F.CrtYd outline (fp_line pairs, width 0.05);
  // other importable layers (3/4/13/14) → filled fp_poly.
  // Mirrors easyeda2kicad.py export logic.
  footprint.solidRegions.forEach((region) => {
    const layerId = parseInt(region.layer, 10);
    if (!SOLID_REGION_LAYERS.has(layerId)) return;
    if (region.fillType !== 'solid' && region.fillType !== 'npth') return;

    const pts = parseSolidRegionPath(region.path, normOriginX, normOriginY);
    if (pts.length < 3) return;

    if (layerId === 99) {
      for (let k = 0; k < pts.length - 1; k++) {
        const [sx, sy] = pts[k];
        const [ex, ey] = pts[k + 1];
        lines.push(
          `  (fp_line (start ${sx.toFixed(4)} ${sy.toFixed(4)}) (end ${ex.toFixed(4)} ${ey.toFixed(4)}) (layer "F.CrtYd") (width 0.05))`,
        );
      }
    } else {
      const layerName = KI_LAYERS[layerId] ?? 'F.SilkS';
      const ptsStr = pts.map(([x, y]) => `(xy ${x.toFixed(6)} ${y.toFixed(6)})`).join(' ');
      lines.push(
        `  (fp_poly (pts ${ptsStr}) (stroke (width 0) (type solid)) (fill solid) (layer "${layerName}"))`,
      );
    }
  });

  lines.push(')');

  return lines.join('\n');
}
