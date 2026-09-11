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
 *  3. PAGE shortcuts — the same three actions as the browser commands, but
 *     listened for by our own content script on pages it runs on. They exist
 *     because some Chromium browsers (Arc, Dia) never deliver `chrome.commands`
 *     to extensions. Bindings live in chrome.storage.sync under `pageShortcuts`.
 *     The content script cannot import this module (a shared chunk would break
 *     a classic content script), so it carries a tiny parser of its own in
 *     `src/content/page-combo.ts`; a test keeps the two default tables equal.
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

/** The browser commands (manifest `commands`), mirrored as page shortcuts. */
export const PAGE_ACTIONS = ['open-finder', 'search-selection', 'install-current'] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

export const PAGE_ACTION_LABELS: Record<PageAction, string> = {
  'open-finder': 'Open or close Part Finder',
  'search-selection': 'Search the highlighted text',
  'install-current': 'Install the part shown in Part Finder',
};

/**
 * Factory defaults, identical to the manifest's `suggested_key`s so a page
 * shortcut and its browser command never disagree out of the box.
 */
export const DEFAULT_PAGE_SHORTCUTS: Readonly<Record<PageAction, string>> = {
  'open-finder': 'Mod+Shift+k',
  'search-selection': 'Mod+Shift+l',
  'install-current': 'Alt+Shift+i',
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
 * The letter or digit a physical key produces on a US layout, from
 * `KeyboardEvent.code` (`KeyI` → `i`, `Digit3` → `3`), or null for any other key.
 */
export function keyFromCode(code: string | undefined | null): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code ?? '');
  if (!m) return null;
  return (m[1] ?? m[2]).toLowerCase();
}

/**
 * Build a combo from the raw fields of a keydown event. Returns null for a
 * lone modifier press (the user is still holding keys) so a recorder can wait
 * for the real key.
 *
 * With Alt (Option) held, macOS reports the composed glyph in `key`
 * (Option+Shift+I is `ˆ`), so a letter or digit is read from `code` instead.
 */
export function comboFromKeys(
  input: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: Platform,
): KeyCombo | null {
  if (!input.key || MODIFIER_KEYS.has(input.key) || input.key === 'Unidentified') return null;
  const mod = platform === 'mac' ? input.metaKey : input.ctrlKey;
  // On macOS a bare Control key is a distinct (rarely used) modifier; on other
  // platforms Meta (the Windows key) is reserved for the OS and is ignored.
  const ctrl = platform === 'mac' ? input.ctrlKey : false;
  const key = (input.altKey ? keyFromCode(input.code) : null) ?? normalizeKey(input.key);
  return { key, mod, alt: input.altKey, shift: input.shiftKey, ctrl };
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

type AnyBindings = Readonly<Partial<Record<string, string | null>>>;

/** The action in `bindings` (other than `except`) already bound to `canonical`, if any. */
function findClash(canonical: string, actions: readonly string[], bindings: AnyBindings, except: string | null): string | null {
  for (const other of actions) {
    if (other === except) continue;
    const existing = parseCombo(bindings[other]);
    if (existing && serializeCombo(existing) === canonical) return other;
  }
  return null;
}

function validateAgainst(
  text: string,
  needsModifier: boolean,
  own: { action: string; actions: readonly string[]; labels: Readonly<Record<string, string>>; bindings: AnyBindings },
  other: { actions: readonly string[]; labels: Readonly<Record<string, string>>; bindings: AnyBindings; kind: string },
): ComboValidation {
  const combo = parseCombo(text);
  if (!combo) return { ok: false, reason: 'Press a key, optionally with modifiers.' };
  const canonical = serializeCombo(combo);
  if (RESERVED.has(canonical)) return { ok: false, reason: 'The browser uses that shortcut.' };
  if (needsModifier && !combo.mod && !combo.alt && !combo.ctrl) {
    return { ok: false, reason: 'Needs a modifier key (⌘ / Ctrl / Alt) so it cannot fire by accident.' };
  }
  const clash = findClash(canonical, own.actions, own.bindings, own.action);
  if (clash) return { ok: false, reason: `Already used by “${own.labels[clash]}”.` };
  // Panel and page shortcuts are both live inside the finder, where the panel
  // table wins; a combo in both would silently shadow the page one there.
  const cross = findClash(canonical, other.actions, other.bindings, null);
  if (cross) return { ok: false, reason: `Already used by the ${other.kind} shortcut “${other.labels[cross]}”.` };
  return { ok: true };
}

/**
 * Decide whether a combo may be assigned to a panel `action`, given the other
 * current bindings. Rules: no browser-reserved combos; `install` writes files
 * so it must carry a modifier; a bare single letter or digit is allowed (the
 * dispatcher ignores it while typing in a field); no duplicates, in this table
 * or the page table.
 */
export function validateCombo(
  text: string,
  action: PanelAction,
  bindings: Readonly<Partial<Record<PanelAction, string | null>>>,
  pageBindings: Readonly<Partial<Record<PageAction, string | null>>> = {},
): ComboValidation {
  return validateAgainst(
    text,
    action === 'install',
    { action, actions: PANEL_ACTIONS, labels: PANEL_ACTION_LABELS, bindings },
    { actions: PAGE_ACTIONS, labels: PAGE_ACTION_LABELS, bindings: pageBindings, kind: 'page' },
  );
}

/**
 * Page shortcuts fire while the user is on an ordinary web page, so every one
 * of them must carry a modifier: a bare letter would hijack typing everywhere.
 */
export function validatePageCombo(
  text: string,
  action: PageAction,
  bindings: Readonly<Partial<Record<PageAction, string | null>>>,
  panelBindings: Readonly<Partial<Record<PanelAction, string | null>>> = {},
): ComboValidation {
  return validateAgainst(
    text,
    true,
    { action, actions: PAGE_ACTIONS, labels: PAGE_ACTION_LABELS, bindings },
    { actions: PANEL_ACTIONS, labels: PANEL_ACTION_LABELS, bindings: panelBindings, kind: 'panel' },
  );
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

function resolveTable<A extends string>(
  actions: readonly A[],
  defaults: Readonly<Record<A, string>>,
  stored: unknown,
): Record<A, string | null> {
  const out = { ...defaults } as Record<A, string | null>;
  if (!stored || typeof stored !== 'object') return out;
  const table = stored as Record<string, unknown>;
  for (const action of actions) {
    if (!(action in table)) continue;
    const value = table[action];
    if (value === null) out[action] = null; // explicitly unbound
    else if (typeof value === 'string' && parseCombo(value)) out[action] = serializeCombo(parseCombo(value)!);
  }
  return out;
}

/** Merge a stored (possibly partial / stale) panel table over the defaults. */
export function resolvePanelShortcuts(stored: unknown): Record<PanelAction, string | null> {
  return resolveTable(PANEL_ACTIONS, DEFAULT_PANEL_SHORTCUTS, stored);
}

/** Merge a stored (possibly partial / stale) page table over the defaults. */
export function resolvePageShortcuts(stored: unknown): Record<PageAction, string | null> {
  return resolveTable(PAGE_ACTIONS, DEFAULT_PAGE_SHORTCUTS, stored);
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

/** Find the page action a pressed combo triggers, if any. */
export function pageActionForCombo(
  bindings: Readonly<Record<PageAction, string | null>>,
  pressed: KeyCombo | null,
): PageAction | null {
  if (!pressed) return null;
  for (const action of PAGE_ACTIONS) {
    if (comboMatches(bindings[action], pressed)) return action;
  }
  return null;
}
