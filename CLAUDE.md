# KiCad Part Finder

Chrome extension + local companion server that auto-detects electronic components on DigiKey/LCSC and installs KiCad-compatible symbols, footprints, and 3D models with one click.

## Architecture

```
Chrome Extension (Manifest V3)
  ├── Content scripts: digikey.ts (JSON-LD), lcsc.ts (URL + MutationObserver)
  ├── Content scripts: selection-listener.ts (highlight text on any page to search)
  ├── Background: service-worker.ts (message routing, badge, sidePanel detection)
  ├── Side panel: sidepanel.ts (UI, search, install, ZIP drop zone, stock/variants)
  ├── Floating panel: floating-panel.ts (fallback for Arc/browsers without sidePanel)
  │   └── Shadow DOM host + iframe loading sidepanel HTML
  │   └── Draggable, resizable, minimizable, position saved to chrome.storage
  └── Calls localhost:3456 for search/install (avoids CORS)

Companion Server (Fastify on localhost:3456)
  ├── GET  /health  — status check
  ├── GET  /search  — proxies JLCPCB + EasyEDA APIs, returns stock/variants
  ├── POST /install — runs easyeda2kicad, places files, updates lib tables
  ├── POST /upload  — accepts ZIP files (SnapEDA, CSE) and installs contents
  └── GET/PUT /config — server configuration
```

## Features

- **Auto-detect MPN** from DigiKey and LCSC product pages (JSON-LD / URL parsing)
- **Highlight-to-search** — select text on any webpage (Figma, Taobao, datasheets) to search
- **One-click install** — symbol + footprint + 3D model placed directly into KiCad libraries
- **LCSC/JLCPCB stock + pricing** — shows availability, unit price, and package info
- **Variants and alternatives** — lists compatible parts, clones, and package variants with stock
- **ZIP drag-and-drop** — drop SnapEDA/CSE ZIP files onto the panel for instant install
- **Floating panel fallback** — draggable overlay for browsers without sidePanel (Arc)
- **Keyboard shortcut** — Cmd+Shift+2 (Mac) / Ctrl+Shift+2 (Windows)
- **LaunchAgent auto-start** — server runs on login, restarts on crash
- **KiCad 10 compatible** — auto-detects KiCad config, updates library tables
- **DigiKey regional domains** — .com, .tw, .co.uk, .de, .jp, .cn, .com.au, .ca

## Project Structure

```
kicad-part-finder/
├── packages/
│   ├── extension/          # Chrome Extension (Vite build)
│   │   ├── manifest.json
│   │   ├── src/content/    # DigiKey, LCSC, selection-listener, floating-panel
│   │   ├── src/background/ # Service worker
│   │   ├── src/sidepanel/  # UI (HTML + CSS + TS)
│   │   └── src/lib/        # API clients (companion, mpn-sources)
│   ├── server/             # Companion Server (Fastify + tsx)
│   │   ├── src/routes/     # health, config, search, install, upload
│   │   ├── src/kicad/      # paths, file-placer, library-table
│   │   └── src/lib/        # config-store, converter (easyeda2kicad CLI)
│   └── shared/             # Shared types + constants
├── package.json            # pnpm workspaces root
└── CLAUDE.md
```

## Key Paths (auto-detected per OS)

| What | macOS | Linux | Windows |
|------|-------|-------|---------|
| KiCad config | `~/Library/Preferences/kicad/{ver}/` | `~/.config/kicad/{ver}/` | `%APPDATA%/kicad/{ver}/` |
| Custom libs | `~/KiCad/custom-libs/` | `~/KiCad/custom-libs/` | `~/KiCad/custom-libs/` |
| Server config | `~/.kicad-part-finder.json` | same | same |
| Server logs | `~/Library/Logs/kicad-part-server.log` | stdout | stdout |

## Development

```bash
pnpm install           # Install dependencies
pnpm test              # Run all tests (31 across extension + server)
pnpm dev:extension     # Rebuild extension on change
pnpm dev:server        # Run server with hot reload
pnpm build:extension   # Build extension → packages/extension/dist/
```

## Important Notes

- **KiCad reads lib tables at startup only** — restart KiCad after the first install to see `KiCadPartFinder` library
- **Symbols are merged** into a single `KiCadPartFinder.kicad_sym` file; duplicates are skipped
- **EasyEDA API is unofficial** — no auth required, endpoints can change, version pinned at `6.4.19.5`
- **JLCPCB search** provides MPN → LCSC ID lookup + stock/pricing/variants (server-side, avoids CORS)
- **SnapEDA/SnapMagic** has no public API — links to search page, users can drop ZIPs for install
- **Content scripts are IIFE-wrapped** to prevent redeclaration errors on re-injection
- **Selection listener** uses `window.__kicadSelectionListenerActive` guard against double-injection
- **Floating panel** uses Shadow DOM + iframe for complete style isolation from host page
- **Server binds to 127.0.0.1 only** — never accessible from outside the machine
- **Library table backups** created before every modification (`*.bak` files)

## APIs Used

| API | Auth | Purpose |
|-----|------|---------|
| JLCPCB `/api/.../selectSmtComponentList` | None | MPN search, stock, pricing, variants |
| EasyEDA `/api/products/{lcscId}/components` | None | Library data (symbol/footprint/3D) |
| `easyeda2kicad` CLI | None | EasyEDA → KiCad format conversion |

## Testing

Tests use vitest. Run with `pnpm test` or per-package:

- **Extension tests** (14): DigiKey JSON-LD parsing, LCSC URL extraction
- **Server tests** (17): KiCad path detection, library table updates (backup, idempotency, structure), file placement, server routes
