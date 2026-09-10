# KiCad Part Finder extension

Manifest V3 Chrome extension that finds EasyEDA/LCSC parts and installs KiCad symbols, footprints, and STEP models with no companion server.

## How it fits together

- **Content scripts** detect parts. `digikey.ts` reads the page's JSON-LD; `lcsc.ts` reads the C-number from the URL and follows client-side navigation. `selection-listener.ts` turns highlighted text into a search while the finder is open.
- **The service worker** routes messages, opens the finder in the chosen mode, runs the three browser commands, and opens helper windows for the overlay. It keeps every piece of state in `chrome.storage.session` so nothing is lost when Chrome stops the idle worker.
- **The UI document** (`src/sidepanel/`) is the same page in every mode. It searches and converts through the relay, previews the symbol, footprint, and 3D model, then writes files with the File System Access API.
- **The relay** (`packages/relay`) does the real JLCPCB and EasyEDA fetches. Both sites block browser requests. The relay URL is stored in `chrome.storage.local` under `relayUrl` and passed to every network helper as `relayBase`.

## Setup

1. Deploy the relay. See `packages/relay/README.md`.
2. Build and load the extension, open it, and paste the relay URL. Click **Test** to confirm it answers.
3. Choose your library folder. Search and previews work before this step; Install needs it.

## Modes

The UI reads its situation from the URL:

| Mode | URL | What is different |
|------|-----|-------------------|
| Side panel | none | Follows the active tab of its window |
| Tab or window | `?tab=<id>&win=1` | Bound to one source tab. Float button hidden |
| Overlay iframe | `?overlay=1` | Cannot use File System Access. Folder grant and install run in helper windows |
| Folder-grant helper | `?win=1&setup=1` | Opens the picker, records the folder, closes |
| Install helper | `?win=1&install=C123&bucket=IC` | Converts and installs, then closes. Stays open on failure so the error can be read |

## Keyboard shortcuts

Browser commands are declared in `manifest.json`. Chrome owns their bindings. The Settings panel reads them with `chrome.commands.getAll()` and links to `chrome://extensions/shortcuts`.

Panel shortcuts are handled in `src/lib/shortcuts.ts` (pure, tested) and dispatched from `sidepanel.ts`. Bindings are stored in `chrome.storage.sync` under `panelShortcuts` as canonical strings such as `Mod+Enter`. `Mod` is Command on macOS and Ctrl elsewhere.

## Build and test

From the repository root:

```sh
pnpm --filter @kicad-part-finder/extension test
pnpm --filter @kicad-part-finder/extension build
pnpm --filter @kicad-part-finder/extension exec tsc --noEmit
```

The build copies `manifest.json` and the icons into `dist/`. Source maps are emitted only for `pnpm dev:extension`.

## Smoke test without Chrome extensions

The built panel can run in a plain page with a stubbed `chrome` object. See the harness approach in the pull request that introduced the shortcuts feature: copy `dist/`, strip the `crossorigin` attributes from `index.html`, prepend a script that defines `window.chrome` with `runtime`, `storage`, `commands`, `windows`, `permissions`, and `tabs`, then open the page in headless Chromium. This is enough to catch runtime errors and check both themes.
