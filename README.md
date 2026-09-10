# KiCad Part Finder

A Chrome extension that turns "I found a part on DigiKey or LCSC" into "the symbol, footprint, and 3D model are in my KiCad library" with one click.

It runs entirely in the browser. There is no companion app to install. Two things make that possible:

- A small **relay** you deploy once (Cloudflare Worker or Vercel edge function). JLCPCB and EasyEDA block browser requests, so the relay fetches on your behalf.
- The browser's **File System Access API**. You grant the extension your library folder once, and it writes files straight into it.

Works with KiCad 7, 8, 9, and 10.

## How it works

```
DigiKey / LCSC page ──detects part──▶ Part Finder panel
Any page ──highlight text──────────▶       │
                                           │ search / convert
                                           ▼
                                    Your relay (workers.dev or vercel.app)
                                           │
                                    JLCPCB search · EasyEDA symbol/footprint/STEP
                                           │
                                           ▼
                                    Your library folder (kicad-libraries)
                                      symbols/DavidLib_<Bucket>.kicad_sym
                                      footprints/DavidLib_<Bucket>.pretty/
                                      3dmodels/<uuid>.step
```

The extension never edits KiCad's global library tables. Those are set up once by the [kicad-libraries](https://github.com/Dav1dyang/kicad-libraries) repo's `tools/setup`, which registers each `DavidLib_<Bucket>` library and the `KiCadPartFinder` catch-all against a `${DAVID_KICAD_LIB}` path variable.

## Setup

You need Node.js 20 or newer and pnpm.

### 1. Build and load the extension

```bash
git clone https://github.com/Dav1dyang/kicad-part-finder.git
cd kicad-part-finder
pnpm install
pnpm build:extension
```

Then in Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `packages/extension/dist`.

### 2. Deploy the relay

Pick one. Both are free-tier and stateless. See [packages/relay/README.md](packages/relay/README.md) for details.

| Host | Command | Relay URL to paste |
|------|---------|--------------------|
| Cloudflare Workers | `cd packages/relay && npx wrangler deploy` | `https://<name>.<you>.workers.dev` |
| Vercel | `cd packages/relay && npx vercel deploy --prod` | `https://<project>.vercel.app/api` |

### 3. Prepare your library folder

Clone [kicad-libraries](https://github.com/Dav1dyang/kicad-libraries) and run its `tools/setup` once. That defines `${DAVID_KICAD_LIB}` in KiCad and adds the library nicknames to KiCad's global tables. Restart KiCad afterwards.

### 4. Finish in the panel

Open the panel with the toolbar icon or **Cmd+Shift+K** (Mac) / **Ctrl+Shift+K** (Windows, Linux). The first-run view asks for two things:

1. **Relay URL.** Paste the address from step 2 and click **Test**. A green check means searches will work.
2. **Library folder.** Click **Choose library folder** and pick your `kicad-libraries` clone. Chrome remembers the grant. Search and preview work without it; only Install needs it.

Both settings live on this computer only. Panel shortcuts sync across your Chrome profile.

## Using it

**On DigiKey or LCSC** the part is detected automatically and the search box is pre-filled. Press Enter or click Search.

**On any other page** highlight a part number. The panel searches it after a short pause. You can turn this off in Settings and use the **Search highlighted text** shortcut instead.

**Typing** works too. Enter an LCSC number like `C3235557` or a manufacturer part number like `TPS2116DRLR`.

When a part number matches several LCSC parts you get a list with stock, price, and package. Pick one. The card then shows:

- the MPN, manufacturer, package, and a stock and price badge from JLCPCB
- **Symbol**, **Footprint**, and **3D** previews (keys 1, 2, 3 switch tabs)
- editable metadata. Empty or uncertain fields are flagged amber so you can confirm them.
- a **Destination library**, auto-picked from the part's category. You can always change it.

Click **Install to KiCad** or press **Cmd+Enter** / **Ctrl+Enter**. The panel lists every file it wrote. The first time a new library file is created you need to restart KiCad so it picks up the file. Later installs into the same library appear after a library reload in KiCad.

If EasyEDA has no data for a part, the panel links to SnapEDA, Component Search Engine, and Ultra Librarian so you can keep going.

## Open modes

Settings lets you choose how the panel opens.

| Mode | Best for | Notes |
|------|----------|-------|
| **Side panel** (default) | Chrome, Edge, Brave | Opens a tab instead on browsers without a side panel. The **Float** button moves the UI into an always-on-top window. |
| **Floating window** | Arc | A separate small window that stays open while you switch tabs. |
| **In-page overlay** | Working inside one page | A draggable, resizable panel on the page itself. Drag the header to move, drag the corner to resize, double-click the header to minimize. Press Escape to close. |

The overlay runs inside a frame, which Chrome does not allow to write files. So when you grant a folder or install from the overlay, a small helper window opens, does the work, and closes itself. That is expected.

## Keyboard shortcuts

There are two kinds.

**Browser shortcuts** work on any page, even when the panel is closed. Chrome manages them, so the extension can only show the current binding. To change one, open Settings and click **Change in Chrome**, or go to `chrome://extensions/shortcuts` directly (`edge://extensions/shortcuts` on Edge, `brave://extensions/shortcuts` on Brave).

| Action | Default |
|--------|---------|
| Open Part Finder | Cmd+Shift+K / Ctrl+Shift+K |
| Search highlighted text | Cmd+Shift+L / Ctrl+Shift+L |
| Install the current part | Alt+Shift+I |

Chrome silently drops a default that another extension already uses. The Settings list shows **Not set** when that happens.

**Panel shortcuts** work while the panel is focused. You can change them in Settings: click a key, press the new combination, done. Press Escape to cancel or Backspace to unbind. They are stored in your Chrome profile and sync across machines.

| Action | Default (Mac / other) |
|--------|-----------------------|
| Focus the search box | / |
| Install the current part | Cmd+Enter / Ctrl+Enter |
| Symbol, Footprint, 3D preview | 1, 2, 3 |
| Open or close Settings | Cmd+, / Ctrl+, |
| Close Settings, clear the search, or close the window | Escape |

Single-key shortcuts pause while you are typing in a text field. Install always needs a modifier so it cannot fire by accident. Combos the browser reserves (Cmd+W, Ctrl+T, and so on) are refused with a reason.

## Appearance

The panel follows your system light or dark theme. Settings lets you pin it to one or the other.

## Troubleshooting

**"Add your relay URL to search"**
The relay is not set. Paste it in Settings and click **Test**.

**Test says the address answered but is not the relay**
On Vercel the endpoints live under `/api`, so the URL must end in `/api`. On Cloudflare use the bare `workers.dev` address.

**"Couldn't reach JLCPCB through your relay"**
The relay is up but JLCPCB refused it, usually a temporary block. Wait a minute, or paste the exact LCSC number, which uses EasyEDA instead.

**The Library pill says "Reconnect folder"**
Chrome forgets folder grants whenever the panel's page is reloaded, for example after a browser restart. Click the pill once to re-allow it. The floating window keeps its grant as long as it stays open.

**No folder dialog appears (Arc floating window)**
Arc's floating popup window does not show native folder dialogs or permission prompts. Click **Choose in a tab instead** (or **Open in a tab** in the message that appears). A normal tab opens, the dialog works there, and the floating window picks up the folder by itself. You can close the tab afterwards.

**Installed, but KiCad does not show the part**
If the install created a new library file, restart KiCad. Otherwise open the Symbol Editor or Footprint Editor and reload the library. Also confirm `${DAVID_KICAD_LIB}` points at your `kicad-libraries` folder in KiCad's path settings.

**The overlay shows "This page blocks embedded panels"**
Some sites forbid embedded frames. Click **Open in a window** or switch to the side panel mode.

**Arc: the floating window disappears when I switch tabs**
Use the **Floating window** open mode rather than the Float button. Arc drops always-on-top windows when the source tab is backgrounded.

## Privacy and security

- The extension only talks to your relay. The relay only talks to JLCPCB and EasyEDA. No data goes anywhere else.
- The relay has no secrets and stores nothing.
- Files are written only inside the folder you grant. KiCad's global tables and your project files are never touched.
- Highlighted text is sent to your relay only when the panel is open and the highlight-to-search setting is on.
- The panel renders every part name with `textContent`, never HTML, so a malicious part name cannot run code.

## Development

```bash
pnpm install
pnpm test               # unit tests for the extension, relay, and legacy server
pnpm dev:extension      # rebuild on change
pnpm build:extension    # production build to packages/extension/dist
pnpm --filter @kicad-part-finder/extension exec tsc --noEmit   # typecheck
```

```
packages/
  extension/   Chrome extension (Manifest V3, Vite, vitest)
  relay/       Cloudflare Worker + Vercel edge function
  shared/      Types shared across packages
  server/      Legacy companion server. Not used by the extension anymore.
scripts/       Legacy install/uninstall scripts for the server. Not needed.
```

See [packages/extension/README.md](packages/extension/README.md) for the extension's internals and [CLAUDE.md](CLAUDE.md) for the conventions contributors and AI tools should follow.

## Uninstall

Remove the extension from `chrome://extensions`. Your library folder and relay deployment are untouched. Delete the relay from your Cloudflare or Vercel dashboard if you no longer want it.

## Credits

The EasyEDA to KiCad converter is adapted from [hulryung/easyeda2kicad-web](https://github.com/hulryung/easyeda2kicad-web), itself inspired by [uPesy/easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py). See [packages/extension/THIRD_PARTY.md](packages/extension/THIRD_PARTY.md).

## License

MIT. See [LICENSE](LICENSE).
