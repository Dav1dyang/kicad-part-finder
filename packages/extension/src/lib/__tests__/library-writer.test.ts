/**
 * Unit tests for the PURE string helpers of the library writer.
 *
 * The FS-Access / IndexedDB layer (pickLibraryFolder, getSavedFolder,
 * installPart) is browser-only and not exercised here; everything tested below
 * is deterministic and DOM/FS-free.
 */
import { describe, it, expect } from 'vitest';
import {
  mergeSymbolLibrary,
  extractSymbolName,
  extractSymbolBlocks,
  extractFootprintName,
  setFootprintModel,
  resolveModelDownload,
  setSymbolFootprintRef
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
});
