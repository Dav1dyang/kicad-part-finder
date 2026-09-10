/**
 * Unit tests for the PURE string helpers of the library writer.
 *
 * The FS-Access / IndexedDB layer (pickLibraryFolder, getSavedFolder,
 * installPart) is browser-only and not exercised here; everything tested below
 * is deterministic and DOM/FS-free.
 */
import { describe, it, expect } from 'vitest';
import {
  applySymbolMeta,
  renameSymbol,
  safeFootprintName,
  setFootprintName,
  setSymbolProperty,
  mergeSymbolLibrary,
  extractSymbolName,
  extractSymbolBlocks,
  extractFootprintName,
  setFootprintModel,
  resolveModelDownload,
  setSymbolFootprintRef,
  updateExistingSymbolFootprintRef
} from '../library-writer';

// A minimal but realistic library wrapper, matching what the converter emits.
const LIB = (...symbols: string[]) =>
  `(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)\n${symbols
    .map((s) => `  ${s}`)
    .join('\n')}\n)\n`;

// A tiny symbol block with nested parens (to exercise the depth scan).
const SYM = (name: string) =>
  `(symbol "${name}" (in_bom yes) (on_board yes)\n` +
  `    (property "Reference" "U" (id 0) (at 0 0 0))\n` +
  `    (symbol "${name}_0_1"\n` +
  `      (rectangle (start -5 5) (end 5 -5))\n` +
  `    )\n` +
  `  )`;

const SYM_WITH_ESCAPED_QUOTE = String.raw`(symbol "CAP_020" (in_bom yes) (on_board yes)
    (property "Reference" "C" (id 0) (at 0 0 0))
    (property "Value" "0.020\"" (id 1) (at 0 -2.54 0))
    (symbol "CAP_020_0_1"
      (rectangle (start -5 5) (end 5 -5))
    )
  )`;

describe('extractSymbolName', () => {
  it('reads the first top-level symbol name', () => {
    expect(extractSymbolName(SYM('TPS2116DRLR'))).toBe('TPS2116DRLR');
    expect(extractSymbolName(LIB(SYM('R0603')))).toBe('R0603');
  });
  it('returns null when there is no symbol', () => {
    expect(extractSymbolName('(kicad_symbol_lib (version 1))')).toBeNull();
  });
});

describe('extractSymbolBlocks', () => {
  it('peels the inner symbol block out of a full library document', () => {
    const block = extractSymbolBlocks(LIB(SYM('FOO')));
    expect(block.startsWith('(symbol "FOO"')).toBe(true);
    // The nested child symbol is preserved…
    expect(block).toContain('(symbol "FOO_0_1"');
    // …and the library wrapper is gone.
    expect(block).not.toContain('kicad_symbol_lib');
    // Balanced parens.
    expect(countChar(block, '(')).toBe(countChar(block, ')'));

    const escapedQuoteBlock = extractSymbolBlocks(LIB(SYM_WITH_ESCAPED_QUOTE));
    expect(escapedQuoteBlock).toBe(SYM_WITH_ESCAPED_QUOTE);
    expect(escapedQuoteBlock).toContain(String.raw`(property "Value" "0.020\""`);
    expect(countChar(escapedQuoteBlock, '(')).toBe(countChar(escapedQuoteBlock, ')'));
  });

  it('returns a bare block unchanged (trimmed)', () => {
    const block = extractSymbolBlocks(SYM('BAR'));
    expect(block).toBe(SYM('BAR'));
  });
});

describe('mergeSymbolLibrary', () => {
  it('creates a fresh library wrapper when the file does not exist', () => {
    const { text, name, added } = mergeSymbolLibrary('', SYM('TPS2116DRLR'));
    expect(added).toBe(true);
    expect(name).toBe('TPS2116DRLR');
    expect(text).toContain('(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)');
    expect(text).toContain('(symbol "TPS2116DRLR"');
    // Exactly one opening library paren, and parens balance.
    expect(countChar(text, '(')).toBe(countChar(text, ')'));
    // Ends with the closing library paren.
    expect(text.trim().endsWith(')')).toBe(true);
  });

  it('accepts a full library document as the new-symbol input too', () => {
    const { text, name, added } = mergeSymbolLibrary('', LIB(SYM('R0603')));
    expect(added).toBe(true);
    expect(name).toBe('R0603');
    expect(text).toContain('(symbol "R0603"');
    // Should not double-wrap the library.
    expect(occurrences(text, 'kicad_symbol_lib')).toBe(1);
  });

  it('inserts a new symbol before the final ) of an existing library', () => {
    const existing = LIB(SYM('ALPHA'));
    const { text, name, added } = mergeSymbolLibrary(existing, SYM('BETA'));
    expect(added).toBe(true);
    expect(name).toBe('BETA');
    // Both symbols now present.
    expect(text).toContain('(symbol "ALPHA"');
    expect(text).toContain('(symbol "BETA"');
    // BETA is inserted AFTER ALPHA and BEFORE the closing library paren.
    expect(text.indexOf('"ALPHA"')).toBeLessThan(text.indexOf('"BETA"'));
    const lastClose = text.lastIndexOf(')');
    expect(text.indexOf('"BETA"')).toBeLessThan(lastClose);
    // Still a single, balanced library.
    expect(occurrences(text, 'kicad_symbol_lib')).toBe(1);
    expect(countChar(text, '(')).toBe(countChar(text, ')'));

    const escaped = mergeSymbolLibrary(existing, LIB(SYM_WITH_ESCAPED_QUOTE));
    expect(escaped.added).toBe(true);
    expect(escaped.name).toBe('CAP_020');
    expect(escaped.text).toContain('(symbol "ALPHA"');
    expect(escaped.text).toContain('(symbol "CAP_020"');
    expect(escaped.text).toContain(String.raw`(property "Value" "0.020\""`);
    expect(countChar(escaped.text, '(')).toBe(countChar(escaped.text, ')'));
  });

  it('dedupes: a symbol whose name already exists leaves the file unchanged', () => {
    const existing = LIB(SYM('DUP'));
    const { text, name, added } = mergeSymbolLibrary(existing, SYM('DUP'));
    expect(added).toBe(false);
    expect(name).toBe('DUP');
    expect(text).toBe(existing); // byte-for-byte unchanged
    // Only one copy of the symbol.
    expect(occurrences(text, '(symbol "DUP"')).toBe(1);
  });

  it('dedupe is name-exact, not a prefix match', () => {
    const existing = LIB(SYM('LM358'));
    // "LM3" is a different part — must be added, not deduped against "LM358".
    const { added } = mergeSymbolLibrary(existing, SYM('LM3'));
    expect(added).toBe(true);
  });

  it('handles names containing regex-special characters safely', () => {
    const weird = 'OP+AMP(x).1';
    const existing = LIB(SYM(weird));
    const dup = mergeSymbolLibrary(existing, SYM(weird));
    expect(dup.added).toBe(false); // deduped despite the special chars
    const fresh = mergeSymbolLibrary(existing, SYM('OTHER'));
    expect(fresh.added).toBe(true);
  });
});

describe('extractFootprintName', () => {
  it('reads the token after (footprint "', () => {
    const fp = '(footprint "SOT-583-8_L2.1" (version 20211014)\n  (layer "F.Cu")\n)';
    expect(extractFootprintName(fp)).toBe('SOT-583-8_L2.1');
  });
  it('falls back to "Footprint" when unparseable', () => {
    expect(extractFootprintName('(module foo)')).toBe('Footprint');
  });
});

describe('setFootprintModel', () => {
  const FP = '(footprint "X" (version 20211014)\n  (layer "F.Cu")\n  (pad "1" smd)\n)';

  it('inserts a (model …) block before the final ) when none exists', () => {
    const out = setFootprintModel(FP, 'abc123.step');
    expect(out).toContain('(model "${DAVID_KICAD_LIB}/3dmodels/abc123.step"');
    // Inserted before the footprint close.
    const lastClose = out.lastIndexOf(')');
    expect(out.indexOf('(model ')).toBeLessThan(lastClose);
    // Parens balance after insertion.
    expect(countChar(out, '(')).toBe(countChar(out, ')'));
  });

  it('rewrites an existing model path in place (idempotent on file name)', () => {
    const withModel =
      '(footprint "X"\n  (pad "1" smd)\n  (model "${DAVID_KICAD_LIB}/3dmodels/old.step"\n    (scale (xyz 1 1 1))\n  )\n)';
    const out = setFootprintModel(withModel, 'new.step');
    expect(out).toContain('3dmodels/new.step');
    expect(out).not.toContain('old.step');
    // Did not add a second model block.
    expect(occurrences(out, '(model ')).toBe(1);
  });
});

describe('resolveModelDownload', () => {
  // Stand-in deployed Worker relay origin; the STEP is fetched through it now.
  const RELAY = 'https://kicad-part-relay.example.workers.dev';

  it('extracts the uuid and builds a relay STEP url + .step filename', () => {
    const url = 'https://easyeda.com/api/v2/components/7de5db90ab974d88b4eb22e148e2ee81/3d';
    const dl = resolveModelDownload(url, RELAY);
    expect(dl).not.toBeNull();
    expect(dl!.uuid).toBe('7de5db90ab974d88b4eb22e148e2ee81');
    expect(dl!.fileName).toBe('7de5db90ab974d88b4eb22e148e2ee81.step');
    // The URL now points at the relay (which fetches modules.easyeda.com
    // server-side), not directly at the WAF-blocked EasyEDA module store.
    expect(dl!.stepUrl).toBe(
      `${RELAY}/easyeda/model?uuid=7de5db90ab974d88b4eb22e148e2ee81`,
    );
  });

  it('trims a trailing slash on the relay base', () => {
    const url = 'https://easyeda.com/api/v2/components/7de5db90ab974d88b4eb22e148e2ee81/3d';
    const dl = resolveModelDownload(url, `${RELAY}/`);
    expect(dl!.stepUrl).toBe(
      `${RELAY}/easyeda/model?uuid=7de5db90ab974d88b4eb22e148e2ee81`,
    );
  });

  it('returns null when there is no 32-hex uuid', () => {
    expect(resolveModelDownload('https://example.com/no-uuid-here', RELAY)).toBeNull();
  });
});

// --- helpers ---------------------------------------------------------------
function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('setSymbolFootprintRef', () => {
  it('qualifies a bare Footprint value with the lib nickname', () => {
    const sym = '(symbol "X" (property "Footprint" "LQFP-48" (at 0 0 0)))';
    expect(setSymbolFootprintRef(sym, 'DavidLib_IC:LQFP-48')).toContain(
      '(property "Footprint" "DavidLib_IC:LQFP-48"',
    );
  });
  it('replaces an already-qualified value', () => {
    const sym = '(symbol "X" (property "Footprint" "Old:Foo"))';
    expect(setSymbolFootprintRef(sym, 'DavidLib_IC:Bar')).toContain('"DavidLib_IC:Bar"');
  });
  it('leaves a symbol without a Footprint property unchanged', () => {
    const sym = '(symbol "X" (property "Value" "X"))';
    expect(setSymbolFootprintRef(sym, 'DavidLib_IC:Bar')).toBe(sym);
  });
  it('inserts the ref literally even with $-tokens (function replacer, not string)', () => {
    const sym = '(symbol "X" (property "Footprint" "old"))';
    expect(setSymbolFootprintRef(sym, 'DavidLib_IC:A$1$&B')).toContain('"DavidLib_IC:A$1$&B"');
  });
  it('replaces a value containing an escaped quote without truncating at it', () => {
    // The old `[^"]*` value group stopped at the inner `\"`, leaving a dangling
    // `" pitch"` and corrupting the symbol. The escape-aware group consumes it.
    const sym = String.raw`(symbol "X" (property "Footprint" "3.5\" pitch" (at 0 0 0)))`;
    const out = setSymbolFootprintRef(sym, 'DavidLib_Conn:HDR-2.54');
    expect(out).toBe(String.raw`(symbol "X" (property "Footprint" "DavidLib_Conn:HDR-2.54" (at 0 0 0)))`);
    // The old escaped-quote value is fully gone (no dangling fragment left behind).
    expect(out).not.toContain('pitch');
    expect(out).not.toContain(String.raw`\"`);
  });
});

describe('updateExistingSymbolFootprintRef', () => {
  // A symbol carrying a BARE Footprint value (the pre-auto-link shape) plus a
  // nested child symbol so the paren-depth scan is exercised.
  const SYM_FP = (name: string, fp: string) =>
    `(symbol "${name}" (in_bom yes) (on_board yes)\n` +
    `    (property "Reference" "U" (id 0) (at 0 0 0))\n` +
    `    (property "Footprint" "${fp}" (id 2) (at 0 0 0))\n` +
    `    (symbol "${name}_0_1"\n` +
    `      (rectangle (start -5 5) (end 5 -5))\n` +
    `    )\n` +
    `  )`;

  it('upgrades an existing symbol\'s bare Footprint to the qualified ref in place', () => {
    const lib = LIB(SYM_FP('TPS2116DRLR', 'LQFP-48'));
    const { text, changed } = updateExistingSymbolFootprintRef(
      lib,
      'TPS2116DRLR',
      'DavidLib_IC:LQFP-48',
    );
    expect(changed).toBe(true);
    expect(text).toContain('(property "Footprint" "DavidLib_IC:LQFP-48"');
    expect(text).not.toContain('(property "Footprint" "LQFP-48"');
    // Still a single, balanced library.
    expect(occurrences(text, 'kicad_symbol_lib')).toBe(1);
    expect(countChar(text, '(')).toBe(countChar(text, ')'));
  });

  it('reports no change when the ref already matches', () => {
    const lib = LIB(SYM_FP('R0603', 'DavidLib_R:R0603'));
    const { text, changed } = updateExistingSymbolFootprintRef(lib, 'R0603', 'DavidLib_R:R0603');
    expect(changed).toBe(false);
    expect(text).toBe(lib); // byte-for-byte unchanged
  });

  it('touches ONLY the named symbol, leaving sibling symbols\' footprints alone', () => {
    const lib = LIB(SYM_FP('ALPHA', 'SOT-23'), SYM_FP('BETA', 'SOT-23'));
    const { text, changed } = updateExistingSymbolFootprintRef(lib, 'BETA', 'DavidLib_T:SOT-23');
    expect(changed).toBe(true);
    // BETA upgraded…
    expect(text).toContain('(property "Footprint" "DavidLib_T:SOT-23"');
    // …ALPHA's bare footprint untouched (still exactly one bare "SOT-23").
    expect(occurrences(text, '(property "Footprint" "SOT-23"')).toBe(1);
    // ALPHA appears before BETA, and only one footprint was qualified.
    expect(text.indexOf('"ALPHA"')).toBeLessThan(text.indexOf('"BETA"'));
    expect(occurrences(text, '"DavidLib_T:SOT-23"')).toBe(1);
  });

  it('returns unchanged when the symbol is absent', () => {
    const lib = LIB(SYM_FP('ALPHA', 'SOT-23'));
    const { text, changed } = updateExistingSymbolFootprintRef(lib, 'GHOST', 'DavidLib_X:Y');
    expect(changed).toBe(false);
    expect(text).toBe(lib);
  });

  it('returns unchanged when the symbol has no Footprint property', () => {
    const lib = LIB(SYM('NOFP')); // SYM(...) emits no Footprint property
    const { text, changed } = updateExistingSymbolFootprintRef(lib, 'NOFP', 'DavidLib_X:Y');
    expect(changed).toBe(false);
    expect(text).toBe(lib);
  });
});

describe('mergeSymbolLibrary insertion point', () => {
  it('inserts inside the library even when a trailing comment contains a paren', () => {
    const existing = '(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)\n  (symbol "A" (property "Value" "A" (id 1) (at 0 0 0)))\n)\n# generated (v0.8)\n';
    const merged = mergeSymbolLibrary(existing, '(symbol "B" (property "Value" "B" (id 1) (at 0 0 0)))');
    expect(merged.added).toBe(true);
    const libClose = merged.text.indexOf('\n)\n# generated');
    expect(libClose).toBeGreaterThan(merged.text.indexOf('(symbol "B"'));
    expect(merged.text.endsWith('# generated (v0.8)\n')).toBe(true);
  });
});

describe('safeFootprintName / setFootprintName', () => {
  it('replaces characters that are illegal in file names', () => {
    expect(safeFootprintName('SOT-23/8')).toBe('SOT-23_8');
    expect(safeFootprintName('QFN:16 "x"')).toBe('QFN_16__x_');
    expect(safeFootprintName('...')).toBe('Footprint');
    expect(safeFootprintName('LQFP-48')).toBe('LQFP-48');
  });
  it('rewrites the footprint token to match', () => {
    expect(setFootprintName('(footprint "SOT-23/8" (layer "F.Cu"))', 'SOT-23_8')).toBe('(footprint "SOT-23_8" (layer "F.Cu"))');
  });
});

const FULL_SYM = [
  '(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)',
  '  (symbol "TPS2116" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)',
  '    (property "Reference" "U" (id 0) (at 0 2.54 0)',
  '      (effects (font (size 1.27 1.27)))',
  '    )',
  '    (property "Value" "TPS2116" (id 1) (at 0 -2.54 0)',
  '      (effects (font (size 1.27 1.27)))',
  '    )',
  '    (property "Footprint" "SOT-23-8" (id 2) (at 0 0 0)',
  '      (effects (font (size 1.27 1.27)) hide)',
  '    )',
  '    (property "Datasheet" "" (id 3) (at 0 0 0)',
  '      (effects (font (size 1.27 1.27)) hide)',
  '    )',
  '    (symbol "TPS2116_0_1"',
  '      (rectangle (start -5 5) (end 5 -5))',
  '    )',
  '  )',
  ')',
].join('\n');

describe('setSymbolProperty', () => {
  it('rewrites an existing property in place', () => {
    const out = setSymbolProperty(FULL_SYM, 'Datasheet', 'https://ti.com/x.pdf');
    expect(out).toContain('(property "Datasheet" "https://ti.com/x.pdf" (id 3)');
    expect(out.split('(property').length).toBe(FULL_SYM.split('(property').length);
  });
  it('adds a missing property after the last one with the next id', () => {
    const out = setSymbolProperty(FULL_SYM, 'Manufacturer', 'Texas "TI" Instruments');
    expect(out).toContain('(property "Manufacturer" "Texas \\"TI\\" Instruments" (id 4) (at 0 0 0)');
    expect(out.indexOf('"Manufacturer"')).toBeLessThan(out.indexOf('(symbol "TPS2116_0_1"'));
  });
  it('does not add an empty property', () => {
    expect(setSymbolProperty(FULL_SYM, 'Package', '')).toBe(FULL_SYM);
  });
});

describe('applySymbolMeta', () => {
  it('renames the symbol and its sub-symbols when the MPN is corrected', () => {
    const out = applySymbolMeta(FULL_SYM, { mpn: 'TPS2116DRLR' });
    expect(out).toContain('(symbol "TPS2116DRLR" (pin_names');
    expect(out).toContain('(symbol "TPS2116DRLR_0_1"');
    expect(out).not.toContain('"TPS2116"');
    expect(out).toContain('(property "Value" "TPS2116DRLR"');
    expect(out).toContain('(property "MPN" "TPS2116DRLR"');
  });
  it('writes manufacturer, package, datasheet and keeps the file well-formed', () => {
    const out = applySymbolMeta(FULL_SYM, { manufacturer: 'TI', package: 'SOT-23-8', datasheet: 'https://x' });
    expect(out).toContain('(property "Manufacturer" "TI"');
    expect(out).toContain('(property "Package" "SOT-23-8"');
    expect(out).toContain('(property "Datasheet" "https://x"');
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });
  it('is a no-op for empty metadata', () => {
    expect(applySymbolMeta(FULL_SYM, {})).toBe(FULL_SYM);
  });
  it('renameSymbol leaves unrelated names alone', () => {
    expect(renameSymbol('(symbol "TPS21160" (symbol "TPS2116_0_1"', 'TPS2116', 'X')).toBe('(symbol "TPS21160" (symbol "X_0_1"');
  });
});
