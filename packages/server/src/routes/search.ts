/**
 * Search route — proxies MPN searches through the server to avoid CORS issues.
 * Returns EasyEDA library availability + LCSC/JLCPCB stock data and variants.
 */

import type { FastifyInstance } from 'fastify';
import { fetchEasyedaComponent } from '../lib/easyeda-client.js';

interface SearchQuery {
  mpn?: string;
  lcscId?: string;
}

/** Stock info for a single variant */
interface VariantInfo {
  mpn: string;
  package: string;
  stock: number;
  price: number | null;
  lcscId: string;
  lcscUrl: string;
}

interface SearchResult {
  found: boolean;
  lcscId?: string;
  title?: string;
  hasSymbol: boolean;
  hasFootprint: boolean;
  has3DModel: boolean;
  /** Stock count for the primary match */
  stock?: number;
  /** Unit price (qty 1) for the primary match */
  price?: number;
  /** Package type for the primary match */
  package?: string;
  /** Related variants / alternative packages with stock > 0 */
  variants?: VariantInfo[];
}

export function registerSearchRoute(app: FastifyInstance) {
  app.get<{ Querystring: SearchQuery }>('/search', async (request): Promise<SearchResult> => {
    const { mpn, lcscId } = request.query;

    const empty: SearchResult = { found: false, hasSymbol: false, hasFootprint: false, has3DModel: false };

    // Search JLCPCB for stock, pricing, variants, and LCSC ID
    const jlcpcbResults = mpn ? await searchJlcpcb(mpn) : [];

    let resolvedLcscId = lcscId;
    let primaryVariant: VariantInfo | undefined;

    if (jlcpcbResults.length > 0) {
      // First result with stock is the primary match
      primaryVariant = jlcpcbResults.find(v => v.stock > 0) || jlcpcbResults[0];
      if (!resolvedLcscId && primaryVariant.lcscId) {
        resolvedLcscId = primaryVariant.lcscId;
      }
    }

    // If we still have no LCSC ID, we can't check EasyEDA
    if (!resolvedLcscId) return empty;

    // Fetch EasyEDA library availability
    const component = await fetchEasyedaComponent(resolvedLcscId);

    // Build variants list — only include in-stock items, exclude the primary match
    const variants = jlcpcbResults
      .filter(v => v.stock > 0 && v.lcscId !== resolvedLcscId)
      .slice(0, 8); // Cap at 8 variants

    return {
      found: true,
      lcscId: resolvedLcscId,
      title: component?.title || primaryVariant?.mpn || mpn,
      hasSymbol: component?.hasSymbol ?? false,
      hasFootprint: component?.hasFootprint ?? false,
      has3DModel: component?.has3DModel ?? false,
      stock: primaryVariant?.stock,
      price: primaryVariant?.price ?? undefined,
      package: primaryVariant?.package || undefined,
      variants: variants.length > 0 ? variants : undefined,
    };
  });
}

/** Search JLCPCB for components — returns all matches with stock/price/package info */
async function searchJlcpcb(mpn: string): Promise<VariantInfo[]> {
  try {
    const resp = await fetch(
      'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: mpn, pageSize: 15, currentPage: 1 }),
      }
    );
    if (!resp.ok) return [];

    const data = (await resp.json()) as { data?: { componentPageInfo?: { list?: unknown } } };
    const list = data?.data?.componentPageInfo?.list;
    if (!Array.isArray(list)) return [];

    return list.map((item: Record<string, unknown>): VariantInfo => {
      const lcscUrl = (item.lcscGoodsUrl as string) || '';
      const lcscMatch = lcscUrl.match(/(C\d+)\.html/);
      const prices = item.componentPrices as Array<{ productPrice: number; startNumber: number }> | undefined;

      return {
        mpn: (item.componentModelEn as string) || '',
        package: (item.componentSpecificationEn as string) || '',
        stock: (item.stockCount as number) || 0,
        price: prices?.[0]?.productPrice ?? null,
        lcscId: lcscMatch?.[1] || '',
        lcscUrl,
      };
    }).filter((v: VariantInfo) => v.mpn && v.lcscId); // Filter out items without MPN or LCSC ID
  } catch {
    return [];
  }
}

