/**
 * Tests for the JLCPCB lookup `diagnostic` — the precise network/parse outcome
 * that the side panel surfaces when a search comes back empty. These mock the
 * global `fetch` (the only external dependency of `searchJlc`) to drive each
 * branch deterministically; no real network is touched.
 *
 * The lookup now routes through the Cloudflare Worker relay, so calls pass a
 * `RELAY` base and the success case asserts the GET hits `${RELAY}/jlcpcb/search`.
 *
 * Companion to jlcpcb-query.test.ts (which covers the pure query relaxation).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveMpnDetailed, resolveMpnToLcsc } from '../jlcpcb';

/** Stand-in deployed Worker relay origin (no trailing slash). */
const RELAY = 'https://kicad-part-relay.example.workers.dev';

/** Build a minimal JLCPCB success envelope with `n` usable list items. */
function jlcEnvelope(n: number) {
  const list = Array.from({ length: n }, (_, i) => ({
    componentModelEn: `TPS2116DRLR`,
    lcscGoodsUrl: `https://www.lcsc.com/product-detail/C${3235557 + i}.html`,
    componentSpecificationEn: 'SOT-23-6',
    stockCount: 1000 - i,
    firstSortAccordingNameEn: 'Power Management',
  }));
  return { code: 200, data: { componentPageInfo: { list } } };
}

/** A Response-like stub good enough for searchJlc (ok / status / json / clone+text). */
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  json?: () => unknown;
  text?: string;
}): Response {
  const json = opts.json ?? (() => ({}));
  const body = {
    ok: opts.ok,
    status: opts.status,
    json: async () => json(),
    text: async () => opts.text ?? '',
    clone() {
      return body;
    },
  };
  return body as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveMpnDetailed diagnostic', () => {
  it('reports "http 200, N results" and returns matches on success', async () => {
    const fetchSpy = vi.fn(async (_url: string) =>
      fakeResponse({ ok: true, status: 200, json: () => jlcEnvelope(1) }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const res = await resolveMpnDetailed('TPS2116DRLR', RELAY);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].lcscId).toBe('C3235557');
    expect(res.diagnostic).toBe('http 200, 1 results');
    expect(res.relaxed).toBe(false);
    expect(res.matchedQuery).toBe('TPS2116DRLR');

    // The lookup GETs the relay's search endpoint (not JLCPCB directly).
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toBe(`${RELAY}/jlcpcb/search?keyword=TPS2116DRLR`);
  });

  it('reports "http 403" when the anti-bot layer rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ ok: false, status: 403 })),
    );

    const res = await resolveMpnDetailed('TPS2116DRLR', RELAY);
    expect(res.matches).toHaveLength(0);
    expect(res.diagnostic).toBe('http 403');
  });

  it('reports "fetch threw: …" when the request fails at the network/CORS layer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const res = await resolveMpnDetailed('TPS2116DRLR', RELAY);
    expect(res.matches).toHaveLength(0);
    expect(res.diagnostic).toBe('fetch threw: Failed to fetch');
  });

  it('reports "non-JSON body (…)" when a 200 returns an HTML challenge page', async () => {
    const html = '<!DOCTYPE html><html><head><title>Just a moment…</title></head>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 200,
          json: () => {
            throw new SyntaxError('Unexpected token <');
          },
          text: html,
        }),
      ),
    );

    const res = await resolveMpnDetailed('TPS2116DRLR', RELAY);
    expect(res.matches).toHaveLength(0);
    expect(res.diagnostic).toBe(`non-JSON body (${html.slice(0, 40)})`);
  });

  it('reports "http 200, 0 results" when JSON parses but the list is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ ok: true, status: 200, json: () => jlcEnvelope(0) })),
    );

    // 'NE555' does not relax, so there's exactly one query attempt.
    const res = await resolveMpnDetailed('NE555', RELAY);
    expect(res.matches).toHaveLength(0);
    expect(res.diagnostic).toBe('http 200, 0 results');
  });

  it('surfaces the ORIGINAL query outcome when relaxed fallbacks also fail', async () => {
    // Every attempt 403s; diagnostic must reflect the first (original) query.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ ok: false, status: 403 })),
    );

    const res = await resolveMpnDetailed('TPS2116A', RELAY); // relaxes to TPS2116
    expect(res.matches).toHaveLength(0);
    expect(res.diagnostic).toBe('http 403');
  });

  it('returns empty diagnostic for blank input without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await resolveMpnDetailed('   ', RELAY);
    expect(res.matches).toHaveLength(0);
    expect(res.diagnostic).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolveMpnToLcsc still returns just the matches array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ ok: true, status: 200, json: () => jlcEnvelope(2) })),
    );

    const matches = await resolveMpnToLcsc('TPS2116DRLR', RELAY);
    expect(Array.isArray(matches)).toBe(true);
    expect(matches).toHaveLength(2);
  });
});
