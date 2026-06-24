/**
 * Tests for parsing the originating tab id from the popup-window URL.
 */
import { describe, it, expect } from 'vitest';
import { parseSourceTabId, isWindowMode } from '../source-tab.js';

describe('parseSourceTabId', () => {
  it('parses a numeric tab id', () => {
    expect(parseSourceTabId('?tab=42')).toBe(42);
  });

  it('parses tab=0 (a valid tab id)', () => {
    expect(parseSourceTabId('?tab=0')).toBe(0);
  });

  it('parses the tab param among other query params', () => {
    expect(parseSourceTabId('?foo=bar&tab=7&baz=1')).toBe(7);
  });

  it('works without a leading "?"', () => {
    expect(parseSourceTabId('tab=13')).toBe(13);
  });

  it('returns null when there is no query string (side-panel mode)', () => {
    expect(parseSourceTabId('')).toBeNull();
  });

  it('returns null when the tab param is absent', () => {
    expect(parseSourceTabId('?foo=bar')).toBeNull();
  });

  it('returns null for a non-numeric tab value', () => {
    expect(parseSourceTabId('?tab=abc')).toBeNull();
  });

  it('returns null for an empty tab value', () => {
    expect(parseSourceTabId('?tab=')).toBeNull();
  });

  it('returns null for a negative tab value', () => {
    expect(parseSourceTabId('?tab=-1')).toBeNull();
  });

  it('returns null for a non-integer tab value', () => {
    expect(parseSourceTabId('?tab=1.5')).toBeNull();
  });
});

describe('isWindowMode', () => {
  it('is true when win=1 is present (floating-window mode)', () => {
    expect(isWindowMode('?win=1')).toBe(true);
  });

  it('is true for win=1 alongside the tab param', () => {
    expect(isWindowMode('?tab=42&win=1')).toBe(true);
  });

  it('works without a leading "?"', () => {
    expect(isWindowMode('tab=42&win=1')).toBe(true);
  });

  it('is false when the win param is absent (auto mode)', () => {
    expect(isWindowMode('?tab=42')).toBe(false);
  });

  it('is false for an empty query string', () => {
    expect(isWindowMode('')).toBe(false);
  });

  it('is false for win values other than "1"', () => {
    expect(isWindowMode('?win=0')).toBe(false);
    expect(isWindowMode('?win=true')).toBe(false);
    expect(isWindowMode('?win=')).toBe(false);
  });
});
