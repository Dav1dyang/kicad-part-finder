# KiCad Part Finder

A Chrome extension that finds KiCad symbols, footprints, and 3D models for electronic components while you browse DigiKey, LCSC, or any website. One click to install them into your KiCad library.

## What it does

1. **Browse a component** on DigiKey, LCSC, or any page
2. The extension **auto-detects the part number** (or you highlight text to search)
3. It searches **EasyEDA/LCSC** for KiCad-compatible files and shows **stock + pricing + variants**
4. Click **Install to KiCad** and the symbol, footprint, and 3D model land in your KiCad library

Works with **KiCad 7, 8, 9, and 10**.

## Features

- Auto-detect MPN from DigiKey and LCSC product pages
- Highlight any text on any page to search (Taobao, datasheets, Figma, etc.)
- LCSC/JLCPCB stock levels, pricing, and compatible alternatives
- Drag-and-drop ZIP files from SnapEDA or ComponentSearchEngine
- Quick links to SnapEDA, ComponentSearchEngine, and Ultra Librarian
- Floating panel for browsers without side panel support (Arc)
- Keyboard shortcut: Cmd+Shift+2 (Mac) / Ctrl+Shift+2 (Win/Linux)
- Auto-start server on login (macOS)
- DigiKey regional sites (.com, .tw, .co.uk, .de, .jp, .cn, .com.au, .ca)

## Install

### Prerequisites

- **Node.js 20+** ([download](https://nodejs.org))
- **Python 3.8+** (for easyeda2kicad converter; optional but recommended)
- **KiCad 7+** installed

### Quick install

```bash
git clone https://github.com/YOUR_USERNAME/kicad-part-finder.git
cd kicad-part-finder
bash scripts/install.sh
```

The install script will:
- Install pnpm and Node.js dependencies
- Create a Python venv and install `easyeda2kicad`
- Build the Chrome extension
- Optionally set up auto-start on macOS

### Load the extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `packages/extension/dist` folder

### Start the server

**macOS with auto-start** (set up during install): The server starts automatically on login.

**Manual start** (all platforms):
```bash
cd packages/server
npx tsx src/index.ts
```

The server runs on `http://localhost:3456`. The green dot in the extension shows connection status.

## How it works

```
Chrome Extension                    Companion Server (localhost:3456)

  DigiKey page                        /search
  → JSON-LD → MPN ──────────────────→ JLCPCB API (stock, price, variants)
                                      EasyEDA API (symbol, footprint, 3D)
  LCSC page
  → URL → C-number ─────────────────→ Same as above

  Any page                            /install
  → Highlight text → MPN ───────────→ easyeda2kicad CLI
                                      → ~/KiCad/custom-libs/symbols/
  SnapEDA ZIP                         → ~/KiCad/custom-libs/footprints/
  → Drag & drop ────────────────────→ → ~/KiCad/custom-libs/3dmodels/
                                      → Updates KiCad library tables
```

## Security

This tool is designed to run locally with minimal attack surface:

- **Server binds to 127.0.0.1 only** — never accessible from the network
- **No authentication tokens or API keys** — uses only public, unauthenticated APIs
- **No data sent to any server we control** — all API calls go directly to EasyEDA/JLCPCB
- **Library table backups** — created before every modification (`.bak` files)
- **ZIP extraction** — size-limited, uses system `unzip`, temp files cleaned up
- **Content scripts use IIFEs** — no global variable leakage
- **Side panel uses `textContent`** — no `innerHTML`, preventing XSS from malicious part names
- **Floating panel uses Shadow DOM** — completely isolated from host page styles/scripts
- **`easyeda2kicad` runs via `execFile`** (not `exec`) — no shell injection possible
- **No sudo/root required** — everything runs in userspace

### What the extension can access

- DigiKey and LCSC product pages (reads part info from the page)
- `localhost:3456` (your companion server)
- Text you highlight on any page (only when the panel is open)
- `chrome.storage` (saves panel position and server URL)

### What the server does to your filesystem

- Creates `~/KiCad/custom-libs/` directory with symbol, footprint, and 3D model files
- Adds one `KiCadPartFinder` entry to your KiCad `sym-lib-table` and `fp-lib-table`
- Creates `~/.kicad-part-finder.json` (server config)
- Creates `~/.kicad-part-finder/start.sh` (macOS auto-start script)
- Writes logs to `~/Library/Logs/kicad-part-server.log` (macOS only)

It **never** modifies existing KiCad libraries or project files.

## Uninstall

```bash
bash scripts/uninstall.sh
```

Then remove the extension from Chrome: `chrome://extensions` > find "KiCad Part Finder" > Remove.

## Development

```bash
pnpm install              # Install dependencies
pnpm test                 # Run all 31 tests
pnpm dev:extension        # Watch-rebuild extension
pnpm dev:server           # Run server with hot reload
pnpm build:extension      # Production build
```

### Project structure

```
packages/
  extension/     Chrome extension (Manifest V3, Vite)
  server/        Companion server (Fastify, TypeScript)
  shared/        Shared types and constants
scripts/
  install.sh     One-command installer
  uninstall.sh   Clean removal
```

## Troubleshooting

**Extension shows gray dot (server disconnected)**
- Check if server is running: `curl http://localhost:3456/health`
- Start manually: `cd packages/server && npx tsx src/index.ts`
- Check logs: `tail -f ~/Library/Logs/kicad-part-server.log`

**"easyeda2kicad not found" on install**
- Install Python: `brew install python` (macOS) or from python.org
- Re-run: `bash scripts/install.sh`

**New library not showing in KiCad**
- KiCad reads library tables at startup only — restart KiCad
- Check: Preferences > Manage Symbol/Footprint Libraries > scroll to bottom

**Extension not detecting part on DigiKey**
- Make sure you're on a product detail page (URL contains `/products/detail/`)
- Try pressing Cmd+Shift+2 to re-scan the page

**Floating panel not appearing (Arc browser)**
- Click the extension icon or press Cmd+Shift+2
- The floating panel should appear in the top-right corner

## License

MIT
