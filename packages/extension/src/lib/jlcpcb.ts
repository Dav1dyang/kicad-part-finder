/**
 * Minimal JLCPCB search client — resolves a free-text MPN to candidate LCSC
 * parts (with package, stock, price, and category text for auto-sort).
 *
 * Ported from the retired companion server's `/search` route. Uses only `fetch`,
 * so it runs in a Manifest V3 service worker (jlcpcb.com is in host_permissions,
 * which sidesteps CORS). When the user already has an LCSC id, the side panel can
 * skip this entirely and convert directly.
 */

/** A single JLCPCB search hit, normalised. */
export interface JlcMatch {
  mpn: string;
  lcscId: string;
  package: string;
  stock: number;
  price: number | null;
  /** Free-text category (e.g. "Power Management ICs") used for auto-sort. */
  category: string;
  lcscUrl: string;
}

const JLC_ENDPOINT =
  'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function lcscIdFromItem(item: Record<string, unknown>): string {
  const candidates = [
    asString(item.lcscGoodsUrl).match(/(C\d+)\.html/)?.[1],
    asString(item.componentCode),
    asString(item.lcscComponentCode),
  ];
  return candidates.find((c) => /^C\d+$/.test(c ?? '')) ?? '';
}

/** Pure LCSC id, e.g. `C3235557` — these are exact and must never be relaxed. */
const LCSC_ID_RE = /^C\d+$/i;

/**
 * Produce progressively-relaxed search queries for a free-text MPN, most-specific
 * first. The original string is always first; later entries broaden the search so
 * a near-miss like `TPS2116A` (no such catalog string) can still surface `TPS2116`.
 *
 * Relaxations applied (in order), de-duped, capped at 3 queries:
 *   1. the original query, trimmed;
 *   2. drop a trailing run of letters that follows a digit (TPS2116A → TPS2116) —
 *      catches grade/variant suffixes appended after the numeric part;
 *   3. the leading alphanumeric stem up to the first separator (`-`, `_`, `/`,
 *      `.`, space), e.g. `LM358DR-foo` → `LM358DR`.
 *
 * Pure LCSC ids are returned verbatim (`[q]`) — they're exact lookups.
 */
export function relaxMpnQuery(q: string): string[] {
  const original = (q ?? '').trim();
  if (!original) return [];

  // Never relax a pure LCSC id — it's an exact catalog key.
  if (LCSC_ID_RE.test(original)) return [original];

  const out: string[] = [original];

  // Strip a trailing letter run that immediately follows a digit (grade/variant
  // suffix): TPS2116A → TPS2116, LM358DR → LM358 (the leading digit is preserved).
  const noSuffix = original.replace(/(\d)[A-Za-z]+$/, '$1');
  if (noSuffix !== original) out.push(noSuffix);

  // Leading alphanumeric stem up to the first separator.
  const stem = original.match(/^[A-Za-z0-9]+/)?.[0] ?? '';
  if (stem) out.push(stem);

  // De-dupe (preserving order) and cap at ~3 queries.
  return [...new Set(out)].slice(0, 3);
}

/** Fetch + normalise one JLCPCB keyword search. Returns [] on any error. */
async function searchJlc(query: string): Promise<JlcMatch[]> {
  let data: unknown;
  try {
    const resp = await fetch(JLC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: query, pageSize: 15, currentPage: 1 }),
    });
    if (!resp.ok) return [];
    data = await resp.json();
  } catch {
    return [];
  }

  const list = (data as { data?: { componentPageInfo?: { list?: unknown } } })?.data
    ?.componentPageInfo?.list;
  if (!Array.isArray(list)) return [];

  const matches: JlcMatch[] = list
    .map((raw): JlcMatch => {
      const item = raw as Record<string, unknown>;
      const lcscUrl = asString(item.lcscGoodsUrl);
      const lcscId = lcscIdFromItem(item);
      const prices = Array.isArray(item.componentPrices) ? item.componentPrices : [];

      // JLCPCB returns first/second-level category names; join the non-empty ones.
      const category = [
        item.firstSortAccordingNameEn,
        item.secondSortAccordingNameEn,
        item.componentLibraryType,
      ]
        .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        .join(' / ');

      return {
        mpn: asString(item.componentModelEn),
        lcscId,
        package: asString(item.componentSpecificationEn),
        stock: asNumber(item.stockCount),
        price: prices.length
          ? asNumberOrNull((prices[0] as Record<string, unknown>).productPrice)
          : null,
        category,
        lcscUrl,
      };
    })
    .filter((m) => m.mpn && m.lcscId);

  // Most-in-stock first so the auto-selected candidate is the orderable one.
  matches.sort((a, b) => b.stock - a.stock);
  return matches;
}

/** Result of an MPN lookup, including which query actually produced the hits. */
export interface MpnResolution {
  matches: JlcMatch[];
  /** The query that returned `matches`; empty when nothing matched. */
  matchedQuery: string;
  /** True when `matchedQuery` is a relaxed fallback, not the original input. */
  relaxed: boolean;
}

/**
 * Resolve a free-text MPN to candidate LCSC parts, trying the original query then
 * progressively-relaxed fallbacks (see {@link relaxMpnQuery}) until one returns
 * hits. Reports which query matched so callers can flag fuzzy results.
 */
export async function resolveMpnDetailed(mpn: string): Promise<MpnResolution> {
  const original = (mpn ?? '').trim();
  if (!original) return { matches: [], matchedQuery: '', relaxed: false };

  const queries = relaxMpnQuery(original);
  for (const query of queries) {
    const matches = await searchJlc(query);
    if (matches.length > 0) {
      return { matches, matchedQuery: query, relaxed: query !== original };
    }
  }
  return { matches: [], matchedQuery: '', relaxed: false };
}

/**
 * Search JLCPCB for an MPN and return all matches with an LCSC id, best (most
 * in-stock) first. Tries relaxed fallbacks for near-miss MPNs. Returns [] on any
 * error or no results.
 */
export async function resolveMpnToLcsc(mpn: string): Promise<JlcMatch[]> {
  return (await resolveMpnDetailed(mpn)).matches;
}
