import { describe, expect, it } from 'vitest';
import { parseInlineMaterials, stripInlineMaterials } from '../obj-materials';

// Shape of an EasyEDA model: an inline library, then geometry grouped by usemtl.
const OBJ = `# EasyEDA
newmtl body
Ka 0.2 0.2 0.2
Kd 0.12 0.12 0.13
Ks 0.5 0.5 0.5
d 1
endmtl
newmtl pins
Kd 0.86 0.75 0.42
d 0.5
endmtl
v 0 0 0
v 1 0 0
v 0 1 0
v 1 1 0
usemtl body
f 1 2 3
usemtl pins
f 2 4 3
`;

describe('parseInlineMaterials', () => {
  it('reads diffuse colour and opacity per material', () => {
    const mats = parseInlineMaterials(OBJ);
    expect(mats.get('body')).toEqual({ color: [0.12, 0.12, 0.13], opacity: 1 });
    expect(mats.get('pins')).toEqual({ color: [0.86, 0.75, 0.42], opacity: 0.5 });
  });

  it('handles a missing endmtl, Tr, and junk values', () => {
    const mats = parseInlineMaterials('newmtl a\nKd 2 -1 x\nTr 0.25\nnewmtl b\nKd 0 0 1\n');
    expect(mats.get('a')).toEqual({ color: [1, 0, 0], opacity: 0.75 });
    expect(mats.get('b')?.color).toEqual([0, 0, 1]);
  });

  it('returns nothing for a plain OBJ', () => {
    expect(parseInlineMaterials('v 0 0 0\nf 1 1 1\n').size).toBe(0);
  });
});

describe('stripInlineMaterials', () => {
  it('keeps geometry and usemtl, drops the inline library', () => {
    const out = stripInlineMaterials(OBJ);
    expect(out).not.toMatch(/newmtl|endmtl|Kd|Ka|Ks|^d /m);
    expect(out).toMatch(/^usemtl body$/m);
    expect(out).toMatch(/^usemtl pins$/m);
    expect(out.match(/^v /gm)).toHaveLength(4);
    expect(out.match(/^f /gm)).toHaveLength(2);
  });
});
