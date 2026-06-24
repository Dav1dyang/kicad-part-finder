/**
 * Background service worker — routes messages between content scripts and the UI.
 * Detects sidePanel API support; on browsers that lack it (e.g. Arc) it opens the
 * same UI in a real browser TAB instead — a tab is a top-level context, so the
 * panel's "Float on top" (Document Picture-in-Picture) works from there. A
 * standalone popup window is kept as a fallback if a tab can't be created.
 *
 * The `openMode` setting (chrome.storage.local) lets the user override that:
 *  - 'window'  → the UI opens directly in a standalone popup window — which, unlike
 *    Document PiP, PERSISTS across tab/app switches in Arc (Arc drops the PiP
 *    window on tab-return).
 *  - 'overlay' → a draggable in-page overlay is injected onto the current page
 *    (content/overlay.js). The overlay hosts the UI in an iframe; File System
 *    Access can't run in that cross-origin iframe, so the overlay delegates
 *    folder-pick + install to a real popup window via OVERLAY_PICK_FOLDER /
 *    OVERLAY_INSTALL messages handled here.
 *  - 'auto' (default / missing) keeps the side-panel-or-tab behavior.
 *
 * Injects a text selection listener when the UI is active so highlighting text
 * on any page triggers a component search.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';
import { convertLcsc } from '../lib/converter/easyeda.js';
import { resolveMpnDetailed } from '../lib/jlcpcb.js';

// Store the most recently detected part per tab
const detectedParts = new Map<number, DetectedPart>();
// Track which tabs have the selection listener injected
const selectionListenerInjected = new Set<number>();
// Id of the popup-window fallback (Arc et al.), if one is currently open.
let finderWindowId: number | null = null;
// Id of the finder TAB (no-sidePanel browsers), if one is currently open. A tab
// is preferred over the popup window so Document PiP "Float on top" can be used.
let finderTabId: number | null = null;
// Ids of short-lived helper windows opened on the overlay's behalf to run File
// System Access (folder grant / install) — tracked so we can close them when the
// work finishes and stop tracking them when the user closes them manually.
const helperWindowIds = new Set<number>();
// Grace period before the SW force-closes a finished helper window. The helper
// shows its success state + self-closes (~1.2s); this is only a safety net for
// contexts where window.close() is blocked. Slightly longer than the self-close.
const HELPER_CLOSE_GRACE_MS = 1800;

// The side-panel UI document, reused as the tab / popup-window fallback. Loadable
// via chrome.runtime.getURL — extension pages are always reachable by the
// extension.
const SIDEPANEL_PATH = 'src/sidepanel/index.html';

/**
 * Read the user's deployed Worker relay URL from chrome.storage.local. The
 * extension can't reach JLCPCB/EasyEDA directly (WAF 403), so every convert /
 * MPN lookup is routed through this relay. Returns '' when unset; callers must
 * surface a "relay URL not set" error in that case.
 */
async function getRelayUrl(): Promise<string> {
  try {
    const { relayUrl } = await chrome.storage.local.get('relayUrl');
    return typeof relayUrl === 'string' ? relayUrl.trim() : '';
  } catch {
    return '';
  }
}

/** Error string the panel surfaces when no relay URL is configured. */
const NO_RELAY_ERROR = 'relay URL not set';

/**
 * How the finder should open. Stored in chrome.storage.local under `openMode`:
 *  - 'auto'    — current behavior (side panel where supported, else a tab so
 *                Document PiP can float).
 *  - 'window'  — a standalone popup window that stays open across tab/app
 *                switches (best for Arc, where PiP gets dropped on tab-return).
 *  - 'overlay' — a draggable in-page overlay injected onto the current page
 *                (v1-style float). FS-Access can't run in the overlay's iframe,
 *                so folder-pick + install are delegated to a real window.
 */
type OpenMode = 'auto' | 'window' | 'overlay';

/**
 * Read the user's open-mode preference. Treats a missing/empty/unknown value as
 * 'auto' so nothing throws and the default behavior is preserved when storage is
 * empty.
 */
async function getOpenMode(): Promise<OpenMode> {
  try {
    const { openMode } = await chrome.storage.local.get('openMode');
    if (openMode === 'window') return 'window';
    if (openMode === 'overlay') return 'overlay';
    return 'auto';
  } catch {
    return 'auto';
  }
}

/** Check if chrome.sidePanel actually works (Arc exposes namespace but doesn't implement it) */
let sidePanelSupported: boolean | null = null;
async function isSidePanelSupported(): Promise<boolean> {
  if (sidePanelSupported !== null) return sidePanelSupported;

  if (!chrome?.sidePanel?.getOptions) {
    sidePanelSupported = false;
    return false;
  }

  try {
    await chrome.sidePanel.getOptions({});
    sidePanelSupported = true;
  } catch {
    sidePanelSupported = false;
  }
  return sidePanelSupported;
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'PART_DETECTED' && typeof sender.tab?.id === 'number') {
    const tabId = sender.tab.id;
    detectedParts.set(tabId, message.part);
    // Update badge to indicate a part was found
    chrome.action.setBadgeText({ text: '1', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
    return false;
  }

  if (message.type === 'NO_PART_FOUND' && typeof sender.tab?.id === 'number') {
    const tabId = sender.tab.id;
    detectedParts.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId });
    return false;
  }

  // UI requesting current part info.
  //  - Side-panel mode: no tabId given → use the active tab of the current window.
  //  - Popup-window mode: the UI passes the originating tab's id (the active tab
  //    here is the popup itself, so the active-tab lookup would be wrong).
  if (message.type === 'GET_DETECTED_PART') {
    if (typeof message.tabId === 'number') {
      const part = detectedParts.get(message.tabId) ?? null;
      sendResponse({ part });
      return false; // answered synchronously
    }
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (typeof tab?.id === 'number' && detectedParts.has(tab.id)) {
          sendResponse({ part: detectedParts.get(tab.id) });
        } else {
          sendResponse({ part: null });
        }
      })
      .catch((err: unknown) => {
        sendResponse({ part: null, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // Keep channel open for async response
  }

  // Side panel asking us to fetch + convert an LCSC part. The fetch goes through
  // the user's deployed Worker relay (EasyEDA WAF-blocks the browser directly).
  // Returns the ConvertResult or an error the panel surfaces.
  if (message.type === 'CONVERT') {
    void (async () => {
      const relayBase = await getRelayUrl();
      if (!relayBase) {
        sendResponse({ ok: false, error: NO_RELAY_ERROR });
        return;
      }
      try {
        const result = await convertLcsc(message.lcscId, relayBase);
        sendResponse({ ok: true, result });
      } catch (err: unknown) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // async
  }

  // Side panel resolving a free-text MPN to candidate LCSC parts via JLCPCB
  // (through the relay). Reports `matchedQuery`/`relaxed` so the UI can flag
  // fuzzy (non-exact) hits.
  if (message.type === 'RESOLVE_MPN') {
    void (async () => {
      const relayBase = await getRelayUrl();
      if (!relayBase) {
        sendResponse({ ok: false, error: NO_RELAY_ERROR });
        return;
      }
      try {
        const { matches, matchedQuery, relaxed, diagnostic } = await resolveMpnDetailed(
          message.mpn,
          relayBase,
        );
        sendResponse({ ok: true, matches, matchedQuery, relaxed, diagnostic });
      } catch (err: unknown) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // async
  }

  // --- In-page overlay → window delegation ----------------------------------
  // File System Access (showDirectoryPicker + writes) is blocked inside the
  // overlay's cross-origin iframe, so the overlay UI asks us to open a REAL
  // popup window (a top-level extension document) to do the FS work.

  // Overlay asking to grant the library folder: open a one-time setup window.
  if (message.type === 'OVERLAY_PICK_FOLDER') {
    void openHelperWindow(`&setup=1`);
    sendResponse({ ok: true });
    return false; // answered synchronously
  }

  // Overlay asking to install a part: open an install window that auto-converts
  // + writes against the saved folder handle, then closes itself.
  if (message.type === 'OVERLAY_INSTALL' && typeof message.lcscId === 'string') {
    const lcsc = encodeURIComponent(message.lcscId);
    const bucket = typeof message.bucket === 'string' && message.bucket
      ? `&bucket=${encodeURIComponent(message.bucket)}`
      : '';
    void openHelperWindow(`&install=${lcsc}${bucket}`);
    sendResponse({ ok: true });
    return false; // answered synchronously
  }

  // The overlay's iframe was blocked (strict host-page CSP frame-src) — the user
  // chose to open the finder in a normal popup window instead.
  if (message.type === 'OVERLAY_FALLBACK_WINDOW') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') void openFinderWindow(tabId);
    else void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (typeof t?.id === 'number') void openFinderWindow(t.id);
    });
    sendResponse({ ok: true });
    return false;
  }

  // The helper window (setup / install) finished its FS work. Broadcast right away
  // so the overlay reflects readiness / the install, but let the helper keep its
  // success state visible and self-close (~1.2s); only force-close it after a
  // grace period as a safety net if window.close() was blocked.
  if (message.type === 'OVERLAY_HELPER_DONE') {
    // `sender.tab` is undefined for a popup-window extension page in MV3, so the
    // helper passes its own window id in the message; fall back to sender.tab just
    // in case.
    const winId = typeof message.windowId === 'number' ? message.windowId : sender.tab?.windowId;
    if (typeof winId === 'number') {
      setTimeout(() => void closeHelperWindow(winId), HELPER_CLOSE_GRACE_MS);
    }
    // Re-broadcast a simplified signal for both the overlay content script and
    // the overlay iframe to react to (folder ready / installed).
    const outgoing = message.kind === 'installed'
      ? { type: 'OVERLAY_INSTALLED' }
      : { type: 'OVERLAY_FOLDER_READY' };
    chrome.runtime.sendMessage(outgoing).catch(() => {
      /* no listeners (overlay closed) — ignore */
    });
    return false;
  }

  return false;
});

/**
 * Open the finder UI for a given tab. Respects the user's `openMode`:
 *  - 'window' → a standalone popup window directly (skips side panel + tab). The
 *    window persists across tab/app switches, which is what Arc users want when
 *    Document PiP keeps getting dropped on tab-return.
 *  - 'auto' (default) → a real side panel where supported, else a tab so the
 *    panel's "Float on top" (Document PiP) can request an always-on-top window.
 *
 * Also injects the selection listener on the source tab so highlight-to-search
 * keeps working wherever the UI lands, in BOTH paths.
 *
 * Shared by the toolbar-icon click and the keyboard shortcut. The shortcut path
 * may not pass a tab, so fall back to the active tab of the current window.
 */
async function openFinder(tab?: chrome.tabs.Tab) {
  let tabId = tab?.id;
  if (typeof tabId !== 'number') {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active?.id;
  }
  if (typeof tabId !== 'number') return;

  const openMode = await getOpenMode();

  if (openMode === 'overlay') {
    // Explicit overlay mode → inject the in-page overlay onto the active tab. On
    // restricted pages (chrome://, the extensions page, the Web Store) injection
    // throws — fall back to a popup window so the icon never dead-ends.
    const injected = await injectOverlay(tabId);
    if (!injected) {
      await openFinderWindow(tabId);
    }
  } else if (openMode === 'window') {
    // Explicit window mode → go straight to the standalone popup window, which
    // survives tab/app switches (unlike side panel / Document PiP in Arc).
    await openFinderWindow(tabId);
  } else {
    // chrome.sidePanel.open() requires a user gesture; both the icon click and
    // the command keystroke qualify, so the call is valid from either entry point.
    const supported = await isSidePanelSupported();

    if (supported) {
      try {
        await chrome.sidePanel.open({ tabId });
      } catch {
        await openFinderTab(tabId);
      }
    } else {
      // No working side panel (e.g. Arc) → open the UI in a real TAB so its
      // "Float on top" (Document PiP) button can request an always-on-top window.
      await openFinderTab(tabId);
    }
  }

  // Keep injecting the selection listener on the SOURCE tab so highlight-to-search
  // still works regardless of where the UI is shown.
  await injectSelectionListener(tabId);
}

// Handle extension icon click.
chrome.action.onClicked.addListener((tab) => {
  void openFinder(tab);
});

// Handle the keyboard shortcut (Cmd/Ctrl+Shift+2). In browsers without a working
// sidePanel (e.g. Arc), _execute_action doesn't reliably fire onClicked when there
// is no default_popup, so we drive a custom command through the same open path.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-finder') void openFinder(tab);
});

/**
 * Open the UI in a real browser TAB (the preferred fallback for browsers without
 * a working chrome.sidePanel, e.g. Arc). A tab is a top-level browsing context,
 * so the panel's "Float on top" (Document Picture-in-Picture) button can request
 * an always-on-top window from it — which it cannot do from a side panel or an
 * extension popup window.
 *
 * The originating tab id is passed via `?tab=` so the UI can pre-fill the part
 * detected on that page (and so the UI knows it's running in a tab/popup, not a
 * side panel). Only one finder tab is kept alive: if it's already open we focus
 * it (re-pointing it at the new source tab) rather than spawning duplicates. If
 * the tab can't be created for any reason, falls back to the popup window.
 */
async function openFinderTab(sourceTabId: number) {
  const url = `${chrome.runtime.getURL(SIDEPANEL_PATH)}?tab=${sourceTabId}`;

  // Reuse an existing finder tab if we have one.
  if (finderTabId !== null) {
    try {
      const existing = await chrome.tabs.get(finderTabId);
      await chrome.tabs.update(finderTabId, { url, active: true });
      if (typeof existing.windowId === 'number') {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    } catch {
      // The tracked tab vanished without an onRemoved — recreate below.
      finderTabId = null;
    }
  }

  try {
    const tab = await chrome.tabs.create({ url, active: true });
    finderTabId = typeof tab?.id === 'number' ? tab.id : null;
  } catch (err) {
    // Couldn't open a tab — fall back to the standalone popup window.
    console.error('Failed to open finder tab; falling back to popup window:', err);
    await openFinderWindow(sourceTabId);
  }
}

/**
 * Open the UI in a standalone popup window — used both as the last-resort fallback
 * when a tab can't be created AND as the explicit 'window' open mode (Arc users who
 * want a UI that persists across tab/app switches). The originating tab id is passed
 * via `?tab=` so the UI can pre-fill the part detected on that page, and `&win=1`
 * flags window mode so the panel hides its "Float on top" button — Document PiP
 * can't be requested from a popup window.
 *
 * Only one finder window is kept alive: if it's already open we focus it (and
 * re-point it at the new source tab) rather than spawning duplicates.
 */
async function openFinderWindow(sourceTabId: number) {
  const url = `${chrome.runtime.getURL(SIDEPANEL_PATH)}?tab=${sourceTabId}&win=1`;

  if (finderWindowId !== null) {
    try {
      await chrome.windows.update(finderWindowId, { focused: true });
      // Re-aim the existing window at the (possibly new) source tab.
      const [view] = await chrome.tabs.query({ windowId: finderWindowId });
      if (typeof view?.id === 'number') {
        await chrome.tabs.update(view.id, { url });
      }
      return;
    } catch {
      // The tracked window vanished without an onRemoved (shouldn't happen, but
      // be defensive) — fall through and create a fresh one.
      finderWindowId = null;
    }
  }

  try {
    const win = await chrome.windows.create({
      type: 'popup',
      width: 460,
      height: 760,
      url,
      focused: true,
    });
    finderWindowId = typeof win?.id === 'number' ? win.id : null;
  } catch (err) {
    console.error('Failed to open finder window:', err);
  }
}

/** Inject the text selection listener so highlighting text triggers a search */
async function injectSelectionListener(tabId: number) {
  if (selectionListenerInjected.has(tabId)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selection-listener.js'],
    });
    selectionListenerInjected.add(tabId);
  } catch {
    // Ignore — page may not allow script injection (e.g., chrome:// pages)
  }
}

/**
 * Inject the in-page overlay onto the given tab. Re-injecting toggles the
 * existing overlay's visibility (the script's own re-injection guard), so this is
 * safe to call repeatedly from the toolbar icon.
 *
 * Returns false if injection is impossible (restricted page: chrome://, the
 * extensions page, the Web Store, a PDF viewer, etc.) so the caller can fall back
 * to a popup window and the icon never dead-ends.
 */
async function injectOverlay(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/overlay.js'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a short-lived top-level extension window to run File System Access on the
 * overlay's behalf (the overlay's iframe can't). `extraQuery` selects the job:
 *   `&setup=1`                         → one-time folder grant, then close.
 *   `&install=<lcscId>[&bucket=<b>]`   → auto convert + install, then close.
 *
 * `&win=1` keeps the side-panel UI in its window/overlay-helper code path (hides
 * the Float button, reads the detected part from `?tab=` rather than the active
 * tab). A fresh window is opened per request so concurrent jobs don't collide;
 * each closes itself when done (and we close it from OVERLAY_HELPER_DONE too).
 */
async function openHelperWindow(extraQuery: string) {
  const url = `${chrome.runtime.getURL(SIDEPANEL_PATH)}?win=1${extraQuery}`;
  try {
    const win = await chrome.windows.create({
      type: 'popup',
      width: 460,
      height: 720,
      url,
      focused: true,
    });
    if (typeof win?.id === 'number') helperWindowIds.add(win.id);
  } catch (err) {
    console.error('Failed to open overlay helper window:', err);
  }
}

/** Close a helper window once its FS-Access job reports done. */
async function closeHelperWindow(windowId: number) {
  if (!helperWindowIds.has(windowId)) return;
  helperWindowIds.delete(windowId);
  try {
    await chrome.windows.remove(windowId);
  } catch {
    // Already closed itself (window.close()) — nothing to do.
  }
}

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedParts.delete(tabId);
  selectionListenerInjected.delete(tabId);
  // Stop tracking the finder tab once it's closed so the next open creates a
  // fresh one instead of trying to focus a dead tab.
  if (tabId === finderTabId) finderTabId = null;
});

// Stop tracking the finder popup window (and any overlay helper window) once
// it's closed — whether we closed it or the user did.
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === finderWindowId) finderWindowId = null;
  helperWindowIds.delete(windowId);
});

// When tab navigates to a new page, re-inject selection listener if it was active
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && selectionListenerInjected.has(tabId)) {
    selectionListenerInjected.delete(tabId);
    void injectSelectionListener(tabId);
  }
});
