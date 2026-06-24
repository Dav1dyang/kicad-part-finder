/**
 * Footprint preview — parse a KiCad `.kicad_mod` and draw a top-view SVG.
 *
 * Two halves:
 *   • {@link parseFootprint} — pure, DOM-free: S-expr → a {@link FootprintModel}
 *     of pads + graphic lines/circles/arcs/polys, plus the overall bounding box.
 *     This is what the unit tests exercise.
 *   • {@link renderFootprintSvg} — turns that model into an `<svg>`: copper pads
 *     (accent-tinted, with number labels), silkscreen, a hairline-dashed
 *     courtyard, and an origin crosshair. Auto-fits the viewBox to the bbox.
 *
 * Coordinates: KiCad footprints are millimetres with Y pointing DOWN on the
 * board but UP in the file's math sense relative to screen — i.e. KiCad's +Y is
 * downward on the fab drawing, which already matches SVG's +Y-down screen axis
 * for a *top view*… except KiCad text/rotation are CCW-positive. We keep X as-is
 * and NEGATE Y so the rendered top view matches what you see in pcbnew, and flip
 * rotation sign to match. Everything is in mm in the SVG user space, so a small
 * uniform margin keeps it crisp at any rendered size.
 */

import {
  parseSexpr,
  findAll,
  firstChild,
  leadingNums,
  isAtom,
  isNode,
  type SNode,
} from './preview-sexpr.js';
import { SVG_NS, type Bbox, growBbox, emptyBbox, isFiniteBbox } from './preview-svg.js';

/** Which board layer a graphic belongs to (only the ones we draw, distinctly). */
export type FpLayerKind = 'silk' | 'courtyard' | 'fab' | 'other';

/** A copper pad in mm (center + size + rotation), Y in KiCad (down) convention. */
export interface FpPad {
  number: string;
  /** Pad geometry: rect/roundrect/oval/circle, or a custom polygon. */
  shape: 'rect' | 'roundrect' | 'oval' | 'circle' | 'custom';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in degrees (KiCad CCW). */
  rot: number;
  /** Whether this is a plated through-hole (drawn with a drill mark). */
  thruHole: boolean;
  /** Drill diameter in mm, when present. */
  drill?: number;
  /** Custom-pad outline points (mm, relative to the pad center), if any. */
  poly?: Array<[number, number]>;
}

/** A straight graphic segment (silk / courtyard / fab). */
export interface FpSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  layer: FpLayerKind;
}

/** A graphic circle (silk / courtyard / fab). KiCad gives center + a rim point. */
export interface FpCircle {
  cx: number;
  cy: number;
  r: number;
  width: number;
  layer: FpLayerKind;
}

/** A closed graphic polygon (e.g. `fp_poly`). */
export interface FpPoly {
  pts: Array<[number, number]>;
  layer: FpLayerKind;
}

/** The parsed footprint: geometry + the bounding box over everything drawn. */
export interface FootprintModel {
  name: string;
  pads: FpPad[];
  segs: FpSeg[];
  circles: FpCircle[];
  polys: FpPoly[];
  /** Bounding box over pads + graphics, in KiCad mm (Y-down). */
  bbox: Bbox;
}

/** Classify a KiCad layer string into the few kinds we render differently. */
function layerKind(layer: string | undefined): FpLayerKind {
  if (!layer) return 'other';
  if (layer.includes('SilkS')) return 'silk';
  if (layer.includes('CrtYd')) return 'courtyard';
  if (layer.includes('Fab')) return 'fab';
  return 'other';
}

/** Read the layer name from a `(layer "F.SilkS")` child, if present. */
function layerOf(node: SNode): FpLayerKind {
  const layerNode = firstChild(node, 'layer');
  if (!layerNode) return 'other';
  const first = layerNode.children.find(isAtom);
  return layerKind(first?.atom);
}

/** Read the `(width N)` child as mm, defaulting to a thin hairline. */
function widthOf(node: SNode, fallback = 0.12): number {
  const w = leadingNums(firstChild(node, 'width'), 1)[0];
  return typeof w === 'number' && w > 0 ? w : fallback;
}

/**
 * Pull `(pts (xy a b) (xy c d) …)` out of a node as mm point pairs. Used for
 * both `fp_poly` outlines and custom-pad `gr_poly` primitives.
 */
function readPts(ptsNode: SNode | undefined): Array<[number, number]> {
  if (!ptsNode) return [];
  const out: Array<[number, number]> = [];
  for (const child of ptsNode.children) {
    if (isNode(child) && child.token === 'xy') {
      const [x, y] = leadingNums(child, 2);
      if (typeof x === 'number' && typeof y === 'number') out.push([x, y]);
    }
  }
  return out;
}

/** Parse one `(pad …)` node into an {@link FpPad}, or null if unusable. */
function parsePad(node: SNode): FpPad | null {
  // (pad "N" smd|thru_hole rect|roundrect|oval|circle|custom (at X Y [rot]) (size W H) …)
  const atoms = node.children.filter(isAtom).map((a) => a.atom);
  // atoms[0] = number, atoms[1] = pad type, atoms[2] = shape.
  const number = atoms[0] ?? '';
  const padType = atoms[1] ?? 'smd';
  const shapeRaw = (atoms[2] ?? 'rect').toLowerCase();
  const shape: FpPad['shape'] =
    shapeRaw === 'rect' ||
    shapeRaw === 'roundrect' ||
    shapeRaw === 'oval' ||
    shapeRaw === 'circle' ||
    shapeRaw === 'custom'
      ? (shapeRaw as FpPad['shape'])
      : 'rect';

  const at = leadingNums(firstChild(node, 'at'), 3);
  if (at.length < 2) return null;
  const [x, y, rot = 0] = at as [number, number, number?];

  const size = leadingNums(firstChild(node, 'size'), 2);
  let [w, h] = [size[0] ?? 0, size[1] ?? 0];

  const thruHole = padType === 'thru_hole' || padType === 'np_thru_hole';
  const drillNode = firstChild(node, 'drill');
  const drill = drillNode ? leadingNums(drillNode, 1)[0] : undefined;

  // Custom pads: prefer the primitive polygon so the real shape shows; the
  // (size …) on a custom pad is a tiny placeholder, so derive a fallback box
  // from the polygon extent when needed.
  let poly: Array<[number, number]> | undefined;
  if (shape === 'custom') {
    const primitives = firstChild(node, 'primitives');
    const grPoly = primitives ? firstChild(primitives, 'gr_poly') : undefined;
    const pts = grPoly ? readPts(firstChild(grPoly, 'pts')) : [];
    if (pts.length >= 3) {
      poly = pts;
      if (w <= 0.01 || h <= 0.01) {
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        w = Math.max(...xs) - Math.min(...xs);
        h = Math.max(...ys) - Math.min(...ys);
      }
    }
  }

  return { number, shape, x, y, w, h, rot: rot ?? 0, thruHole, drill: drill && drill > 0 ? drill : undefined, poly };
}

/** The four corners of a (rotated) pad in mm, KiCad coords. */
function padCorners(pad: FpPad): Array<[number, number]> {
  const hw = pad.w / 2;
  const hh = pad.h / 2;
  const a = (pad.rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const local: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return local.map(([lx, ly]) => [pad.x + lx * cos - ly * sin, pad.y + lx * sin + ly * cos]);
}

/**
 * Parse a `.kicad_mod` into a {@link FootprintModel}. Pure + DOM-free.
 *
 * Returns `null` when the text isn't a footprint S-expr at all. A footprint with
 * zero drawable geometry yields a model with an empty bbox (the renderer treats
 * that as "nothing to show").
 */
export function parseFootprint(text: string): FootprintModel | null {
  const root = parseSexpr(text);
  if (!root) return null;
  // Accept both modern "footprint" and legacy "module" roots.
  if (root.token !== 'footprint' && root.token !== 'module') return null;

  const nameAtom = root.children.find(isAtom);
  const name = nameAtom?.atom ?? '';

  const pads: FpPad[] = [];
  for (const node of findAll(root, 'pad')) {
    const pad = parsePad(node);
    if (pad) pads.push(pad);
  }

  const segs: FpSeg[] = [];
  for (const node of findAll(root, 'fp_line')) {
    const [x1, y1] = leadingNums(firstChild(node, 'start'), 2);
    const [x2, y2] = leadingNums(firstChild(node, 'end'), 2);
    if ([x1, y1, x2, y2].some((v) => typeof v !== 'number')) continue;
    segs.push({
      x1: x1!,
      y1: y1!,
      x2: x2!,
      y2: y2!,
      width: widthOf(node),
      layer: layerOf(node),
    });
  }

  const circles: FpCircle[] = [];
  for (const node of findAll(root, 'fp_circle')) {
    const [cx, cy] = leadingNums(firstChild(node, 'center'), 2);
    const [ex, ey] = leadingNums(firstChild(node, 'end'), 2);
    if ([cx, cy, ex, ey].some((v) => typeof v !== 'number')) continue;
    const r = Math.hypot(ex! - cx!, ey! - cy!);
    circles.push({ cx: cx!, cy: cy!, r, width: widthOf(node), layer: layerOf(node) });
  }
  // fp_arc: approximate as the chord through start→mid→end so the silhouette is
  // honest without re-deriving the arc centre. (mid is the arc midpoint.)
  for (const node of findAll(root, 'fp_arc')) {
    const [sx, sy] = leadingNums(firstChild(node, 'start'), 2);
    const [mx, my] = leadingNums(firstChild(node, 'mid'), 2);
    const [ex, ey] = leadingNums(firstChild(node, 'end'), 2);
    if ([sx, sy, ex, ey].some((v) => typeof v !== 'number')) continue;
    const layer = layerOf(node);
    const width = widthOf(node);
    if (typeof mx === 'number' && typeof my === 'number') {
      segs.push({ x1: sx!, y1: sy!, x2: mx, y2: my, width, layer });
      segs.push({ x1: mx, y1: my, x2: ex!, y2: ey!, width, layer });
    } else {
      segs.push({ x1: sx!, y1: sy!, x2: ex!, y2: ey!, width, layer });
    }
  }

  const polys: FpPoly[] = [];
  for (const node of findAll(root, 'fp_poly')) {
    const pts = readPts(firstChild(node, 'pts'));
    if (pts.length >= 3) polys.push({ pts, layer: layerOf(node) });
  }

  // --- Bounding box over everything drawable (pads dominate; graphics extend it).
  const bbox = emptyBbox();
  for (const pad of pads) {
    for (const [cx, cy] of padCorners(pad)) growBbox(bbox, cx, cy);
  }
  for (const s of segs) {
    growBbox(bbox, s.x1, s.y1);
    growBbox(bbox, s.x2, s.y2);
  }
  for (const c of circles) {
    growBbox(bbox, c.cx - c.r, c.cy - c.r);
    growBbox(bbox, c.cx + c.r, c.cy + c.r);
  }
  for (const p of polys) {
    for (const [px, py] of p.pts) growBbox(bbox, px, py);
  }

  return { name, pads, segs, circles, polys, bbox };
}

// --- Rendering ---------------------------------------------------------------

/** Colours, read from the design tokens so the preview matches the card. */
const COLORS = {
  pad: 'var(--accent)',
  padStroke: 'var(--accent-bright)',
  padLabel: '#04130c',
  silk: 'rgba(231, 232, 236, 0.78)',
  courtyard: 'rgba(224, 166, 75, 0.55)',
  fab: 'rgba(158, 160, 170, 0.4)',
  origin: 'rgba(95, 214, 160, 0.7)',
  hole: '#0c0d10',
};

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Map a KiCad mm point to SVG user space (X kept, Y negated for top view). */
function sx(x: number): number {
  return x;
}
function sy(y: number): number {
  return -y;
}

/**
 * Render a parsed footprint to an `<svg>` element that auto-fits its viewBox to
 * the geometry. Draw order is bottom→top: courtyard, fab, silk, pads, labels,
 * origin — so copper reads as the foreground.
 *
 * @param model parsed footprint (from {@link parseFootprint}).
 * @returns an `<svg>` ready to insert, or a small "no geometry" note element
 *   when there's nothing drawable.
 */
export function renderFootprintSvg(model: FootprintModel): SVGElement {
  const svg = el('svg', {
    xmlns: SVG_NS,
    class: 'preview-svg preview-svg--footprint',
    preserveAspectRatio: 'xMidYMid meet',
  });

  if (!isFiniteBbox(model.bbox)) {
    svg.setAttribute('viewBox', '0 0 1 1');
    return svg;
  }

  // viewBox in SVG space (Y negated). Add a margin = ~8% of the larger extent
  // (min 0.4mm) so nothing touches the edge.
  const b = model.bbox;
  const sxs = [sx(b.minX), sx(b.maxX)];
  const sys = [sy(b.minY), sy(b.maxY)];
  const vx0 = Math.min(...sxs);
  const vx1 = Math.max(...sxs);
  const vy0 = Math.min(...sys);
  const vy1 = Math.max(...sys);
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  const margin = Math.max(0.4, Math.max(w, h) * 0.08);
  svg.setAttribute(
    'viewBox',
    `${(vx0 - margin).toFixed(3)} ${(vy0 - margin).toFixed(3)} ${(w + margin * 2).toFixed(3)} ${(h + margin * 2).toFixed(3)}`,
  );

  const groups: Record<FpLayerKind, SVGElement> = {
    courtyard: el('g', { class: 'fp-courtyard' }),
    fab: el('g', { class: 'fp-fab' }),
    other: el('g', { class: 'fp-other' }),
    silk: el('g', { class: 'fp-silk' }),
  };
  // Append in z-order; pads + labels go above all graphics.
  svg.appendChild(groups.courtyard);
  svg.appendChild(groups.fab);
  svg.appendChild(groups.other);
  svg.appendChild(groups.silk);
  const padGroup = el('g', { class: 'fp-pads' });
  const labelGroup = el('g', { class: 'fp-labels' });
  svg.appendChild(padGroup);
  svg.appendChild(labelGroup);

  const segStroke = (layer: FpLayerKind): string =>
    layer === 'courtyard' ? COLORS.courtyard : layer === 'fab' ? COLORS.fab : COLORS.silk;

  for (const s of model.segs) {
    const line = el('line', {
      x1: sx(s.x1).toFixed(4),
      y1: sy(s.y1).toFixed(4),
      x2: sx(s.x2).toFixed(4),
      y2: sy(s.y2).toFixed(4),
      stroke: segStroke(s.layer),
      'stroke-width': Math.max(s.width, 0.04).toFixed(4),
      'stroke-linecap': 'round',
    });
    if (s.layer === 'courtyard') line.setAttribute('stroke-dasharray', '0.3 0.2');
    (groups[s.layer] ?? groups.other).appendChild(line);
  }

  for (const c of model.circles) {
    const circle = el('circle', {
      cx: sx(c.cx).toFixed(4),
      cy: sy(c.cy).toFixed(4),
      r: Math.max(c.r, 0.02).toFixed(4),
      fill: 'none',
      stroke: segStroke(c.layer),
      'stroke-width': Math.max(c.width, 0.04).toFixed(4),
    });
    if (c.layer === 'courtyard') circle.setAttribute('stroke-dasharray', '0.3 0.2');
    (groups[c.layer] ?? groups.other).appendChild(circle);
  }

  for (const p of model.polys) {
    const d = p.pts.map(([px, py]) => `${sx(px).toFixed(4)},${sy(py).toFixed(4)}`).join(' ');
    const poly = el('polygon', {
      points: d,
      fill: p.layer === 'silk' ? COLORS.silk : 'none',
      stroke: segStroke(p.layer),
      'stroke-width': '0.06',
    });
    (groups[p.layer] ?? groups.other).appendChild(poly);
  }

  // --- Pads (copper) + number labels.
  for (const pad of model.pads) {
    padGroup.appendChild(padShape(pad));

    if (pad.thruHole && pad.drill && pad.drill > 0) {
      padGroup.appendChild(
        el('circle', {
          cx: sx(pad.x).toFixed(4),
          cy: sy(pad.y).toFixed(4),
          r: (pad.drill / 2).toFixed(4),
          fill: COLORS.hole,
        }),
      );
    }

    if (pad.number) {
      // Label sized to fit the pad's smaller dimension, clamped to a legible band.
      const fs = Math.max(0.35, Math.min(pad.w, pad.h) * 0.55);
      const label = el('text', {
        x: sx(pad.x).toFixed(4),
        y: sy(pad.y).toFixed(4),
        fill: COLORS.padLabel,
        'font-size': fs.toFixed(3),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        class: 'fp-pad-label',
      });
      label.textContent = pad.number;
      labelGroup.appendChild(label);
    }
  }

  // --- Origin crosshair at (0,0).
  const cross = el('g', { class: 'fp-origin' });
  const reach = Math.max(0.4, Math.min(w, h) * 0.12);
  cross.appendChild(
    el('line', { x1: -reach, y1: 0, x2: reach, y2: 0, stroke: COLORS.origin, 'stroke-width': 0.04 }),
  );
  cross.appendChild(
    el('line', { x1: 0, y1: -reach, x2: 0, y2: reach, stroke: COLORS.origin, 'stroke-width': 0.04 }),
  );
  svg.appendChild(cross);

  return svg;
}

/** Build the copper shape element for a pad (rect/roundrect/oval/circle/custom). */
function padShape(pad: FpPad): SVGElement {
  const common = {
    fill: COLORS.pad,
    stroke: COLORS.padStroke,
    'stroke-width': '0.03',
    'fill-opacity': '0.85',
  };

  if (pad.poly && pad.poly.length >= 3) {
    // Custom pad: polygon points are relative to the pad center.
    const pts = pad.poly
      .map(([lx, ly]) => `${sx(pad.x + lx).toFixed(4)},${sy(pad.y + ly).toFixed(4)}`)
      .join(' ');
    return el('polygon', { points: pts, ...common });
  }

  if (pad.shape === 'circle' || (pad.shape === 'oval' && Math.abs(pad.w - pad.h) < 1e-3)) {
    return el('circle', {
      cx: sx(pad.x).toFixed(4),
      cy: sy(pad.y).toFixed(4),
      r: (Math.max(pad.w, pad.h) / 2).toFixed(4),
      ...common,
    });
  }

  // rect / roundrect / oval → a (rounded) rect drawn at the origin then rotated
  // into place via a transform. Rotation sign flips because Y is negated.
  const rx =
    pad.shape === 'oval'
      ? Math.min(pad.w, pad.h) / 2
      : pad.shape === 'roundrect'
        ? Math.min(pad.w, pad.h) * 0.25
        : 0;
  const rect = el('rect', {
    x: (-pad.w / 2).toFixed(4),
    y: (-pad.h / 2).toFixed(4),
    width: pad.w.toFixed(4),
    height: pad.h.toFixed(4),
    rx: rx.toFixed(4),
    ry: rx.toFixed(4),
    transform: `translate(${sx(pad.x).toFixed(4)} ${sy(pad.y).toFixed(4)}) rotate(${(-pad.rot).toFixed(3)})`,
    ...common,
  });
  return rect;
}

/**
 * One-shot helper: parse `.kicad_mod` text and return a fitted `<svg>`, or
 * `null` when the text can't be parsed into a footprint with any geometry.
 * Wrapped by the side panel so a parse failure shows "preview unavailable".
 */
export function footprintToSvg(text: string): SVGElement | null {
  const model = parseFootprint(text);
  if (!model || !isFiniteBbox(model.bbox)) return null;
  return renderFootprintSvg(model);
}
