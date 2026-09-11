/**
 * The page listener's own, minimal key-combo helpers.
 *
 * `content/page-listener.js` is a classic content script and must stay
 * self-contained: importing `src/lib/shortcuts.ts` (which the side panel also
 * imports) would make rollup split it into a shared chunk that a classic script
 * cannot load. So this module re-implements the two pieces the listener needs,
 * parsing a canonical combo string (`"Mod+Shift+k"`) and matching it against a
 * keydown, and is imported by nothing else. A unit test asserts that
 * `PAGE_SHORTCUT_DEFAULTS` equals `DEFAULT_PAGE_SHORTCUTS` in the main module.
 */

export interface PageCombo {
  key: string;
  /** The platform primary modifier: ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** Control on macOS only (never set elsewhere, where Ctrl is `mod`). */
  ctrl: boolean;
}

/** Must stay identical to `DEFAULT_PAGE_SHORTCUTS` in src/lib/shortcuts.ts. */
export const PAGE_SHORTCUT_DEFAULTS: Readonly<Record<string, string>> = {
  'open-finder': 'Mod+Shift+k',
  'search-selection': 'Mod+Shift+l',
  'install-current': 'Alt+Shift+i',
};

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Hyper', 'Super', 'Fn', 'CapsLock']);

function normalizeKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Parse `"Mod+Shift+k"`; null for anything malformed or not a string. */
export function parsePageCombo(text: unknown): PageCombo | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = text.split('+');
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.splice(parts.length - 2, 2, '+');
  }
  const combo: PageCombo = { key: '', mod: false, alt: false, shift: false, ctrl: false };
  for (const raw of parts) {
    const part = raw.trim();
    if (part === 'Mod') combo.mod = true;
    else if (part === 'Ctrl') combo.ctrl = true;
    else if (part === 'Alt') combo.alt = true;
    else if (part === 'Shift') combo.shift = true;
    else if (part && !combo.key) combo.key = normalizeKey(part);
    else return null;
  }
  if (!combo.key || MODIFIERS.has(combo.key)) return null;
  return combo;
}

/** The keydown fields a match needs. */
export interface PageKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `KeyI` → `i`, `Digit3` → `3`; null for any other physical key. */
function keyFromCode(code: string | undefined): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code ?? '');
  return m ? (m[1] ?? m[2]).toLowerCase() : null;
}

/**
 * Whether a keydown is exactly this combo on this platform. With Alt (Option)
 * held, macOS puts the composed glyph in `key` (Option+Shift+I is `ˆ`), so a
 * letter or digit is read from `code` instead, as the main module does.
 */
export function pageComboMatches(combo: PageCombo, ev: PageKeyEvent, isMac: boolean): boolean {
  if (!ev.key || MODIFIERS.has(ev.key)) return false;
  const mod = isMac ? ev.metaKey : ev.ctrlKey;
  const ctrl = isMac ? ev.ctrlKey : false;
  const key = (ev.altKey ? keyFromCode(ev.code) : null) ?? normalizeKey(ev.key);
  return (
    key === combo.key &&
    mod === combo.mod &&
    ctrl === combo.ctrl &&
    ev.altKey === combo.alt &&
    ev.shiftKey === combo.shift
  );
}

/**
 * Turn the stored `pageShortcuts` table (or nothing) into parsed combos, one
 * per known action. An explicit `null` unbinds; junk falls back to the default.
 */
export function resolvePageTable(stored: unknown): Record<string, PageCombo | null> {
  const out: Record<string, PageCombo | null> = {};
  const table = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  for (const action of Object.keys(PAGE_SHORTCUT_DEFAULTS)) {
    const value = action in table ? table[action] : PAGE_SHORTCUT_DEFAULTS[action];
    out[action] = value === null ? null : (parsePageCombo(value) ?? parsePageCombo(PAGE_SHORTCUT_DEFAULTS[action]));
  }
  return out;
}

/** The first action whose combo matches the keydown, if any. */
export function matchPageAction(
  table: Readonly<Record<string, PageCombo | null>>,
  ev: PageKeyEvent,
  isMac: boolean,
): string | null {
  for (const [action, combo] of Object.entries(table)) {
    if (combo && pageComboMatches(combo, ev, isMac)) return action;
  }
  return null;
}
