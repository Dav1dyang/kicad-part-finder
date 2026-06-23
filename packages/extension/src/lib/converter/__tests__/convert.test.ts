/**
 * Tests for the EasyEDA -> KiCad convert core.
 *
 * The primary suite is DETERMINISTIC and OFFLINE: it loads a saved raw EasyEDA
 * response (C3235557 = TI TPS2116DRLR) from __tests__/fixtures and runs the pure
 * parsers via `convertFromResult`. No network is touched.
 *
 * A second, skipped-by-default suite hits the live EasyEDA API to smoke-test
 * `fetchEasyedaComponent`. Enable it with RUN_LIVE_EASYEDA=1.
 */
import { describe, it, expect } from 'vitest';

import fixture from './fixtures/C3235557.json';
import {
  convertFromResult,
  extractMeta,
  fetchEasyedaComponent,
  type EasyedaResult,
} from '../easyeda';

const LCSC_ID = 'C3235557';
const result = (fixture as { result: EasyedaResult }).result;

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
});

describe('extractMeta datasheet fallback', () => {
  it('falls back to the LCSC datasheet URL when no link is present', () => {
    const bare: EasyedaResult = { title: 'X', description: 'd' };
    expect(extractMeta(bare, LCSC_ID).datasheet).toBe(
      `https://www.lcsc.com/datasheet/${LCSC_ID}.pdf`,
    );
  });

  it('prefers the footprint c_para link when present', () => {
    expect(extractMeta(result, LCSC_ID).datasheet).toMatch(/^https?:\/\//);
    // The fixture's footprint c_para carries a TI datasheet link.
    expect(extractMeta(result, LCSC_ID).datasheet).toContain('ti.com');
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
