/**
 * Unit tests for the shared S-expression reader the previews are built on.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSexpr,
  childNodes,
  firstChild,
  findAll,
  leadingNums,
  isNode,
  isAtom,
} from '../preview-sexpr.js';

describe('parseSexpr', () => {
  it('parses a nested list with bare atoms and quoted strings', () => {
    const node = parseSexpr('(pad "1" smd rect (at -0.75 0.64 90) (size 0.28 0.68))')!;
    expect(node.token).toBe('pad');
    // Leaf atoms: "1", smd, rect (the (at …) / (size …) are nested lists).
    const atoms = node.children.filter(isAtom).map((a) => a.atom);
    expect(atoms).toEqual(['1', 'smd', 'rect']);
    const at = firstChild(node, 'at')!;
    expect(leadingNums(at)).toEqual([-0.75, 0.64, 90]);
  });

  it('preserves quoted strings containing spaces and escapes', () => {
    const node = parseSexpr('(property "Some Name" "a \\"quoted\\" value")')!;
    const atoms = node.children.filter(isAtom).map((a) => a.atom);
    expect(atoms[0]).toBe('Some Name');
    expect(atoms[1]).toBe('a "quoted" value');
  });

  it('tolerates arbitrary whitespace and newlines', () => {
    const node = parseSexpr('(\n  foo\n   (bar 1)\n   (bar 2)\n)')!;
    expect(node.token).toBe('foo');
    expect(childNodes(node, 'bar')).toHaveLength(2);
  });

  it('findAll walks the whole tree depth-first', () => {
    const node = parseSexpr('(a (b (pin 1) (c (pin 2))) (pin 3))')!;
    const pins = findAll(node, 'pin');
    expect(pins).toHaveLength(3);
  });

  it('returns null when there is no list', () => {
    expect(parseSexpr('')).toBeNull();
    expect(parseSexpr('   ')).toBeNull();
    expect(parseSexpr('bare-atom-only')).toBeNull();
  });

  it('leadingNums stops at the first non-numeric child', () => {
    const node = parseSexpr('(at 1.5 -2 (layer "F.Cu"))')!;
    expect(leadingNums(node)).toEqual([1.5, -2]);
    expect(leadingNums(node, 1)).toEqual([1.5]);
  });

  it('isNode / isAtom discriminate children', () => {
    const node = parseSexpr('(x 1 (y 2))')!;
    expect(isAtom(node.children[0])).toBe(true);
    expect(isNode(node.children[1])).toBe(true);
  });
});
