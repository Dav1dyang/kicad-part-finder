/**
 * kicad-part-relay — a Cloudflare Worker that proxies the JLCPCB and EasyEDA
 * APIs for the KiCad Part Finder browser extension.
 *
 * WHY THIS EXISTS: the extension's MV3 service worker / side panel get HTTP 403
 * from the JLCPCB and EasyEDA WAFs even with spoofed `Referer`/`User-Agent`
 * (browser fetches are fingerprinted; the declarativeNetRequest header hack is
 * no longer enough). Server-side fetches with a plain desktop Chrome UA + the
 * right Referer sail through (curl -> 200). So this Worker performs the real
 * upstream fetch and hands the body back to the extension with permissive CORS.
 *
 * Endpoints (all GET):
 *   GET /jlcpcb/search?keyword=X     -> JLCPCB SMT component search (JSON verbatim)
 *   GET /easyeda/component?lcsc=C123 -> EasyEDA component JSON (verbatim)
 *   GET /easyeda/model?uuid=HEX      -> EasyEDA STEP model bytes (streamed)
 *   GET /easyeda/model-obj?uuid=HEX  -> EasyEDA OBJ 3D model text (for previews)
 *   GET /                            -> "kicad-part-relay ok" (text/plain)
 *
 * No bindings, no secrets, no state — a pure stateless proxy.
 */

/** A normal desktop Chrome UA so the upstream WAFs treat us as a browser. */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** EasyEDA API version pinned by the upstream API (matches the extension). */
const EASYEDA_API_VERSION = '6.4.19.5';

/** Permissive CORS headers attached to EVERY response (incl. errors + preflight). */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/** Validates an LCSC part id, e.g. "C3235557". */
const LCSC_ID_RE = /^C\d+$/;

/** Validates an EasyEDA 3D-model uuid — a run of hex digits. */
const HEX_RE = /^[0-9a-fA-F]+$/;

/** JSON response with CORS headers merged in. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/** Plain-text response with CORS headers merged in. */
function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
  });
}

/** Standard upstream-error envelope: `{ error, status }` at the upstream status. */
function upstreamError(error: string, status: number): Response {
  return json({ error, status }, status);
}

/**
 * GET /jlcpcb/search?keyword=X
 *
 * Server-side POST to the JLCPCB SMT component search with the same JSON body
 * the extension used to send directly. Returns JLCPCB's JSON body verbatim.
 */
export async function handleJlcpcbSearch(url: URL): Promise<Response> {
  const keyword = url.searchParams.get('keyword') ?? '';
  if (!keyword.trim()) {
    return upstreamError('missing keyword', 400);
  }

  const endpoint =
    'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': DESKTOP_UA,
        Referer: 'https://jlcpcb.com/',
        Origin: 'https://jlcpcb.com',
      },
      body: JSON.stringify({ keyword, pageSize: 15, currentPage: 1 }),
    });
  } catch (err) {
    return upstreamError(
      `jlcpcb fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  if (!resp.ok) {
    return upstreamError(`jlcpcb upstream HTTP ${resp.status}`, resp.status);
  }

  // Return the body verbatim, preserving the upstream Content-Type when present.
  const bodyText = await resp.text();
  const contentType = resp.headers.get('Content-Type') ?? 'application/json';
  return new Response(bodyText, {
    status: 200,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS },
  });
}

/**
 * GET /easyeda/component?lcsc=C123
 *
 * Server-side GET of the EasyEDA component endpoint for an LCSC id. Returns the
 * EasyEDA JSON verbatim. Validates `lcsc` matches /^C\d+$/.
 */
export async function handleEasyedaComponent(url: URL): Promise<Response> {
  const lcsc = url.searchParams.get('lcsc') ?? '';
  if (!LCSC_ID_RE.test(lcsc)) {
    return upstreamError(`invalid lcsc id: "${lcsc}" (expected like "C3235557")`, 400);
  }

  const endpoint = `https://easyeda.com/api/products/${lcsc}/components?version=${EASYEDA_API_VERSION}`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': DESKTOP_UA,
        Referer: 'https://easyeda.com/',
      },
    });
  } catch (err) {
    return upstreamError(
      `easyeda fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  if (!resp.ok) {
    return upstreamError(`easyeda upstream HTTP ${resp.status}`, resp.status);
  }

  const bodyText = await resp.text();
  const contentType = resp.headers.get('Content-Type') ?? 'application/json';
  return new Response(bodyText, {
    status: 200,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS },
  });
}

/**
 * GET /easyeda/model?uuid=HEX
 *
 * Server-side GET of the EasyEDA STEP model store; streams the bytes back with
 * the upstream Content-Type. Validates uuid is hex.
 */
export async function handleEasyedaModel(url: URL): Promise<Response> {
  const uuid = url.searchParams.get('uuid') ?? '';
  if (!HEX_RE.test(uuid)) {
    return upstreamError(`invalid uuid: "${uuid}" (expected hex)`, 400);
  }

  const endpoint = `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${uuid}`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Referer: 'https://easyeda.com/',
      },
    });
  } catch (err) {
    return upstreamError(
      `easyeda model fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  if (!resp.ok) {
    return upstreamError(`easyeda model upstream HTTP ${resp.status}`, resp.status);
  }

  // Stream the model bytes straight back, preserving the upstream Content-Type.
  const contentType = resp.headers.get('Content-Type') ?? 'application/octet-stream';
  return new Response(resp.body, {
    status: 200,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS },
  });
}

/**
 * GET /easyeda/model-obj?uuid=HEX
 *
 * Server-side GET of EasyEDA's OBJ 3D-model store (a DIFFERENT store than the
 * STEP one above: `/3dmodel/{uuid}` vs `/qAxj…/{uuid}`). Returns the OBJ as text
 * so the side panel can render a lightweight three.js preview without the heavy
 * STEP→mesh decode the install path needs. Validates uuid is hex.
 *
 * The upstream serves the OBJ with `Content-Type: application/octet-stream`, so
 * we normalize it to `text/plain` for the browser fetch — the bytes are the
 * same verbatim OBJ text either way.
 */
export async function handleEasyedaModelObj(url: URL): Promise<Response> {
  const uuid = url.searchParams.get('uuid') ?? '';
  if (!HEX_RE.test(uuid)) {
    return upstreamError(`invalid uuid: "${uuid}" (expected hex)`, 400);
  }

  const endpoint = `https://modules.easyeda.com/3dmodel/${uuid}`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Referer: 'https://easyeda.com/',
      },
    });
  } catch (err) {
    return upstreamError(
      `easyeda model-obj fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  if (!resp.ok) {
    return upstreamError(`easyeda model-obj upstream HTTP ${resp.status}`, resp.status);
  }

  // Return the OBJ text verbatim with a text content-type (the upstream sends
  // octet-stream). Read as text so CORS + content-type are unambiguous.
  const body = await resp.text();
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, _env: unknown): Promise<Response> {
    // CORS preflight — answer every OPTIONS with 204 + permissive headers.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    // On Vercel the same handlers are mounted under `/api` (see api/*.ts), so
    // accept both `/jlcpcb/search` and `/api/jlcpcb/search`.
    const pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

    // Health check / root.
    if (pathname === '/') {
      return text('kicad-part-relay ok');
    }

    // All real endpoints are GET-only.
    if (request.method !== 'GET') {
      return upstreamError(`method not allowed: ${request.method}`, 405);
    }

    try {
      switch (pathname) {
        case '/jlcpcb/search':
          return await handleJlcpcbSearch(url);
        case '/easyeda/component':
          return await handleEasyedaComponent(url);
        case '/easyeda/model':
          return await handleEasyedaModel(url);
        case '/easyeda/model-obj':
          return await handleEasyedaModelObj(url);
        default:
          return upstreamError(`not found: ${pathname}`, 404);
      }
    } catch (err) {
      // Defensive catch-all — should be unreachable since each handler wraps its
      // own fetch, but guarantees a CORS-friendly JSON error no matter what.
      return upstreamError(err instanceof Error ? err.message : String(err), 500);
    }
  },
};
