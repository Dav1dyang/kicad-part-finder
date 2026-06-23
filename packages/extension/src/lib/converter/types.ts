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

/**
 * KiCad electrical pin type. Mirrors the subset of EasyEDA pin types the
 * converter understands; everything else maps to `passive`.
 */
export type KiCadPinType =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'power_in'
  | 'passive'
  | 'unspecified';

/** Intermediate representation of a parsed EasyEDA schematic symbol. */
export interface ParsedSchematic {
  name: string;
  /**
   * KiCad Reference designator prefix derived from EasyEDA `head.c_para.pre`
   * (the trailing `?` stripped), e.g. `R`, `C`, `U`. Empty when unknown.
   */
  prefix?: string;
  /**
   * Manufacturer part number from `head.c_para` ("Manufacturer Part" / "name").
   * Drives the symbol Value + symbol name. Empty when unknown.
   */
  mpn?: string;
  /**
   * Normalization origin in raw EasyEDA units (`head.x` / `head.y`). Subtracting
   * it before scaling re-centers the symbol near the KiCad origin. Undefined
   * when the document carries no usable origin.
   */
  bbox?: { x: number; y: number };
  pins: Array<{
    number: string;
    name: string;
    x: number;
    y: number;
    rotation?: number;
    length?: number;
    /** KiCad electrical type derived from the EasyEDA `electric` integer. */
    electricType?: KiCadPinType;
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
