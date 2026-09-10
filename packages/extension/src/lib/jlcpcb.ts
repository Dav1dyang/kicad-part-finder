/**
 * Minimal JLCPCB search client — resolves a free-text MPN to candidate LCSC
 * parts (with package, stock, price, and category text for auto-sort).
 *
 * Routes through the user's deployed Cloudflare Worker relay (`relayBase`)
 * rather than calling JLCPCB directly: the browser gets HTTP 403 from JLCPCB's
 * WAF even with spoofed headers, but the Worker fetches server-side (200) and
 * returns the JSON verbatim with permissive CORS. Uses only `fetch`, so it runs
 * in a Manifest V3 service worker. When the user already has an LCSC id, the
 * side panel can skip this entirely and convert directly.
 *
 * `relayBase` is the Worker origin (e.g.
 * `https://kicad-part-relay.foo.workers.dev`, no trailing slash); the search
 * hits `${relayBase}/jlcpcb/search?keyword=...`.
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

/** How long one relay round-trip may take before it counts as failed. */
export const RELAY_TIMEOUT_MS = 20_000;

/** Trim a trailing slash so `${relayBase}/path` never doubles up. */
function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

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

/**
 * Outcome of a single JLCPCB keyword search: the normalised matches plus a
 * short human-readable `diagnostic` describing exactly what happened at the
 * network/parse layer. The diagnostic is what the UI surfaces when a search
 * comes back empty, so we stop guessing whether it's anti-bot blocking
 * (`http 403`), a CORS/network failure (`fetch threw: …`), an HTML challenge
 * page (`non-JSON body (…)`), or simply no catalog hits (`http 200, 0 results`).
 */
interface JlcSearchOutcome {
  matches: JlcMatch[];
  diagnostic: string;
}

/** Fetch + normalise one JLCPCB keyword search via the relay. Never throws —
 * failures are captured in the returned `diagnostic`, and `matches` is [] on any
 * error. `relayBase` is the deployed Worker origin (no trailing slash). */
async function searchJlc(query: string, relayBase: string): Promise<JlcSearchOutcome> {
  const endpoint = `${trimTrailingSlash(relayBase)}/jlcpcb/search?keyword=${encodeURIComponent(query)}`;

  let resp: Response;
  try {
    // GET the relay; the Worker does the real (server-side) JLCPCB POST and
    // returns the body verbatim with permissive CORS. A hung relay must not
    // leave the panel spinning forever, so every request has a deadline.
    resp = await fetch(endpoint, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  } catch (err) {
    // Network-layer failure: relay unreachable / wrong URL / offline (surfaced
    // as a generic "Failed to fetch"), or the deadline above.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { matches: [], diagnostic: 'timed out' };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { matches: [], diagnostic: `fetch threw: ${reason}` };
  }

  if (!resp.ok) {
    // The relay reached JLCPCB but it (or the relay) rejected us. The relay
    // mirrors the upstream status (e.g. 403 anti-bot, 5xx) and returns an
    // `{error,status}` envelope, so `http <status>` still pinpoints the cause.
    return { matches: [], diagnostic: `http ${resp.status}` };
  }

  // 200 OK — but the anti-bot layer can still return an HTML challenge page
  // with a 200, so confirm the body actually parses as JSON.
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    let snippet = '';
    try {
      snippet = (await resp.clone().text()).slice(0, 40);
    } catch {
      /* body already consumed / unavailable — leave snippet empty */
    }
    return { matches: [], diagnostic: `non-JSON body (${snippet})` };
  }

  const list = (data as { data?: { componentPageInfo?: { list?: unknown } } })?.data
    ?.componentPageInfo?.list;
  if (!Array.isArray(list)) {
    // Valid JSON but not the shape we expect (e.g. an error envelope) — treat
    // as zero results so the UI still nudges toward an exact LCSC#.
    return { matches: [], diagnostic: `http ${resp.status}, 0 results` };
  }

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

  // Exact MPN hits first (so "TPS2116DRLR" doesn't land on a higher-stock
  // sibling), then most-in-stock so the auto-selected candidate is orderable.
  const wanted = query.trim().toLowerCase();
  const exact = (m: JlcMatch) => (m.mpn.toLowerCase() === wanted ? 1 : 0);
  matches.sort((a, b) => exact(b) - exact(a) || b.stock - a.stock);
  return { matches, diagnostic: `http ${resp.status}, ${matches.length} results` };
}

/** Result of an MPN lookup, including which query actually produced the hits. */
export interface MpnResolution {
  matches: JlcMatch[];
  /** The query that returned `matches`; empty when nothing matched. */
  matchedQuery: string;
  /** True when `matchedQuery` is a relaxed fallback, not the original input. */
  relaxed: boolean;
  /**
   * Short human-readable description of the precise network/parse outcome of the
   * lookup — for surfacing the REAL failure in the UI instead of a generic "no
   * match". Reflects the FIRST (original-query) attempt, since that's what the
   * user typed and the most diagnostic when nothing comes back. Examples:
   * `"http 200, 1 results"`, `"http 403"`, `"fetch threw: Failed to fetch"`,
   * `"non-JSON body (<!DOCTYPE html><html lang=\"en\"><he)"`. Empty only for
   * blank input.
   */
  diagnostic: string;
}

/**
 * Resolve a free-text MPN to candidate LCSC parts via the relay, trying the
 * original query then progressively-relaxed fallbacks (see {@link relaxMpnQuery})
 * until one returns hits. Reports which query matched so callers can flag fuzzy
 * results, plus a `diagnostic` describing what actually happened on the wire
 * (status / JSON / results / thrown error) so a failed search can show the real
 * cause.
 *
 * @param mpn       free-text manufacturer part number (or LCSC id).
 * @param relayBase deployed Worker origin (e.g. `https://x.workers.dev`).
 */
export async function resolveMpnDetailed(
  mpn: string,
  relayBase: string,
): Promise<MpnResolution> {
  const original = (mpn ?? '').trim();
  if (!original) return { matches: [], matchedQuery: '', relaxed: false, diagnostic: '' };

  const queries = relaxMpnQuery(original);
  // Remember the original (first) query's outcome — it's the most informative
  // thing to show the user when every query ultimately comes back empty.
  let firstDiagnostic = '';
  for (const [i, query] of queries.entries()) {
    const { matches, diagnostic } = await searchJlc(query, relayBase);
    if (i === 0) firstDiagnostic = diagnostic;
    if (matches.length > 0) {
      return { matches, matchedQuery: query, relaxed: query !== original, diagnostic };
    }
  }
  return { matches: [], matchedQuery: '', relaxed: false, diagnostic: firstDiagnostic };
}

/**
 * Search JLCPCB (via the relay) for an MPN and return all matches with an LCSC
 * id, best (most in-stock) first. Tries relaxed fallbacks for near-miss MPNs.
 * Returns [] on any error or no results.
 */
export async function resolveMpnToLcsc(mpn: string, relayBase: string): Promise<JlcMatch[]> {
  return (await resolveMpnDetailed(mpn, relayBase)).matches;
}
