# KiCad Part Finder

Chrome extension (Manifest V3) that detects electronic parts on DigiKey and LCSC, searches JLCPCB and EasyEDA through a user-deployed relay, and writes KiCad symbols, footprints, and STEP models into the user's library folder with the File System Access API.

**There is no companion server.** The old `packages/server` was removed; conversion and library writes happen in the browser. Do not reintroduce a local server for them.

## Architecture

```
packages/extension          Chrome extension (Vite build, vitest tests)
  src/background/           Service worker: message routing, open modes, commands, helper windows
  src/content/              digikey.ts, lcsc.ts (detection), page-listener.ts (highlights + page shortcuts),
                            overlay.ts (in-page panel)
  src/sidepanel/            The UI document. Runs in the side panel, a tab, a popup window,
                            the overlay iframe, and short-lived helper windows.
  src/lib/                  converter/ (EasyEDA -> KiCad), jlcpcb.ts, library-writer.ts (FS Access),
                            autosort.ts (category -> bucket), shortcuts.ts, relay-url.ts
packages/relay              Cloudflare Worker + Vercel edge function that proxies JLCPCB/EasyEDA
packages/shared             Shared types
```

Data flow: page or typed query -> service worker -> relay -> JLCPCB (MPN to LCSC id, stock, price) and EasyEDA (symbol, footprint, 3D) -> converter -> card -> `installPart()` writes into the granted folder.

## The UI runs in five contexts

The same `src/sidepanel/index.html` is loaded everywhere. It reads its situation from the URL:

| Context | URL | Notes |
|---------|-----|-------|
| Side panel | no params | Reads the detected part from the active tab |
| Tab or popup window | `?tab=<id>&win=1` | `tab` is the source page; `win=1` hides the Float button |
| Overlay iframe | `?overlay=1` | File System Access is blocked in a cross-origin iframe, so folder grant and install are delegated to helper windows through the service worker |
| Folder-grant helper | `?win=1&setup=1` | Opens the picker, records the folder, closes itself |
| Install helper | `?win=1&install=C123&bucket=IC` | Converts, installs against the saved handle, closes itself |

Helper windows report back with `OVERLAY_HELPER_DONE`; the service worker rebroadcasts `OVERLAY_FOLDER_READY`, `OVERLAY_INSTALLED`, or `OVERLAY_INSTALL_FAILED` to the overlay iframe.

## Storage keys

| Key | Where | Purpose |
|-----|-------|---------|
| `relayUrl` | `chrome.storage.local` | The relay origin, normalized (no trailing slash) |
| `openMode` | `chrome.storage.local` | `auto`, `window`, or `overlay` |
| `overlayBounds` | `chrome.storage.local` | Overlay position, size, minimized state |
| `overlayLibraryName` | `chrome.storage.local` | Folder name mirror for the overlay iframe, which cannot hold the handle |
| `selectionSearch` | `chrome.storage.local` | Whether highlighting text searches automatically (default on) |
| `theme` | `chrome.storage.local` | `system`, `dark`, or `light` |
| `panelShortcuts` | `chrome.storage.sync` | Customized panel shortcuts (`action -> "Mod+Enter"` strings) |
| `pageShortcuts` | `chrome.storage.sync` | Customized page shortcuts, the browser commands' twins (`open-finder -> "Mod+Shift+k"`) |
| `libraryFolder` | IndexedDB `kicad-part-finder/handles` | The `FileSystemDirectoryHandle` |
| finder tab/window ids, detected parts | `chrome.storage.session` | Survive service-worker restarts |

## Rules that keep it working

- **Service worker state must survive termination.** Chrome kills an idle MV3 worker after about 30 seconds. Anything that has to outlive a request goes in `chrome.storage.session`, never a module-level variable.
- **Content scripts are IIFE-wrapped** and guard against re-injection with a `window.__kicad*` flag. `content/overlay.js` and `content/page-listener.js` must stay self-contained classic scripts; their helpers (`overlay-bounds.ts`, `page-combo.ts`) are imported by no other entry so rollup inlines them, and the `iife-wrap-content-scripts` Vite plugin wraps both so re-injection cannot redeclare top-level consts. Never import `src/lib/shortcuts.ts` from a content script.
- **Alt combos read the physical key.** macOS composes a glyph for Option+letter (`ˆ` for Option+Shift+I), so `comboFromKeys` and the page listener take a letter or digit from `KeyboardEvent.code` whenever Alt is held.
- **The page listener runs wherever we may run.** DigiKey and LCSC pages get it from the manifest, the tab the finder was opened on gets it through `activeTab`, and every site gets a registered content script once the user grants the optional all-sites permission. The service worker reports `selectionReady` to the finder so it can say when a page cannot reach it.
- **The relay is required for search, convert, previews, and the STEP download.** The folder is required only at install time. Gate the UI accordingly.
- **Never use `innerHTML` with data from the network.** Part names come from JLCPCB and EasyEDA; render with `textContent`.
- **Library writes are append-and-dedupe.** `mergeSymbolLibrary` skips a symbol whose name already exists. Footprints are overwritten by name. The symbol's `Footprint` field is qualified as `DavidLib_<Bucket>:<name>` so KiCad links them automatically.
- **Browser-level shortcuts cannot be set by the extension.** `chrome.commands.getAll()` reads them; changing one means sending the user to `chrome://extensions/shortcuts`. Arc and Dia never deliver them, so the page listener forwards the same three actions as `PAGE_COMMAND`; the worker dedupes a command and its page twin within 500 ms. Panel and page shortcuts are ours and live in `src/lib/shortcuts.ts`.
- **`open-finder` is a toggle.** The worker finds open side panels with `chrome.runtime.getContexts` (no bookkeeping, nothing keeping the worker awake); closing asks the panel document to `window.close()`, then falls back to a global `sidePanel.setOptions({ enabled: false })` and re-enable, only while one window shows the panel (per-tab options would make the panel tab-scoped). The floating window is minimized, not closed, so its folder grant survives.
- **Pure logic goes in its own module with tests.** Everything under `src/lib` and the `preview-*`, `overlay-bounds`, `overlay-params`, `source-tab` modules is DOM-free and unit-tested. Keep it that way when adding features.

## Chrome extension guidance

Google's Modern Web Guidance skill for Chrome extensions is installed at `.claude/skills/chrome-extensions` (source in `.agents/skills/chrome-extensions`, pinned by `skills-lock.json`). Read its `SKILL.md` and the relevant `references/extensions/*.md` before touching the manifest, the service worker, content scripts, permissions, or the side panel. Two of its rules that matter here: `tab.url` is undefined without the `tabs` permission (we do not request it, so compare tab ids instead), and `activeTab` only applies to direct gestures such as the toolbar click or a command, never to a button inside the panel.

## Development

```bash
pnpm install
pnpm test                                   # all packages
pnpm --filter @kicad-part-finder/extension test
pnpm --filter @kicad-part-finder/extension build
pnpm --filter @kicad-part-finder/extension exec tsc --noEmit
```

Load `packages/extension/dist` as an unpacked extension. After changing the manifest or the service worker, click the reload icon on `chrome://extensions`.

## Writing style for docs and UI copy

Short sentences. Plain words. Say what happens and what to do next. Error messages name the cause and one recovery action. Avoid jargon in the panel; keep raw diagnostics (HTTP status, exception text) behind a "Details" line.
