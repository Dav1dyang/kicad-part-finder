/**
 * EasyEDA/LCSC API client — fetches component data for KiCad conversion.
 * No authentication required. These are unofficial but stable endpoints.
 *
 * API response format for /api/products/{lcscId}/components:
 *   { success: true, result: { uuid, title, dataStr: {}, packageDetail: { dataStr: {} } } }
 * Note: result is a SINGLE object, not an array. dataStr fields are objects, not strings.
 */

import { EASYEDA_API } from '@kicad-part-finder/shared';
import type { ComponentAvailability } from '@kicad-part-finder/shared';

/** Parsed component data from EasyEDA */
export interface EasyEDAComponent {
  title: string;
  description: string;
  hasSymbol: boolean;
  hasFootprint: boolean;
  has3DModel: boolean;
  lcscId: string;
}

/** Search JLCPCB by MPN to find LCSC ID */
export async function searchByMpn(mpn: string): Promise<string | null> {
  try {
    // Use JLCPCB's search API which is more reliable than EasyEDA's
    const resp = await fetch(
      'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: mpn,
          pageSize: 5,
          currentPage: 1,
        }),
      }
    );
    if (!resp.ok) return null;

    const data = await resp.json();
    const list = data?.data?.componentPageInfo?.list;
    if (Array.isArray(list) && list.length > 0) {
      // Extract LCSC ID from the URL or componentCode
      const first = list[0];
      const lcscUrl = first.lcscGoodsUrl as string | undefined;
      if (lcscUrl) {
        const match = lcscUrl.match(/(C\d+)\.html/);
        if (match) return match[1];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch component data from EasyEDA by LCSC ID */
export async function fetchComponentByLcscId(lcscId: string): Promise<EasyEDAComponent | null> {
  try {
    const resp = await fetch(EASYEDA_API.componentByLcsc(lcscId));
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.success || !data.result) return null;

    // result is a single object, not an array
    const component = data.result;

    const hasSymbol = !!component.dataStr && typeof component.dataStr === 'object';
    const hasFootprint = !!component.packageDetail?.dataStr &&
      typeof component.packageDetail.dataStr === 'object';
    // 3D model: check if packageDetail exists (easyeda2kicad can extract the model)
    const has3DModel = hasFootprint; // If footprint exists, 3D model is usually available

    return {
      title: component.title || '',
      description: component.description || '',
      hasSymbol,
      hasFootprint,
      has3DModel,
      lcscId,
    };
  } catch {
    return null;
  }
}

/** Check availability across EasyEDA for a given MPN or LCSC ID */
export async function checkAvailability(
  mpn: string,
  lcscId?: string
): Promise<ComponentAvailability & { resolvedLcscId?: string }> {
  let component: EasyEDAComponent | null = null;
  let resolvedLcscId = lcscId;

  // If we have an LCSC ID, fetch directly
  if (lcscId) {
    component = await fetchComponentByLcscId(lcscId);
  }

  // If no LCSC ID or fetch failed, try searching by MPN
  if (!component) {
    const foundLcscId = await searchByMpn(mpn);
    if (foundLcscId) {
      resolvedLcscId = foundLcscId;
      component = await fetchComponentByLcscId(foundLcscId);
    }
  }

  if (component) {
    return {
      source: 'easyeda',
      hasSymbol: component.hasSymbol,
      hasFootprint: component.hasFootprint,
      has3DModel: component.has3DModel,
      resolvedLcscId,
    };
  }

  return {
    source: 'easyeda',
    hasSymbol: false,
    hasFootprint: false,
    has3DModel: false,
  };
}
