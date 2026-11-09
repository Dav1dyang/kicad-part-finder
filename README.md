# KiCad Part Finder

A Chrome extension that takes a part from DigiKey, LCSC, or any page, checks it, and writes its symbol, footprint, and 3D model into your KiCad library folder.

- **No app to install.** Conversion and file writes happen in the browser.
- **Checked before it is written.** Each part shows who made it (LCSC or a community uploader) and whether every symbol pin has a footprint pad.
- **Works in the side panel** of Chrome, Edge, Brave, and Dia, or as a floating window (Arc) or an in-page overlay.
- KiCad 7, 8, 9, and 10. macOS, Windows, and Linux.

```
DigiKey / LCSC page ─ detects part ─▶ Part Finder panel ◀─ highlight text on any page
                                           │ search, convert, check
                                           ▼
                                   your relay (Cloudflare or Vercel, free)
                                           │
                               JLCPCB search · EasyEDA symbol, footprint, STEP
                                           │
                                           ▼
                                   your library folder
                                     symbols/<Prefix>_<Bucket>.kicad_sym
                                     footprints/<Prefix>_<Bucket>.pretty/
                                     3dmodels/<uuid>.step
```

## Setup (about 10 minutes, once per computer)

You need Node.js 20+ and pnpm (`npm install -g pnpm`).

### 1. Build and load the extension

```bash
git clone https://github.com/Dav1dyang/kicad-part-finder.git
```

```bash
cd kicad-part-finder && pnpm install && pnpm build:extension
```

Open `chrome://extensions` (or `edge://`, `brave://`; in Dia use its Extensions page), turn on **Developer mode**, click **Load unpacked**, and pick `packages/extension/dist`.

### 2. Deploy the relay

JLCPCB and EasyEDA refuse requests from browser extensions, so a tiny relay you own makes them instead. It is stateless, has no secrets, and fits the free tier. Deploy one per person; a relay can serve all your computers.

| Host | Command (from `packages/relay`) | Relay URL to paste |
|------|---------|--------------------|
| Cloudflare Workers | `npx wrangler deploy` | `https://kicad-part-relay.<you>.workers.dev` |
| Vercel | `npx vercel deploy --prod` | `https://<project>.vercel.app/api` |

Details in [packages/relay/README.md](packages/relay/README.md).

### 3. Point KiCad at a library folder

Part Finder writes into one folder and never edits KiCad's settings. KiCad has to know about that folder once.

**If you use [kicad-libraries](https://github.com/Dav1dyang/kicad-libraries):** clone it and run its `tools/setup`. Done.

**Any other folder:**

1. Make an empty folder, for example `~/Documents/KiCad/parts`.
2. In KiCad, open **Preferences › Configure Paths** and add a variable (default name `DAVID_KICAD_LIB`; you can pick your own in Settings) pointing at that folder.
3. Close KiCad. In Part Finder **Settings › KiCad libraries**, click **Copy symbol rows** and paste them inside `sym-lib-table`, then **Copy footprint rows** into `fp-lib-table`. Both files live in KiCad's settings folder (macOS: `~/Library/Preferences/kicad/<version>/`; Windows: `%APPDATA%\kicad\<version>\`; Linux: `~/.config/kicad/<version>/`).
4. Open KiCad again.

### 4. Finish in the panel

Open Part Finder with the toolbar icon or **Cmd+Shift+K** / **Ctrl+Shift+K**. The first-run view asks for:

1. **Relay URL.** Paste it and click **Test**. A green check means search works.
2. **Library folder.** Click **Choose library folder** and pick the folder from step 3. If it already holds libraries with another prefix, the panel offers to use it.

Both stay on this computer. Shortcut changes sync through your browser profile.

## Using it

- **DigiKey or LCSC product page:** the part is detected and searched.
- **Any page:** highlight a part number. To make this work on every site, click **Allow on all sites** once in Settings.
- **Typing:** an LCSC number (`C3235557`) or a manufacturer part number (`TPS2116DRLR`).

A part number with several matches shows a list with stock, price, and package. The card then shows:

- the LCSC number, a **LCSC verified** or **Community part** chip, and JLCPCB stock and price
- **Symbol**, **Footprint**, and **3D** previews (keys 1, 2, 3)
- **Checks**: who made the part, pin and pad counts, whether every pin has a pad, and whether a 3D model exists. Problems open the list automatically. A damaged file blocks Install.
- editable MPN, manufacturer, package, and datasheet (empty fields are flagged)
- the destination library, picked from the part's category

Click **Install to KiCad** or press **Cmd+Enter** / **Ctrl+Enter**. The panel lists every file it wrote. A new library file needs a KiCad restart; later installs need only a library reload.

If EasyEDA has nothing usable, the panel links to Ultra Librarian, SnapMagic (SnapEDA), and Component Search Engine. They have no public API, so you download from them yourself (free accounts).

### What "verified" means

EasyEDA marks each component with who uploaded it and whether LCSC checked it. LCSC's own parts are reliable for most uses. Community parts can be fine, but compare the pinout and land pattern with the datasheet before you order boards. The pin and pad check catches the most common mistake (a pin numbered differently from its pad) but cannot catch a wrong pad size.

## Library layout

Each destination is one library pair named `<Prefix>_<Bucket>`:

| Bucket | Gets |
|--------|------|
| Power | regulators, PMICs, battery chargers |
| Connector | headers, USB, terminal blocks |
| Light | LEDs, displays, optocouplers |
| Discrete | resistors, capacitors, diodes, transistors |
| Switch | buttons, encoders, relays |
| IC | everything else that is a chip |
| Mechanical | standoffs, heatsinks, hardware |
| KiCadPartFinder | catch-all, not prefixed |

Symbols are appended and never duplicated. Footprints are overwritten by name. Each symbol's Footprint field is set to `<Prefix>_<Bucket>:<footprint>` so KiCad links them. STEP models are referenced as `${<path variable>}/3dmodels/<uuid>.step`.

## Open modes

| Mode | Best for | Notes |
|------|----------|-------|
| **Side panel** (default) | Chrome, Edge, Brave, Dia | Opens a tab where there is no side panel. **Float** pins it in an always-on-top window. |
| **Floating window** | Arc | A small window that stays open across tabs. |
| **In-page overlay** | Working in one page | Drag the header to move, the corner to resize. Escape closes it. A small helper window opens to write files, because a page frame cannot. |

## Keyboard shortcuts

| Action | Default (Mac / other) | Where |
|--------|-----------------------|-------|
| Open or close Part Finder | Cmd+Shift+K / Ctrl+Shift+K | anywhere |
| Search highlighted text | Cmd+Shift+L / Ctrl+Shift+L | anywhere |
| Install the current part | Alt+Shift+I | anywhere |
| Install (panel focused) | Cmd+Enter / Ctrl+Enter | panel |
| Focus search | / | panel |
| Symbol, Footprint, 3D | 1, 2, 3 | panel |
| Settings | Cmd+, / Ctrl+, | panel |

The first three are browser shortcuts; change them at `chrome://extensions/shortcuts`. Arc and Dia do not deliver browser shortcuts, so Part Finder also listens for the same keys on pages it may run on (page shortcuts). Panel and page shortcuts can be changed in **Settings › Keyboard shortcuts**.

## Troubleshooting

| You see | Do this |
|---------|---------|
| "Add your relay URL to search" | Paste the relay URL in Settings and click **Test**. |
| Test says it is not the relay | On Vercel the URL must end in `/api`. On Cloudflare use the bare `workers.dev` address. |
| "Relay works, but it is an older version" | Redeploy the relay (step 2). Search still works meanwhile. |
| "JLCPCB refused the request for now" | Wait a minute, or paste the exact LCSC number, which goes to EasyEDA instead. |
| Library pill says **Reconnect folder** | Click it once. Browsers drop folder access when the panel reloads, for example after a restart. |
| Installed, but KiCad does not show it | Restart KiCad if a new library file was created; otherwise reload the library. Check the path variable in **Preferences › Configure Paths**. |
| Shortcut does nothing in Arc or Dia | Use the toolbar icon once on that page, or **Allow on all sites** so page shortcuts work everywhere. |
| No folder dialog in Arc's floating window | Click **Choose in a tab instead**. The window picks the folder up by itself. |
| Overlay says the page blocks embedded panels | Click **Open in a window**, or use the side panel. |

## Privacy

- The extension talks only to your relay; the relay talks only to JLCPCB and EasyEDA.
- Files are written only inside the folder you grant. KiCad settings and project files are never touched.
- Highlighted text is sent only while the panel is open and highlight-to-search is on.
- Part names from the network are rendered as text, never as HTML.

## Development

```bash
pnpm test                 # extension and relay unit tests
```

```bash
pnpm build:extension      # production build to packages/extension/dist
```

```bash
pnpm --filter @kicad-part-finder/extension exec tsc --noEmit
```

```
packages/
  extension/   Chrome extension (Manifest V3, Vite, vitest)
  relay/       Cloudflare Worker, also runs as a Vercel edge function
```

[packages/extension/README.md](packages/extension/README.md) covers the internals; [CLAUDE.md](CLAUDE.md) lists the rules contributors and AI tools follow.

## Credits and license

The EasyEDA to KiCad converter is adapted from [hulryung/easyeda2kicad-web](https://github.com/hulryung/easyeda2kicad-web), itself based on [uPesy/easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py). See [THIRD_PARTY.md](packages/extension/THIRD_PARTY.md). MIT license, see [LICENSE](LICENSE).
