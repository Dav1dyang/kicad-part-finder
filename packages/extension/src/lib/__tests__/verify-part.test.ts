import { describe, expect, it } from 'vitest';
import fixture from '../converter/__tests__/fixtures/C3235557.json';
import resistorFixture from '../converter/__tests__/fixtures/C25804.json';
import { convertFromResult, extractSource, type EasyedaResult } from '../converter/easyeda';
import { isBalanced, padNumbers, pinNumbers, verifyPart, type PartCheck } from '../verify-part';

const tps = convertFromResult((fixture as { result: EasyedaResult }).result, 'C3235557');
const resistor = convertFromResult((resistorFixture as { result: EasyedaResult }).result, 'C25804');

const sym = (pins: string) => `(kicad_symbol_lib (symbol "X" (symbol "X_0_1" ${pins})))`;
const pin = (n: string) => `(pin passive line (at 0 0 0) (length 2.54) (name "~" (effects)) (number "${n}" (effects)))`;
const fp = (pads: string) => `(footprint "F" (layer "F.Cu") ${pads})`;
const pad = (n: string, kind = 'smd') => `(pad "${n}" ${kind} rect (at 0 0) (size 1 1) (layers "F.Cu"))`;
const OFFICIAL = { verified: true, official: true, author: 'LCSC', footprintTitle: 'R0603', updated: '2024-01-11' };

const byId = (checks: PartCheck[], id: string) => checks.find((c) => c.id === id);

describe('isBalanced', () => {
  it('ignores parens inside strings and escaped quotes', () => {
    expect(isBalanced('(a "x)" (b "\\")"))')).toBe(true);
  });
  it('catches missing, extra, and empty input', () => {
    expect(isBalanced('(a (b)')).toBe(false);
    expect(isBalanced('(a))')).toBe(false);
    expect(isBalanced('   ')).toBe(false);
  });
});

describe('pinNumbers / padNumbers', () => {
  it('reads every pin number from the symbol', () => {
    expect(pinNumbers(sym(pin('1') + pin('2')))).toEqual(['1', '2']);
  });
  it('reads electrical pads and skips unnumbered or non-plated ones', () => {
    expect(padNumbers(fp(pad('1') + pad('2') + pad('') + pad('3', 'np_thru_hole')))).toEqual(['1', '2']);
  });
});

describe('verifyPart', () => {
  it('passes both real fixtures with no errors', () => {
    for (const part of [tps, resistor]) {
      const report = verifyPart(part);
      expect(report.level).not.toBe('error');
      expect(byId(report.checks, 'pin-pad')?.level).toBe('ok');
    }
  });

  it('reads provenance from the fixtures: both are LCSC verified parts', () => {
    expect(tps.source).toMatchObject({ verified: true, official: true, author: 'LCSC' });
    expect(resistor.source.footprintTitle).toBe('R0603');
    expect(byId(verifyPart(resistor).checks, 'source')?.level).toBe('ok');
  });

  it('warns about a community-made part', () => {
    const src = extractSource({ verify: false, owner: { username: 'someone', nickname: 'Someone' }, packageDetail: { owner: { username: 'someone' } } });
    expect(src).toMatchObject({ verified: false, official: false, author: 'Someone' });
    const report = verifyPart({ symbol: sym(pin('1')), footprint: fp(pad('1')), model3dUrl: null, source: src });
    expect(byId(report.checks, 'source')?.level).toBe('warn');
    expect(report.level).toBe('warn');
  });

  it('flags symbol pins that have no pad, and lists extra pads as a note', () => {
    const report = verifyPart({ symbol: sym(pin('1') + pin('2') + pin('3')), footprint: fp(pad('1') + pad('2') + pad('EP')), model3dUrl: 'x', source: OFFICIAL });
    const check = byId(report.checks, 'pin-pad');
    expect(check?.level).toBe('warn');
    expect(check?.message).toContain('3');
    expect(check?.detail).toContain('EP');
  });

  it('calls a damaged file an error, which blocks install', () => {
    const report = verifyPart({ symbol: '(kicad_symbol_lib (symbol "X"', footprint: fp(pad('1')), model3dUrl: null, source: OFFICIAL });
    expect(byId(report.checks, 'symbol')?.level).toBe('error');
    expect(report.level).toBe('error');
    expect(report.blocking).toBe(true);
  });

  it('warns when the symbol has no pins or the footprint has no pads', () => {
    const report = verifyPart({ symbol: sym(''), footprint: fp(''), model3dUrl: null, source: OFFICIAL });
    expect(byId(report.checks, 'symbol')?.level).toBe('warn');
    expect(byId(report.checks, 'footprint')?.level).toBe('warn');
    expect(report.blocking).toBe(false);
  });

  it('notes duplicate pin numbers', () => {
    const report = verifyPart({ symbol: sym(pin('1') + pin('1')), footprint: fp(pad('1')), model3dUrl: null, source: OFFICIAL });
    expect(byId(report.checks, 'pin-pad')?.detail).toMatch(/twice|more than once/);
  });

  it('reports the 3D model as optional', () => {
    const report = verifyPart({ symbol: sym(pin('1')), footprint: fp(pad('1')), model3dUrl: null, source: OFFICIAL });
    expect(byId(report.checks, 'model')?.level).toBe('info');
    expect(report.level).toBe('ok');
  });
});
