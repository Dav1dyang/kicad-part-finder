/**
 * Tests for parsing the originating tab id from the popup-window URL.
 */
import { describe, it, expect } from 'vitest';
import { parseSourceTabId } from '../source-tab.js';

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
