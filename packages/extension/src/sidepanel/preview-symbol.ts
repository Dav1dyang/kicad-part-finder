/**
 * Symbol preview — parse a KiCad `.kicad_sym` and draw the symbol as an SVG.
 *
 * Two halves, mirroring the footprint preview:
 *   • {@link parseSymbol} — pure, DOM-free: S-expr → a {@link SymbolModel} of the
 *     body graphics (rectangles / polylines / circles / arcs) and pins (stub +
 *     name + number), plus the overall bounding box. Unit-tested directly.
 *   • {@link renderSymbolSvg} — turns that into an `<svg>`: the body outline,
 *     each pin as a stub line with its name (toward the body) and number (toward
 *     the tip), and an auto-fitted viewBox.
 *
 * Coordinates: `.kicad_sym` is millimetres with KiCad's +Y pointing UP. SVG is
 * +Y-down, so we NEGATE Y (X kept). A pin's `(at X Y ANGLE)` is the connection
 * tip; the stub runs from the tip toward the body at `tip + length·(cosA,sinA)`.
 */

import {
  parseSexpr,
  childNodes,
  findAll,
  firstChild,
  leadingNums,
  isAtom,
  type SNode,
} from './preview-sexpr.js';
import { SVG_NS, type Bbox, growBbox, emptyBbox, isFiniteBbox } from './preview-svg.js';

/** A rectangle body graphic (mm, KiCad Y-up). */
export interface SymRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A polyline body graphic — an ordered run of points (mm). */
export interface SymPolyline {
  pts: Array<[number, number]>;
}

/** A circle body graphic (mm). */
export interface SymCircle {
  cx: number;
  cy: number;
  r: number;
}

/** A pin: connection tip, orientation, length, and its name + number text. */
export interface SymPin {
  x: number;
  y: number;
  /** Orientation in degrees (0/90/180/270): direction tip→body. */
  angle: number;
  length: number;
  name: string;
  number: string;
}

/** The parsed symbol: body graphics + pins + the bounding box over everything. */
export interface SymbolModel {
  name: string;
  rects: SymRect[];
  polylines: SymPolyline[];
  circles: SymCircle[];
  pins: SymPin[];
  /** Bounding box over body + pin endpoints, in KiCad mm (Y-up). */
  bbox: Bbox;
}

/** Pull `(pts (xy a b) …)` as mm point pairs. */
function readPts(ptsNode: SNode | undefined): Array<[number, number]> {
  if (!ptsNode) return [];
  const out: Array<[number, number]> = [];
  for (const xy of childNodes(ptsNode, 'xy')) {
    const [x, y] = leadingNums(xy, 2);
    if (typeof x === 'number' && typeof y === 'number') out.push([x, y]);
  }
  return out;
}

/** Read a pin's `(name "…")` / `(number "…")` child as a string. */
function quotedChild(node: SNode, token: string): string {
  const child = firstChild(node, token);
  if (!child) return '';
  const first = child.children.find(isAtom);
  return first ? first.atom : '';
}

/**
 * Parse a `.kicad_sym` into a {@link SymbolModel}. Pure + DOM-free.
 *
 * Walks the WHOLE tree for `rectangle` / `polyline` / `circle` / `arc` / `pin`
 * nodes, so it doesn't matter how the body is split across `_0_1` / `_1_1`
 * sub-symbols (or unit variants). Returns `null` when the text isn't a symbol
 * S-expr; a body-less symbol yields an empty bbox.
 */
export function parseSymbol(text: string): SymbolModel | null {
  const root = parseSexpr(text);
  if (!root) return null;
  // Accept a full library (kicad_symbol_lib) or a bare (symbol …).
  if (root.token !== 'kicad_symbol_lib' && root.token !== 'symbol') return null;

  // Name: the first inner (symbol "…") that names the part (skip the lib root).
  let name = '';
  const symbolNodes = findAll(root, 'symbol');
  for (const s of symbolNodes) {
    const first = s.children.find(isAtom);
    if (first && first.atom && !/_\d+_\d+$/.test(first.atom)) {
      name = first.atom;
      break;
    }
  }

  const rects: SymRect[] = [];
  for (const node of findAll(root, 'rectangle')) {
    const [x1, y1] = leadingNums(firstChild(node, 'start'), 2);
    const [x2, y2] = leadingNums(firstChild(node, 'end'), 2);
    if ([x1, y1, x2, y2].some((v) => typeof v !== 'number')) continue;
    rects.push({ x1: x1!, y1: y1!, x2: x2!, y2: y2! });
  }

  const polylines: SymPolyline[] = [];
  for (const node of findAll(root, 'polyline')) {
    const pts = readPts(firstChild(node, 'pts'));
    if (pts.length >= 2) polylines.push({ pts });
  }

  const circles: SymCircle[] = [];
  for (const node of findAll(root, 'circle')) {
    const [cx, cy] = leadingNums(firstChild(node, 'center'), 2);
    const r = leadingNums(firstChild(node, 'radius'), 1)[0];
    if ([cx, cy, r].some((v) => typeof v !== 'number')) continue;
    circles.push({ cx: cx!, cy: cy!, r: r! });
  }
  // Arcs → chord through start→mid→end as a 2-segment polyline (honest outline
  // without re-deriving the arc centre).
  for (const node of findAll(root, 'arc')) {
    const [sx, sy] = leadingNums(firstChild(node, 'start'), 2);
    const [mx, my] = leadingNums(firstChild(node, 'mid'), 2);
    const [ex, ey] = leadingNums(firstChild(node, 'end'), 2);
    if ([sx, sy, ex, ey].some((v) => typeof v !== 'number')) continue;
    const pts: Array<[number, number]> =
      typeof mx === 'number' && typeof my === 'number'
        ? [
            [sx!, sy!],
            [mx, my],
            [ex!, ey!],
          ]
        : [
            [sx!, sy!],
            [ex!, ey!],
          ];
    polylines.push({ pts });
  }

  const pins: SymPin[] = [];
  for (const node of findAll(root, 'pin')) {
    const at = leadingNums(firstChild(node, 'at'), 3);
    if (at.length < 2) continue;
    const [x, y, angle = 0] = at as [number, number, number?];
    const length = leadingNums(firstChild(node, 'length'), 1)[0] ?? 2.54;
    pins.push({
      x,
      y,
      angle: angle ?? 0,
      length,
      name: quotedChild(node, 'name'),
      number: quotedChild(node, 'number'),
    });
  }

  // --- Bounding box over body graphics + pin tips/body-ends.
  const bbox = emptyBbox();
  for (const r of rects) {
    growBbox(bbox, r.x1, r.y1);
    growBbox(bbox, r.x2, r.y2);
  }
  for (const pl of polylines) for (const [px, py] of pl.pts) growBbox(bbox, px, py);
  for (const c of circles) {
    growBbox(bbox, c.cx - c.r, c.cy - c.r);
    growBbox(bbox, c.cx + c.r, c.cy + c.r);
  }
  for (const p of pins) {
    growBbox(bbox, p.x, p.y);
    const a = (p.angle * Math.PI) / 180;
    growBbox(bbox, p.x + p.length * Math.cos(a), p.y + p.length * Math.sin(a));
  }

  return { name, rects, polylines, circles, pins, bbox };
}

// --- Rendering ---------------------------------------------------------------

const COLORS = {
  body: 'var(--surface-2)',
  bodyStroke: 'var(--accent)',
  pin: 'rgba(231, 232, 236, 0.85)',
  pinDot: 'var(--accent-bright)',
  name: 'var(--text)',
  number: 'var(--text-dim)',
  origin: 'rgba(95, 214, 160, 0.55)',
};

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** SVG mapping: X kept, Y negated (KiCad Y-up → SVG Y-down). */
function sx(x: number): number {
  return x;
}
function sy(y: number): number {
  return -y;
}

/**
 * Render a parsed symbol to an auto-fitting `<svg>`. Body graphics first, then
 * pins (stub + endpoint dot), then pin text, then an origin crosshair.
 *
 * @returns an `<svg>` ready to insert (empty viewBox when there's no geometry).
 */
export function renderSymbolSvg(model: SymbolModel): SVGElement {
  const svg = el('svg', {
    xmlns: SVG_NS,
    class: 'preview-svg preview-svg--symbol',
    preserveAspectRatio: 'xMidYMid meet',
  });

  if (!isFiniteBbox(model.bbox)) {
    svg.setAttribute('viewBox', '0 0 1 1');
    return svg;
  }

  const b = model.bbox;
  const sxs = [sx(b.minX), sx(b.maxX)];
  const sys = [sy(b.minY), sy(b.maxY)];
  const vx0 = Math.min(...sxs);
  const vx1 = Math.max(...sxs);
  const vy0 = Math.min(...sys);
  const vy1 = Math.max(...sys);
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  // Generous margin so pin labels (drawn outside the bbox) aren't clipped.
  const margin = Math.max(2.2, Math.max(w, h) * 0.16);
  svg.setAttribute(
    'viewBox',
    `${(vx0 - margin).toFixed(3)} ${(vy0 - margin).toFixed(3)} ${(w + margin * 2).toFixed(3)} ${(h + margin * 2).toFixed(3)}`,
  );

  const bodyGroup = el('g', { class: 'sym-body' });
  const pinGroup = el('g', { class: 'sym-pins' });
  const textGroup = el('g', { class: 'sym-text' });
  svg.appendChild(bodyGroup);
  svg.appendChild(pinGroup);
  svg.appendChild(textGroup);

  // --- Body outline.
  for (const r of model.rects) {
    const x = Math.min(sx(r.x1), sx(r.x2));
    const y = Math.min(sy(r.y1), sy(r.y2));
    bodyGroup.appendChild(
      el('rect', {
        x: x.toFixed(4),
        y: y.toFixed(4),
        width: Math.abs(sx(r.x2) - sx(r.x1)).toFixed(4),
        height: Math.abs(sy(r.y2) - sy(r.y1)).toFixed(4),
        rx: '0.2',
        fill: COLORS.body,
        stroke: COLORS.bodyStroke,
        'stroke-width': '0.18',
      }),
    );
  }
  for (const pl of model.polylines) {
    const pts = pl.pts.map(([px, py]) => `${sx(px).toFixed(4)},${sy(py).toFixed(4)}`).join(' ');
    bodyGroup.appendChild(
      el('polyline', {
        points: pts,
        fill: 'none',
        stroke: COLORS.bodyStroke,
        'stroke-width': '0.18',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }
  for (const c of model.circles) {
    bodyGroup.appendChild(
      el('circle', {
        cx: sx(c.cx).toFixed(4),
        cy: sy(c.cy).toFixed(4),
        r: c.r.toFixed(4),
        fill: 'none',
        stroke: COLORS.bodyStroke,
        'stroke-width': '0.18',
      }),
    );
  }

  // --- Pins. Text size scales with the symbol but stays legible.
  const fs = Math.max(0.9, Math.min(1.5, Math.max(w, h) * 0.06));
  for (const pin of model.pins) {
    const a = (pin.angle * Math.PI) / 180;
    const tipX = sx(pin.x);
    const tipY = sy(pin.y);
    // Body end of the stub = tip + length·(cosA, sinA), with Y negated.
    const bodyX = sx(pin.x + pin.length * Math.cos(a));
    const bodyY = sy(pin.y + pin.length * Math.sin(a));

    pinGroup.appendChild(
      el('line', {
        x1: tipX.toFixed(4),
        y1: tipY.toFixed(4),
        x2: bodyX.toFixed(4),
        y2: bodyY.toFixed(4),
        stroke: COLORS.pin,
        'stroke-width': '0.15',
        'stroke-linecap': 'round',
      }),
    );
    // A small dot marks the connection tip.
    pinGroup.appendChild(
      el('circle', { cx: tipX.toFixed(4), cy: tipY.toFixed(4), r: '0.28', fill: COLORS.pinDot }),
    );

    // Unit direction of the stub in SCREEN space (tip → body).
    const dx = bodyX - tipX;
    const dy = bodyY - tipY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const horizontal = Math.abs(ux) >= Math.abs(uy);

    // Number: just OUTSIDE the tip (away from body); Name: just INSIDE the body
    // end (toward body). Anchor flips with direction so text never overlaps the
    // stub awkwardly.
    if (pin.number) {
      const nx = tipX - ux * 0.4;
      const ny = tipY - uy * 0.4 - (horizontal ? 0.35 : 0);
      const t = el('text', {
        x: nx.toFixed(4),
        y: ny.toFixed(4),
        fill: COLORS.number,
        'font-size': (fs * 0.82).toFixed(3),
        'text-anchor': horizontal ? (ux > 0 ? 'end' : 'start') : 'middle',
        'dominant-baseline': horizontal ? 'central' : 'auto',
        class: 'sym-pin-number',
      });
      t.textContent = pin.number;
      textGroup.appendChild(t);
    }
    if (pin.name && pin.name !== '~') {
      const nameX = bodyX + ux * 0.5;
      const nameY = bodyY + uy * 0.5;
      const t = el('text', {
        x: nameX.toFixed(4),
        y: nameY.toFixed(4),
        fill: COLORS.name,
        'font-size': fs.toFixed(3),
        'text-anchor': horizontal ? (ux > 0 ? 'start' : 'end') : 'middle',
        'dominant-baseline': horizontal ? 'central' : uy > 0 ? 'hanging' : 'auto',
        class: 'sym-pin-name',
      });
      t.textContent = pin.name;
      textGroup.appendChild(t);
    }
  }

  // --- Origin crosshair.
  const reach = Math.max(0.6, Math.min(w, h) * 0.08);
  const cross = el('g', { class: 'sym-origin' });
  cross.appendChild(
    el('line', { x1: -reach, y1: 0, x2: reach, y2: 0, stroke: COLORS.origin, 'stroke-width': 0.08 }),
  );
  cross.appendChild(
    el('line', { x1: 0, y1: -reach, x2: 0, y2: reach, stroke: COLORS.origin, 'stroke-width': 0.08 }),
  );
  svg.appendChild(cross);

  return svg;
}

/**
 * One-shot helper: parse `.kicad_sym` text and return a fitted `<svg>`, or
 * `null` when it can't be parsed into a symbol with any geometry.
 */
export function symbolToSvg(text: string): SVGElement | null {
  const model = parseSymbol(text);
  if (!model || !isFiniteBbox(model.bbox)) return null;
  return renderSymbolSvg(model);
}
