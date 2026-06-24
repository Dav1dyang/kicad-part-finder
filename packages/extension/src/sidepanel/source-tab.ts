/**
 * Pure helper shared by the side-panel UI.
 *
 * The popup-window fallback (browsers without a working chrome.sidePanel, e.g.
 * Arc) opens the same UI document with `?tab=<id>` so it knows which page to read
 * the detected part from. In side-panel mode there is no `tab` param and the UI
 * reads the active tab instead.
 *
 * Kept in its own DOM/chrome-free module so it can be unit-tested directly.
 */

/**
 * Parse the originating tab id from a URL query string (e.g. `location.search`).
 * Returns null when the `tab` param is absent or not a valid non-negative integer.
 */
export function parseSourceTabId(search: string): number | null {
  const raw = new URLSearchParams(search).get('tab');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

/**
 * Whether the UI was opened in the standalone floating popup window (the service
 * worker appends `&win=1` to the URL in window mode). Document Picture-in-Picture
 * can't be requested from a popup window, so the caller hides the Float button
 * when this is true.
 *
 * Truthy only for `win=1` so a stray/empty value never accidentally enables it.
 */
export function isWindowMode(search: string): boolean {
  return new URLSearchParams(search).get('win') === '1';
}
