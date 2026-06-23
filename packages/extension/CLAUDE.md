# Extension Notes

This package is a no-server Manifest V3 Chrome extension. Do not reintroduce
the retired companion-server flow for conversion or library writes.

Key paths:

- `src/background/service-worker.ts` routes detected-part, conversion, and
  JLCPCB lookup messages.
- `src/lib/converter/easyeda.ts` fetches EasyEDA data and preserves the public
  `convertLcsc(lcscId: string)` API.
- `src/lib/library-writer.ts` writes symbols, footprints, and STEP models via
  the File System Access API.
- `rules.json` injects `Referer: https://easyeda.com/` for EasyEDA/module
  fetches via declarativeNetRequest.

Required checks from the repo root:

```sh
pnpm test
pnpm --filter @kicad-part-finder/extension build
```
