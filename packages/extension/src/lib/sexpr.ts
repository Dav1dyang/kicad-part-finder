/**
 * Minimal S-expression reader for KiCad text (`.kicad_sym` / `.kicad_mod`).
 *
 * KiCad files are S-expressions: `(token child child …)` where a child is
 * either another list, a bare atom (`1.27`, `F.SilkS`), or a quoted string
 * (`"pad name"`, with `\"` / `\\` escapes). This reader turns the text into a
 * tree of {@link SNode}s so the preview parsers can walk it without brittle
 * regexes — it tolerates arbitrary whitespace/newlines, so it works on our own
 * converter output AND on hand-authored library files.
 *
 * Pure + DOM-free → safe to unit-test in isolation and to run in a service
 * worker or the side panel alike.
 */

/** A parsed S-expression list: a head token plus its children. */
export interface SNode {
  /** The list head, e.g. `"pad"`, `"fp_line"`, `"symbol"`. */
  token: string;
  /** Child nodes — nested lists and leaf atoms, in source order. */
  children: SItem[];
}

/** A leaf value inside a list: a bare atom or a (possibly quoted) string. */
export interface SAtom {
  /** Discriminator so callers can tell atoms from nested lists. */
  atom: string;
  /** True when the source spelled this as a `"quoted"` string. */
  quoted: boolean;
}

/** Either a nested list or a leaf atom. */
export type SItem = SNode | SAtom;

/** Type guard: is this child a nested list (vs. a leaf atom)? */
export function isNode(item: SItem | undefined): item is SNode {
  return !!item && 'token' in item;
}

/** Type guard: is this child a leaf atom (vs. a nested list)? */
export function isAtom(item: SItem | undefined): item is SAtom {
  return !!item && 'atom' in item;
}

/**
 * Parse the FIRST top-level S-expression in `text` into a tree.
 *
 * Returns `null` when there is no `(`-list at all (empty / malformed input),
 * so callers can degrade to "preview unavailable" instead of throwing. Trailing
 * content after the first complete list is ignored.
 */
export function parseSexpr(text: string): SNode | null {
  let i = 0;
  const n = text.length;

  /** Advance past spaces, tabs, and newlines. */
  function skipWs(): void {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        i++;
      } else {
        break;
      }
    }
  }

  /** Read one item (list or atom) starting at `i`, or null at end/`)`. */
  function readItem(): SItem | null {
    skipWs();
    if (i >= n) return null;
    const c = text[i];
    if (c === '(') return readList();
    if (c === ')') return null;
    if (c === '"') return readQuoted();
    return readBareAtom();
  }

  function readList(): SNode {
    i++; // consume '('
    skipWs();
    // The head token: a bare word (occasionally quoted in odd files).
    let token: string;
    if (text[i] === '"') {
      token = readQuoted().atom;
    } else {
      token = readBareAtom().atom;
    }
    const children: SItem[] = [];
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (text[i] === ')') {
        i++; // consume ')'
        break;
      }
      const item = readItem();
      if (item === null) break;
      children.push(item);
    }
    return { token, children };
  }

  function readQuoted(): SAtom {
    i++; // consume opening quote
    let out = '';
    while (i < n) {
      const c = text[i++];
      if (c === '\\' && i < n) {
        // Preserve common escapes; pass anything else through verbatim.
        const next = text[i++];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      } else if (c === '"') {
        break;
      } else {
        out += c;
      }
    }
    return { atom: out, quoted: true };
  }

  function readBareAtom(): SAtom {
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '(' || c === ')') break;
      out += c;
      i++;
    }
    return { atom: out, quoted: false };
  }

  skipWs();
  if (i >= n || text[i] !== '(') return null;
  return readList();
}

/** Every direct child list of `node` whose head token === `token`. */
export function childNodes(node: SNode, token: string): SNode[] {
  return node.children.filter((c): c is SNode => isNode(c) && c.token === token);
}

/** The first direct child list of `node` with head token === `token`, if any. */
export function firstChild(node: SNode, token: string): SNode | undefined {
  return childNodes(node, token)[0];
}

/** Walk the whole tree depth-first and collect every list with this token. */
export function findAll(node: SNode, token: string): SNode[] {
  const out: SNode[] = [];
  const visit = (cur: SNode): void => {
    if (cur.token === token) out.push(cur);
    for (const child of cur.children) {
      if (isNode(child)) visit(child);
    }
  };
  visit(node);
  return out;
}

/** The atom values of a node's leaf children, in order (lists skipped). */
export function atomValues(node: SNode): string[] {
  return node.children.filter(isAtom).map((a) => a.atom);
}

/** Parse a leaf atom as a finite number, or `undefined` if it isn't one. */
export function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = Number(value);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Read the leading numeric atoms of a node — e.g. `(at 1.2 -3.4 90)` →
 * `[1.2, -3.4, 90]`. Stops at the first non-numeric / nested child so a token
 * like `(start 1 2)` yields `[1, 2]` cleanly. Returns at most `count` entries
 * when `count` is given.
 */
export function leadingNums(node: SNode | undefined, count?: number): number[] {
  if (!node) return [];
  const out: number[] = [];
  for (const child of node.children) {
    if (!isAtom(child)) break;
    const v = num(child.atom);
    if (v === undefined) break;
    out.push(v);
    if (count !== undefined && out.length >= count) break;
  }
  return out;
}
