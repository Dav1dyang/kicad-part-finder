import { describe, expect, it } from 'vitest';
import {
  commitReminder,
  DEFAULT_LIBRARY_CONFIG,
  fragmentMismatches,
  parseTableRows,
  setupHint,
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

describe('setup hint', () => {
  const cfg = DEFAULT_LIBRARY_CONFIG;
  const matching = libraryTableRows(cfg).symbols;
  const folder = (over = {}) => ({ name: 'kicad-libraries', hasSetupScript: true, symTableFragment: matching, ...over });

  it('reads nickname and uri from table rows', () => {
    const rows = parseTableRows(matching);
    expect(rows.get('DavidLib_IC')).toBe('${DAVID_KICAD_LIB}/symbols/DavidLib_IC.kicad_sym');
    expect(rows.get('KiCadPartFinder')).toBe('${DAVID_KICAD_LIB}/symbols/KiCadPartFinder.kicad_sym');
  });

  it('finds no mismatch when the fragment registers the same rows, or there is none', () => {
    expect(fragmentMismatches(matching, cfg)).toEqual([]);
    expect(fragmentMismatches('', cfg)).toEqual([]);
  });

  it('lists libraries the fragment registers differently or not at all', () => {
    const lab = { prefix: 'Lab', pathVar: 'DAVID_KICAD_LIB' };
    const off = fragmentMismatches(matching, lab);
    expect(off).toContain('Lab_IC');
    expect(off).not.toContain('KiCadPartFinder');
    const otherVar = { prefix: 'DavidLib', pathVar: 'LAB_KICAD' };
    expect(fragmentMismatches(matching, otherVar)).toContain('KiCadPartFinder');
  });

  it('names the variable and the folder it must point at', () => {
    expect(setupHint(cfg, null)).toMatch(/set DAVID_KICAD_LIB to your library folder/);
    expect(setupHint(cfg, folder({ hasSetupScript: false }))).toMatch(/set DAVID_KICAD_LIB to “kicad-libraries”/);
    expect(setupHint(cfg, null)).toMatch(/before the last \)/);
  });

  it('points at tools/setup when the folder has one that matches', () => {
    const hint = setupHint(cfg, folder());
    expect(hint).toMatch(/run \.\/tools\/setup/);
    expect(hint).not.toMatch(/different libraries/);
  });

  it('warns when the folder setup script registers other names', () => {
    const hint = setupHint({ prefix: 'Lab', pathVar: 'DAVID_KICAD_LIB' }, folder());
    expect(hint).toMatch(/different libraries than these settings \(Lab_Power, Lab_Connector, …\)/);
    expect(hint).toMatch(/Configure Paths/);
  });
});

describe('commit reminder', () => {
  it('says nothing outside a git repo', () => {
    expect(commitReminder(null)).toBe('');
    expect(commitReminder({ name: 'lib', isGitRepo: false, hasCatalogScript: true })).toBe('');
  });
  it('asks for a commit, and a catalog refresh when the folder has the script', () => {
    expect(commitReminder({ name: 'lib', isGitRepo: true, hasCatalogScript: false })).toBe('Commit the new files in “lib” so they are saved in git.');
    expect(commitReminder({ name: 'kicad-libraries', isGitRepo: true, hasCatalogScript: true })).toBe(
      'Run ./tools/catalog, then commit the new files in “kicad-libraries”.',
    );
  });
});
