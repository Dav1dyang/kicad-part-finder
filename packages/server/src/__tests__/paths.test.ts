/**
 * Tests for KiCad path detection and library table path generation.
 */
import { describe, it, expect } from 'vitest';
import { getLibraryTablePath } from '../kicad/paths.js';

describe('getLibraryTablePath', () => {
  it('returns sym-lib-table path for symbol type', () => {
    const path = getLibraryTablePath('/Users/test/.config/kicad/10.0', 'symbol');
    expect(path).toBe('/Users/test/.config/kicad/10.0/sym-lib-table');
  });

  it('returns fp-lib-table path for footprint type', () => {
    const path = getLibraryTablePath('/Users/test/.config/kicad/10.0', 'footprint');
    expect(path).toBe('/Users/test/.config/kicad/10.0/fp-lib-table');
  });
});
