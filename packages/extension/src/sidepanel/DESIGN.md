# Part Finder design language: Soft Fields

Soft pastel colour fields on handmade paper. Shapes are made of colour, not lines, and their edges feather into the ground like airbrush on paper. Calm, flat, a little handmade. The default palette is a green apple with a brown stem.

Mood references: a pastel green apple with a brown stem, airbrushed green hills with white speckle, mid-century flat-colour information design. Not wanted: neon, glossy or raised "3D pill" buttons, hard outlines, grids on the background, saturated blue against green.

## Principles

1. **Shapes, not lines.** No outlines, no divider rules. Space and colour separate things.
2. **Edges bleed.** A shape's own colour (`--block`) feathers past its edge into the ground. Never a dark drop shadow, never a highlight or bevel.
3. **Colour glows from within.** Colour blocks are deepest in the middle and lighten toward the edge (`--mist`).
4. **Paper, not a grid.** One texture everywhere (`--paper`): fine grain, long fibres, sparse white speckle. The only dots are the functional grid on the drawing stage.
5. **Pastel fields, dark ink.** Fills are pastel; text on them is a dark ink of the same hue. White text on saturated colour is not used.
6. **OKLab everywhere.** Every gradient and `color-mix()` interpolates in OKLab so blends stay clean, never grey in the middle.
7. **Colour has one job.** Status colours are fixed; main and accent come from the combination chosen in Settings.
10. **One colour family per combination.** Ground, surfaces and ink all take the main colour's hue, so Lake is a blue paper and Peach a warm one. The ground is one colour: a glow of the main colour over a wash of its hue. The accent never paints the ground.
8. **Plain type.** Helvetica, sentence case, no tracked capitals. Monospace only for file paths, code, and pin labels in drawings.
9. **Soft corners.** 14 px surfaces, 10 px fields and buttons, 7 px small controls, full pills for chips and switches.

## Colour roles

| Token | Role | Light (Apple) | Dark |
|-------|------|---------------|------|
| `--bg`, `--ground` | Ground: off-white wash of the main hue, with a glow of the main colour top right | `#eef3e9` | deep field green `#2a372c`, soft main-colour glow |
| `--surface-1/2/3` | Surface, field, secondary-action fills | `#fafcf6` / `#eef3e8` / `#e4ebdc` | `#334135` / `#3c4b3f` / `#475749` |
| `--text`, `--text-dim`, `--text-faint` | Ink, tinted with the main hue | `#202717` / `#484f3f` / `#575e4f` | `#eaf3eb` / `#cbd9cd` / `#b4c4b6` |
| `--btn-primary` (+ ink) | Main action field (palette) | apple green `#c8e4a2` / `#1f3a1c` | `#d2e9ab` / `#16261b` |
| `--accent` (+ ink, wash) | Selection and highlight (palette) | stem brown `#8a5a3b`, wash `#f1e5d8` | tan `#d9b08c`, wash `#3f3224` |
| `--ok` | Ready, success, verified | green `#2f8f3a`, wash `#e2f1d6` | `#8fd16f` |
| `--warn` | Needs a look | honey `#7a5208`, wash `#f5e8cc` | `#ecc983` |
| `--danger` | Error, always with its × mark | plum `#74345a`, wash `#f3e2ea` | `#eab0cd` |

Colour combinations (`src/lib/palettes.ts`): Apple (default), Lake, Moss, Mist, Peach. Each sets main, accent, the 3D tile and the house mark for both schemes. Ground, surfaces and ink are derived in OKLCH from the main colour's hue at fixed lightness and chroma levels (`neutrals()`), measured from the original Apple set; Apple dark pins its hue to keep the deep field green. The values in `styles.css` are Apple's, shown until the panel script applies the saved combination. Contrast is unit-tested for every combination: text and secondary text at 4.5:1 on the ground and every surface, ink on main and accent ink on wash at 4.5:1 (also under the mist), accent marks at 3:1 on cards. `e2e/run.cjs` checks the painted page follows each main colour in both themes.

## Primitives

| Primitive | Look | Used by |
|-----------|------|---------|
| Ground | `--ground` gradients + paper, fixed | page |
| Surface | `--surface-1`, 14 px, large bleed | result card, Settings, setup |
| Field | `--surface-2`, 10 px, no border, small bleed. Hover one step darker. Focus: mid-accent ring + glow | text inputs, library select, search box, preview tabs track, open-mode track, drawing stage |
| Block | role wash + `--mist` + paper, small bleed, text in role ink | Library/Relay pills when something is missing, checks, status lines, notes, success list, detected-part offer |
| Quiet block | `--surface-2` + `--mist` + paper, small bleed, green icon only | Library/Relay pills when ready (the normal state) |
| Chip | full pill, wash fill, no border, no bleed | LCSC number, provenance, stock and price, flags |
| Selected | accent wash fill only | active preview tab, open mode, theme, library select, match row |
| Main action | pastel `--btn-primary` field + `--mist` + paper, small bleed in its own colour, dark ink | Install |
| Secondary action | `--surface-3` block, small bleed | Test, Copy rows, Allow on all sites, Float, Settings, Install another |
| List row | Surface colour, small bleed, 10 px gaps | other sources, match list |
| Link | accent ink, underline on hover | inline actions in hints and status lines |
| Focus | 2 px mid-accent ring + glow, raised above neighbours | every interactive element focused by keyboard |

## Layering and overlap

- **Two bleed sizes.** `--bleed-lg` (20 px + 4 px) for surfaces on the ground. `--bleed-sm` (10 px + 1 px) for everything inside a surface or in a list.
- **Small bleed fits inside padding.** 11 px is less than a surface's 14 px padding, so a child's halo is never clipped into a hard edge by the surface's rounded clip.
- **Gaps are at least twice the small bleed.** Lists and pill rows use 10 px gaps so halos stay separate shapes instead of one blob.
- **Later siblings paint over earlier ones.** The small bleed is kept at 70 % of the block colour so an overlap only tints, never hides.
- **Focus rises.** A focused control gets `z-index: 1` so its ring is never covered by a neighbour's halo.
- **Inside the card nothing repaints the card colour.** The header is transparent so the card's paper reads as one sheet.

## Drawings (symbol and footprint previews)

Drawings use theme tokens only, never fixed colours, so they read on light paper, dark ground, and every colour combination.

| Element | Colour |
|---------|--------|
| Symbol body outline, pin dots | accent |
| Pin lines, pin numbers | `--text-dim` (ink) |
| Pin names | `--text` |
| Pads | main colour field, numbers in its ink (same pairing as Install) |
| Silkscreen | `--text-dim` at 50 % so pads stay the focus |
| Courtyard | honey at 65 % |
| Origin crosshair | accent at 45 % |

## Exceptions

- **Key caps** keep a thin outline: they picture physical keys.
- **Colour swatches** in Settings show selection with an ink ring, since the swatch itself is coloured.
- **The drawing stage** has a faint dot grid: it is a drawing aid, not decoration.
- **The library select** opens the operating system's own menu, which follows the system theme. The closed control follows the Field style.

## States every interactive element shows

Default, hover, keyboard focus, active or selected, disabled (dimmed, no bleed), busy (the label says what is happening), and error (plum block with ×). `e2e/states.cjs` renders each of these in light and dark into one contact sheet per theme for review; `e2e/run.cjs` checks that nothing overflows at 320 to 800 px in both themes.

## Review loop

Before shipping a visual change: build, run `node e2e/states.cjs`, and critique both sheets against this file. Check: no outlines or dividers crept back, every shape uses one primitive, halos do not merge or clip, text pairs stay at 4.5:1, and dark mode is as considered as light.
