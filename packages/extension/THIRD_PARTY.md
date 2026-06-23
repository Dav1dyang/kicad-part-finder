# Third-Party Code

## easyeda2kicad-web (hulryung)

Files under `src/lib/converter/` are adapted from
[hulryung/easyeda2kicad-web](https://github.com/hulryung/easyeda2kicad-web),
which is MIT-licensed (per its README).

| Vendored file | Upstream source |
| --- | --- |
| `src/lib/converter/kicad-parser.ts` | `lib/kicad-parser.ts` (verbatim; only the type-import path changed) |
| `src/lib/converter/schematic-parser.ts` | `parseSchematicData` extracted from `components/SchematicViewer.tsx` (React stripped) |
| `src/lib/converter/types.ts` | `types/easyeda.ts` (trimmed to the converter's needs) |

`src/lib/converter/easyeda.ts` and the tests under
`src/lib/converter/__tests__/` are original to this project.

That upstream project is in turn inspired by
[easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py) by uPesy.

> Disclaimer (carried over from upstream): the accuracy of converted symbols and
> footprints is not guaranteed. Always verify components before using them in a
> production PCB design.
