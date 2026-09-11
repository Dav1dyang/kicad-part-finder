import { describe, it, expect } from 'vitest';
import { PAGE_SHORTCUT_DEFAULTS, matchPageAction, pageComboMatches, parsePageCombo, resolvePageTable } from '../page-combo';
import { DEFAULT_PAGE_SHORTCUTS, parseCombo, serializeCombo } from '../../lib/shortcuts';

const ev = (key: string, mods: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('page-combo (the content script copy)', () => {
  it('keeps its defaults identical to the main shortcuts module', () => {
    expect(PAGE_SHORTCUT_DEFAULTS).toEqual(DEFAULT_PAGE_SHORTCUTS);
  });

  it('parses the same canonical strings as the main module', () => {
    for (const text of ['Mod+Shift+k', 'Alt+Shift+i', 'Ctrl+Mod+Alt+Shift+F2', 'Mod++', 'Escape', 'Space']) {
      const main = parseCombo(text)!;
      expect(parsePageCombo(text)).toEqual(main);
      expect(parsePageCombo(serializeCombo(main))).toEqual(main);
    }
    expect(parsePageCombo('')).toBeNull();
    expect(parsePageCombo('Mod+')).toBeNull();
    expect(parsePageCombo('Shift')).toBeNull();
    expect(parsePageCombo(42)).toBeNull();
  });

  it('matches a keydown per platform', () => {
    const combo = parsePageCombo('Mod+Shift+k')!;
    expect(pageComboMatches(combo, ev('K', { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(pageComboMatches(combo, ev('k', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    // The other platform's primary modifier does not count.
    expect(pageComboMatches(combo, ev('k', { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(pageComboMatches(combo, ev('k', { metaKey: true, shiftKey: true }), false)).toBe(false);
    // Extra or missing modifiers fail; a lone modifier never matches.
    expect(pageComboMatches(combo, ev('k', { metaKey: true, shiftKey: true, altKey: true }), true)).toBe(false);
    expect(pageComboMatches(combo, ev('k', { metaKey: true }), true)).toBe(false);
    expect(pageComboMatches(combo, ev('Shift', { shiftKey: true }), true)).toBe(false);
  });

  it('matches Alt combos through the physical key, as macOS composes glyphs with Option', () => {
    const install = parsePageCombo('Alt+Shift+i')!;
    expect(pageComboMatches(install, ev('ˆ', { altKey: true, shiftKey: true, code: 'KeyI' }), true)).toBe(true);
    expect(pageComboMatches(install, ev('I', { altKey: true, shiftKey: true, code: 'KeyI' }), false)).toBe(true);
    expect(pageComboMatches(install, ev('ˆ', { altKey: true, shiftKey: true, code: 'KeyU' }), true)).toBe(false);
  });

  it('resolves stored tables with unbinding and junk fallback', () => {
    const table = resolvePageTable({ 'open-finder': null, 'search-selection': 'garbage+', 'install-current': 'Mod+i' });
    expect(table['open-finder']).toBeNull();
    expect(table['search-selection']).toEqual(parsePageCombo('Mod+Shift+l'));
    expect(table['install-current']).toEqual(parsePageCombo('Mod+i'));
    expect(Object.keys(resolvePageTable(undefined))).toEqual(Object.keys(PAGE_SHORTCUT_DEFAULTS));
  });

  it('finds the action for a keydown', () => {
    const table = resolvePageTable(undefined);
    expect(matchPageAction(table, ev('L', { metaKey: true, shiftKey: true }), true)).toBe('search-selection');
    expect(matchPageAction(table, ev('i', { altKey: true, shiftKey: true }), false)).toBe('install-current');
    expect(matchPageAction(table, ev('x', { metaKey: true }), true)).toBeNull();
  });
});
