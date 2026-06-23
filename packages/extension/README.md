# KiCad Part Finder Extension

Manifest V3 Chrome extension for finding EasyEDA/LCSC parts and installing
KiCad symbols, footprints, and STEP models without a companion server.

## Architecture

- Content scripts detect parts on DigiKey and LCSC pages.
- The MV3 service worker resolves MPNs through JLCPCB and converts LCSC parts
  through EasyEDA — but JLCPCB/EasyEDA WAF-block the browser directly (HTTP 403),
  so both go through the user's deployed **Cloudflare Worker relay**
  (`packages/relay`). The relay URL is stored in `chrome.storage.local` under
  `relayUrl` and entered via the side panel's "Relay URL" field.
- The side panel asks the user for a KiCad library folder with the File System
  Access API and writes all generated files inside that folder. The 3D-model
  STEP is also fetched through the relay.

## Setup

1. Deploy the relay — see `packages/relay/README.md` (`cd packages/relay;
   wrangler login; wrangler deploy`).
2. Load the extension, open the side panel, and paste the deployed Worker URL
   (`…workers.dev`) into the **Relay URL** field. Until it's set, a banner
   appears and Search/Install are disabled.

## Build And Test

Run from the repository root:

```sh
pnpm --filter @kicad-part-finder/extension test
pnpm --filter @kicad-part-finder/extension build
```

The build copies `manifest.json` and icons into `packages/extension/dist/`.
