import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_TEXT, RELAY_VERSION, handleRequest } from '../index';
// The extension's own reading of the health check. Tests only; not typechecked here.
import { REQUIRED_RELAY_VERSION, interpretRelayHealth } from '../../../extension/src/lib/relay-url';

const get = (path: string, method = 'GET') => handleRequest(new Request(`https://relay.test${path}`, { method }));

afterEach(() => vi.unstubAllGlobals());

describe('relay routing', () => {
  it('answers the health check with its version, with or without /api', async () => {
    for (const path of ['/', '/api', '/api/']) {
      const resp = await get(path);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe(HEALTH_TEXT);
    }
    expect(HEALTH_TEXT).toContain(`v${RELAY_VERSION}`);
  });

  it('answers preflight with CORS headers', async () => {
    const resp = await get('/jlcpcb/search', 'OPTIONS');
    expect(resp.status).toBe(204);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('rejects unknown paths and non-GET methods', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/jlcpcb/search?keyword=x', 'POST')).status).toBe(405);
  });

  it('validates inputs before calling upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await get('/jlcpcb/search?keyword=%20')).status).toBe(400);
    expect((await get(`/jlcpcb/search?keyword=${'x'.repeat(101)}`)).status).toBe(400);
    expect((await get('/easyeda/component?lcsc=123')).status).toBe(400);
    expect((await get('/easyeda/component?lcsc=C12%2F..')).status).toBe(400);
    expect((await get('/easyeda/model?uuid=not-hex')).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('relay proxying', () => {
  it('POSTs the JLCPCB search and returns the body with CORS and a short cache', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"code":200}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const resp = await get('/api/jlcpcb/search?keyword=TPS2116DRLR');
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('{"code":200}');
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(resp.headers.get('Cache-Control')).toBe('public, max-age=300');
    const [endpoint, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toContain('jlcpcb.com');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ keyword: 'TPS2116DRLR' });
  });

  it('routes STEP and OBJ models to their own stores', async () => {
    const fetchSpy = vi.fn(async () => new Response('ISO-10303-21;', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await get('/easyeda/model?uuid=abcdef0123456789');
    const obj = await get('/easyeda/model-obj?uuid=abcdef0123456789');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/qAxj6KHrDKw4blvCG8QJPs7Y/abcdef0123456789');
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/3dmodel/abcdef0123456789');
    expect(obj.headers.get('Content-Type')).toContain('text/plain');
  });

  it('mirrors an upstream error status in a JSON envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })));
    const resp = await get('/easyeda/component?lcsc=C3235557');
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ error: 'easyeda upstream HTTP 403', status: 403 });
  });

  it('turns a network failure into a 502 and a timeout into a 504', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('boom'); }));
    expect((await get('/easyeda/component?lcsc=C1')).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('slow', 'TimeoutError'); }));
    expect((await get('/easyeda/component?lcsc=C1')).status).toBe(504);
  });
});

describe('extension compatibility', () => {
  it('is the version the extension asks for, and passes its health check', () => {
    expect(REQUIRED_RELAY_VERSION).toBe(RELAY_VERSION);
    expect(interpretRelayHealth(200, HEALTH_TEXT)).toEqual({ ok: true, version: RELAY_VERSION, outdated: false });
  });
});
