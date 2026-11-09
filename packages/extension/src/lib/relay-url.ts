/**
 * Relay URL handling — pure helpers shared by the settings UI and the service
 * worker. The relay is the user's own deployed proxy (Cloudflare Worker or
 * Vercel edge function, see packages/relay); everything the extension fetches
 * from JLCPCB/EasyEDA goes through it.
 */

export interface RelayUrlResult {
  /** The cleaned URL (no trailing slash), or '' when the input is empty. */
  url: string;
  /** A short, user-facing problem with the input, or null when it's usable. */
  error: string | null;
}

/**
 * Clean up what the user typed:
 *  - trims whitespace and trailing slashes;
 *  - adds `https://` when no scheme was given (pasting a bare host is common);
 *  - rejects anything that isn't http(s), has spaces, or fails to parse.
 * An empty input is not an error — it just means "no relay yet".
 */
export function normalizeRelayUrl(input: string | null | undefined): RelayUrlResult {
  const raw = (input ?? '').trim();
  if (!raw) return { url: '', error: null };
  if (/\s/.test(raw)) return { url: raw, error: 'The relay URL cannot contain spaces.' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { url: raw, error: 'That does not look like a URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url: raw, error: 'The relay URL must start with https:// (or http:// for a local relay).' };
  }
  if (parsed.search || parsed.hash) {
    return { url: raw, error: 'Paste just the relay address, without ?query or #fragment.' };
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return { url: `${parsed.origin}${path}`, error: null };
}

/** Short form for the status pill: host plus any path, no scheme. */
export function prettyRelay(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '');
    return tail && tail !== '/' ? `${u.host}${tail}` : u.host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

/** The text the relay's root endpoint starts with when it is healthy. */
export const RELAY_HEALTH_TEXT = 'kicad-part-relay ok';

/**
 * The relay version this extension is built for (see RELAY_VERSION in
 * packages/relay). An older relay still searches and installs, but misses
 * newer endpoints, so the panel asks the user to redeploy it.
 */
export const REQUIRED_RELAY_VERSION = 2;

export type RelayHealth =
  | { ok: true; version: number; outdated: boolean }
  | { ok: false; reason: 'not-a-relay' | 'http-error'; detail: string };

/** Read `v<n>` from the health text. Relays before versioning say nothing: v1. */
export function parseRelayVersion(body: string): number {
  const m = body.match(/kicad-part-relay ok v(\d+)/i);
  return m ? Number(m[1]) : 1;
}

/**
 * Interpret a health-check response. A healthy relay answers 200 with
 * `kicad-part-relay ok v<version>`; anything else is classified so the UI can
 * give one clear next step.
 */
export function interpretRelayHealth(status: number, body: string): RelayHealth {
  if (status >= 200 && status < 300) {
    if (body.toLowerCase().includes('kicad-part-relay')) {
      const version = parseRelayVersion(body);
      return { ok: true, version, outdated: version < REQUIRED_RELAY_VERSION };
    }
    return { ok: false, reason: 'not-a-relay', detail: 'The address answered, but it is not the relay. Check the path (Vercel deployments end in /api).' };
  }
  return { ok: false, reason: 'http-error', detail: `The relay answered HTTP ${status}.` };
}
