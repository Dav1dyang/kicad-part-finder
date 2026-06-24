/**
 * Tests for the overlay-mode URL-param parsers the side-panel UI reads
 * (`overlay=1`, `setup=1`, `install=<lcscId>`, `bucket=<name>`).
 */
import { describe, it, expect } from 'vitest';
import {
  isOverlayMode,
  isSetupMode,
  parseInstallLcsc,
  parseBucket,
} from '../overlay-params.js';

describe('isOverlayMode', () => {
  it('is true for overlay=1', () => {
    expect(isOverlayMode('?overlay=1')).toBe(true);
  });
  it('is true alongside other params, no leading "?"', () => {
    expect(isOverlayMode('foo=bar&overlay=1')).toBe(true);
  });
  it('is false when absent', () => {
    expect(isOverlayMode('?tab=3')).toBe(false);
    expect(isOverlayMode('')).toBe(false);
  });
  it('is false for values other than "1"', () => {
    expect(isOverlayMode('?overlay=0')).toBe(false);
    expect(isOverlayMode('?overlay=true')).toBe(false);
    expect(isOverlayMode('?overlay=')).toBe(false);
  });
});

describe('isSetupMode', () => {
  it('is true for setup=1 (the folder-grant helper window)', () => {
    expect(isSetupMode('?win=1&setup=1')).toBe(true);
  });
  it('is false when absent or not "1"', () => {
    expect(isSetupMode('?win=1')).toBe(false);
    expect(isSetupMode('?setup=0')).toBe(false);
    expect(isSetupMode('')).toBe(false);
  });
});

describe('parseInstallLcsc', () => {
  it('parses a canonical LCSC id', () => {
    expect(parseInstallLcsc('?install=C3235557')).toBe('C3235557');
  });
  it('uppercases a lowercase id', () => {
    expect(parseInstallLcsc('?install=c123')).toBe('C123');
  });
  it('parses among other params', () => {
    expect(parseInstallLcsc('?win=1&install=C25804&bucket=Resistor')).toBe('C25804');
  });
  it('returns null when absent', () => {
    expect(parseInstallLcsc('?win=1')).toBeNull();
    expect(parseInstallLcsc('')).toBeNull();
  });
  it('returns null for a malformed (non-LCSC) value', () => {
    expect(parseInstallLcsc('?install=TPS2116DRLR')).toBeNull();
    expect(parseInstallLcsc('?install=C')).toBeNull();
    expect(parseInstallLcsc('?install=123')).toBeNull();
    expect(parseInstallLcsc('?install=')).toBeNull();
    expect(parseInstallLcsc('?install=C12;rm')).toBeNull();
  });
});

describe('parseBucket', () => {
  const ALLOWED = ['KiCadPartFinder', 'Resistor', 'Capacitor'] as const;

  it('returns an allowed bucket', () => {
    expect(parseBucket('?bucket=Resistor', ALLOWED)).toBe('Resistor');
  });
  it('returns the catch-all bucket when chosen', () => {
    expect(parseBucket('?bucket=KiCadPartFinder', ALLOWED)).toBe('KiCadPartFinder');
  });
  it('returns null when absent', () => {
    expect(parseBucket('?install=C1', ALLOWED)).toBeNull();
    expect(parseBucket('', ALLOWED)).toBeNull();
  });
  it('returns null for a value not in the allow-list (no junk libraries)', () => {
    expect(parseBucket('?bucket=Bogus', ALLOWED)).toBeNull();
    expect(parseBucket('?bucket=', ALLOWED)).toBeNull();
    expect(parseBucket('?bucket=../etc', ALLOWED)).toBeNull();
  });
});
