# Extension Notes

This package is a no-server Manifest V3 Chrome extension. Do not reintroduce
the retired companion-server flow for conversion or library writes.

JLCPCB and EasyEDA WAF-block the browser directly (HTTP 403 even with spoofed
headers), so every JLCPCB/EasyEDA call routes through the user's deployed
**Cloudflare Worker relay** (`packages/relay`). The Worker origin is stored in
`chrome.storage.local` under `relayUrl` (set via the side panel's "Relay URL"
field) and threaded into the converter/JLCPCB/library-writer functions as a
`relayBase` argument. The old `declarativeNetRequest` Referer hack (`rules.json`)
is gone.

Key paths:

- `src/background/service-worker.ts` reads `relayUrl` from `chrome.storage.local`
  and routes detected-part, conversion, and JLCPCB lookup messages; it replies
  with `error: "relay URL not set"` when unset.
- `src/lib/converter/easyeda.ts` fetches EasyEDA data via the relay; public API
  is `convertLcsc(lcscId, relayBase)` / `fetchEasyedaComponent(lcscId, relayBase)`.
- `src/lib/jlcpcb.ts` resolves MPNs via the relay
  (`resolveMpnDetailed(mpn, relayBase)`).
- `src/lib/library-writer.ts` writes symbols, footprints, and STEP models via
  the File System Access API; `installPart(root, input, relayBase)` and
  `resolveModelDownload(model3dUrl, relayBase)` fetch the STEP through the relay.

Required checks from the repo root:

```sh
pnpm test
pnpm --filter @kicad-part-finder/extension build
```
