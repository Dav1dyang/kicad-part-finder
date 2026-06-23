/**
 * Tests for the EasyEDA -> KiCad convert core.
 *
 * The primary suite is DETERMINISTIC and OFFLINE: it loads saved raw EasyEDA
 * responses (C3235557 = TI TPS2116DRLR; C25804 = UNI-ROYAL 10k 0603 resistor)
 * from __tests__/fixtures and runs the pure parsers via `convertFromResult`.
 * No network is touched.
 *
 * A second, skipped-by-default suite hits the live EasyEDA API to smoke-test
 * `fetchEasyedaComponent`. Enable it with RUN_LIVE_EASYEDA=1.
 */
import { describe, it, expect } from 'vitest';

import fixture from './fixtures/C3235557.json';
import resistorFixture from './fixtures/C25804.json';
import {
  convertFromResult,
  extractMeta,
  fetchEasyedaComponent,
  type EasyedaResult,
} from '../easyeda';

const LCSC_ID = 'C3235557';
const result = (fixture as { result: EasyedaResult }).result;

const RESISTOR_LCSC_ID = 'C25804';
const resistorResult = (resistorFixture as { result: EasyedaResult }).result;

/** Largest |x|,|y| among a symbol's element coordinates (mm). */
function maxAbsSymbolCoord(symbol: string): number {
  let max = 0;
  for (const match of symbol.matchAll(/-?\d+\.\d+/g)) {
    const v = Math.abs(parseFloat(match[0]));
    if (v > max) max = v;
  }
  return max;
}

/** All (number, name) pairs from a symbol's pin definitions, in file order. */
function symbolPins(symbol: string): Array<{ number: string; name: string }> {
  const lines = symbol.split('\n');
  const pins: Array<{ number: string; name: string }> = [];
  let pendingName: string | null = null;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*\(name "([^"]*)"/);
    if (nameMatch) {
      pendingName = nameMatch[1];
      continue;
    }
    const numMatch = line.match(/^\s*\(number "([^"]*)"/);
    if (numMatch && pendingName !== null) {
      pins.push({ number: numMatch[1], name: pendingName });
      pendingName = null;
    }
  }
  return pins;
}

/** Value of a named symbol property, or undefined if absent. */
function symbolProperty(symbol: string, name: string): string | undefined {
  const m = symbol.match(new RegExp(`\\(property "${name}" "([^"]*)"`));
  return m ? m[1] : undefined;
}

describe('convertFromResult (offline, fixture C3235557 = TPS2116)', () => {
  const converted = convertFromResult(result, LCSC_ID);

  it('produces a KiCad symbol library with at least one symbol', () => {
    expect(converted.symbol).toContain('(kicad_symbol_lib');
    expect(converted.symbol).toMatch(/\(symbol "/);
  });

  it('produces a KiCad footprint with at least one pad', () => {
    // KiCad has used both "(footprint" (v6+) and "(module" (legacy) headers.
    expect(converted.footprint).toMatch(/\((?:footprint|module)/);
    expect(converted.footprint).toMatch(/\(pad /);
  });

  it('stamps the LCSC part number into the footprint', () => {
    expect(converted.footprint).toContain(`(property "LCSC Part" "${LCSC_ID}")`);
  });

  it('resolves a 3D-model URL from the SVGNODE uuid', () => {
    expect(converted.model3dUrl).toBeTypeOf('string');
    expect(converted.model3dUrl).toContain('7de5db90ab974d88b4eb22e148e2ee81');
  });

  it('extracts deterministic metadata', () => {
    expect(converted.meta).toMatchObject({
      lcsc: 'C3235557',
      mpn: 'TPS2116DRLR',
      package: 'SOT-583-8_L2.1-W1.6-P0.50-LS1.6-BL',
    });
    expect(converted.meta.manufacturer).toContain('TI');
    // This component's EasyEDA `description` is empty, so we only assert the
    // field is always a (possibly empty) string — never undefined.
    expect(converted.meta.description).toBeTypeOf('string');
  });

  // --- Milestone 4: symbol polish -------------------------------------------

  it('sets the symbol Value + name to the MPN, not the package string', () => {
    // Value carries the MPN…
    expect(symbolProperty(converted.symbol, 'Value')).toBe('TPS2116DRLR');
    // …and the symbol/library id does too (never the SOT-583 package name).
    expect(converted.symbol).toMatch(/\(symbol "TPS2116DRLR"/);
    expect(converted.symbol).not.toMatch(/\(symbol "SOT-583/);
  });

  it('derives the Reference prefix from EasyEDA `pre` (U? -> U)', () => {
    expect(symbolProperty(converted.symbol, 'Reference')).toBe('U');
  });

  it('gives at least one pin a real name distinct from its number', () => {
    const pins = symbolPins(converted.symbol);
    expect(pins.length).toBe(8);
    // e.g. pin 1 is "GND", pin 2 "VOUT" — names from EasyEDA, not the pad number.
    expect(pins.some((p) => p.name !== p.number)).toBe(true);
    expect(pins.find((p) => p.number === '1')?.name).toBe('GND');
  });

  it('types its pins (this fixture has electric=0 -> passive for every pin)', () => {
    // The TPS2116 EasyEDA data tags every pin `electric=0` (unspecified), so the
    // faithful mapping is `passive`. We assert the converter still emits well-
    // formed typed pins (not a crash / empty type). The non-default mapping is
    // exercised by the resistor fixture below, whose pins are `electric=1`.
    expect(converted.symbol).toMatch(/\(pin passive line/);
    const pinTypeLines = converted.symbol
      .split('\n')
      .filter((l) => /^\s*\(pin /.test(l));
    expect(pinTypeLines).toHaveLength(8);
    expect(pinTypeLines.every((l) => /\(pin \w+ line /.test(l))).toBe(true);
  });

  it('normalizes the symbol body + pins close to the origin', () => {
    // Before polish the IC landed at ~90,-70; after, every coord is well within
    // a sane window of the origin.
    expect(maxAbsSymbolCoord(converted.symbol)).toBeLessThan(60);
  });

  it('populates Footprint / Datasheet / Manufacturer / LCSC properties', () => {
    expect(symbolProperty(converted.symbol, 'Footprint')).toBe(
      'SOT-583-8_L2.1-W1.6-P0.50-LS1.6-BL',
    );
    expect(symbolProperty(converted.symbol, 'Datasheet')).toMatch(/^https?:\/\//);
    expect(symbolProperty(converted.symbol, 'Manufacturer')).toContain('TI');
    expect(symbolProperty(converted.symbol, 'LCSC')).toBe('C3235557');
    expect(symbolProperty(converted.symbol, 'MPN')).toBe('TPS2116DRLR');
  });
});

describe('convertFromResult (offline, fixture C25804 = 10k 0603 resistor)', () => {
  const converted = convertFromResult(resistorResult, RESISTOR_LCSC_ID);

  it('still produces a KiCad symbol + footprint', () => {
    expect(converted.symbol).toContain('(kicad_symbol_lib');
    expect(converted.footprint).toMatch(/\((?:footprint|module)/);
    expect(converted.footprint).toMatch(/\(pad /);
  });

  it('sets Reference to "R" for a resistor (pre: "R?")', () => {
    expect(symbolProperty(converted.symbol, 'Reference')).toBe('R');
  });

  it('sets the symbol Value to the MPN, not the package "R0603"', () => {
    expect(converted.meta.mpn).toBe('0603WAF1002T5E');
    expect(symbolProperty(converted.symbol, 'Value')).toBe('0603WAF1002T5E');
    // Guard against the old behaviour where Value == package string.
    expect(symbolProperty(converted.symbol, 'Value')).not.toBe('R0603');
    expect(symbolProperty(converted.symbol, 'Value')).not.toBe(converted.meta.package);
    // The package still lands in the Footprint property.
    expect(symbolProperty(converted.symbol, 'Footprint')).toBe('R0603');
  });

  it('emits exactly two pins, normalized near the origin', () => {
    const pins = symbolPins(converted.symbol);
    expect(pins.length).toBe(2);
    expect(maxAbsSymbolCoord(converted.symbol)).toBeLessThan(60);
  });

  it('maps the EasyEDA pin electrical type (electric=1 -> input)', () => {
    // Both resistor pins are EasyEDA `electric=1`; this proves the type table is
    // wired up (not every pin defaults to passive).
    const pinTypeLines = converted.symbol
      .split('\n')
      .filter((l) => /^\s*\(pin /.test(l));
    expect(pinTypeLines).toHaveLength(2);
    expect(pinTypeLines.every((l) => /\(pin input line /.test(l))).toBe(true);
  });
});

describe('extractMeta datasheet fallback', () => {
  it('falls back to the LCSC datasheet URL when no link is present', () => {
    const bare: EasyedaResult = { title: 'X', description: 'd' };
    expect(extractMeta(bare, LCSC_ID).datasheet).toBe(
      `https://www.lcsc.com/datasheet/${LCSC_ID}.pdf`,
    );

    expect(() => convertFromResult({ packageDetail: { dataStr: {} } }, LCSC_ID)).toThrow(
      /missing schematic dataStr/,
    );
    expect(() => convertFromResult({ dataStr: {} }, LCSC_ID)).toThrow(
      /missing footprint packageDetail\.dataStr/,
    );
  });

  it('prefers the footprint c_para link when present', () => {
    expect(extractMeta(result, LCSC_ID).datasheet).toMatch(/^https?:\/\//);
    // The fixture's footprint c_para carries a TI datasheet link.
    expect(extractMeta(result, LCSC_ID).datasheet).toContain('ti.com');

    const stringDocs: EasyedaResult = {
      ...result,
      dataStr: JSON.stringify(result.dataStr),
      packageDetail: { dataStr: JSON.stringify(result.packageDetail?.dataStr) },
    };
    expect(extractMeta(stringDocs, LCSC_ID)).toMatchObject({
      lcsc: 'C3235557',
      mpn: 'TPS2116DRLR',
      package: 'SOT-583-8_L2.1-W1.6-P0.50-LS1.6-BL',
    });
  });
});

// Live smoke test — skipped unless RUN_LIVE_EASYEDA=1 (needs network + the
// EasyEDA WAF headers baked into fetchEasyedaComponent).
const liveDescribe = process.env.RUN_LIVE_EASYEDA === '1' ? describe : describe.skip;
liveDescribe('fetchEasyedaComponent (live)', () => {
  it('fetches a real component result for C3235557', async () => {
    const live = await fetchEasyedaComponent(LCSC_ID);
    expect(live).toBeTruthy();
    expect(live.dataStr).toBeTruthy();
    expect(live.packageDetail?.dataStr).toBeTruthy();
  }, 20000);

  it('rejects a malformed LCSC id without hitting the network', async () => {
    await expect(fetchEasyedaComponent('not-an-id')).rejects.toThrow(/Invalid LCSC id/);
  });
});
