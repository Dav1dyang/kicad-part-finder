# Extension notes

This package is a no-server Manifest V3 Chrome extension. Do not reintroduce the retired companion-server flow for conversion or library writes.

JLCPCB and EasyEDA block the browser directly (HTTP 403 even with spoofed headers), so every JLCPCB/EasyEDA call routes through the user's deployed relay (`packages/relay`, Cloudflare Worker or Vercel edge function). The relay origin is stored in `chrome.storage.local` under `relayUrl`, normalized by `src/lib/relay-url.ts`, and threaded into the converter, JLCPCB, and library-writer functions as a `relayBase` argument.

Key paths:

- `src/background/service-worker.ts` keeps all state in `chrome.storage.session`, routes `PART_DETECTED`, `CONVERT`, `RESOLVE_MPN`, `PAGE_COMMAND`, and the `OVERLAY_*` messages, handles the three commands (with `open-finder` as a toggle), keeps the page listener injected, and replies with `error: "relay URL not set"` when the relay is missing.
- `src/content/page-listener.ts` is the classic content script for highlights and page shortcuts. It imports only `page-combo.ts`; importing `src/lib/shortcuts.ts` there would split a shared chunk it cannot load.
- `src/lib/converter/easyeda.ts` fetches EasyEDA data via the relay: `convertLcsc(lcscId, relayBase)`.
- `src/lib/jlcpcb.ts` resolves MPNs via the relay: `resolveMpnDetailed(mpn, relayBase)`. Exact MPN hits sort first.
- `src/lib/library-writer.ts` writes symbols, footprints, and STEP models via the File System Access API. `installPart(root, input, relayBase)` applies the card's edited metadata (`applySymbolMeta`), sanitizes the footprint file name, merges under a Web Lock, and reports `libraryCreated`.
- `src/lib/shortcuts.ts` is the pure keyboard-shortcut model (parse, format, validate, dispatch) for panel and page shortcuts. `src/lib/relay-url.ts` is the pure relay-URL model.
- `src/sidepanel/sidepanel.ts` is the UI. Every search or convert carries a sequence number and drops stale responses.

Every relay fetch has a deadline (`AbortSignal.timeout`). Keep it that way when adding endpoints.

Required checks from the repo root:

```sh
pnpm test
pnpm --filter @kicad-part-finder/extension build
pnpm --filter @kicad-part-finder/extension exec tsc --noEmit
```
