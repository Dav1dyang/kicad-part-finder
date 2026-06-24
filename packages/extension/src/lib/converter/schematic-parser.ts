// Adapted from hulryung/easyeda2kicad-web (MIT per its README). https://github.com/hulryung/easyeda2kicad-web
//
// Standalone extraction of `parseSchematicData` from the upstream React
// `components/SchematicViewer.tsx`. The geometry parse logic is the upstream
// implementation (React hooks/JSX dropped, debug `console.log` removed). The
// `ParsedSchematic` type now lives in `./types`. No Node-only APIs — safe to run
// in a browser service worker. See ../../../THIRD_PARTY.md for attribution.
//
// Milestone 4 (symbol polish) adds, as an independent clean-room reimplementation
// (no code copied from the AGPL easyeda2kicad.py), extraction of: the Reference
// prefix + MPN + normalization origin from `head`, and per-pin NAME text +
// electrical type out of the EasyEDA pin string's `^^`-delimited sub-parts.

import { KiCadPinType, ParsedSchematic } from './types';

/**
 * Map an EasyEDA pin `electric` integer to a KiCad electrical type.
 *
 * EasyEDA encodes: 0 = unspecified, 1 = input, 2 = output, 3 = bidirectional,
 * 4 = power. KiCad spells "power" as `power_in`. Anything we don't recognize —
 * including the common 0/unspecified case — falls back to `passive`, which is
 * the safest neutral type for a generic library part.
 */
function easyedaPinTypeToKiCad(electric: string | undefined): KiCadPinType {
  switch ((electric ?? '').trim()) {
    case '1':
      return 'input';
    case '2':
      return 'output';
    case '3':
      return 'bidirectional';
    case '4':
      return 'power_in';
    default:
      return 'passive';
  }
}

/**
 * Derive the KiCad Reference designator prefix from an EasyEDA `pre` field by
 * stripping the placeholder `?` (`"U?"` -> `"U"`, `"R?"` -> `"R"`). Returns ''
 * when the input is empty/missing so the caller can apply its own fallback.
 */
function prefixFromPre(pre: string | undefined): string {
  if (typeof pre !== 'string') return '';
  return pre.replace(/\?/g, '').trim();
}

export function parseSchematicData(dataStr: string | any): ParsedSchematic {
  const schematic: ParsedSchematic = {
    name: '',
    pins: [],
    polylines: [],
    circles: [],
    rectangles: [],
    texts: [],
  };

  try {
    let data = dataStr;
    if (typeof dataStr === 'string') {
      data = JSON.parse(dataStr);
    }

    // Get component package name (use package, not name, to match footprint naming)
    const cPara = data.head?.c_para;
    if (cPara) {
      schematic.name = cPara.package || '';
      // Reference prefix (e.g. "U?" -> "U") and the manufacturer part number,
      // used by the symbol exporter for the Reference / Value / symbol name.
      schematic.prefix = prefixFromPre(cPara.pre);
      schematic.mpn =
        cPara['Manufacturer Part'] || cPara['name'] || '';
    }

    // Normalization origin: EasyEDA stores the symbol's canvas center in
    // head.x / head.y. Subtracting it (see the exporter) re-centers the symbol
    // near the KiCad origin. Only record it when both are finite numbers.
    const headX = parseFloat(data.head?.x);
    const headY = parseFloat(data.head?.y);
    if (Number.isFinite(headX) && Number.isFinite(headY)) {
      schematic.bbox = { x: headX, y: headY };
    }

    // Parse shape array
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

        const parts = shapeStr.split('~');
        const type = parts[0];

        switch (type) {
          case 'P': {
            // EasyEDA pin string. The settings sub-part (before the first "^^")
            // is `P~show~electric~pinNumber~x~y~rotation~gId~isLocked`; further
            // "^^"-delimited sub-parts carry the dot, path, NAME and NUMBER text,
            // etc. Indices below are derived from that layout (clean-room).
            const pinNumber = parts[3] || '';
            const pinX = parseFloat(parts[4] || '0');
            const pinY = parseFloat(parts[5] || '0');
            const pinRotation = parseFloat(parts[6] || '0');
            const electricType = easyedaPinTypeToKiCad(parts[2]);

            const pathParts = shapeStr.split('^^');

            // Pin NAME text lives in sub-part index 3, as
            // `visible~textX~textY~textRot~NAMETEXT~anchor~...` — field 4 is the
            // visible label (e.g. "GND", "VOUT"). Fall back to the pad number
            // when EasyEDA gives no usable name.
            let pinName = pinNumber;
            if (pathParts.length > 3) {
              const nameFields = pathParts[3].split('~');
              const nameText = (nameFields[4] ?? '').trim();
              if (nameText) {
                pinName = nameText;
              }
            }

            // Extract pin length from SVG path data
            let pinLength = 10; // default
            // Find the SVG path part after ^^
            if (pathParts.length > 2) {
              // pathParts[2] contains something like "M 380 280 h 20"
              const pathData = pathParts[2];
              const pathMatch = pathData.match(/[hv]\s*([-\d.]+)/);
              if (pathMatch) {
                pinLength = Math.abs(parseFloat(pathMatch[1]));
              }
            }

            schematic.pins.push({
              number: pinNumber,
              name: pinName,
              x: pinX,
              y: pinY,
              rotation: pinRotation,
              length: pinLength,
              electricType,
            });
            break;
          }

          case 'PL':
            // Polyline format: PL~x1 y1 x2 y2 x3 y3...~color~width~layer~style~gId~flags
            const coordStr = parts[1] || '';
            const coordValues = coordStr.trim().split(/\s+/);
            const points: Array<{ x: number; y: number }> = [];
            for (let i = 0; i < coordValues.length; i += 2) {
              if (i + 1 < coordValues.length) {
                points.push({
                  x: parseFloat(coordValues[i]),
                  y: parseFloat(coordValues[i + 1]),
                });
              }
            }
            if (points.length > 0) {
              schematic.polylines.push({
                points,
                strokeWidth: parseFloat(parts[3] || '1'),
              });
            }
            break;

          case 'C':
          case 'CIRCLE':
            // CIRCLE format: C~x~y~radius~width~layer~gId
            schematic.circles.push({
              x: parseFloat(parts[1] || '0'),
              y: parseFloat(parts[2] || '0'),
              radius: parseFloat(parts[3] || '0'),
            });
            break;

          case 'E':
            // ELLIPSE format: E~x~y~rx~ry~color~width~layer~style~gId~flags
            // Treat as circle with radius being the average of rx and ry
            const ex = parseFloat(parts[1] || '0');
            const ey = parseFloat(parts[2] || '0');
            const rx = parseFloat(parts[3] || '0');
            const ry = parseFloat(parts[4] || '0');
            schematic.circles.push({
              x: ex,
              y: ey,
              radius: (rx + ry) / 2,
            });
            break;

          case 'R':
            // RECT format: R~x~y~rx~ry~width~height~color~strokeWidth~layer~style~gId~flags
            let rectX, rectY, rectWidth, rectHeight, rectRx, rectRy;

            rectX = parseFloat(parts[1] || '0');
            rectY = parseFloat(parts[2] || '0');

            // Check if we need to use parts[3],[4] or parts[5],[6] for width/height
            const val3 = parseFloat(parts[3] || '0');
            const val4 = parseFloat(parts[4] || '0');
            const val5 = parseFloat(parts[5] || '0');
            const val6 = parseFloat(parts[6] || '0');

            if (parts[3] === '' || (val5 > val3 && val6 > val4)) {
              // parts[3],[4] are empty or corner radius, parts[5],[6] are width/height
              rectRx = val3;
              rectRy = val4;
              rectWidth = val5;
              rectHeight = val6;
            } else {
              // parts[3],[4] are width/height
              rectWidth = val3;
              rectHeight = val4;
              rectRx = 0;
              rectRy = 0;
            }

            if (rectWidth > 0 && rectHeight > 0) {
              schematic.rectangles.push({
                x: rectX,
                y: rectY,
                width: rectWidth,
                height: rectHeight,
                rx: rectRx,
                ry: rectRy,
              });
            }
            break;

          case 'A':
            // ARC/PATH format: A~svg_path_data~color~width~layer~style~gId~flags
            // For now, skip complex arc rendering
            // We would need to parse SVG path commands to render this properly
            break;

          case 'T':
          case 'TEXT':
            // TEXT format: T~x~y~rotation~text~...
            schematic.texts.push({
              text: parts[4] || '',
              x: parseFloat(parts[1] || '0'),
              y: parseFloat(parts[2] || '0'),
              size: 12,
            });
            break;
        }
      }
    }
  } catch (error) {
    console.error('Error parsing schematic:', error);
  }

  return schematic;
}
