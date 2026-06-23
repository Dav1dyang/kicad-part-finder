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

/**
 * Search JLCPCB for an MPN and return all matches with an LCSC id, best (most
 * in-stock) first. Returns [] on any error or no results.
 */
export async function resolveMpnToLcsc(mpn: string): Promise<JlcMatch[]> {
  const query = (mpn ?? '').trim();
  if (!query) return [];

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
      const lcscUrl = (item.lcscGoodsUrl as string) || '';
      const lcscMatch = lcscUrl.match(/(C\d+)\.html/);
      const prices = item.componentPrices as
        | Array<{ productPrice: number; startNumber: number }>
        | undefined;

      // JLCPCB returns first/second-level category names; join the non-empty ones.
      const category = [
        item.firstSortAccordingNameEn,
        item.secondSortAccordingNameEn,
        item.componentLibraryType,
      ]
        .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        .join(' / ');

      return {
        mpn: (item.componentModelEn as string) || '',
        lcscId: lcscMatch?.[1] || '',
        package: (item.componentSpecificationEn as string) || '',
        stock: (item.stockCount as number) || 0,
        price: prices?.[0]?.productPrice ?? null,
        category,
        lcscUrl,
      };
    })
    .filter((m) => m.mpn && m.lcscId);

  // Most-in-stock first so the auto-selected candidate is the orderable one.
  matches.sort((a, b) => b.stock - a.stock);
  return matches;
}
