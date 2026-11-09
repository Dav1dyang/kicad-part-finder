# kicad-part-relay

A small stateless proxy that fetches from JLCPCB and EasyEDA for the KiCad Part Finder extension.

## Why it exists

JLCPCB and EasyEDA answer HTTP 403 to requests from a browser extension, even with spoofed headers. The same requests made from a server succeed. The relay makes them and returns the body with open CORS headers. It has no secrets, stores nothing, and fits the free tier of Cloudflare or Vercel.

## Endpoints

All are `GET`. On Vercel the same paths live under `/api`.

| Path | Upstream | Returns | Cached |
|------|----------|---------|--------|
| `/` | none | `kicad-part-relay ok v2` | no |
| `/jlcpcb/search?keyword=X` | JLCPCB parts search | JSON, verbatim | 5 min |
| `/easyeda/component?lcsc=C123` | EasyEDA component (symbol, footprint, provenance) | JSON, verbatim | 1 h browser, 1 day edge |
| `/easyeda/model?uuid=HEX` | EasyEDA STEP store | STEP bytes, streamed | 7 days |
| `/easyeda/model-obj?uuid=HEX` | EasyEDA OBJ store (3D preview) | OBJ text | 7 days |

Errors come back as `{ "error": "...", "status": <code> }` with the upstream status, 502 when the upstream is unreachable, or 504 after 15 seconds. Inputs are validated first: `lcsc` must look like `C123`, `uuid` must be hex, `keyword` at most 100 characters.

The health check carries a version. The extension compares it with the one it needs and asks you to redeploy an older relay. Bump `RELAY_VERSION` in `src/index.ts` when an endpoint is added or changes; a test keeps it equal to the extension's `REQUIRED_RELAY_VERSION`.

## Deploy

### Cloudflare Workers

```bash
cd packages/relay
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

Paste the printed `https://kicad-part-relay.<you>.workers.dev` into Part Finder and click **Test**.

### Vercel

```bash
cd packages/relay
```

```bash
npx vercel deploy --prod
```

Paste `https://<project>.vercel.app/api` (with `/api`) into Part Finder.

### Updating

Pull the repo and run the same deploy command again. The URL stays the same.

## Local development

```bash
npx wrangler dev
```

That serves on `http://localhost:8787`, which you can paste as the relay URL while testing.

## Tests

```bash
pnpm --filter @kicad-part-finder/relay test
```

```bash
pnpm --filter @kicad-part-finder/relay typecheck
```

The tests stub `fetch`, so they need no network.
