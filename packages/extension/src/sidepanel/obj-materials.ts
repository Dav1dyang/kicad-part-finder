/**
 * EasyEDA 3D models are OBJ files with their material library written inline:
 *
 *   newmtl mat3
 *   Kd 0.78 0.55 0.18      diffuse colour, 0..1
 *   d 1                    opacity
 *   endmtl
 *   ...
 *   usemtl mat3
 *   f 1 2 3
 *
 * three's OBJLoader keeps each `usemtl` group as a named material but cannot
 * read the inline library, so the colours are parsed here and applied by name.
 * Pure and DOM-free.
 */

export interface ObjMaterial {
  /** Diffuse colour as [r, g, b], each 0..1. */
  color: [number, number, number];
  /** 1 = opaque. */
  opacity: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Read every `newmtl … endmtl` block. Later blocks win on a repeated name. */
export function parseInlineMaterials(objText: string): Map<string, ObjMaterial> {
  const out = new Map<string, ObjMaterial>();
  let name: string | null = null;
  let current: ObjMaterial | null = null;
  const commit = () => {
    if (name && current) out.set(name, current);
    name = null;
    current = null;
  };
  for (const raw of objText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('newmtl ')) {
      commit();
      name = line.slice(7).trim();
      current = { color: [0.6, 0.6, 0.6], opacity: 1 };
    } else if (current) {
      const [key, ...vals] = line.split(/\s+/);
      if (key === 'Kd' && vals.length >= 3) {
        current.color = [clamp01(Number(vals[0])), clamp01(Number(vals[1])), clamp01(Number(vals[2]))];
      } else if (key === 'd' && vals.length >= 1) {
        current.opacity = clamp01(Number(vals[0]));
      } else if (key === 'Tr' && vals.length >= 1) {
        current.opacity = 1 - clamp01(Number(vals[0]));
      } else if (key === 'endmtl') {
        commit();
      }
    }
  }
  commit();
  return out;
}

/** Lines OBJLoader understands: geometry, groups, and `usemtl` (kept so colours map by name). */
const OBJ_LINE = /^(vn|vt|vp|v|f|l|p|o|g|s|usemtl)\b/;

/**
 * Drop the inline material library (and EasyEDA's non-standard `endmtl`) so the
 * loader sees plain geometry plus `usemtl` group names.
 */
export function stripInlineMaterials(objText: string): string {
  return objText
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t === '' || t.startsWith('#') || OBJ_LINE.test(t);
    })
    .join('\n');
}
