# KiCad Part Finder

A browser extension that adds a part's KiCad symbol, footprint, and 3D model to your library in one click. It checks the part first.

- Finds parts on DigiKey, LCSC, or any highlighted text.
- Shows who made the part and whether every pin has a pad.
- Runs in the side panel of Chrome, Edge, Brave, and Dia; or as a floating window (Arc) or on-page panel.
- KiCad 7 to 10, macOS, Windows, Linux. No app to install.

```
page or typed part ──▶ Part Finder ──▶ your relay ──▶ JLCPCB + EasyEDA
                            │
                            ▼
                  your library folder
                    symbols/<Prefix>_<Bucket>.kicad_sym
                    footprints/<Prefix>_<Bucket>.pretty/
                    3dmodels/<uuid>.step
```

## Setup (once per computer)

Needs Node.js 20+ and pnpm (`npm i -g pnpm`).

**1. Build and load**

```bash
git clone https://github.com/Dav1dyang/kicad-part-finder.git && cd kicad-part-finder && pnpm install && pnpm build:extension
```

Open your browser's extensions page, turn on **Developer mode**, click **Load unpacked**, pick `packages/extension/dist`.

**2. Deploy the relay** (once per person, free)

JLCPCB and EasyEDA block extensions, so a small relay you own fetches for you. From `packages/relay`:

| Host | Command | URL to paste |
|------|---------|--------------|
| Cloudflare | `npx wrangler deploy` | `https://kicad-part-relay.<you>.workers.dev` |
| Vercel | `npx vercel deploy --prod` | `https://<project>.vercel.app/api` |

**3. Connect KiCad to a folder**

- Using [kicad-libraries](https://github.com/Dav1dyang/kicad-libraries)? Run its `tools/setup`. Done.
- Otherwise: make a folder, add a path variable to it in KiCad (**Preferences › Configure Paths**, default name `DAVID_KICAD_LIB`), close KiCad, then paste the rows from **Settings › KiCad libraries › Copy** into `sym-lib-table` and `fp-lib-table` in KiCad's settings folder:
  - macOS `~/Library/Preferences/kicad/<version>/`
  - Windows `%APPDATA%\kicad\<version>\`
  - Linux `~/.config/kicad/<version>/`

**4. Open Part Finder** (toolbar icon or **Cmd/Ctrl+Shift+K**), paste the relay URL, click **Test**, then **Choose folder**.

## Use

1. Open a DigiKey or LCSC product page, highlight a part number, or type one (`C3235557`, `TPS2116DRLR`).
2. Pick a match if there are several.
3. Review the card: previews (keys 1, 2, 3), checks, fields, destination library.
4. **Install to KiCad** (**Cmd/Ctrl+Enter**). Restart KiCad for a new library file; otherwise reload the library.

**Checks.** "LCSC verified" means LCSC made and checked the part. "Community part" means someone else uploaded it: compare it with the datasheet before ordering boards. The pin check catches pins with no matching pad, not wrong pad sizes. Damaged files cannot be installed.

**No EasyEDA data?** The card links to Ultra Librarian, SnapMagic, and Component Search Engine (free accounts, manual download).

## Libraries

Each destination is `<Prefix>_<Bucket>`: Power, Connector, Light, Discrete, Switch, IC, Mechanical, plus the unprefixed `KiCadPartFinder` catch-all. The bucket is picked from the part's category; you can change it.

Symbols are added once, never duplicated. Footprints are replaced by name. Each symbol links to its footprint, and footprints link to `${<path variable>}/3dmodels/<uuid>.step`. Change the prefix and path variable in Settings.

## Shortcuts

| Action | Mac / other |
|--------|-------------|
| Open or close | Cmd+Shift+K / Ctrl+Shift+K |
| Search highlighted text | Cmd+Shift+L / Ctrl+Shift+L |
| Install | Alt+Shift+I, or Cmd/Ctrl+Enter in the panel |
| Focus search · previews · Settings | / · 1 2 3 · Cmd/Ctrl+, |

Change browser shortcuts at `chrome://extensions/shortcuts`. Arc and Dia ignore those, so Part Finder also listens on pages it can run on. Change those and panel shortcuts in **Settings › Keyboard shortcuts**.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Add your relay URL" | Paste it in Settings, click **Test**. |
| Test says "not the relay" | Vercel URLs end in `/api`. |
| "Works, but outdated" | Redeploy the relay. |
| "JLCPCB is busy" | Wait a minute, or paste the LCSC number. |
| Library says **Reconnect folder** | Click it once (browsers forget after a restart). |
| Part missing in KiCad | Restart KiCad or reload the library. Check the path variable. |
| Shortcut does nothing (Arc, Dia) | Click **Allow on all sites** in Settings. |
| No folder dialog (Arc window) | Click **Choose in a tab instead**. |

## Privacy

The extension talks only to your relay; the relay only to JLCPCB and EasyEDA. Files are written only inside your folder. Highlighted text is sent only while the panel is open.

## Develop

```bash
pnpm test && pnpm build:extension
```

`pnpm test:e2e` loads the built extension in Chromium against a mock relay: search, checks, 3D colours, install, and dedupe.

`packages/extension` is the extension, `packages/relay` the relay. See [CLAUDE.md](CLAUDE.md) for contributor rules and [packages/extension/README.md](packages/extension/README.md) for internals.

## Credits

Converter adapted from [hulryung/easyeda2kicad-web](https://github.com/hulryung/easyeda2kicad-web) and [uPesy/easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py) ([THIRD_PARTY.md](packages/extension/THIRD_PARTY.md)). MIT license.
