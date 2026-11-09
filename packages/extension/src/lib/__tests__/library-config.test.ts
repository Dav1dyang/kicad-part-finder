import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIBRARY_CONFIG,
  detectPrefix,
  libraryNickname,
  libraryTableRows,
  modelPath,
  normalizeLibraryConfig,
  validatePathVar,
  validatePrefix,
} from '../library-config';
import { setFootprintModel } from '../library-writer';

describe('normalizeLibraryConfig', () => {
  it('keeps the original names by default', () => {
    expect(normalizeLibraryConfig(undefined)).toEqual({ prefix: 'DavidLib', pathVar: 'DAVID_KICAD_LIB' });
  });
  it('accepts a clean custom config and strips ${} from the path variable', () => {
    expect(normalizeLibraryConfig({ prefix: ' Lab ', pathVar: '${LAB_KICAD}' })).toEqual({ prefix: 'Lab', pathVar: 'LAB_KICAD' });
  });
  it('falls back per field on bad input', () => {
    expect(normalizeLibraryConfig({ prefix: 'has space', pathVar: 'OK_VAR' })).toEqual({ prefix: 'DavidLib', pathVar: 'OK_VAR' });
    expect(normalizeLibraryConfig({ prefix: 'Good', pathVar: '9bad' })).toEqual({ prefix: 'Good', pathVar: 'DAVID_KICAD_LIB' });
  });
  it('explains invalid values', () => {
    expect(validatePrefix('Lab_1')).toBeNull();
    expect(validatePrefix('1Lab')).toMatch(/letter/);
    expect(validatePathVar('${MY_LIB}')).toBeNull();
    expect(validatePathVar('MY-LIB')).toMatch(/letters/);
  });
});

describe('naming', () => {
  const lab = { prefix: 'Lab', pathVar: 'LAB_KICAD' };
  it('prefixes buckets but not the catch-all library', () => {
    expect(libraryNickname('IC', lab)).toBe('Lab_IC');
    expect(libraryNickname('KiCadPartFinder', lab)).toBe('KiCadPartFinder');
  });
  it('references models through the path variable', () => {
    expect(modelPath('abc.step', lab)).toBe('${LAB_KICAD}/3dmodels/abc.step');
    expect(setFootprintModel('(footprint "F"\n)', 'abc.step', lab)).toContain('(model "${LAB_KICAD}/3dmodels/abc.step"');
    expect(setFootprintModel('(footprint "F"\n)', 'abc.step')).toContain('${DAVID_KICAD_LIB}/3dmodels/abc.step');
  });
  it('builds KiCad table rows for every library', () => {
    const rows = libraryTableRows(DEFAULT_LIBRARY_CONFIG);
    expect(rows.symbols.split('\n')).toHaveLength(8);
    expect(rows.symbols).toContain('(lib (name "DavidLib_IC")(type "KiCad")(uri "${DAVID_KICAD_LIB}/symbols/DavidLib_IC.kicad_sym")(options "")(descr ""))');
    expect(rows.footprints).toContain('(uri "${DAVID_KICAD_LIB}/footprints/KiCadPartFinder.pretty")');
  });
});

describe('detectPrefix', () => {
  it('finds the prefix an existing folder uses', () => {
    expect(detectPrefix(['DavidLib_IC.kicad_sym', 'DavidLib_Power.kicad_sym', 'KiCadPartFinder.kicad_sym'])).toBe('DavidLib');
    expect(detectPrefix(['My_Lib_IC.kicad_sym'])).toBe('My_Lib');
  });
  it('picks the most common prefix and ignores unrelated files', () => {
    expect(detectPrefix(['A_IC.kicad_sym', 'B_IC.kicad_sym', 'B_Light.kicad_sym', 'notes.kicad_sym'])).toBe('B');
    expect(detectPrefix(['Random.kicad_sym'])).toBeNull();
  });
});
