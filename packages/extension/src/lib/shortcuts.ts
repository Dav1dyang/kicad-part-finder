/**
 * Keyboard shortcuts — the pure, DOM-free core.
 *
 * Two kinds of shortcut exist in this extension:
 *
 *  1. BROWSER shortcuts (`chrome.commands` in manifest.json). Chrome owns these:
 *     an extension can only READ the current binding (`chrome.commands.getAll`)
 *     and send the user to chrome://extensions/shortcuts to change it. The UI
 *     shows them live and offers a "Change in Chrome" link.
 *
 *  2. PANEL shortcuts — keys that work while the finder itself is focused
 *     (focus search, install, switch preview tabs…). These are fully ours: the
 *     bindings live in chrome.storage.sync under `panelShortcuts` and the user
 *     re-records them from the Settings panel.
 *
 * This module knows nothing about the DOM or chrome.* APIs so it can be unit-
 * tested directly. A combo is stored as a canonical string, e.g. `"Mod+Enter"`,
 * `"Shift+/"`, `"1"`, `"Escape"`. `Mod` means ⌘ on macOS and Ctrl elsewhere,
 * so one stored binding behaves natively on both platforms.
 */

/** The actions a panel shortcut can trigger. */
export const PANEL_ACTIONS = [
  'focusSearch',
  'install',
  'previewSymbol',
  'previewFootprint',
  'preview3d',
  'toggleSettings',
  'dismiss',
] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

/** Human labels for the settings list. */
export const PANEL_ACTION_LABELS: Record<PanelAction, string> = {
  focusSearch: 'Focus the search box',
  install: 'Install the current part',
  previewSymbol: 'Show the Symbol preview',
  previewFootprint: 'Show the Footprint preview',
  preview3d: 'Show the 3D preview',
  toggleSettings: 'Open or close Settings',
  dismiss: 'Close Settings, clear the search, or close the window',
};

/** Factory defaults. `Mod` = ⌘ on macOS, Ctrl elsewhere. */
export const DEFAULT_PANEL_SHORTCUTS: Readonly<Record<PanelAction, string>> = {
  focusSearch: '/',
  install: 'Mod+Enter',
  previewSymbol: '1',
  previewFootprint: '2',
  preview3d: '3',
  toggleSettings: 'Mod+,',
  dismiss: 'Escape',
};

/** A parsed key combination. `mod` is the platform primary modifier (⌘ / Ctrl). */
export interface KeyCombo {
  key: string;
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** The NON-primary control key: Ctrl on macOS (⌃). Never set elsewhere. */
  ctrl: boolean;
}

export type Platform = 'mac' | 'other';

/** Detect the platform from a UA-ish string or navigator platform hint. */
export function detectPlatform(hint: string | undefined | null): Platform {
  return /mac|iphone|ipad|ipod/i.test(hint ?? '') ? 'mac' : 'other';
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Hyper', 'Super', 'Fn', 'CapsLock']);

/**
 * Normalise a `KeyboardEvent.key` value for storage: single printable
 * characters are lower-cased (so `Shift+/` is stored, not `?`), named keys
 * (`Enter`, `Escape`, `ArrowUp`, `F2`) are kept as-is, and a space is `Space`.
 */
export function normalizeKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key.length === 1) return key.toLowerCase();
  return key;
}

/**
 * Build a combo from the raw fields of a keydown event. Returns null for a
 * lone modifier press (the user is still holding keys) so a recorder can wait
 * for the real key.
 */
export function comboFromKeys(
  input: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: Platform,
): KeyCombo | null {
  if (!input.key || MODIFIER_KEYS.has(input.key) || input.key === 'Unidentified') return null;
  const mod = platform === 'mac' ? input.metaKey : input.ctrlKey;
  // On macOS a bare Control key is a distinct (rarely used) modifier; on other
  // platforms Meta (the Windows key) is reserved for the OS and is ignored.
  const ctrl = platform === 'mac' ? input.ctrlKey : false;
  return { key: normalizeKey(input.key), mod, alt: input.altKey, shift: input.shiftKey, ctrl };
}

/** Canonical string form, e.g. `Mod+Shift+k`, `Escape`, `Ctrl+Alt+1`. */
export function serializeCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.mod) parts.push('Mod');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  parts.push(combo.key);
  return parts.join('+');
}

/** Parse the canonical string form. Returns null for anything malformed. */
export function parseCombo(text: string | null | undefined): KeyCombo | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = text.split('+');
  // A literal "+" key serialises as "...+"+"" → rejoin it.
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.splice(parts.length - 2, 2, '+');
  }
  const combo: KeyCombo = { key: '', mod: false, alt: false, shift: false, ctrl: false };
  for (const raw of parts) {
    const part = raw.trim();
    if (part === 'Mod') combo.mod = true;
    else if (part === 'Ctrl') combo.ctrl = true;
    else if (part === 'Alt') combo.alt = true;
    else if (part === 'Shift') combo.shift = true;
    else if (part && !combo.key) combo.key = normalizeKey(part);
    else return null;
  }
  if (!combo.key || MODIFIER_KEYS.has(combo.key)) return null;
  return combo;
}

/** Key-cap glyphs used on macOS; other platforms spell the key out. */
const MAC_KEY_GLYPHS: Record<string, string> = {
  Enter: '⏎',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};
const OTHER_KEY_NAMES: Record<string, string> = {
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

/**
 * Format a combo as the individual key caps to render, in order, e.g.
 * `['⌘', '⇧', 'K']` on macOS or `['Ctrl', 'Shift', 'K']` elsewhere.
 */
export function comboToKeyCaps(combo: KeyCombo, platform: Platform): string[] {
  const caps: string[] = [];
  if (platform === 'mac') {
    if (combo.ctrl) caps.push('⌃');
    if (combo.alt) caps.push('⌥');
    if (combo.shift) caps.push('⇧');
    if (combo.mod) caps.push('⌘');
  } else {
    if (combo.mod) caps.push('Ctrl');
    if (combo.alt) caps.push('Alt');
    if (combo.shift) caps.push('Shift');
  }
  const key = combo.key;
  const names = platform === 'mac' ? MAC_KEY_GLYPHS : OTHER_KEY_NAMES;
  caps.push(names[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  return caps;
}

/** One-line label, e.g. `⌘⏎` on macOS or `Ctrl+Enter` elsewhere. */
export function formatCombo(text: string | null | undefined, platform: Platform): string {
  const combo = parseCombo(text);
  if (!combo) return 'Not set';
  const caps = comboToKeyCaps(combo, platform);
  return platform === 'mac' ? caps.join('') : caps.join('+');
}

/**
 * Split a browser-level shortcut string as returned by `chrome.commands.getAll`
 * into key caps. Chrome returns `"Ctrl+Shift+K"` on Windows/Linux and a glyph
 * run like `"⌘⇧K"` on macOS; an unassigned command returns `""`.
 */
export function browserShortcutToKeyCaps(shortcut: string | undefined | null): string[] {
  const s = (shortcut ?? '').trim();
  if (!s) return [];
  if (s.includes('+')) return s.split('+').map((p) => p.trim()).filter(Boolean);
  // Glyph run: every modifier glyph is its own cap, the remainder is the key.
  const caps: string[] = [];
  let rest = s;
  for (const glyph of ['⌃', '⌥', '⇧', '⌘']) {
    if (rest.startsWith(glyph)) {
      caps.push(glyph);
      rest = rest.slice(glyph.length);
    }
  }
  // Chrome may order glyphs differently; sweep any that remain anywhere.
  for (const glyph of ['⌃', '⌥', '⇧', '⌘']) {
    if (rest.includes(glyph)) {
      caps.push(glyph);
      rest = rest.replace(glyph, '');
    }
  }
  if (rest) caps.push(rest);
  return caps;
}

/** Combos the browser itself claims; binding them would never reach the page. */
const RESERVED: ReadonlySet<string> = new Set([
  'Mod+w', 'Mod+t', 'Mod+n', 'Mod+q', 'Mod+l', 'Mod+r', 'Mod+f', 'Mod+p', 'Mod+s', 'Mod+h', 'Mod+m',
  'Mod+Shift+w', 'Mod+Shift+t', 'Mod+Shift+n', 'Mod+Tab', 'Mod+Shift+Tab', 'Alt+Tab',
  'Tab', 'Shift+Tab', 'F5', 'F11', 'F12',
]);

export interface ComboValidation {
  ok: boolean;
  /** Short reason shown inline when not ok. */
  reason?: string;
}

/**
 * Decide whether a combo may be assigned to `action`, given the other current
 * bindings. Rules: no browser-reserved combos; `install` writes files so it
 * must carry a modifier; a bare single letter or digit is allowed (the
 * dispatcher ignores it while typing in a field); no duplicates.
 */
export function validateCombo(
  text: string,
  action: PanelAction,
  bindings: Readonly<Partial<Record<PanelAction, string | null>>>,
): ComboValidation {
  const combo = parseCombo(text);
  if (!combo) return { ok: false, reason: 'Press a key, optionally with modifiers.' };
  const canonical = serializeCombo(combo);
  if (RESERVED.has(canonical)) return { ok: false, reason: 'The browser uses that shortcut.' };
  if (action === 'install' && !combo.mod && !combo.alt && !combo.ctrl) {
    return { ok: false, reason: 'Install needs a modifier key (⌘ / Ctrl / Alt) so it cannot fire by accident.' };
  }
  for (const other of PANEL_ACTIONS) {
    if (other === action) continue;
    const existing = bindings[other];
    if (existing && parseCombo(existing) && serializeCombo(parseCombo(existing)!) === canonical) {
      return { ok: false, reason: `Already used by “${PANEL_ACTION_LABELS[other]}”.` };
    }
  }
  return { ok: true };
}

/** Whether a stored binding table matches a keydown. */
export function comboMatches(stored: string | null | undefined, pressed: KeyCombo | null): boolean {
  const want = parseCombo(stored);
  if (!want || !pressed) return false;
  return (
    want.key === pressed.key &&
    want.mod === pressed.mod &&
    want.alt === pressed.alt &&
    want.shift === pressed.shift &&
    want.ctrl === pressed.ctrl
  );
}

/**
 * A bare key (no ⌘/Ctrl/Alt) must not fire while the user is typing in a text
 * field — `/` inside the datasheet URL is just a slash. `Escape` is the one
 * exception: it should always work.
 */
export function comboIsBareKey(combo: KeyCombo): boolean {
  return !combo.mod && !combo.alt && !combo.ctrl && combo.key !== 'Escape';
}

/** Merge a stored (possibly partial / stale) table over the defaults. */
export function resolvePanelShortcuts(
  stored: unknown,
): Record<PanelAction, string | null> {
  const out = { ...DEFAULT_PANEL_SHORTCUTS } as Record<PanelAction, string | null>;
  if (!stored || typeof stored !== 'object') return out;
  const table = stored as Record<string, unknown>;
  for (const action of PANEL_ACTIONS) {
    if (!(action in table)) continue;
    const value = table[action];
    if (value === null) out[action] = null; // explicitly unbound
    else if (typeof value === 'string' && parseCombo(value)) out[action] = serializeCombo(parseCombo(value)!);
  }
  return out;
}

/** Find the action a pressed combo triggers, if any. */
export function actionForCombo(
  bindings: Readonly<Record<PanelAction, string | null>>,
  pressed: KeyCombo | null,
): PanelAction | null {
  if (!pressed) return null;
  for (const action of PANEL_ACTIONS) {
    if (comboMatches(bindings[action], pressed)) return action;
  }
  return null;
}
