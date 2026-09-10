# kicad-part-relay

A tiny **Cloudflare Worker** that proxies the JLCPCB and EasyEDA APIs for the
KiCad Part Finder browser extension.

## Why this exists

The extension runs entirely in the browser (Manifest V3, no companion server).
But JLCPCB and EasyEDA sit behind WAFs that return **HTTP 403** to browser
`fetch()` calls — even with spoofed `Referer` / `User-Agent` headers — because
they fingerprint the request as coming from a browser extension. The same
requests made **server-side** (a plain `curl` with a desktop Chrome UA and the
right `Referer`) come back **200**.

So this Worker does the real upstream fetch on the server and returns the body
to the extension with permissive CORS headers. The extension talks only to your
Worker; the Worker talks to JLCPCB/EasyEDA.

## Endpoints

All endpoints are `GET` and every response (including errors and the `OPTIONS`
preflight) carries permissive CORS headers (`Access-Control-Allow-Origin: *`).

| Endpoint | Proxies | Returns |
| --- | --- | --- |
| `GET /` | — | `text/plain` `kicad-part-relay ok` (health check) |
| `GET /jlcpcb/search?keyword=X` | `POST` JLCPCB `selectSmtComponentList` (`{keyword, pageSize:15, currentPage:1}`) | JLCPCB JSON verbatim |
| `GET /easyeda/component?lcsc=C123` | `GET` `easyeda.com/api/products/<lcsc>/components?version=6.4.19.5` | EasyEDA JSON verbatim |
| `GET /easyeda/model?uuid=HEX` | `GET` `modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/<uuid>` | STEP model bytes (streamed, upstream `Content-Type`) |

On any upstream error the Worker returns `{ "error": "...", "status": <code> }`
JSON at the upstream status code. `lcsc` must match `^C\d+$`; `uuid` must be hex.

## Deploy

From this directory (`packages/relay`):

```sh
cd packages/relay
wrangler login        # one-time: opens a browser to authorize your Cloudflare account
wrangler deploy       # or: pnpm deploy
```

`wrangler deploy` prints the live URL, e.g.:

```
https://kicad-part-relay.<your-subdomain>.workers.dev
```

**Copy that URL** and paste it into the extension's **Relay URL** field (in the
first-run view or in Settings), then click **Test**. The extension persists it in
`chrome.storage.local` and routes all JLCPCB/EasyEDA traffic through it.

> No bindings, secrets, or paid features are required — this is a free-tier
> stateless proxy. A custom domain works too; the extension only needs the URL.

## Local development

```sh
wrangler dev          # serves on http://localhost:8787
```

Then point the extension's Relay URL at `http://localhost:8787` to test against
your local Worker (note: `http://localhost` is not covered by the extension's
`https://*.workers.dev/*` host permission, so prefer the deployed URL for normal
use).

## Typecheck

```sh
pnpm --filter @kicad-part-finder/relay typecheck
```

## Deploy on Vercel (alternative to Cloudflare Workers)

The relay also runs as a Vercel Edge Function: the files under `api/` delegate
to the same Worker handler, which accepts paths with or without the `/api`
prefix. From this folder:

```bash
npx vercel deploy --prod    # first run links the project + logs you in
```

Vercel prints a URL like `https://kicad-part-relay-xxx.vercel.app`. The endpoints
live under `/api`, so set the extension's **Relay URL** to:

```
https://<your-project>.vercel.app/api
```

Sanity check in a browser:
`https://<your-project>.vercel.app/api/jlcpcb/search?keyword=TPS2116DRLR`
→ JSON containing TPS2116DRLR / C3235557.
