/**
 * Pure, DOM-free URL-param parsers the side-panel UI reads to decide its overlay
 * mode. Kept separate from overlay-bounds.ts so neither helper module is shared
 * across rollup entry points (which would split the overlay content script's code
 * into a chunk it couldn't import). Imported only by sidepanel.ts; unit-tested.
 *
 * The params:
 *   `overlay=1`            — running inside the in-page overlay iframe.
 *   `setup=1`             — one-time folder-grant helper window.
 *   `install=<lcscId>`    — auto-install helper window.
 *   `bucket=<name>`       — destination library for the auto-install helper.
 */

/**
 * Whether the side-panel UI is running INSIDE the in-page overlay iframe (the
 * content script appends `?overlay=1` to the iframe src). In this mode File
 * System Access is blocked (cross-origin iframe), so folder-pick + install are
 * delegated to a real window via the service worker.
 *
 * Truthy only for `overlay=1` so a stray/empty value never accidentally enables it.
 */
export function isOverlayMode(search: string): boolean {
  return new URLSearchParams(search).get('overlay') === '1';
}

/**
 * Whether this is the one-time "grant the folder" helper window the service
 * worker opens for the overlay (`?win=1&setup=1`). The UI focuses the folder
 * picker so the user grants access in a single click, then the window closes.
 */
export function isSetupMode(search: string): boolean {
  return new URLSearchParams(search).get('setup') === '1';
}

/**
 * The LCSC id the install-helper window should auto-install, or null. The service
 * worker opens `?win=1&install=<lcscId>&bucket=<bucket>`; the UI detects this,
 * converts + installs against the saved folder handle, then auto-closes.
 *
 * Normalised to the canonical `C\d+` LCSC shape (uppercased); returns null for
 * anything that doesn't look like an LCSC id so a malformed param can't drive an
 * install.
 */
export function parseInstallLcsc(search: string): string | null {
  const raw = new URLSearchParams(search).get('install');
  if (raw === null) return null;
  const trimmed = raw.trim().toUpperCase();
  return /^C\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * The destination bucket name passed to the install-helper window (`&bucket=`),
 * or null when absent/empty. Validated against the caller-supplied allow-list so
 * an unknown value falls back to auto-sort rather than creating a junk library.
 */
export function parseBucket(search: string, allowed: readonly string[]): string | null {
  const raw = new URLSearchParams(search).get('bucket');
  if (raw === null) return null;
  const trimmed = raw.trim();
  return allowed.includes(trimmed) ? trimmed : null;
}
