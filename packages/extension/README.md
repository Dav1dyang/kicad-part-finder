# KiCad Part Finder Extension

Manifest V3 Chrome extension for finding EasyEDA/LCSC parts and installing
KiCad symbols, footprints, and STEP models without a companion server.

## Architecture

- Content scripts detect parts on DigiKey and LCSC pages.
- The MV3 service worker resolves MPNs through JLCPCB and converts LCSC parts
  through EasyEDA using extension host permissions.
- The side panel asks the user for a KiCad library folder with the File System
  Access API and writes all generated files inside that folder.
- `rules.json` is a static `declarativeNetRequest` ruleset that injects the
  EasyEDA `Referer` header browsers will not allow extension `fetch()` calls to
  set directly.

## Build And Test

Run from the repository root:

```sh
pnpm --filter @kicad-part-finder/extension test
pnpm --filter @kicad-part-finder/extension build
```

The build copies `manifest.json`, `rules.json`, and icons into
`packages/extension/dist/`.
