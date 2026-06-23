// Adapted from hulryung/easyeda2kicad-web (MIT per its README). https://github.com/hulryung/easyeda2kicad-web
//
// Type definitions for the parsed EasyEDA footprint/schematic intermediate
// representation. Vendored from the upstream `types/easyeda.ts` and trimmed to
// only what the converter needs (no React, no Next.js types). Pure types — safe
// to import from a browser service worker.

/** Intermediate representation of a parsed EasyEDA footprint. */
export interface ParsedFootprint {
  name: string;
  originX?: number;
  originY?: number;
  pads: Array<{
    number: string;
    type: string;
    shape: string;
    x: number;
    y: number;
    width: number;
    height: number;
    drill?: number;
    holeLength?: number;
    rotation?: number;
    layerId: number;
    points?: string;
  }>;
  lines: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    layer: string;
  }>;
  circles: Array<{
    x: number;
    y: number;
    radius: number;
    width: number;
    layer: string;
  }>;
  arcs: Array<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    angle: number;
    width: number;
    layer: string;
  }>;
  texts: Array<{
    text: string;
    x: number;
    y: number;
    size: number;
    layer: string;
  }>;
  solidRegions: Array<{
    layer: string;
    path: string;
    fillType: string;
  }>;
}

/** Intermediate representation of a parsed EasyEDA schematic symbol. */
export interface ParsedSchematic {
  name: string;
  pins: Array<{
    number: string;
    name: string;
    x: number;
    y: number;
    rotation?: number;
    length?: number;
  }>;
  polylines: Array<{
    points: Array<{ x: number; y: number }>;
    strokeWidth: number;
  }>;
  circles: Array<{
    x: number;
    y: number;
    radius: number;
  }>;
  rectangles: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    rx?: number;
    ry?: number;
  }>;
  texts: Array<{
    text: string;
    x: number;
    y: number;
    size: number;
  }>;
}
