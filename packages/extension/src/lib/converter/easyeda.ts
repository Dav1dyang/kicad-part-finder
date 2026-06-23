/**
 * Browser-compatible EasyEDA -> KiCad convert core.
 *
 * Fetches a component's raw EasyEDA JSON and runs the vendored pure-JS parsers
 * (kicad-parser.ts, schematic-parser.ts) to produce KiCad `.kicad_sym` /
 * `.kicad_mod` text plus deterministic metadata.
 *
 * IMPORTANT — browser-service-worker safety: this module (and the whole
 * converter/ dir) uses ONLY `fetch` and pure JS. No `fs`, `path`,
 * `child_process`, axios, or any `node:` import — so it runs unchanged in Node
 * 20+ and a Manifest V3 service worker.
 */

import {
  parseEasyEDAFootprint,
  convertToKiCadFootprint,
  convertToKiCadSymbol,
  extract3DModelUUID,
} from './kicad-parser';
import { parseSchematicData } from './schematic-parser';

/** EasyEDA API version pinned by the upstream API (matches the rest of the repo). */
const EASYEDA_API_VERSION = '6.4.19.5';

/** Validates an LCSC part id, e.g. "C3235557". */
const LCSC_ID_RE = /^C\d+$/;

/** Metadata pulled deterministically from the EasyEDA component JSON. */
export interface ConvertMeta {
  lcsc: string;
  mpn: string;
  manufacturer: string;
  datasheet: string;
  package: string;
  description: string;
}

/** Result of {@link convertLcsc}. */
export interface ConvertResult {
  /** KiCad symbol library text (.kicad_sym). */
  symbol: string;
  /** KiCad footprint/module text (.kicad_mod). */
  footprint: string;
  /**
   * EasyEDA 3D-model UUID resolved to an absolute model URL, or null when the
   * component has no 3D model. NOTE: fetching/decoding this is a later
   * milestone — here we only surface the URL.
   */
  model3dUrl: string | null;
  /** Deterministic metadata extracted from the EasyEDA JSON. */
  meta: ConvertMeta;
}

/**
 * The `result` object returned by the EasyEDA components endpoint. Only the
 * fields the converter consumes are typed; everything else is passed through.
 */
export interface EasyedaResult {
  title?: string;
  description?: string;
  lcsc?: { number?: string };
  szlcsc?: { number?: string };
  /** Schematic-symbol document (object or JSON string). */
  dataStr?: any;
  /** Footprint document lives under packageDetail.dataStr (object or JSON string). */
  packageDetail?: { dataStr?: any };
}

/** First defined, non-empty string among the candidates (else ''). */
function firstNonEmpty(...candidates: Array<unknown>): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return '';
}

/** Parse an EasyEDA document that may arrive as an object or a JSON string. */
function parseEasyedaDoc(value: unknown): any | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

function requireEasyedaDoc(value: unknown, label: string, lcscId: string): any {
  const parsed = parseEasyedaDoc(value);
  if (!parsed) {
    throw new Error(`EasyEDA component ${lcscId} is missing ${label}`);
  }
  return parsed;
}

/**
 * Fetch the raw EasyEDA component JSON for an LCSC id and return its `.result`.
 *
 * Uses only `fetch`, so it works in Node 20+ and a browser service worker. In
 * Chrome extension service workers, `User-Agent` and `Referer` are forbidden
 * request headers and fetch() silently drops them; the required EasyEDA Referer
 * is injected by the static declarativeNetRequest rule in `rules.json`.
 *
 * @param lcscId LCSC part id, e.g. "C3235557". Must match /^C\d+$/.
 * @returns The parsed `result` object from the EasyEDA response.
 * @throws If the id is malformed, the HTTP request fails, or the payload has no
 *   successful `result`.
 */
export async function fetchEasyedaComponent(lcscId: string): Promise<EasyedaResult> {
  if (!LCSC_ID_RE.test(lcscId)) {
    throw new Error(`Invalid LCSC id: "${lcscId}" (expected format like "C3235557")`);
  }

  const url = `https://easyeda.com/api/products/${lcscId}/components?version=${EASYEDA_API_VERSION}`;

  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (!resp.ok) {
    throw new Error(`EasyEDA request failed for ${lcscId}: HTTP ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { success?: boolean; result?: EasyedaResult };
  if (!data.success || !data.result) {
    throw new Error(`EasyEDA returned no component for ${lcscId}`);
  }

  return data.result;
}

/**
 * Build the deterministic metadata block from an EasyEDA `result`.
 *
 * MPN / manufacturer / package come from `dataStr.head.c_para`; the LCSC id is
 * preferred from the response (`result.lcsc.number`) and falls back to the
 * caller-supplied id. The datasheet uses the footprint's `c_para.link` when
 * present, otherwise the canonical LCSC datasheet URL.
 */
export function extractMeta(result: EasyedaResult, lcscId: string): ConvertMeta {
  const schematicHead = parseEasyedaDoc(result.dataStr)?.head?.c_para ?? {};
  const footprintHead = parseEasyedaDoc(result.packageDetail?.dataStr)?.head?.c_para ?? {};

  const lcsc = firstNonEmpty(
    result.lcsc?.number,
    result.szlcsc?.number,
    schematicHead['Supplier Part'],
    lcscId,
  );

  const datasheet = firstNonEmpty(
    footprintHead['link'],
    schematicHead['link'],
    `https://www.lcsc.com/datasheet/${lcscId}.pdf`,
  );

  return {
    lcsc,
    mpn: firstNonEmpty(schematicHead['Manufacturer Part'], schematicHead['name'], result.title),
    manufacturer: firstNonEmpty(schematicHead['Manufacturer'], schematicHead['Supplier']),
    datasheet,
    package: firstNonEmpty(schematicHead['package'], footprintHead['package']),
    description: firstNonEmpty(result.description),
  };
}

/**
 * Run the vendored parsers over an already-fetched EasyEDA `result`. This is the
 * pure, network-free core of {@link convertLcsc} — it's what the offline fixture
 * test exercises.
 *
 * @param result EasyEDA `result` object (e.g. from {@link fetchEasyedaComponent}
 *   or a saved fixture).
 * @param lcscId LCSC id used for the footprint's "LCSC Part" property, metadata
 *   fallback, and the datasheet fallback URL.
 */
export function convertFromResult(result: EasyedaResult, lcscId: string): ConvertResult {
  // Schematic symbol lives in result.dataStr; footprint in packageDetail.dataStr.
  const schematicData = requireEasyedaDoc(result.dataStr, 'schematic dataStr', lcscId);
  const footprintData = requireEasyedaDoc(
    result.packageDetail?.dataStr,
    'footprint packageDetail.dataStr',
    lcscId,
  );

  // Metadata is computed first so the symbol exporter can stamp it into the
  // symbol's Value/Footprint/Datasheet/Manufacturer/MPN/LCSC properties.
  const meta = extractMeta(result, lcscId);

  const schematic = parseSchematicData(schematicData);
  const symbol = convertToKiCadSymbol(schematic, {
    mpn: meta.mpn,
    manufacturer: meta.manufacturer,
    datasheet: meta.datasheet,
    lcsc: meta.lcsc,
    package: meta.package,
  });

  const parsedFootprint = parseEasyEDAFootprint(footprintData);
  const footprint = convertToKiCadFootprint(
    parsedFootprint,
    parsedFootprint.originX,
    parsedFootprint.originY,
    lcscId,
  );

  const uuid3d = extract3DModelUUID(footprintData);
  const model3dUrl = uuid3d
    ? `https://easyeda.com/api/v2/components/${uuid3d}/3d`
    : null;

  return {
    symbol,
    footprint,
    model3dUrl,
    meta,
  };
}

/**
 * Fetch a component from EasyEDA by LCSC id and convert it to KiCad text.
 *
 * Public entry point for the convert core. Pure `fetch` + pure JS, so it runs in
 * Node 20+ and a Manifest V3 service worker alike.
 *
 * @param lcscId LCSC part id, e.g. "C3235557". Must match /^C\d+$/.
 * @returns `{ symbol, footprint, model3dUrl, meta }` — see {@link ConvertResult}.
 * @throws Propagates errors from {@link fetchEasyedaComponent}.
 */
export async function convertLcsc(lcscId: string): Promise<ConvertResult> {
  const result = await fetchEasyedaComponent(lcscId);
  return convertFromResult(result, lcscId);
}
