import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAGE_SHORTCUTS,
  DEFAULT_PANEL_SHORTCUTS,
  PAGE_ACTIONS,
  actionForCombo,
  pageActionForCombo,
  browserShortcutToKeyCaps,
  comboFromKeys,
  comboIsBareKey,
  comboMatches,
  comboToKeyCaps,
  detectPlatform,
  formatCombo,
  keyFromCode,
  parseCombo,
  resolvePageShortcuts,
  resolvePanelShortcuts,
  serializeCombo,
  validateCombo,
  validatePageCombo,
} from '../shortcuts';

const press = (key: string, mods: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('detectPlatform', () => {
  it('recognises macOS hints', () => {
    expect(detectPlatform('MacIntel')).toBe('mac');
    expect(detectPlatform('macOS')).toBe('mac');
    expect(detectPlatform('Win32')).toBe('other');
    expect(detectPlatform(undefined)).toBe('other');
  });
});

describe('comboFromKeys', () => {
  it('maps ⌘ to Mod on mac and Ctrl to Mod elsewhere', () => {
    expect(comboFromKeys(press('Enter', { metaKey: true }), 'mac')).toEqual({ key: 'Enter', mod: true, alt: false, shift: false, ctrl: false });
    expect(comboFromKeys(press('Enter', { ctrlKey: true }), 'other')).toEqual({ key: 'Enter', mod: true, alt: false, shift: false, ctrl: false });
  });
  it('keeps macOS Control as a separate modifier and ignores the Windows key', () => {
    expect(comboFromKeys(press('k', { ctrlKey: true }), 'mac')?.ctrl).toBe(true);
    expect(comboFromKeys(press('k', { metaKey: true }), 'other')?.mod).toBe(false);
  });
  it('returns null for a lone modifier press', () => {
    expect(comboFromKeys(press('Shift', { shiftKey: true }), 'mac')).toBeNull();
    expect(comboFromKeys(press('Meta', { metaKey: true }), 'mac')).toBeNull();
  });
  it('normalises printable keys to lower case and space to Space', () => {
    expect(comboFromKeys(press('K', { shiftKey: true }), 'mac')?.key).toBe('k');
    expect(comboFromKeys(press(' '), 'mac')?.key).toBe('Space');
  });
  it('reads the letter from the physical key when Alt composes a glyph (macOS Option)', () => {
    expect(comboFromKeys(press('ˆ', { altKey: true, shiftKey: true, code: 'KeyI' }), 'mac')).toEqual({ key: 'i', mod: false, alt: true, shift: true, ctrl: false });
    expect(comboFromKeys(press('¡', { altKey: true, code: 'Digit1' }), 'mac')?.key).toBe('1');
    // Without Alt the composed/printed key is the truth (Shift+/ is `?` on the key `/`).
    expect(comboFromKeys(press('?', { shiftKey: true, code: 'Slash' }), 'mac')?.key).toBe('?');
    // A physical key that is not a letter or digit falls back to `key`.
    expect(comboFromKeys(press('Enter', { altKey: true, code: 'Enter' }), 'other')?.key).toBe('Enter');
    expect(keyFromCode('KeyQ')).toBe('q');
    expect(keyFromCode('Digit7')).toBe('7');
    expect(keyFromCode('Slash')).toBeNull();
  });
});

describe('serializeCombo / parseCombo', () => {
  it('round-trips in canonical modifier order', () => {
    const combo = parseCombo('Shift+Mod+k')!;
    expect(serializeCombo(combo)).toBe('Mod+Shift+k');
    expect(parseCombo(serializeCombo(combo))).toEqual(combo);
  });
  it('rejects malformed strings', () => {
    expect(parseCombo('')).toBeNull();
    expect(parseCombo('Mod+')).toBeNull();
    expect(parseCombo('Mod+Shift')).toBeNull();
    expect(parseCombo('a+b')).toBeNull();
    expect(parseCombo(null)).toBeNull();
  });
  it('parses a literal plus key', () => {
    expect(parseCombo('Mod++')?.key).toBe('+');
  });
});

describe('formatting', () => {
  it('uses glyphs on mac and words elsewhere', () => {
    expect(formatCombo('Mod+Enter', 'mac')).toBe('⌘⏎');
    expect(formatCombo('Mod+Enter', 'other')).toBe('Ctrl+Enter');
    expect(comboToKeyCaps(parseCombo('Mod+Shift+k')!, 'mac')).toEqual(['⇧', '⌘', 'K']);
    expect(comboToKeyCaps(parseCombo('Mod+Shift+k')!, 'other')).toEqual(['Ctrl', 'Shift', 'K']);
  });
  it('shows Not set for an unbound action', () => {
    expect(formatCombo(null, 'mac')).toBe('Not set');
  });
  it('splits Chrome command strings from both platforms', () => {
    expect(browserShortcutToKeyCaps('Ctrl+Shift+K')).toEqual(['Ctrl', 'Shift', 'K']);
    expect(browserShortcutToKeyCaps('⌘⇧K')).toEqual(['⌘', '⇧', 'K']);
    expect(browserShortcutToKeyCaps('')).toEqual([]);
    expect(browserShortcutToKeyCaps(undefined)).toEqual([]);
  });
});

describe('validateCombo', () => {
  it('blocks browser-reserved combos', () => {
    expect(validateCombo('Mod+w', 'focusSearch', DEFAULT_PANEL_SHORTCUTS).ok).toBe(false);
    expect(validateCombo('Tab', 'focusSearch', DEFAULT_PANEL_SHORTCUTS).ok).toBe(false);
  });
  it('requires a modifier for install', () => {
    const res = validateCombo('i', 'install', DEFAULT_PANEL_SHORTCUTS);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/modifier/);
    expect(validateCombo('Alt+i', 'install', DEFAULT_PANEL_SHORTCUTS).ok).toBe(true);
  });
  it('flags duplicates with the other action name', () => {
    const res = validateCombo('1', 'focusSearch', DEFAULT_PANEL_SHORTCUTS);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Symbol preview/);
  });
  it('allows re-assigning the same combo to the same action', () => {
    expect(validateCombo('/', 'focusSearch', DEFAULT_PANEL_SHORTCUTS).ok).toBe(true);
  });
  it('refuses a combo the page table already uses, and vice versa', () => {
    const res = validateCombo('Mod+Shift+k', 'focusSearch', DEFAULT_PANEL_SHORTCUTS, DEFAULT_PAGE_SHORTCUTS);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/page shortcut/);
    const back = validatePageCombo('Mod+Enter', 'open-finder', DEFAULT_PAGE_SHORTCUTS, DEFAULT_PANEL_SHORTCUTS);
    expect(back.ok).toBe(false);
    expect(back.reason).toMatch(/panel shortcut/);
    // Without the other table there is nothing to clash with.
    expect(validatePageCombo('Mod+Enter', 'open-finder', DEFAULT_PAGE_SHORTCUTS).ok).toBe(true);
  });
});

describe('dispatch helpers', () => {
  it('matches a pressed combo against a stored one', () => {
    expect(comboMatches('Mod+Enter', comboFromKeys(press('Enter', { metaKey: true }), 'mac'))).toBe(true);
    expect(comboMatches('Mod+Enter', comboFromKeys(press('Enter'), 'mac'))).toBe(false);
    expect(comboMatches(null, comboFromKeys(press('Enter'), 'mac'))).toBe(false);
  });
  it('identifies bare keys that must not fire inside inputs, except Escape', () => {
    expect(comboIsBareKey(parseCombo('/')!)).toBe(true);
    expect(comboIsBareKey(parseCombo('Escape')!)).toBe(false);
    expect(comboIsBareKey(parseCombo('Mod+k')!)).toBe(false);
  });
  it('resolves stored tables over defaults, honouring explicit unbinding', () => {
    const table = resolvePanelShortcuts({ install: 'Alt+i', preview3d: null, bogus: 'x', focusSearch: 'not a combo+' });
    expect(table.install).toBe('Alt+i');
    expect(table.preview3d).toBeNull();
    expect(table.focusSearch).toBe('/');
    expect(resolvePanelShortcuts(undefined)).toEqual(DEFAULT_PANEL_SHORTCUTS);
  });
  it('finds the action for a pressed combo', () => {
    const table = resolvePanelShortcuts(undefined);
    expect(actionForCombo(table, comboFromKeys(press('2'), 'mac'))).toBe('previewFootprint');
    expect(actionForCombo(table, comboFromKeys(press(',', { ctrlKey: true }), 'other'))).toBe('toggleSettings');
    expect(actionForCombo(table, comboFromKeys(press('z'), 'mac'))).toBeNull();
  });
});

describe('page shortcuts', () => {
  it('defaults match the manifest suggested keys', () => {
    expect(DEFAULT_PAGE_SHORTCUTS).toEqual({
      'open-finder': 'Mod+Shift+k',
      'search-selection': 'Mod+Shift+l',
      'install-current': 'Alt+Shift+i',
    });
    expect(PAGE_ACTIONS).toEqual(['open-finder', 'search-selection', 'install-current']);
  });
  it('resolves a stored table over the defaults and honours explicit unbinding', () => {
    const table = resolvePageShortcuts({ 'open-finder': 'Alt+p', 'search-selection': null, junk: 'x' });
    expect(table['open-finder']).toBe('Alt+p');
    expect(table['search-selection']).toBeNull();
    expect(table['install-current']).toBe('Alt+Shift+i');
    expect(resolvePageShortcuts('nope')).toEqual(DEFAULT_PAGE_SHORTCUTS);
  });
  it('requires a modifier for every page action', () => {
    const res = validatePageCombo('k', 'open-finder', DEFAULT_PAGE_SHORTCUTS);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/modifier/);
    expect(validatePageCombo('Shift+k', 'open-finder', DEFAULT_PAGE_SHORTCUTS).ok).toBe(false);
    expect(validatePageCombo('Alt+k', 'open-finder', DEFAULT_PAGE_SHORTCUTS).ok).toBe(true);
  });
  it('rejects browser-reserved combos and duplicates within the page table', () => {
    expect(validatePageCombo('Mod+w', 'open-finder', DEFAULT_PAGE_SHORTCUTS).ok).toBe(false);
    const dup = validatePageCombo('Mod+Shift+l', 'open-finder', DEFAULT_PAGE_SHORTCUTS);
    expect(dup.ok).toBe(false);
    expect(dup.reason).toMatch(/highlighted text/);
  });
  it('finds the page action for a pressed combo', () => {
    const table = resolvePageShortcuts(undefined);
    expect(pageActionForCombo(table, comboFromKeys(press('K', { metaKey: true, shiftKey: true }), 'mac'))).toBe('open-finder');
    expect(pageActionForCombo(table, comboFromKeys(press('k', { ctrlKey: true, shiftKey: true }), 'other'))).toBe('open-finder');
    expect(pageActionForCombo(table, comboFromKeys(press('I', { altKey: true, shiftKey: true }), 'mac'))).toBe('install-current');
    expect(pageActionForCombo(table, comboFromKeys(press('k', { metaKey: true }), 'mac'))).toBeNull();
    expect(pageActionForCombo(table, null)).toBeNull();
  });
});
