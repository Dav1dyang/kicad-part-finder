/**
 * Vercel Edge Function adapter — reuses the SAME proxy handler as the Cloudflare
 * Worker (../src/index.ts), so the relay can deploy on Vercel or Cloudflare with
 * one source of truth.
 *
 * Vercel mounts this catch-all at /api/*, so the routes are:
 *   /api/jlcpcb/search   /api/easyeda/component   /api/easyeda/model
 * → set the extension's "Relay URL" to  https://<project>.vercel.app/api
 */
import worker from '../src/index';

export const config = { runtime: 'edge' };

export default function handler(request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  // Strip Vercel's "/api" mount prefix so the worker's pathname routing matches.
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  return worker.fetch(new Request(url.toString(), request), {});
}
