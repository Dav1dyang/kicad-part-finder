/**
 * kicad-part-relay: a stateless proxy for the KiCad Part Finder extension.
 *
 * JLCPCB and EasyEDA answer HTTP 403 to requests from a browser extension,
 * even with spoofed headers. The same requests made server-side succeed, so
 * this Worker makes them and hands the body back with permissive CORS.
 *
 * Endpoints (GET; the same paths also work under /api for Vercel):
 *   /                            health check: "kicad-part-relay ok v<version>"
 *   /jlcpcb/search?keyword=X     JLCPCB parts search (JSON, verbatim)
 *   /easyeda/component?lcsc=C1   EasyEDA symbol + footprint data (JSON, verbatim)
 *   /easyeda/model?uuid=HEX      STEP model (bytes, streamed)
 *   /easyeda/model-obj?uuid=HEX  OBJ model for the 3D preview (text)
 *
 * No bindings, secrets, or storage.
 */

/**
 * Bump when an endpoint is added or changes shape. The extension compares it
 * with the version it needs and asks the user to redeploy an older relay.
 */
export const RELAY_VERSION = 2;

export const HEALTH_TEXT = `kicad-part-relay ok v${RELAY_VERSION}`;

/** A normal desktop Chrome user agent; the upstream WAFs expect a browser. */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** EasyEDA API version the component endpoint is pinned to. */
const EASYEDA_API_VERSION = '6.4.19.5';

/** Upstream deadline. Shorter than the extension's own 20 s so the relay answers first. */
const UPSTREAM_TIMEOUT_MS = 15_000;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/** How long browsers and the edge may keep each kind of answer. */
const CACHE = {
  /** Stock and price move; keep searches fresh. */
  search: 'public, max-age=300',
  /** Symbol and footprint data rarely change. */
  component: 'public, max-age=3600, s-maxage=86400',
  /** Models are addressed by content uuid, so they never change. */
  model: 'public, max-age=604800, immutable',
};

const LCSC_ID_RE = /^C\d{1,12}$/;
const UUID_RE = /^[0-9a-fA-F]{8,64}$/;
const MAX_KEYWORD_LENGTH = 100;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/** Error envelope the extension understands: `{ error, status }` at that status. */
function fail(error: string, status: number): Response {
  return json({ error, status }, status);
}

interface ProxyOptions {
  label: string;
  init: RequestInit;
  cache: string;
  /** Force a content type (the OBJ store sends octet-stream). */
  contentType?: string;
  /** Stream the body instead of buffering it (large STEP files). */
  stream?: boolean;
}

/** Fetch upstream with a deadline and relay the answer, or a clear error. */
async function proxy(endpoint: string, opts: ProxyOptions): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(endpoint, { ...opts.init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return timedOut
      ? fail(`${opts.label} did not answer in ${UPSTREAM_TIMEOUT_MS / 1000} s`, 504)
      : fail(`${opts.label} fetch failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  if (!resp.ok) return fail(`${opts.label} upstream HTTP ${resp.status}`, resp.status);

  const headers = {
    'Content-Type': opts.contentType ?? resp.headers.get('Content-Type') ?? 'application/octet-stream',
    'Cache-Control': opts.cache,
    ...CORS_HEADERS,
  };
  return new Response(opts.stream ? resp.body : await resp.text(), { status: 200, headers });
}

export function handleJlcpcbSearch(url: URL): Promise<Response> | Response {
  const keyword = (url.searchParams.get('keyword') ?? '').trim();
  if (!keyword) return fail('missing keyword', 400);
  if (keyword.length > MAX_KEYWORD_LENGTH) return fail('keyword too long', 400);
  return proxy('https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList', {
    label: 'jlcpcb',
    cache: CACHE.search,
    contentType: 'application/json',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': DESKTOP_UA,
        Referer: 'https://jlcpcb.com/',
        Origin: 'https://jlcpcb.com',
      },
      body: JSON.stringify({ keyword, pageSize: 15, currentPage: 1 }),
    },
  });
}

export function handleEasyedaComponent(url: URL): Promise<Response> | Response {
  const lcsc = url.searchParams.get('lcsc') ?? '';
  if (!LCSC_ID_RE.test(lcsc)) return fail(`invalid lcsc id: "${lcsc}" (expected like "C3235557")`, 400);
  return proxy(`https://easyeda.com/api/products/${lcsc}/components?version=${EASYEDA_API_VERSION}`, {
    label: 'easyeda',
    cache: CACHE.component,
    contentType: 'application/json',
    init: {
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': DESKTOP_UA,
        Referer: 'https://easyeda.com/',
      },
    },
  });
}

/** STEP and OBJ live in two different EasyEDA stores. */
function handleModel(url: URL, kind: 'step' | 'obj'): Promise<Response> | Response {
  const uuid = url.searchParams.get('uuid') ?? '';
  if (!UUID_RE.test(uuid)) return fail(`invalid uuid: "${uuid}" (expected hex)`, 400);
  const store = kind === 'step' ? 'qAxj6KHrDKw4blvCG8QJPs7Y' : '3dmodel';
  return proxy(`https://modules.easyeda.com/${store}/${uuid}`, {
    label: kind === 'step' ? 'easyeda model' : 'easyeda model-obj',
    cache: CACHE.model,
    contentType: kind === 'obj' ? 'text/plain; charset=utf-8' : undefined,
    stream: kind === 'step',
    init: { headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://easyeda.com/' } },
  });
}

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/';

  if (path === '/') {
    return new Response(HEALTH_TEXT, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
    });
  }
  if (request.method !== 'GET') return fail(`method not allowed: ${request.method}`, 405);

  try {
    switch (path) {
      case '/jlcpcb/search':
        return await handleJlcpcbSearch(url);
      case '/easyeda/component':
        return await handleEasyedaComponent(url);
      case '/easyeda/model':
        return await handleModel(url, 'step');
      case '/easyeda/model-obj':
        return await handleModel(url, 'obj');
      default:
        return fail(`not found: ${path}`, 404);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

export default {
  fetch: (request: Request): Promise<Response> => handleRequest(request),
};
