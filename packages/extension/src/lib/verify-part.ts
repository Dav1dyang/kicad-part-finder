/**
 * Check a converted part before it is written to the library.
 *
 * Catches what would otherwise surface later in KiCad: a damaged file, a
 * symbol without pins, symbol pins with no matching footprint pad (KiCad's
 * "pad not found" in PCB update), and parts uploaded by the community rather
 * than published by LCSC. Pure and DOM-free.
 */

import type { PartSource } from './converter/easyeda.js';
import { atomValues, findAll, isAtom, parseSexpr } from './sexpr.js';

export type CheckLevel = 'ok' | 'info' | 'warn' | 'error';

export interface PartCheck {
  id: 'source' | 'symbol' | 'footprint' | 'pin-pad' | 'model';
  level: CheckLevel;
  /** One short line for the card. */
  message: string;
  /** Optional second line with specifics. */
  detail?: string;
}

export interface PartReport {
  /** The worst level among the checks ('info' counts as 'ok'). */
  level: 'ok' | 'warn' | 'error';
  /** True when the files are damaged and must not be written. */
  blocking: boolean;
  checks: PartCheck[];
}

export interface VerifiableResult {
  symbol: string;
  footprint: string;
  model3dUrl: string | null;
  source: PartSource;
}

/** True when every `(` closes, outside quoted strings, and there is at least one list. */
export function isBalanced(text: string): boolean {
  let depth = 0;
  let lists = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') {
      depth++;
      lists++;
    } else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString && lists > 0;
}

/** Every pin number in a symbol, in file order (duplicates kept). */
export function pinNumbers(symbolText: string): string[] {
  const root = parseSexpr(symbolText);
  if (!root) return [];
  return findAll(root, 'pin').flatMap((p) => {
    const num = p.children.find((c) => !isAtom(c) && c.token === 'number');
    const value = num && !isAtom(num) ? atomValues(num)[0] : undefined;
    return value === undefined ? [] : [value];
  });
}

/** Numbers of the electrical pads in a footprint (unnumbered and non-plated holes skipped). */
export function padNumbers(footprintText: string): string[] {
  const root = parseSexpr(footprintText);
  if (!root) return [];
  return findAll(root, 'pad').flatMap((p) => {
    const [num, kind] = atomValues(p);
    return num && kind !== 'np_thru_hole' ? [num] : [];
  });
}

const RANK: Record<CheckLevel, number> = { ok: 0, info: 0, warn: 1, error: 2 };

const list = (items: string[], max = 6) =>
  items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function verifyPart(part: VerifiableResult): PartReport {
  const checks: PartCheck[] = [];

  // Who made it.
  const { verified, official, author } = part.source;
  if (official && verified) {
    checks.push({ id: 'source', level: 'ok', message: 'Made and verified by LCSC' });
  } else if (verified) {
    checks.push({ id: 'source', level: 'ok', message: `Verified by LCSC, made by ${author}` });
  } else {
    checks.push({
      id: 'source',
      level: 'warn',
      message: official ? 'Made by LCSC, not verified' : `Made by ${author}, not verified`,
      detail: 'Check pinout and pads against the datasheet before ordering.',
    });
  }

  // Files are intact and not empty.
  const symbolOk = isBalanced(part.symbol) && /\(symbol\s+"/.test(part.symbol);
  const footprintOk = isBalanced(part.footprint) && /\(footprint\s+"/.test(part.footprint);
  const pins = symbolOk ? pinNumbers(part.symbol) : [];
  const pads = footprintOk ? padNumbers(part.footprint) : [];

  checks.push(
    !symbolOk
      ? { id: 'symbol', level: 'error', message: 'Symbol data is damaged', detail: 'Search again, or try a source below.' }
      : pins.length === 0
        ? { id: 'symbol', level: 'warn', message: 'Symbol has no pins' }
        : { id: 'symbol', level: 'ok', message: `Symbol: ${plural(pins.length, 'pin')}` },
  );
  checks.push(
    !footprintOk
      ? { id: 'footprint', level: 'error', message: 'Footprint data is damaged', detail: 'Search again, or try a source below.' }
      : pads.length === 0
        ? { id: 'footprint', level: 'warn', message: 'Footprint has no pads' }
        : { id: 'footprint', level: 'ok', message: `Footprint: ${plural(new Set(pads).size, 'pad')}${part.source.footprintTitle ? ` (${part.source.footprintTitle})` : ''}` },
  );

  // Every symbol pin needs a pad with the same number.
  if (pins.length && pads.length) {
    const padSet = new Set(pads);
    const pinSet = new Set(pins);
    const missing = [...pinSet].filter((n) => !padSet.has(n));
    const extra = [...padSet].filter((n) => !pinSet.has(n));
    const dupes = [...new Set(pins.filter((n, i) => pins.indexOf(n) !== i))];
    const notes = [
      extra.length ? `Pads without a pin (often thermal or mounting): ${list(extra)}.` : '',
      dupes.length ? `Repeated pin numbers: ${list(dupes)}.` : '',
    ].filter(Boolean);
    checks.push(
      missing.length
        ? {
            id: 'pin-pad',
            level: 'warn',
            message: `Pin${missing.length === 1 ? '' : 's'} ${list(missing)} ${missing.length === 1 ? 'has' : 'have'} no pad`,
            detail: ['KiCad flags these on PCB update.', ...notes].join(' '),
          }
        : { id: 'pin-pad', level: 'ok', message: 'Every pin has a pad', detail: notes.join(' ') || undefined },
    );
  }

  checks.push(
    part.model3dUrl
      ? { id: 'model', level: 'ok', message: '3D model (STEP)' }
      : { id: 'model', level: 'info', message: 'No 3D model. The rest still installs.' },
  );

  const worst = Math.max(...checks.map((c) => RANK[c.level]));
  return {
    level: worst === 2 ? 'error' : worst === 1 ? 'warn' : 'ok',
    blocking: checks.some((c) => c.level === 'error'),
    checks,
  };
}
