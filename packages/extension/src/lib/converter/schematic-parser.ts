// Adapted from hulryung/easyeda2kicad-web (MIT per its README). https://github.com/hulryung/easyeda2kicad-web
//
// Standalone extraction of `parseSchematicData` from the upstream React
// `components/SchematicViewer.tsx`. The parse logic is byte-for-byte the
// upstream implementation; everything React (hooks, JSX, the viewer component)
// has been dropped, and the original debug `console.log` was removed. The
// `ParsedSchematic` type now lives in `./types`. No Node-only APIs — safe to run
// in a browser service worker. See ../../../THIRD_PARTY.md for attribution.

import { ParsedSchematic } from './types';

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
    if (data.head?.c_para) {
      schematic.name = data.head.c_para.package || '';
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
          case 'P':
            // PIN format: P~show~0~pinNumber~x~y~rotation~gId~...^^x~y^^M x y h/v length~...
            const pinNumber = parts[3] || '';
            const pinX = parseFloat(parts[4] || '0');
            const pinY = parseFloat(parts[5] || '0');
            const pinRotation = parseFloat(parts[6] || '0');

            // Extract pin length from SVG path data
            let pinLength = 10; // default
            // Find the SVG path part after ^^
            const pathParts = shapeStr.split('^^');
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
              name: pinNumber, // Use number as name for now
              x: pinX,
              y: pinY,
              rotation: pinRotation,
              length: pinLength,
            });
            break;

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
