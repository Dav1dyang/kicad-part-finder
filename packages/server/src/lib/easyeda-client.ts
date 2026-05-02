/**
 * Thin client for EasyEDA's unofficial component API.
 *
 * Used by both the search route (to report library availability) and the
 * install converter (as a pre-flight check before invoking easyeda2kicad).
 */

const EASYEDA_API_VERSION = '6.4.19.5';

export interface EasyedaComponent {
  title: string;
  hasSymbol: boolean;
  hasFootprint: boolean;
  has3DModel: boolean;
}

export type EasyedaPreflight =
  | { status: 'ok'; component: EasyedaComponent }
  | { status: 'not_found' }
  | { status: 'unreachable'; reason: string };

/** Fetch component metadata. Returns null on any failure. */
export async function fetchEasyedaComponent(lcscId: string): Promise<EasyedaComponent | null> {
  const result = await preflightEasyeda(lcscId);
  return result.status === 'ok' ? result.component : null;
}

/** Detailed pre-flight: distinguishes "API down" from "part not in library". */
export async function preflightEasyeda(lcscId: string): Promise<EasyedaPreflight> {
  let resp: Response;
  try {
    resp = await fetch(
      `https://easyeda.com/api/products/${lcscId}/components?version=${EASYEDA_API_VERSION}`,
    );
  } catch (err) {
    return { status: 'unreachable', reason: err instanceof Error ? err.message : 'fetch failed' };
  }

  if (!resp.ok) {
    return { status: 'unreachable', reason: `HTTP ${resp.status}` };
  }

  let data: { success?: boolean; result?: Record<string, unknown> };
  try {
    data = (await resp.json()) as { success?: boolean; result?: Record<string, unknown> };
  } catch {
    return { status: 'unreachable', reason: 'non-JSON response' };
  }

  if (!data.success || !data.result) {
    return { status: 'not_found' };
  }

  const r = data.result as Record<string, unknown>;
  const packageDetail = r.packageDetail as Record<string, unknown> | undefined;
  return {
    status: 'ok',
    component: {
      title: (r.title as string) || '',
      hasSymbol: !!r.dataStr && typeof r.dataStr === 'object',
      hasFootprint: !!packageDetail?.dataStr && typeof packageDetail.dataStr === 'object',
      has3DModel: !!packageDetail,
    },
  };
}
