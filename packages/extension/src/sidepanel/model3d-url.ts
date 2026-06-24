/**
 * Extract the EasyEDA 3D-model uuid from the converter's `model3dUrl`.
 *
 * The converter emits `https://easyeda.com/api/v2/components/{uuid}/3d`, where
 * `{uuid}` is a run of hex digits. The relay's `/easyeda/model-obj?uuid=…`
 * endpoint wants just that uuid. This is pure + DOM-free so it's unit-tested
 * directly, and it's tolerant: any string containing a hex run that looks like
 * an EasyEDA uuid works, and a bare uuid passes through unchanged.
 */

/** A plausible EasyEDA uuid: a longish run of hex (32 chars in practice). */
const HEX_RUN_RE = /[0-9a-fA-F]{8,}/;

/**
 * Return the hex uuid from a `model3dUrl`, or `null` when there isn't one.
 *
 * Accepts the canonical `…/components/{uuid}/3d` shape, a bare uuid, or any
 * string with an embedded hex run; rejects empty / non-hex input.
 */
export function uuidFromModelUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Prefer the explicit /components/{uuid}/3d segment when present.
  const m = url.match(/\/components\/([0-9a-fA-F]+)(?:\/3d)?/);
  if (m) return m[1];
  // Otherwise accept a bare uuid or any embedded hex run.
  const run = url.match(HEX_RUN_RE);
  return run ? run[0] : null;
}
