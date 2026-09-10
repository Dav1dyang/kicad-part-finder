/**
 * Background service worker — routes messages between content scripts and the
 * finder UI, opens the UI in the user's chosen mode, and runs the File System
 * Access helper windows on behalf of the in-page overlay.
 *
 * MV3 workers are killed after ~30 s idle, so NOTHING that must outlive one
 * message lives in a module variable. All of it (detected parts, the finder
 * tab/window ids, helper-window bookkeeping, injected-listener tabs) is kept in
 * `chrome.storage.session`, which survives worker restarts and is cleared when
 * the browser closes. Module-level caches below are only ever an optimisation.
 *
 * Open modes (`chrome.storage.local.openMode`):
 *  - 'auto'    — side panel where supported, else a browser tab (so Document
 *                Picture-in-Picture "Float" works).
 *  - 'window'  — a standalone popup window that persists across tab switches
 *                (best for Arc, which drops PiP windows).
 *  - 'overlay' — a draggable in-page overlay (content/overlay.js). Its iframe
 *                cannot use File System Access, so folder grant + install are
 *                delegated to short-lived helper windows opened here.
 *
 * Browser-level commands (manifest `commands`): open-finder, search-selection,
 * install-current. Chrome owns their bindings; see src/lib/shortcuts.ts.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';
import { convertLcsc } from '../lib/converter/easyeda.js';
import { resolveMpnDetailed } from '../lib/jlcpcb.js';

// --- Constants ----------------------------------------------------------------

/** The side-panel UI document, reused as the tab / popup-window fallback. */
const SIDEPANEL_PATH = 'src/sidepanel/index.html';

/** Error string the panel surfaces when no relay URL is configured. */
const NO_RELAY_ERROR = 'relay URL not set';

/** Grace period before the worker force-closes a finished helper window. */
const HELPER_CLOSE_GRACE_MS = 1800;

/** Badge colour for "a part was detected on this page". */
const BADGE_COLOR = '#22c55e';

// --- Session state (survives worker restarts) ---------------------------------

interface HelperWindowRecord {
  kind: 'setup' | 'install';
  /** True once the helper reported a terminal outcome (OVERLAY_HELPER_DONE). */
  reported: boolean;
}

interface SessionState {
  /** Most recent detected part per tab id. */
  detectedParts: Record<string, DetectedPart>;
  /** The finder TAB (browsers without a side panel), if open. */
  finderTabId: number | null;
  /** The finder popup WINDOW ('window' mode / last-resort fallback), if open. */
  finderWindowId: number | null;
  /** Helper windows opened for the overlay, by window id. */
  helperWindows: Record<string, HelperWindowRecord>;
  /** The single folder-grant helper window, if open. */
  setupHelperWindowId: number | null;
  /** True while an install helper is being created or is running. */
  installHelperBusy: boolean;
  /** Tabs where the selection listener was injected. */
  selectionTabs: number[];
  /** Whether chrome.sidePanel actually works (Arc exposes it but doesn't implement it). */
  sidePanelSupported: boolean | null;
}

const DEFAULT_SESSION: SessionState = {
  detectedParts: {},
  finderTabId: null,
  finderWindowId: null,
  helperWindows: {},
  setupHelperWindowId: null,
  installHelperBusy: false,
  selectionTabs: [],
  sidePanelSupported: null,
};

const SESSION_KEY = 'sw';

/**
 * Read the whole session record. One key holds one object, so concurrent
 * handlers see a consistent snapshot; writes go through {@link updateSession}
 * which is serialised with a tiny promise chain.
 */
async function getSession(): Promise<SessionState> {
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const s = stored?.[SESSION_KEY] as Partial<SessionState> | undefined;
    return { ...DEFAULT_SESSION, ...(s ?? {}) };
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

let sessionChain: Promise<unknown> = Promise.resolve();

/** Apply a mutation to the session record atomically (within this worker). */
function updateSession<T>(mutate: (s: SessionState) => T): Promise<T> {
  const run = async () => {
    const s = await getSession();
    const out = mutate(s);
    try {
      await chrome.storage.session.set({ [SESSION_KEY]: s });
    } catch {
      /* storage unavailable — the in-memory mutation still served this call */
    }
    return out;
  };
  const next = sessionChain.then(run, run);
  sessionChain = next.catch(() => {});
  return next;
}

// --- Settings (chrome.storage.local) ------------------------------------------

async function getRelayUrl(): Promise<string> {
  try {
    const { relayUrl } = await chrome.storage.local.get('relayUrl');
    return typeof relayUrl === 'string' ? relayUrl.trim().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

type OpenMode = 'auto' | 'window' | 'overlay';

/**
 * The open-mode preference, cached so the toolbar click can call
 * `chrome.sidePanel.open()` without first awaiting storage (the user gesture
 * that authorises it does not reliably survive an await on a cold worker).
 */
let openModeCache: OpenMode | null = null;

function normalizeOpenMode(value: unknown): OpenMode {
  return value === 'window' || value === 'overlay' ? value : 'auto';
}

async function getOpenMode(): Promise<OpenMode> {
  if (openModeCache) return openModeCache;
  try {
    const { openMode } = await chrome.storage.local.get('openMode');
    openModeCache = normalizeOpenMode(openMode);
  } catch {
    openModeCache = 'auto';
  }
  return openModeCache;
}

// Warm the cache on every worker start and keep it fresh.
void getOpenMode();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.openMode) {
    openModeCache = normalizeOpenMode(changes.openMode.newValue);
  }
});

/** Whether highlight-to-search is enabled (default on). */
async function isSelectionSearchEnabled(): Promise<boolean> {
  try {
    const { selectionSearch } = await chrome.storage.local.get('selectionSearch');
    return selectionSearch !== false;
  } catch {
    return true;
  }
}

// --- Side panel support probe -------------------------------------------------

let sidePanelSupportedCache: boolean | null = null;

async function isSidePanelSupported(): Promise<boolean> {
  if (sidePanelSupportedCache !== null) return sidePanelSupportedCache;
  const s = await getSession();
  if (s.sidePanelSupported !== null) {
    sidePanelSupportedCache = s.sidePanelSupported;
    return s.sidePanelSupported;
  }
  let supported = false;
  if (chrome?.sidePanel?.getOptions) {
    try {
      await chrome.sidePanel.getOptions({});
      supported = true;
    } catch {
      supported = false;
    }
  }
  sidePanelSupportedCache = supported;
  await updateSession((st) => {
    st.sidePanelSupported = supported;
  });
  return supported;
}

// Probe early so the first click already knows the answer.
void isSidePanelSupported();

// --- Detected parts + badge ---------------------------------------------------

async function setDetectedPart(tabId: number, part: DetectedPart | null): Promise<void> {
  await updateSession((s) => {
    if (part) s.detectedParts[String(tabId)] = part;
    else delete s.detectedParts[String(tabId)];
  });
  // Only page detections get the badge; a highlighted selection is transient.
  const badge = part && part.source !== 'selection' ? '1' : '';
  try {
    await chrome.action.setBadgeText({ text: badge, tabId });
    if (badge) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
  } catch {
    /* tab may already be gone */
  }
}

async function getDetectedPart(tabId: number): Promise<DetectedPart | null> {
  const s = await getSession();
  return s.detectedParts[String(tabId)] ?? null;
}

async function activeTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return typeof tab?.id === 'number' ? tab.id : null;
  } catch {
    return null;
  }
}

/** Broadcast to every finder document (extension pages only; never content scripts). */
function broadcast(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    /* no finder document is open — nothing to tell */
  });
}

// --- Message routing ----------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  // Content script found (or lost) a part on its page.
  if (message.type === 'PART_DETECTED' && typeof sender.tab?.id === 'number') {
    const tabId = sender.tab.id;
    void (async () => {
      const part = message.part as DetectedPart;
      if (part?.source === 'selection' && !(await isSelectionSearchEnabled())) return;
      await setDetectedPart(tabId, part);
    })();
    return false;
  }

  if (message.type === 'NO_PART_FOUND' && typeof sender.tab?.id === 'number') {
    void setDetectedPart(sender.tab.id, null);
    return false;
  }

  // UI asking for the part detected on a tab. Side-panel mode passes no tabId
  // and gets the active tab; tab/window mode passes its source tab.
  if (message.type === 'GET_DETECTED_PART') {
    void (async () => {
      const tabId = typeof message.tabId === 'number' ? message.tabId : await activeTabId();
      const part = tabId === null ? null : await getDetectedPart(tabId);
      sendResponse({ part, tabId });
    })();
    return true;
  }

  // Fetch + convert an LCSC part through the relay.
  if (message.type === 'CONVERT') {
    void (async () => {
      const relayBase = await getRelayUrl();
      if (!relayBase) {
        sendResponse({ ok: false, error: NO_RELAY_ERROR });
        return;
      }
      try {
        const result = await convertLcsc(String(message.lcscId ?? ''), relayBase);
        sendResponse({ ok: true, result });
      } catch (err: unknown) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  // Resolve a free-text MPN to LCSC candidates via JLCPCB (through the relay).
  if (message.type === 'RESOLVE_MPN') {
    void (async () => {
      const relayBase = await getRelayUrl();
      if (!relayBase) {
        sendResponse({ ok: false, error: NO_RELAY_ERROR });
        return;
      }
      try {
        const res = await resolveMpnDetailed(String(message.mpn ?? ''), relayBase);
        sendResponse({ ok: true, ...res });
      } catch (err: unknown) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  // --- Overlay → helper-window delegation ------------------------------------

  if (message.type === 'OVERLAY_PICK_FOLDER') {
    void openSetupHelperWindow().then(
      (id) => sendResponse(id === null ? { ok: false, error: 'Could not open a window.' } : { ok: true }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }

  if (message.type === 'OVERLAY_INSTALL' && typeof message.lcscId === 'string') {
    void openInstallHelperWindow(message.lcscId, typeof message.bucket === 'string' ? message.bucket : '').then(
      (res) => sendResponse(res),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }

  // The overlay's iframe was blocked by the page's CSP — open a window instead.
  if (message.type === 'OVERLAY_FALLBACK_WINDOW') {
    void (async () => {
      const tabId = sender.tab?.id ?? (await activeTabId());
      if (tabId !== null) await openFinderWindow(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // A helper window reached a terminal outcome.
  //   'folder'       → OVERLAY_FOLDER_READY, close the helper
  //   'installed'    → OVERLAY_INSTALLED, close the helper
  //   'failed'       → OVERLAY_INSTALL_FAILED (with the error); the helper STAYS
  //                    open so the user can read the error
  //   'needs-folder' → OVERLAY_INSTALL_FAILED (needsFolder); the helper stays
  //                    open and is focused so the user can grant the folder
  if (message.type === 'OVERLAY_HELPER_DONE') {
    void (async () => {
      const winId = typeof message.windowId === 'number' ? message.windowId : sender.tab?.windowId;
      const kind = String(message.kind ?? '');
      if (typeof winId === 'number') {
        await updateSession((s) => {
          const rec = s.helperWindows[String(winId)];
          if (rec) rec.reported = true;
          if (kind !== 'installed' && kind !== 'folder') {
            // The install helper is finished with (even if its window stays open).
            if (rec?.kind === 'install') s.installHelperBusy = false;
          }
        });
        if (kind === 'installed' || kind === 'folder') {
          setTimeout(() => void closeHelperWindow(winId), HELPER_CLOSE_GRACE_MS);
        } else if (kind === 'needs-folder') {
          try {
            await chrome.windows.update(winId, { focused: true });
          } catch {
            /* window gone */
          }
        }
      }
      const error = typeof message.error === 'string' ? message.error : '';
      broadcast(
        kind === 'installed'
          ? { type: 'OVERLAY_INSTALLED' }
          : kind === 'folder'
            ? { type: 'OVERLAY_FOLDER_READY' }
            : { type: 'OVERLAY_INSTALL_FAILED', needsFolder: kind === 'needs-folder', error },
      );
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

// --- Opening the finder -------------------------------------------------------

/**
 * Open the finder for a tab in the user's chosen mode, then (re-)inject the
 * selection listener on that tab so highlight-to-search works.
 *
 * `chrome.sidePanel.open()` needs the user gesture that triggered us, so in
 * auto mode it is called before any other await when the caches are warm.
 */
async function openFinder(tab?: chrome.tabs.Tab): Promise<void> {
  let tabId = tab?.id;
  if (typeof tabId !== 'number') tabId = (await activeTabId()) ?? undefined;
  if (typeof tabId !== 'number') return;

  const openMode = openModeCache ?? (await getOpenMode());

  if (openMode === 'overlay') {
    // Restricted pages (chrome://, the Web Store, PDFs) refuse injection —
    // fall back to a window so the icon never dead-ends.
    const injected = await injectOverlay(tabId);
    if (!injected) await openFinderWindow(tabId);
  } else if (openMode === 'window') {
    await openFinderWindow(tabId);
  } else {
    const supported =
      sidePanelSupportedCache !== null ? sidePanelSupportedCache : await isSidePanelSupported();
    if (supported) {
      try {
        await chrome.sidePanel.open({ tabId });
      } catch {
        await openFinderTab(tabId);
      }
    } else {
      await openFinderTab(tabId);
    }
  }

  if (await isSelectionSearchEnabled()) await injectSelectionListener(tabId);
}

chrome.action.onClicked.addListener((tab) => {
  void openFinder(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-finder') void openFinder(tab);
  else if (command === 'search-selection') void searchSelection(tab);
  else if (command === 'install-current') void installCurrent(tab);
});

/**
 * "Search highlighted text" command: read the selection from the active tab
 * (the command grants activeTab, so this works on any page), record it as the
 * tab's detected part, then open the finder — which pre-fills and searches it.
 */
async function searchSelection(tab?: chrome.tabs.Tab): Promise<void> {
  let tabId = tab?.id;
  if (typeof tabId !== 'number') tabId = (await activeTabId()) ?? undefined;
  if (typeof tabId !== 'number') return;

  // Open the finder FIRST so chrome.sidePanel.open() still holds the command's
  // user gesture; read the selection in parallel and hand it over when ready.
  const opening = openFinder(tab);
  let text = '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.getSelection()?.toString() ?? '').trim(),
    });
    text = String(results?.[0]?.result ?? '').trim();
  } catch {
    /* restricted page — nothing to read */
  }

  if (text && text.length <= 80 && !text.includes('\n')) {
    // `autoSearch` covers the finder document that is still loading: its
    // GET_DETECTED_PART prefill sees the flag and searches. An already-open
    // finder reacts to the broadcast instead.
    const part: DetectedPart = { mpn: text, source: 'selection', pageUrl: tab?.url ?? '', autoSearch: true };
    await setDetectedPart(tabId, part);
    broadcast({ type: 'PART_DETECTED', part, tabId, viaCommand: true });
  }
  await opening;
}

/** "Install the current part" command: tell the finder for this tab to install. */
async function installCurrent(tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = tab?.id ?? (await activeTabId());
  // In window/tab mode the active tab IS the finder page; tell it so it can
  // match on its own tab id instead of its source tab.
  const finderPrefix = chrome.runtime.getURL(SIDEPANEL_PATH);
  const isFinderTab = typeof tab?.url === 'string' && tab.url.startsWith(finderPrefix);
  broadcast({ type: 'COMMAND', name: 'install-current', tabId, isFinderTab });
}

/**
 * Open the UI in a browser TAB (browsers without a working side panel). One
 * finder tab is reused while it still shows the finder; if the user navigated
 * it elsewhere a fresh tab is opened instead of overwriting their page.
 */
async function openFinderTab(sourceTabId: number): Promise<void> {
  const finderPrefix = chrome.runtime.getURL(SIDEPANEL_PATH);
  const url = `${finderPrefix}?tab=${sourceTabId}`;
  const s = await getSession();

  if (s.finderTabId !== null) {
    try {
      const existing = await chrome.tabs.get(s.finderTabId);
      const currentUrl = existing.url || existing.pendingUrl || '';
      // An empty URL means "unknown" (not "navigated away") — reuse the tab.
      if (!currentUrl || currentUrl.startsWith(finderPrefix)) {
        await chrome.tabs.update(s.finderTabId, { url, active: true });
        if (typeof existing.windowId === 'number') {
          await chrome.windows.update(existing.windowId, { focused: true });
        }
        return;
      }
    } catch {
      /* the tab is gone — fall through */
    }
    await updateSession((st) => {
      st.finderTabId = null;
    });
  }

  try {
    const created = await chrome.tabs.create({ url, active: true });
    const id = typeof created?.id === 'number' ? created.id : null;
    await updateSession((st) => {
      st.finderTabId = id;
    });
  } catch (err) {
    console.error('Failed to open finder tab; falling back to a window:', err);
    await openFinderWindow(sourceTabId);
  }
}

/**
 * Open the UI in a standalone popup window ('window' mode, and the last-resort
 * fallback). `&win=1` tells the UI it is a window (hides Float). One window is
 * reused and re-aimed at the new source tab.
 */
async function openFinderWindow(sourceTabId: number): Promise<void> {
  const url = `${chrome.runtime.getURL(SIDEPANEL_PATH)}?tab=${sourceTabId}&win=1`;
  const s = await getSession();

  if (s.finderWindowId !== null) {
    try {
      await chrome.windows.update(s.finderWindowId, { focused: true });
      const [view] = await chrome.tabs.query({ windowId: s.finderWindowId });
      if (typeof view?.id === 'number') await chrome.tabs.update(view.id, { url });
      return;
    } catch {
      await updateSession((st) => {
        st.finderWindowId = null;
      });
    }
  }

  try {
    const win = await chrome.windows.create({ type: 'popup', width: 460, height: 760, url, focused: true });
    const id = typeof win?.id === 'number' ? win.id : null;
    await updateSession((st) => {
      st.finderWindowId = id;
    });
  } catch (err) {
    console.error('Failed to open finder window:', err);
  }
}

// --- Content-script injection -------------------------------------------------

/**
 * Inject the selection listener into a tab. Injection is only possible where
 * we have host access: DigiKey/LCSC by manifest, the page the user opened the
 * finder on via activeTab, or everywhere once the user granted the optional
 * all-sites permission from Settings. Failures are silent by design.
 */
async function injectSelectionListener(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/selection-listener.js'] });
    await updateSession((s) => {
      if (!s.selectionTabs.includes(tabId)) s.selectionTabs.push(tabId);
    });
  } catch {
    /* restricted page or no host access — highlight-to-search is unavailable here */
  }
}

/** Inject (or toggle) the in-page overlay. Returns false on restricted pages. */
async function injectOverlay(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] });
    return true;
  } catch {
    return false;
  }
}

// --- Helper windows (File System Access on the overlay's behalf) --------------

async function createHelperWindow(
  extraQuery: string,
  kind: HelperWindowRecord['kind'],
  focused: boolean,
): Promise<number | null> {
  const url = `${chrome.runtime.getURL(SIDEPANEL_PATH)}?win=1${extraQuery}`;
  try {
    const win = await chrome.windows.create({ type: 'popup', width: 460, height: 720, url, focused });
    if (typeof win?.id !== 'number') return null;
    const id = win.id;
    await updateSession((s) => {
      s.helperWindows[String(id)] = { kind, reported: false };
      if (kind === 'setup') s.setupHelperWindowId = id;
    });
    return id;
  } catch (err) {
    console.error('Failed to open helper window:', err);
    return null;
  }
}

/** True while a setup window is being created (guards the check-then-act race). */
let setupHelperPending = false;

/** Open (or focus) the single folder-grant helper window. */
async function openSetupHelperWindow(): Promise<number | null> {
  const s = await getSession();
  if (s.setupHelperWindowId !== null) {
    try {
      await chrome.windows.update(s.setupHelperWindowId, { focused: true });
      return s.setupHelperWindowId;
    } catch {
      await updateSession((st) => {
        delete st.helperWindows[String(st.setupHelperWindowId)];
        st.setupHelperWindowId = null;
      });
    }
  }
  if (setupHelperPending) return -1;
  setupHelperPending = true;
  try {
    return await createHelperWindow('&setup=1', 'setup', true);
  } finally {
    setupHelperPending = false;
  }
}

/**
 * Open an install helper. Only one runs at a time: two helpers writing the same
 * library file concurrently would lose a symbol. The window opens unfocused —
 * it needs no interaction unless the folder grant lapsed, in which case the
 * helper reports `needs-folder` and we focus it then.
 */
async function openInstallHelperWindow(
  lcscId: string,
  bucket: string,
): Promise<{ ok: boolean; error?: string }> {
  const busy = await updateSession((s) => {
    if (s.installHelperBusy) return true;
    s.installHelperBusy = true;
    return false;
  });
  if (busy) return { ok: false, error: 'Another install is still running. Wait for it to finish.' };

  const query = `&install=${encodeURIComponent(lcscId)}${bucket ? `&bucket=${encodeURIComponent(bucket)}` : ''}`;
  const id = await createHelperWindow(query, 'install', false);
  if (id === null) {
    await updateSession((s) => {
      s.installHelperBusy = false;
    });
    return { ok: false, error: 'Could not open the install window.' };
  }
  return { ok: true };
}

async function closeHelperWindow(windowId: number): Promise<void> {
  const known = await updateSession((s) => {
    const rec = s.helperWindows[String(windowId)];
    if (!rec) return false;
    delete s.helperWindows[String(windowId)];
    if (s.setupHelperWindowId === windowId) s.setupHelperWindowId = null;
    if (rec.kind === 'install') s.installHelperBusy = false;
    return true;
  });
  if (!known) return;
  try {
    await chrome.windows.remove(windowId);
  } catch {
    /* already closed itself */
  }
}

// --- Lifecycle hooks ----------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateSession((s) => {
    delete s.detectedParts[String(tabId)];
    s.selectionTabs = s.selectionTabs.filter((id) => id !== tabId);
    if (s.finderTabId === tabId) s.finderTabId = null;
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    const outcome = await updateSession((s) => {
      const rec = s.helperWindows[String(windowId)];
      if (s.finderWindowId === windowId) s.finderWindowId = null;
      if (!rec) return null;
      delete s.helperWindows[String(windowId)];
      if (s.setupHelperWindowId === windowId) s.setupHelperWindowId = null;
      if (rec.kind === 'install') s.installHelperBusy = false;
      return rec;
    });
    if (!outcome || outcome.reported) return;
    // The user closed a helper before it finished — un-stick the overlay.
    broadcast(
      outcome.kind === 'install'
        ? { type: 'OVERLAY_INSTALL_FAILED', needsFolder: false, error: 'The install window was closed.' }
        : { type: 'OVERLAY_FOLDER_DISMISSED' },
    );
  })();
});

// Navigation: forget the detected part and badge as soon as a tab starts
// loading a new page (the content script re-detects on product pages), keep
// the selection listener alive on tracked tabs, and stop tracking a finder tab
// the user navigated elsewhere.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === undefined && changeInfo.url === undefined) return;
    void (async () => {
      const s = await getSession();
      // A real navigation starts with status 'loading'. Same-document
      // history changes only report `url`, and the LCSC content script
      // re-announces those itself, so they must not wipe the detection.
      if (changeInfo.status === 'loading' && s.detectedParts[String(tabId)]) {
        await setDetectedPart(tabId, null);
      }
      if (changeInfo.status === 'complete' && s.selectionTabs.includes(tabId)) {
        if (await isSelectionSearchEnabled()) await injectSelectionListener(tabId);
      }
      if (tabId === s.finderTabId && typeof changeInfo.url === 'string') {
        if (!changeInfo.url.startsWith(chrome.runtime.getURL(SIDEPANEL_PATH))) {
          await updateSession((st) => {
            st.finderTabId = null;
          });
        }
      }
    })();
});

// Tell open finder documents which tab is now active so a side panel can offer
// that tab's detected part instead of showing a stale one.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void (async () => {
    const part = await getDetectedPart(tabId);
    broadcast({ type: 'TAB_ACTIVATED', tabId, windowId, part });
  })();
});
