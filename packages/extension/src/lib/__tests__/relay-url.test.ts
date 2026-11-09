import { describe, it, expect } from 'vitest';
import { interpretRelayHealth, normalizeRelayUrl, prettyRelay } from '../relay-url';

describe('normalizeRelayUrl', () => {
  it('treats empty input as "no relay", not an error', () => {
    expect(normalizeRelayUrl('')).toEqual({ url: '', error: null });
    expect(normalizeRelayUrl('   ')).toEqual({ url: '', error: null });
    expect(normalizeRelayUrl(undefined)).toEqual({ url: '', error: null });
  });
  it('adds https:// to a bare host and strips trailing slashes', () => {
    expect(normalizeRelayUrl('kicad-relay.foo.workers.dev/').url).toBe('https://kicad-relay.foo.workers.dev');
    expect(normalizeRelayUrl('https://x.vercel.app/api///').url).toBe('https://x.vercel.app/api');
  });
  it('keeps http:// for a local relay', () => {
    expect(normalizeRelayUrl('http://localhost:8787')).toEqual({ url: 'http://localhost:8787', error: null });
  });
  it('rejects spaces, other schemes, queries, and junk', () => {
    expect(normalizeRelayUrl('https://a b.com').error).toMatch(/spaces/);
    expect(normalizeRelayUrl('ftp://relay.example').error).toMatch(/https/);
    expect(normalizeRelayUrl('https://relay.example/api?x=1').error).toMatch(/query/);
    expect(normalizeRelayUrl('https://').error).toMatch(/URL/);
  });
});

describe('prettyRelay', () => {
  it('drops the scheme and keeps the path', () => {
    expect(prettyRelay('https://x.vercel.app/api')).toBe('x.vercel.app/api');
    expect(prettyRelay('https://x.workers.dev/')).toBe('x.workers.dev');
    expect(prettyRelay('not a url')).toBe('not a url');
  });
});

describe('interpretRelayHealth', () => {
  it('accepts the health text and reads the version', () => {
    expect(interpretRelayHealth(200, 'kicad-part-relay ok v2')).toEqual({ ok: true, version: 2, outdated: false });
    expect(interpretRelayHealth(200, 'kicad-part-relay ok v3')).toEqual({ ok: true, version: 3, outdated: false });
  });
  it('treats a relay without a version as v1 and outdated', () => {
    expect(interpretRelayHealth(200, 'kicad-part-relay ok')).toEqual({ ok: true, version: 1, outdated: true });
  });
  it('flags a 200 that is not the relay', () => {
    const r = interpretRelayHealth(200, '<!doctype html>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-a-relay');
  });
  it('reports HTTP errors', () => {
    const r = interpretRelayHealth(404, 'not found');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/404/);
  });
});
