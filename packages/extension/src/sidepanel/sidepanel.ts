/**
 * Side panel UI. Self-contained: no companion server.
 *
 * One calm surface with three states:
 *   • Readiness strip (always visible): Library + Relay pills. Click to change.
 *     The Setup view takes over on first run or when something is missing; the
 *     relay URL also lives in the Settings disclosure (gear).
 *   • Search: LCSC#/MPN input, pre-filled from a detected part. Search and
 *     previews need only the relay; the folder is needed at install time.
 *   • Result card → Install: MPN headline, stock/price badge, editable metadata
 *     (empty fields flagged amber), an auto-picked destination bucket, then a
 *     confident Install → busy → success state listing the written files.
 *
 * The same document runs in five contexts (see CLAUDE.md): side panel, tab or
 * popup window (`?tab=&win=1`), the in-page overlay iframe (`?overlay=1`), the
 * folder-grant helper (`?win=1&setup=1`), and the install helper
 * (`?win=1&install=C…`). File System Access is blocked inside the overlay's
 * cross-origin iframe, so it delegates folder-pick and install to helper
 * windows through the service worker.
 *
 * Keyboard shortcuts: browser-level commands are read from chrome.commands and
 * changed on chrome://extensions/shortcuts; panel shortcuts and page shortcuts
 * are ours (see ../lib/shortcuts.ts) and are recorded in Settings. Page
 * shortcuts are matched by the page listener on web pages and, for the
 * finder's own documents, here as well (forwarded as PAGE_COMMAND).
 *
 * The open-finder toggle may ask a side-panel document to close itself
 * (CLOSE_SIDE_PANEL); the worker finds open panels with runtime.getContexts.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';
import type { ConvertResult } from '../lib/converter/easyeda.js';
import type { JlcMatch } from '../lib/jlcpcb.js';
import { LIBRARY_CHOICES, categoryToBucket, type LibraryChoice } from '../lib/autosort.js';
import {
  peekSavedFolder,
  pickLibraryFolder,
  requestFolderPermission,
  installPart,
  type FolderPermission,
  type InstallPartResult,
} from '../lib/library-writer.js';
import { getSecondarySourceLinks } from '../lib/mpn-sources.js';
import { normalizeRelayUrl, prettyRelay, interpretRelayHealth } from '../lib/relay-url.js';
import {
  PANEL_ACTIONS,
  PANEL_ACTION_LABELS,
  DEFAULT_PANEL_SHORTCUTS,
  PAGE_ACTIONS,
  PAGE_ACTION_LABELS,
  DEFAULT_PAGE_SHORTCUTS,
  actionForCombo,
  pageActionForCombo,
  browserShortcutToKeyCaps,
  comboFromKeys,
  comboIsBareKey,
  comboToKeyCaps,
  detectPlatform,
  parseCombo,
  resolvePanelShortcuts,
  resolvePageShortcuts,
  serializeCombo,
  validateCombo,
  validatePageCombo,
  type PageAction,
  type PanelAction,
  type Platform,
} from '../lib/shortcuts.js';
import { parseSourceTabId, isWindowMode } from './source-tab.js';
import { isOverlayMode, isSetupMode, parseInstallLcsc, parseBucket } from '../content/overlay-params.js';
import { isPipSupported, floatOnTop, type FloatHandle } from './float.js';
import { createPreviewController, type PreviewController } from './preview-controller.js';

// --- DOM ---------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $('app');

const floatBtn = $<HTMLButtonElement>('floatBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsPanel = $('settingsPanel');
const floatingNote = $('floatingNote');
const windowNote = $('windowNote');

const openModeSelector = $('openModeSelector');
const windowModeNote = $('windowModeNote');
const themeSelector = $('themeSelector');
const selectionSearchToggle = $<HTMLInputElement>('selectionSearchToggle');
const allSitesRow = $('allSitesRow');
const allSitesBtn = $<HTMLButtonElement>('allSitesBtn');
const browserShortcutsEl = $('browserShortcuts');
const pageShortcutsEl = $('pageShortcuts');
const panelShortcutsEl = $('panelShortcuts');
const resetShortcutsBtn = $<HTMLButtonElement>('resetShortcutsBtn');

const libPill = $<HTMLButtonElement>('libPill');
const libPillValue = $('libPillValue');
const relayPill = $<HTMLButtonElement>('relayPill');
const relayPillValue = $('relayPillValue');

const setupView = $('setupView');
const setupStepLib = $('setupStepLib');
const setupStepRelay = $('setupStepRelay');
const chooseFolderBtn = $<HTMLButtonElement>('chooseFolderBtn');
const chooseInTabBtn = $<HTMLButtonElement>('chooseInTabBtn');
const grantModeNote = $('grantModeNote');
const relayUrlInputSetup = $<HTMLInputElement>('relayUrlInputSetup');
const relayTestBtnSetup = $<HTMLButtonElement>('relayTestBtnSetup');
const relayNoteSetup = $('relayNoteSetup');
const setupDoneBtn = $<HTMLButtonElement>('setupDoneBtn');

const relayUrlInput = $<HTMLInputElement>('relayUrlInput');
const relayTestBtn = $<HTMLButtonElement>('relayTestBtn');
const relayNote = $('relayNote');

const searchInput = $<HTMLInputElement>('searchInput');
const searchField = document.querySelector('.search-field') as HTMLElement;
const searchBtn = $<HTMLButtonElement>('searchBtn');
const searchHint = $('searchHint');
const selectionHint = $('selectionHint');
const selectionHintText = $('selectionHintText');
const selectionAllowBtn = $<HTMLButtonElement>('selectionAllowBtn');
const searchStatus = $('searchStatus');
const detectedOffer = $('detectedOffer');
const detectedOfferMpn = $('detectedOfferMpn');
const detectedOfferBtn = $<HTMLButtonElement>('detectedOfferBtn');
const detectedOfferDismiss = $<HTMLButtonElement>('detectedOfferDismiss');

const candidateSection = $('candidateSection');
const candidateList = $('candidateList');

const partCard = $('partCard');
const cardLcsc = $<HTMLAnchorElement>('cardLcsc');
const cardMpn = $('cardMpn');
const cardSub = $('cardSub');
const stockBadge = $('stockBadge');
const fieldMpn = $<HTMLInputElement>('fieldMpn');
const fieldManufacturer = $<HTMLInputElement>('fieldManufacturer');
const fieldPackage = $<HTMLInputElement>('fieldPackage');
const fieldDatasheet = $<HTMLInputElement>('fieldDatasheet');
const datasheetLink = $<HTMLAnchorElement>('datasheetLink');
const flagMpn = $('flagMpn');
const flagDatasheet = $('flagDatasheet');
const bucketSelect = $<HTMLSelectElement>('bucketSelect');
const destPath = $('destPath');
const symbolAvail = $('symbolAvail');
const footprintAvail = $('footprintAvail');
const model3dAvail = $('model3dAvail');
const installBtn = $<HTMLButtonElement>('installBtn');
const installBtnText = $('installBtnText');
const installStatus = $('installStatus');
const successPanel = $('successPanel');
const writtenList = $<HTMLUListElement>('writtenList');
const restartNote = $('restartNote');
const reloadNote = $('reloadNote');
const installAnotherBtn = $<HTMLButtonElement>('installAnotherBtn');
const closeHelperBtn = $<HTMLButtonElement>('closeHelperBtn');

const secondarySources = $('secondarySources');
const sourceLinks = $('sourceLinks');

// --- State -------------------------------------------------------------------
let libraryFolder: FileSystemDirectoryHandle | null = null;
let folderPermission: FolderPermission = 'none';
/** The saved handle even when its grant lapsed, so a click can re-request it directly. */
let savedHandle: FileSystemDirectoryHandle | null = null;
/** Folder name when a handle exists but needs a click to re-grant. */
let savedFolderName = '';
let current: ConvertResult | null = null;
let currentMatch: JlcMatch | null = null;
let candidates: JlcMatch[] = [];
let relayUrl = '';
/** Generation counter: any await in a search/convert checks it's still current. */
let searchSeq = 0;
let searchInFlight = false;
let detectDebounce: ReturnType<typeof setTimeout> | null = null;
let installInFlight = false;
let overlayInstallWatchdog: ReturnType<typeof setTimeout> | null = null;
let pickFolderInFlight = false;
let floatHandle: FloatHandle | null = null;
/** Keep the Setup view open while the user is working in it. */
let setupPinned = false;
/** The part offered (not forced) by the detected-part chip. */
let offeredPart: DetectedPart | null = null;
/** Side-panel mode: the tab (and window) this panel belongs to. */
let myActiveTabId: number | null = null;
let myWindowId: number | null = null;
/** Tab/window mode: the id of the tab this finder page itself lives in. */
let myOwnTabId: number | null = null;
let selectionSearch = true;
/**
 * Whether the page this finder belongs to has the page listener (so highlights
 * and page shortcuts reach us). null until the worker has told us.
 */
let selectionReady: boolean | null = null;
/** True once the user has typed in the search box since it was last set by us. */
let searchDirty = false;
let panelShortcuts = resolvePanelShortcuts(undefined);
let pageShortcuts = resolvePageShortcuts(undefined);
const platform: Platform = detectPlatform(
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform,
);
/** The action currently being recorded in Settings, if any. */
let recordingAction: PanelAction | PageAction | null = null;
/** Which table the recording belongs to. */
let recordingGroup: 'panel' | 'page' = 'panel';
/** The document the key handler is bound to (changes when floating in PiP). */
let keyDocument: Document = document;

const runningInWindow = isWindowMode(location.search);
const runningInOverlay = isOverlayMode(location.search);
const runningInSetup = isSetupMode(location.search);
const autoInstallLcsc = parseInstallLcsc(location.search);
/** The page this finder belongs to (tab/window mode). Re-aimed by RETARGET. */
let sourceTabId = parseSourceTabId(location.search);
const runningInHelper = runningInSetup || autoInstallLcsc !== null;
/** A normal tab opened from the floating window just to choose the folder (`?grant=1`). */
const runningInGrantTab = new URLSearchParams(location.search).get('grant') === '1';
/** How long a folder dialog may stay silent before we offer the tab route. */
const PICKER_SILENCE_MS = 2500;
/** The plain side panel: no source tab, not a window, not framed, not a helper. */
const runningInSidePanel = sourceTabId === null && !runningInWindow && !runningInOverlay && !runningInHelper && !runningInGrantTab;

const OVERLAY_LIB_KEY = 'overlayLibraryName';
let overlayLibraryName = '';
let preview: PreviewController | null = null;

/** Overlay installs that never report back are reset after this long. */
const OVERLAY_INSTALL_WATCHDOG_MS = 120_000;

// --- Init --------------------------------------------------------------------
async function init() {
  // Register the message listener FIRST so nothing broadcast during the
  // awaited setup below is missed.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'RETARGET') {
      // The worker re-aims THIS document at a new source tab instead of
      // reloading it, so the folder grant survives. Answer only for our tab.
      if (runningInHelper || runningInOverlay || message.finderTabId !== myOwnTabId) return false;
      sourceTabId = typeof message.tabId === 'number' ? message.tabId : sourceTabId;
      sendResponse({ ok: true });
      if (message.part) offerOrSearch(message.part as DetectedPart, false);
      return false;
    }
    onRuntimeMessage(message, sender);
    return false;
  });

  for (const choice of LIBRARY_CHOICES) {
    const opt = document.createElement('option');
    opt.value = choice;
    opt.textContent = bucketLabel(choice);
    bucketSelect.appendChild(opt);
  }

  // Readiness strip + setup.
  // The pill re-requests a lapsed grant in one click; the setup button always
  // opens the folder picker, so there is a path that works even when Chrome
  // shows no permission prompt.
  libPill.addEventListener('click', () => void onLibraryAction('pill'));
  chooseFolderBtn.addEventListener('click', () => void onLibraryAction('pick'));
  chooseInTabBtn.addEventListener('click', openFinderInTab);
  // Arc's floating popup window does not show native folder dialogs, so in
  // window mode the tab route is offered up front, not only after a failure.
  if (runningInWindow && !runningInHelper) show(chooseInTabBtn);
  if (runningInGrantTab) {
    setupPinned = true;
    show(grantModeNote);
  }
  relayPill.addEventListener('click', () => {
    if (!hasRelay()) openSetupFocusRelay();
    else toggleSettings();
  });
  setupDoneBtn.addEventListener('click', () => {
    setupPinned = false;
    refreshReadiness();
    searchInput.focus();
  });

  // Settings.
  settingsBtn.addEventListener('click', () => toggleSettings());
  for (const input of [relayUrlInput, relayUrlInputSetup]) {
    input.addEventListener('input', () => void onRelayUrlChange(input));
    input.addEventListener('blur', () => normalizeRelayInput(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        normalizeRelayInput(input);
        void testRelay(input === relayUrlInput ? relayNote : relayNoteSetup, input);
      }
    });
  }
  relayTestBtn.addEventListener('click', () => void testRelay(relayNote, relayUrlInput));
  relayTestBtnSetup.addEventListener('click', () => void testRelay(relayNoteSetup, relayUrlInputSetup));
  openModeSelector.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (target?.name === 'openMode') void onOpenModeChange(target.value);
  });
  themeSelector.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (target?.name === 'theme') void onThemeChange(target.value);
  });
  selectionSearchToggle.addEventListener('change', () => void onSelectionSearchChange());
  allSitesBtn.addEventListener('click', () => void requestAllSites());
  resetShortcutsBtn.addEventListener('click', () => void resetAllShortcuts());

  // Search.
  searchInput.addEventListener('input', () => {
    searchDirty = true;
  });
  selectionAllowBtn.addEventListener('click', () => void allowAllSitesForThisPage());
  searchBtn.addEventListener('click', () => void runSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    // Ignore the Enter that commits an IME composition (Chinese/Japanese input).
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void runSearch(searchInput.value);
    }
  });
  detectedOfferBtn.addEventListener('click', () => {
    if (!offeredPart) return;
    const text = offeredPart.lcscId || offeredPart.mpn;
    hideOffer();
    setSearchValue(text);
    void runSearch(text);
  });
  detectedOfferDismiss.addEventListener('click', hideOffer);

  // Card.
  installBtn.addEventListener('click', () => void onInstall());
  installAnotherBtn.addEventListener('click', resetForAnother);
  closeHelperBtn.addEventListener('click', () => window.close());
  bucketSelect.addEventListener('change', () => {
    updateDestPath();
    rearmInstallButton();
  });

  preview = createPreviewController(partCard);
  setupFloatButton();
  bindKeys(document);

  // Stored settings.
  try {
    const stored = await chrome.storage.local.get(['relayUrl', 'openMode', 'theme', 'selectionSearch']);
    relayUrl = normalizeRelayUrl(typeof stored.relayUrl === 'string' ? stored.relayUrl : '').url;
    selectOpenMode(normalizeOpenMode(stored.openMode));
    applyTheme(normalizeTheme(stored.theme));
    selectionSearch = stored.selectionSearch !== false;
  } catch {
    relayUrl = '';
    applyTheme('system');
  }
  relayUrlInput.value = relayUrl;
  relayUrlInputSetup.value = relayUrl;
  selectionSearchToggle.checked = selectionSearch;
  void refreshAllSitesRow();
  await loadShortcuts();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.panelShortcuts) {
      panelShortcuts = resolvePanelShortcuts(changes.panelShortcuts.newValue);
      renderPanelShortcuts();
      renderKeyHints();
    }
    if (changes.pageShortcuts) {
      pageShortcuts = resolvePageShortcuts(changes.pageShortcuts.newValue);
      renderPageShortcuts();
    }
  });

  // Library folder.
  if (runningInOverlay) {
    try {
      const stored = await chrome.storage.local.get(OVERLAY_LIB_KEY);
      overlayLibraryName = typeof stored[OVERLAY_LIB_KEY] === 'string' ? stored[OVERLAY_LIB_KEY] : '';
    } catch {
      overlayLibraryName = '';
    }
  } else {
    await refreshFolderState();
  }

  refreshReadiness();
  void renderBrowserShortcuts();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void renderBrowserShortcuts();
  });

  // Which tab/window does this document belong to?
  try {
    myWindowId = (await chrome.windows.getCurrent()).id ?? null;
  } catch {
    myWindowId = null;
  }
  try {
    myOwnTabId = (await chrome.tabs.getCurrent())?.id ?? null;
  } catch {
    myOwnTabId = null;
  }

  // Pre-fill from the detected part.
  if (!runningInHelper) {
    try {
      const msg = sourceTabId === null ? { type: 'GET_DETECTED_PART' } : { type: 'GET_DETECTED_PART', tabId: sourceTabId };
      const resp = await chrome.runtime.sendMessage(msg);
      if (typeof resp?.tabId === 'number') myActiveTabId = resp.tabId;
      const part = resp?.part as DetectedPart | undefined;
      if (part && (part.source !== 'selection' || selectionSearch || part.autoSearch)) {
        setSearchValue(part.lcscId || part.mpn || '');
        if (part.autoSearch) void runSearch(searchInput.value);
      }
    } catch {
      /* no detected part */
    }
  }

  // Tell the overlay content script the frame is alive (its CSP watchdog).
  if (runningInOverlay) {
    try {
      window.parent.postMessage({ type: 'kicad-overlay-ready' }, '*');
    } catch {
      /* not framed */
    }
  }

  if (runningInSetup) runFolderGrantHelper();
  else if (autoInstallLcsc) void runAutoInstallHelper(autoInstallLcsc);
  else if (!runningInOverlay) searchInput.focus();
}

// --- Runtime messages ----------------------------------------------------------

/** Does a message about `tabId` concern THIS finder document? */
function concernsMe(tabId: number | undefined): boolean {
  if (typeof tabId !== 'number') return true; // unknown origin: don't drop it
  if (sourceTabId !== null) return tabId === sourceTabId;
  if (myActiveTabId !== null) return tabId === myActiveTabId;
  return true;
}

function onRuntimeMessage(message: any, sender: chrome.runtime.MessageSender): void {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'PART_DETECTED' && message.part) {
    if (runningInHelper) return; // single-purpose windows never re-search
    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (!concernsMe(tabId)) return;
    const part = message.part as DetectedPart;
    if (part.source === 'selection' && !selectionSearch && !message.viaCommand) return;
    offerOrSearch(part, Boolean(message.viaCommand));
    return;
  }

  if (message.type === 'TAB_ACTIVATED') {
    // Side-panel mode follows the active tab of its window.
    if (sourceTabId !== null || runningInHelper || runningInOverlay) return;
    if (myWindowId !== null && message.windowId !== myWindowId) return;
    myActiveTabId = typeof message.tabId === 'number' ? message.tabId : myActiveTabId;
    if (typeof message.selectionReady === 'boolean') setSelectionReady(message.selectionReady);
    if (message.part) offerOrSearch(message.part as DetectedPart, false);
    return;
  }

  // The worker (re)injected the page listener on a tab, or could not.
  if (message.type === 'SELECTION_READY') {
    if (runningInHelper || !concernsMe(message.tabId)) return;
    if (typeof message.ready === 'boolean') setSelectionReady(message.ready);
    return;
  }

  // The open-finder toggle closed the side panel but this document survived.
  if (message.type === 'CLOSE_SIDE_PANEL') {
    if (runningInSidePanel && message.windowId === myWindowId) window.close();
    return;
  }

  if (message.type === 'COMMAND' && message.name === 'install-current') {
    if (runningInHelper) return;
    const mine = message.isFinderTab
      ? typeof message.tabId === 'number' && message.tabId === myOwnTabId
      : concernsMe(message.tabId);
    if (!mine) return;
    if (!installBtn.disabled) void onInstall();
    return;
  }

  if (!runningInOverlay) {
    // A folder granted in another finder document (a tab, say): pick up
    // whatever state Chrome will give this document without a prompt.
    if (message.type === 'OVERLAY_FOLDER_READY' || message.type === 'FOLDER_GRANTED') {
      void refreshFolderState().then(() => {
        refreshReadiness();
        if (folderPermission === 'granted') {
          rearmInstallButton();
          setStatus(searchStatus, `“${folderName()}” is connected.`, 'success');
        } else if (folderPermission === 'prompt') {
          setStatus(searchStatus, `“${savedFolderName}” was chosen. Click the Library pill once to use it here.`, 'info');
        }
      });
    }
    return;
  }

  if (message.type === 'OVERLAY_FOLDER_READY') {
    pickFolderInFlight = false;
    libPill.disabled = false;
    hide(searchStatus);
    void refreshOverlayReadiness();
  } else if (message.type === 'OVERLAY_FOLDER_DISMISSED') {
    pickFolderInFlight = false;
    libPill.disabled = false;
    setStatus(searchStatus, 'Folder access was not granted. Click Library to try again.', 'error');
  } else if (message.type === 'OVERLAY_INSTALLED') {
    clearOverlayWatchdog();
    installInFlight = false;
    void refreshOverlayReadiness();
    markOverlayInstalled();
  } else if (message.type === 'OVERLAY_INSTALL_FAILED') {
    clearOverlayWatchdog();
    installInFlight = false;
    void refreshOverlayReadiness();
    markOverlayInstallFailed(message.needsFolder === true, typeof message.error === 'string' ? message.error : '');
  }
}

/**
 * A part was detected for this document's tab. Search it right away when the
 * panel is idle; otherwise offer it in a chip so nothing the user is doing is
 * thrown away. An explicit command ("Search highlighted text") always searches.
 */
function offerOrSearch(part: DetectedPart, force: boolean): void {
  const text = part.lcscId || part.mpn || '';
  if (!text) return;
  // "Typing" means the user actually edited the box, not merely that it holds
  // focus: a floating window keeps focus on the box while the page is used.
  const typing = searchDirty && searchInput.value.trim() !== '';
  const busy = installInFlight || searchInFlight;
  const cardShowing = !partCard.classList.contains('hidden');
  const sameAsCurrent = current && (current.meta.lcsc === text || current.meta.mpn === text);

  if (!force && (typing || busy || (cardShowing && !sameAsCurrent && part.source !== 'selection'))) {
    if (sameAsCurrent) return;
    offeredPart = part;
    setText(detectedOfferMpn, text);
    show(detectedOffer);
    return;
  }
  if (sameAsCurrent) return;
  hideOffer();
  setSearchValue(text);
  if (detectDebounce) clearTimeout(detectDebounce);
  detectDebounce = setTimeout(() => {
    detectDebounce = null;
    if (installInFlight) return;
    void runSearch(searchInput.value);
  }, force ? 0 : 350);
}

function hideOffer(): void {
  offeredPart = null;
  hide(detectedOffer);
}

/** Set the search box from code (a detection, a chip, a reset): not the user typing. */
function setSearchValue(text: string): void {
  searchInput.value = text;
  searchDirty = false;
}

// --- Highlight-to-search availability -----------------------------------------

function setSelectionReady(ready: boolean): void {
  selectionReady = ready;
  void refreshSelectionHint();
}

/**
 * Explain, under the search box, when highlighting on the page cannot reach us:
 * the page has no listener (no host access) or is one Chrome never lets us into.
 */
async function refreshSelectionHint(): Promise<void> {
  const relevant = selectionSearch && selectionReady === false && !runningInHelper && !runningInGrantTab;
  if (!relevant) {
    hide(selectionHint);
    return;
  }
  let allSites = false;
  try {
    allSites = await chrome.permissions.contains({ origins: ['https://*/*'] });
  } catch {
    allSites = false;
  }
  setText(
    selectionHintText,
    allSites
      ? 'Highlight-to-search is not available on this page.'
      : 'Highlight-to-search is off on this page. Open Part Finder from the toolbar icon there, or',
  );
  selectionAllowBtn.classList.toggle('hidden', allSites);
  show(selectionHint);
}

/** "Allow on all sites" from the hint: grant, then put the listener on this page now. */
async function allowAllSitesForThisPage(): Promise<void> {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
  } catch {
    granted = false;
  }
  void refreshAllSitesRow();
  if (!granted) {
    setStatus(searchStatus, 'Not allowed. Highlight-to-search keeps working on the page where you open the finder.', 'info');
    return;
  }
  const tabId = sourceTabId ?? myActiveTabId;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'ENSURE_PAGE_LISTENER', tabId: tabId ?? undefined });
    if (typeof resp?.ready === 'boolean') setSelectionReady(resp.ready);
  } catch {
    /* the worker will tell us when it can */
  }
}

// --- Overlay delegation ---------------------------------------------------------

async function refreshOverlayReadiness() {
  try {
    const stored = await chrome.storage.local.get(OVERLAY_LIB_KEY);
    overlayLibraryName = typeof stored[OVERLAY_LIB_KEY] === 'string' ? stored[OVERLAY_LIB_KEY] : '';
  } catch {
    /* keep the last-known value */
  }
  refreshReadiness();
}

function clearOverlayWatchdog() {
  if (overlayInstallWatchdog) clearTimeout(overlayInstallWatchdog);
  overlayInstallWatchdog = null;
}

function markOverlayInstalled() {
  if (!current) return;
  setInstallButton('done', `Installed ${current.meta.mpn || current.meta.lcsc}`);
  setStatus(installStatus, `Installed into ${bucketLabel(bucketSelect.value)}.`, 'success');
  hide(restartNote);
  show(reloadNote);
  writtenList.textContent = '';
  show(successPanel);
  installAnotherBtn.focus();
}

function markOverlayInstallFailed(needsFolder: boolean, error: string) {
  setInstallButton('error', needsFolder ? 'Grant folder access to finish' : 'Install failed. Retry');
  refreshInstallEnabled();
  setStatus(
    installStatus,
    needsFolder
      ? 'Grant your library folder in the small window that opened. The install continues there.'
      : error || 'Install failed. Try again.',
    'error',
  );
}

function runFolderGrantHelper() {
  setupPinned = true;
  refreshReadiness();
  setStatus(searchStatus, 'Choose your KiCad library folder to finish. This window closes by itself.', 'info');
  chooseFolderBtn.focus();
}

function afterGrantInHelper(handle: FileSystemDirectoryHandle): boolean {
  if (runningInSetup) {
    setStatus(searchStatus, `Granted “${handle.name}”.`, 'success');
    void finishHelper('folder');
    return true;
  }
  return false;
}

async function runAutoInstallHelper(lcscId: string) {
  await convertAndShow(lcscId, null, undefined, ++searchSeq);
  if (!current) {
    void finishHelper('failed', searchStatus.textContent || 'Conversion failed.');
    show(closeHelperBtn);
    show(successPanel);
    return;
  }
  const wantBucket = parseBucket(location.search, LIBRARY_CHOICES);
  if (wantBucket) bucketSelect.value = wantBucket;
  updateDestPath();

  if (!libraryFolder) {
    libPill.focus();
    setStatus(installStatus, 'Click the Library pill to confirm your folder. The part installs right after.', 'info');
    void notifyOverlay('needs-folder');
    return;
  }
  await onInstall();
  await finishInstallHelper();
}

/** After an install in the helper: report the outcome and close on success. */
async function finishInstallHelper() {
  if (installBtn.classList.contains('is-done')) {
    void finishHelper('installed');
  } else {
    void notifyOverlay('failed', installStatus.textContent || 'Install failed.');
    show(closeHelperBtn);
    show(successPanel);
  }
}

type HelperOutcome = 'folder' | 'installed' | 'failed' | 'needs-folder';

async function notifyOverlay(kind: HelperOutcome, error = '') {
  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {
    /* no safety-net close then */
  }
  try {
    await chrome.runtime.sendMessage({ type: 'OVERLAY_HELPER_DONE', kind, windowId, error });
  } catch {
    /* worker unreachable */
  }
}

async function finishHelper(kind: HelperOutcome, error = '') {
  await notifyOverlay(kind, error);
  if (kind === 'failed') return; // stay open so the error can be read
  setTimeout(() => {
    try {
      window.close();
    } catch {
      /* the worker closes us after a grace period */
    }
  }, 1200);
}

// --- Float on top ----------------------------------------------------------------

function setupFloatButton() {
  if (runningInOverlay || runningInHelper) {
    floatBtn.classList.add('hidden');
    return;
  }
  if (runningInWindow) {
    floatBtn.classList.add('hidden');
    windowNote.classList.remove('hidden');
    return;
  }
  if (!isPipSupported()) {
    floatBtn.classList.add('hidden');
    return;
  }
  floatBtn.classList.remove('hidden');
  floatBtn.addEventListener('click', () => void onToggleFloat());
}

async function onToggleFloat() {
  if (floatHandle) {
    floatHandle.close();
    return;
  }
  try {
    floatHandle = await floatOnTop({
      root: app,
      onEnter: (pipWindow) => {
        floatingNote.classList.remove('hidden');
        floatBtn.classList.add('is-active');
        floatBtn.title = 'Return from the floating window';
        setText(floatBtn.querySelector('.icon-label'), 'Floating');
        bindKeys(pipWindow.document);
        pipWindow.document.addEventListener('visibilitychange', () => preview?.refresh());
        preview?.refresh();
      },
      onLeave: () => {
        floatHandle = null;
        floatingNote.classList.add('hidden');
        floatBtn.classList.remove('is-active');
        floatBtn.title = 'Float on top in an always-on-top window';
        setText(floatBtn.querySelector('.icon-label'), 'Float');
        bindKeys(document);
        preview?.refresh();
      },
    });
  } catch {
    floatHandle = null;
    floatBtn.classList.add('hidden');
    setStatus(searchStatus, 'Floating needs a normal browser tab. Open the finder in a tab to float it.', 'error');
  }
}

// --- Settings --------------------------------------------------------------------

function toggleSettings(forceOpen?: boolean) {
  const open = forceOpen ?? settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden', !open);
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    relayUrlInput.value = relayUrl;
    void renderBrowserShortcuts();
    refreshReadiness();
    relayUrlInput.focus();
  } else {
    cancelRecording();
    refreshReadiness();
  }
}

type OpenMode = 'auto' | 'window' | 'overlay';
function normalizeOpenMode(value: unknown): OpenMode {
  return value === 'window' || value === 'overlay' ? value : 'auto';
}
function currentDocumentMode(): OpenMode {
  if (runningInOverlay) return 'overlay';
  if (runningInWindow) return 'window';
  return 'auto';
}
function selectOpenMode(mode: OpenMode) {
  const input = openModeSelector.querySelector<HTMLInputElement>(`input[name="openMode"][value="${mode}"]`);
  if (input) input.checked = true;
}
async function onOpenModeChange(value: string) {
  const mode = normalizeOpenMode(value);
  try {
    await chrome.storage.local.set({ openMode: mode });
  } catch {
    /* keep the in-memory choice */
  }
  windowModeNote.classList.toggle('hidden', mode === currentDocumentMode());
}

type Theme = 'system' | 'dark' | 'light';
function normalizeTheme(value: unknown): Theme {
  return value === 'dark' || value === 'light' ? value : 'system';
}
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  // Keep a floating PiP document in step.
  const pipDoc = floatHandle?.pipWindow.document;
  if (pipDoc) {
    if (theme === 'system') pipDoc.documentElement.removeAttribute('data-theme');
    else pipDoc.documentElement.setAttribute('data-theme', theme);
  }
  const input = themeSelector.querySelector<HTMLInputElement>(`input[name="theme"][value="${theme}"]`);
  if (input) input.checked = true;
}
async function onThemeChange(value: string) {
  const theme = normalizeTheme(value);
  applyTheme(theme);
  try {
    await chrome.storage.local.set({ theme });
  } catch {
    /* keep for this session */
  }
}

async function onSelectionSearchChange() {
  selectionSearch = selectionSearchToggle.checked;
  try {
    await chrome.storage.local.set({ selectionSearch });
  } catch {
    /* keep for this session */
  }
  void refreshAllSitesRow();
  void refreshSelectionHint();
}

/** Show the "allow on all sites" nudge only while the toggle is on and the grant is missing. */
async function refreshAllSitesRow() {
  if (!selectionSearch) {
    hide(allSitesRow);
    return;
  }
  try {
    const has = await chrome.permissions.contains({ origins: ['https://*/*'] });
    allSitesRow.classList.toggle('hidden', has);
  } catch {
    hide(allSitesRow);
  }
}

async function requestAllSites() {
  try {
    const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
    if (!granted) setStatus(searchStatus, 'Not allowed. Highlight-to-search keeps working on the page where you open the finder.', 'info');
  } catch {
    /* the request needs a click; ignore */
  }
  void refreshAllSitesRow();
}

// --- Keyboard shortcuts ------------------------------------------------------------

async function loadShortcuts() {
  try {
    const stored = await chrome.storage.sync.get(['panelShortcuts', 'pageShortcuts']);
    panelShortcuts = resolvePanelShortcuts(stored.panelShortcuts);
    pageShortcuts = resolvePageShortcuts(stored.pageShortcuts);
  } catch {
    panelShortcuts = resolvePanelShortcuts(undefined);
    pageShortcuts = resolvePageShortcuts(undefined);
  }
  renderPanelShortcuts();
  renderPageShortcuts();
  renderKeyHints();
}

async function savePanelShortcuts() {
  try {
    await chrome.storage.sync.set({ panelShortcuts });
  } catch {
    /* keep for this session */
  }
  renderPanelShortcuts();
  renderKeyHints();
}

async function savePageShortcuts() {
  try {
    await chrome.storage.sync.set({ pageShortcuts });
  } catch {
    /* keep for this session */
  }
  renderPageShortcuts();
}

async function resetAllShortcuts() {
  cancelRecording();
  panelShortcuts = resolvePanelShortcuts(undefined);
  pageShortcuts = resolvePageShortcuts(undefined);
  await Promise.all([savePanelShortcuts(), savePageShortcuts()]);
}

/** Render key caps into a container. */
function renderCaps(container: HTMLElement, caps: string[], unsetLabel = 'Not set') {
  container.textContent = '';
  if (!caps.length) {
    const k = document.createElement('span');
    k.className = 'kbd unset';
    k.textContent = unsetLabel;
    container.appendChild(k);
    return;
  }
  for (const cap of caps) {
    const k = document.createElement('kbd');
    k.className = 'kbd';
    k.textContent = cap;
    container.appendChild(k);
  }
}

/** The browser-level commands, live from Chrome. */
async function renderBrowserShortcuts() {
  let commands: chrome.commands.Command[] = [];
  try {
    commands = await chrome.commands.getAll();
  } catch {
    commands = [];
  }
  browserShortcutsEl.textContent = '';
  const shortcutsPage = browserShortcutsUrl();
  for (const cmd of commands) {
    if (!cmd.name || cmd.name === '_execute_action') continue;
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    row.setAttribute('role', 'listitem');
    const name = document.createElement('div');
    name.className = 'shortcut-name';
    const title = document.createElement('span');
    title.textContent = cmd.description || cmd.name;
    const desc = document.createElement('span');
    desc.className = 'shortcut-desc';
    desc.textContent = 'Browser shortcut';
    name.appendChild(title);
    name.appendChild(desc);
    const keys = document.createElement('span');
    keys.className = 'keys';
    const caps = browserShortcutToKeyCaps(cmd.shortcut);
    renderCaps(keys, caps, 'Not set');
    if (!caps.length) desc.textContent = 'Not set in the browser. The page shortcut below still works.';
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'link-btn';
    change.textContent = caps.length ? 'Change in Chrome' : 'Set in Chrome';
    change.addEventListener('click', () => {
      void chrome.tabs.create({ url: shortcutsPage }).catch(() => {
        setStatus(searchStatus, `Open ${shortcutsPage} in a new tab to change browser shortcuts.`, 'info');
      });
    });
    row.appendChild(name);
    row.appendChild(keys);
    row.appendChild(change);
    browserShortcutsEl.appendChild(row);
  }
}

/** The shortcuts page for this browser. */
function browserShortcutsUrl(): string {
  const brands = (navigator as { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands ?? [];
  const names = brands.map((b) => b.brand.toLowerCase()).join(' ');
  if (names.includes('edge')) return 'edge://extensions/shortcuts';
  if ((navigator as { brave?: unknown }).brave || names.includes('brave')) return 'brave://extensions/shortcuts';
  return 'chrome://extensions/shortcuts';
}

/** One recorder list: a row per action with the current keys and a Reset link. */
function renderRecorderList<A extends PanelAction | PageAction>(
  container: HTMLElement,
  group: 'panel' | 'page',
  actions: readonly A[],
  labels: Readonly<Record<A, string>>,
  defaults: Readonly<Record<A, string>>,
  table: Readonly<Record<A, string | null>>,
  onReset: (action: A) => void,
) {
  container.textContent = '';
  for (const action of actions) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    row.setAttribute('role', 'listitem');
    row.dataset.action = action;

    const name = document.createElement('div');
    name.className = 'shortcut-name';
    name.textContent = labels[action];

    const keysBtn = document.createElement('button');
    keysBtn.type = 'button';
    keysBtn.className = 'keys-btn';
    keysBtn.setAttribute('aria-label', `Change shortcut for: ${labels[action]}`);
    const combo = parseCombo(table[action]);
    renderCaps(keysBtn, combo ? comboToKeyCaps(combo, platform) : [], 'Not set');
    keysBtn.addEventListener('click', () => startRecording(group, action, keysBtn));

    row.appendChild(name);
    row.appendChild(keysBtn);

    if (table[action] !== defaults[action]) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'link-btn quiet';
      reset.textContent = 'Reset';
      reset.addEventListener('click', () => onReset(action));
      row.appendChild(reset);
    }
    container.appendChild(row);
  }
}

/** The panel shortcuts, with a recorder per row. */
function renderPanelShortcuts() {
  renderRecorderList(panelShortcutsEl, 'panel', PANEL_ACTIONS, PANEL_ACTION_LABELS, DEFAULT_PANEL_SHORTCUTS, panelShortcuts, (action) => {
    panelShortcuts[action] = DEFAULT_PANEL_SHORTCUTS[action];
    void savePanelShortcuts();
  });
}

/** The page shortcuts (the browser commands' twins), with a recorder per row. */
function renderPageShortcuts() {
  renderRecorderList(pageShortcutsEl, 'page', PAGE_ACTIONS, PAGE_ACTION_LABELS, DEFAULT_PAGE_SHORTCUTS, pageShortcuts, (action) => {
    pageShortcuts[action] = DEFAULT_PAGE_SHORTCUTS[action];
    void savePageShortcuts();
  });
}

/** Show the current bindings on the Install button and preview tabs. */
function renderKeyHints() {
  for (const el of app.querySelectorAll<HTMLElement>('[data-shortcut]')) {
    const action = el.dataset.shortcut as PanelAction;
    const combo = parseCombo(panelShortcuts[action]);
    el.textContent = combo ? comboToKeyCaps(combo, platform).join(platform === 'mac' ? '' : '+') : '';
  }
}

let recordingBtn: HTMLButtonElement | null = null;

function startRecording(group: 'panel' | 'page', action: PanelAction | PageAction, btn: HTMLButtonElement) {
  cancelRecording();
  recordingGroup = group;
  recordingAction = action;
  recordingBtn = btn;
  btn.classList.add('is-recording');
  renderCaps(btn, [], 'Press keys…');
  clearShortcutError(btn);
}

function cancelRecording() {
  if (!recordingAction) return;
  recordingAction = null;
  recordingBtn = null;
  renderPanelShortcuts();
  renderPageShortcuts();
}

/** Store a recorded combo (or null to unbind) in the table being recorded. */
function commitRecording(action: PanelAction | PageAction, text: string | null): void {
  recordingAction = null;
  recordingBtn = null;
  if (recordingGroup === 'page') {
    pageShortcuts[action as PageAction] = text;
    void savePageShortcuts();
  } else {
    panelShortcuts[action as PanelAction] = text;
    void savePanelShortcuts();
  }
}

function showShortcutError(btn: HTMLElement, reason: string) {
  const row = btn.closest('.shortcut-row');
  if (!row) return;
  clearShortcutError(btn);
  row.classList.add('has-error');
  const note = document.createElement('div');
  note.className = 'shortcut-error';
  note.textContent = reason;
  row.appendChild(note);
}
function clearShortcutError(btn: HTMLElement) {
  const row = btn.closest('.shortcut-row');
  row?.classList.remove('has-error');
  row?.querySelector('.shortcut-error')?.remove();
}

/** Bind the single keydown handler to a document (re-bound when floating). */
function bindKeys(doc: Document) {
  keyDocument.removeEventListener('keydown', onKeyDown, true);
  keyDocument = doc;
  doc.addEventListener('keydown', onKeyDown, true);
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
}

function onKeyDown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  const pressed = comboFromKeys(e, platform);

  // Recorder: capture the next real key.
  if (recordingAction && recordingBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (!pressed) return; // still holding modifiers
    const action = recordingAction;
    const btn = recordingBtn;
    if (pressed.key === 'Escape' && !pressed.mod && !pressed.alt && !pressed.shift) {
      cancelRecording();
      return;
    }
    if (pressed.key === 'Backspace' && !pressed.mod && !pressed.alt && !pressed.shift) {
      commitRecording(action, null);
      return;
    }
    const text = serializeCombo(pressed);
    const check =
      recordingGroup === 'page'
        ? validatePageCombo(text, action as PageAction, pageShortcuts, panelShortcuts)
        : validateCombo(text, action as PanelAction, panelShortcuts, pageShortcuts);
    if (!check.ok) {
      showShortcutError(btn, check.reason ?? 'That shortcut cannot be used.');
      renderCaps(btn, [], 'Press keys…');
      return;
    }
    commitRecording(action, text);
    return;
  }

  if (!pressed) return;
  const action = actionForCombo(panelShortcuts, pressed);
  if (action) {
    if (comboIsBareKey(pressed) && isEditable(e.target)) return;
    if (runAction(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }

  // Page shortcuts pressed while the finder itself is focused. The page
  // listener never sees these keys here, so forward them ourselves.
  const pageAction = pageActionForCombo(pageShortcuts, pressed);
  if (pageAction && runPageAction(pageAction)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** A page shortcut inside the finder. Returns false when it means nothing here. */
function runPageAction(action: PageAction): boolean {
  if (runningInHelper) return false;
  switch (action) {
    case 'open-finder':
      if (runningInOverlay) {
        try {
          window.parent.postMessage({ type: 'kicad-overlay-close' }, '*');
        } catch {
          /* not framed */
        }
        return true;
      }
      // The worker decides: it knows whether we are a side panel, a window, or a tab.
      chrome.runtime
        .sendMessage({ type: 'PAGE_COMMAND', name: 'open-finder', windowId: myWindowId ?? undefined })
        .catch(() => {});
      return true;
    case 'install-current':
      return runAction('install');
    case 'search-selection':
      return false; // nothing highlighted inside the finder
  }
}

/** Run a panel action. Returns false when nothing sensible could happen. */
function runAction(action: PanelAction): boolean {
  switch (action) {
    case 'focusSearch':
      searchInput.focus();
      searchInput.select();
      return true;
    case 'install':
      if (installBtn.disabled || partCard.classList.contains('hidden')) return false;
      void onInstall();
      return true;
    case 'previewSymbol':
    case 'previewFootprint':
    case 'preview3d':
      if (partCard.classList.contains('hidden')) return false;
      preview?.activate(action === 'previewSymbol' ? 'symbol' : action === 'previewFootprint' ? 'footprint' : '3d');
      return true;
    case 'toggleSettings':
      toggleSettings();
      return true;
    case 'dismiss':
      return dismiss();
  }
}

/** Escape: close what's on top, in order of how transient it is. */
function dismiss(): boolean {
  if (!detectedOffer.classList.contains('hidden')) {
    hideOffer();
    return true;
  }
  if (!settingsPanel.classList.contains('hidden')) {
    toggleSettings(false);
    return true;
  }
  if (searchInFlight) {
    searchSeq++;
    endSearch();
    setStatus(searchStatus, 'Search cancelled.', 'info');
    return true;
  }
  if (runningInOverlay) {
    try {
      window.parent.postMessage({ type: 'kicad-overlay-close' }, '*');
    } catch {
      /* not framed */
    }
    return true;
  }
  if (searchInput.value) {
    setSearchValue('');
    searchInput.focus();
    return true;
  }
  if (runningInWindow && !runningInHelper) {
    window.close();
    return true;
  }
  return false;
}

// --- Library folder ------------------------------------------------------------------

/** Look at the saved handle without prompting; pick up a live grant if there is one. */
async function refreshFolderState() {
  try {
    const { handle, permission } = await peekSavedFolder();
    folderPermission = permission;
    savedHandle = handle;
    savedFolderName = handle?.name ?? '';
    libraryFolder = permission === 'granted' ? handle : null;
  } catch {
    folderPermission = 'none';
    savedHandle = null;
    libraryFolder = null;
  }
}

/** Record a freshly granted handle and refresh everything that depends on it. */
async function adoptFolder(handle: FileSystemDirectoryHandle) {
  libraryFolder = handle;
  savedHandle = handle;
  folderPermission = 'granted';
  savedFolderName = handle.name;
  rearmInstallButton();
  hide(searchStatus);
  refreshReadiness();
  try {
    await chrome.storage.local.set({ [OVERLAY_LIB_KEY]: handle.name });
  } catch {
    /* overlay just won't auto-reflect the folder */
  }
  // Tell every other finder document (the floating window, say) so it can
  // re-check the handle: Chrome shares the grant across pages of one origin
  // while any of them stays open.
  try {
    await chrome.runtime.sendMessage({ type: 'FOLDER_GRANTED', name: handle.name });
  } catch {
    /* no other finder document is open */
  }
  if (runningInGrantTab) {
    setupPinned = false;
    refreshReadiness();
    setStatus(searchStatus, `“${handle.name}” granted. Go back to the floating window; you can close this tab.`, 'success');
  }
  if (runningInHelper) {
    const closed = afterGrantInHelper(handle);
    if (!closed && autoInstallLcsc && current) {
      await onInstall();
      await finishInstallHelper();
    }
  }
}

/** Open the finder in a normal browser tab, where the folder picker always works. */
function openFinderInTab() {
  const base = chrome.runtime.getURL('src/sidepanel/index.html');
  const url = `${base}?grant=1${sourceTabId !== null ? `&tab=${sourceTabId}` : ''}`;
  void chrome.tabs.create({ url }).catch(() => {
    setStatus(searchStatus, 'Could not open a tab. Open the finder from the toolbar in a normal window.', 'error');
  });
}

/**
 * `pill`: one click re-allows a lapsed grant (the permission prompt is the
 * first thing that runs, so it keeps the click's user gesture). `pick`: always
 * open the folder picker. If the browser shows neither, offer a normal tab.
 */
async function onLibraryAction(mode: 'pill' | 'pick') {
  if (runningInOverlay) {
    if (pickFolderInFlight) return;
    pickFolderInFlight = true;
    libPill.disabled = true;
    setStatus(searchStatus, 'A small window is opening so you can grant your library folder…', 'info');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'OVERLAY_PICK_FOLDER' });
      if (!resp?.ok) throw new Error(resp?.error || 'Could not open the window.');
    } catch (err) {
      pickFolderInFlight = false;
      libPill.disabled = false;
      setStatus(searchStatus, err instanceof Error ? err.message : 'Could not open the folder window.', 'error');
    }
    return;
  }

  // One click to re-allow the saved folder. No await may come before the
  // permission request, or the click's gesture is spent and Chrome refuses.
  if (mode === 'pill' && folderPermission === 'prompt' && savedHandle) {
    // If no permission bubble appears (Arc's popup window), say so instead of
    // looking dead. The request itself is still allowed to finish later.
    const silent = setTimeout(() => {
      setStatus(
        searchStatus,
        'No permission prompt? This window may not show one. Choose the folder in a tab instead.',
        'info',
        '',
        { label: 'Open in a tab', run: openFinderInTab },
      );
    }, PICKER_SILENCE_MS);
    const ok = await requestFolderPermission(savedHandle);
    clearTimeout(silent);
    if (ok) {
      await adoptFolder(savedHandle);
      return;
    }
    // No prompt appeared, or it was declined. Give the guaranteed path.
    setupPinned = true;
    refreshReadiness();
    setStatus(
      searchStatus,
      `Chrome did not re-allow “${savedFolderName}”. Choose the folder again below.`,
      'error',
      '',
      { label: 'Open in a tab', run: openFinderInTab },
    );
    chooseFolderBtn.focus();
    return;
  }

  const silent = setTimeout(() => {
    setStatus(
      searchStatus,
      'No folder dialog? This window may not show one. Choose the folder in a tab instead.',
      'info',
      '',
      { label: 'Open in a tab', run: openFinderInTab },
    );
  }, PICKER_SILENCE_MS);
  try {
    const handle = await pickLibraryFolder();
    clearTimeout(silent);
    await adoptFolder(handle);
  } catch (err) {
    clearTimeout(silent);
    if (err instanceof DOMException && err.name === 'AbortError') {
      hide(searchStatus);
      return;
    }
    const msg = err instanceof Error ? err.message : '';
    const noPicker =
      (err instanceof DOMException && (err.name === 'SecurityError' || err.name === 'NotAllowedError')) ||
      /gesture|not allowed|unavailable/i.test(msg);
    if (noPicker) {
      setStatus(
        searchStatus,
        'This window cannot open the folder picker. Open the finder in a normal tab and choose the folder there.',
        'error',
        msg,
        { label: 'Open in a tab', run: openFinderInTab },
      );
      return;
    }
    setStatus(searchStatus, msg || 'Could not open the folder.', 'error');
  }
}

// --- Relay URL ------------------------------------------------------------------------

/**
 * Persist the relay URL as the user types. The field being typed in is left
 * alone (rewriting it jumps the caret); the mirror field and storage get the
 * normalized value. An invalid value shows an inline note and is not saved.
 */
async function onRelayUrlChange(source: HTMLInputElement) {
  const { url, error } = normalizeRelayUrl(source.value);
  const note = source === relayUrlInput ? relayNote : relayNoteSetup;
  source.classList.toggle('is-invalid', Boolean(error));
  if (error) {
    setNote(note, error, 'error');
    return;
  }
  setNote(note, '', '');
  relayUrl = url;
  const mirror = source === relayUrlInput ? relayUrlInputSetup : relayUrlInput;
  if (mirror.value !== relayUrl) mirror.value = relayUrl;
  refreshReadiness();
  try {
    await chrome.storage.local.set({ relayUrl });
  } catch {
    /* keep in memory */
  }
}

function normalizeRelayInput(input: HTMLInputElement) {
  const { url, error } = normalizeRelayUrl(input.value);
  if (!error && input.value !== url) input.value = url;
}

/**
 * GET the relay root and report in one line what to do next. Tests what is in
 * the field right now (not the last saved URL); a working address is saved.
 */
async function testRelay(note: HTMLElement, input: HTMLInputElement) {
  const { url, error } = normalizeRelayUrl(input.value);
  if (error || !url) {
    setNote(note, error ?? 'Paste your relay URL first.', 'error');
    return;
  }
  if (url !== relayUrl) await onRelayUrlChange(input);
  setNote(note, 'Checking…', 'checking');
  try {
    const resp = await fetch(`${url}/`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    const body = await resp.text();
    const health = interpretRelayHealth(resp.status, body);
    if (health.ok) setNote(note, 'Relay reachable. You can search now.', 'ok');
    else setNote(note, health.detail, 'error');
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    setNote(note, timedOut ? 'No answer in 8 seconds. Check the address and your connection.' : 'Could not reach that address. Check it and your connection.', 'error');
  }
}

function setNote(el: HTMLElement, text: string, kind: '' | 'ok' | 'error' | 'checking') {
  el.textContent = text;
  el.className = `field-note${kind ? ` is-${kind}` : ''}`;
}

function hasRelay(): boolean {
  return relayUrl.length > 0;
}
function hasFolder(): boolean {
  return runningInOverlay ? overlayLibraryName.length > 0 : libraryFolder !== null;
}
function folderName(): string {
  return runningInOverlay ? overlayLibraryName : (libraryFolder?.name ?? savedFolderName);
}
function isReady(): boolean {
  return hasRelay() && hasFolder();
}

function openSetupFocusRelay() {
  setupPinned = true;
  refreshReadiness();
  relayUrlInputSetup.focus();
}

/** Single source of truth for "what's set up". */
function refreshReadiness() {
  // Library pill.
  libPill.classList.remove('is-ready', 'is-missing');
  if (hasFolder()) {
    libPill.classList.add('is-ready');
    setText(libPillValue, folderName());
    libPill.title = `Library folder: ${folderName()}. Click to change.`;
  } else if (!runningInOverlay && folderPermission === 'prompt') {
    libPill.classList.add('is-missing');
    setText(libPillValue, 'Reconnect folder');
    libPill.title = `Chrome needs one click to re-allow “${savedFolderName}”.`;
  } else {
    libPill.classList.add('is-missing');
    setText(libPillValue, 'Choose folder');
    libPill.title = 'Choose your KiCad library folder';
  }

  // Relay pill.
  relayPill.classList.remove('is-ready', 'is-missing');
  if (hasRelay()) {
    relayPill.classList.add('is-ready');
    setText(relayPillValue, prettyRelay(relayUrl));
    relayPill.title = `Relay: ${relayUrl}. Click to edit.`;
  } else {
    relayPill.classList.add('is-missing');
    setText(relayPillValue, 'Add relay URL');
    relayPill.title = 'Add your relay URL';
  }

  // Setup view: first run, something missing, or pinned while editing. Never
  // over a result card, and never duplicated under an open Settings panel.
  const cardShowing = !partCard.classList.contains('hidden');
  const settingsOpen = !settingsPanel.classList.contains('hidden');
  const showSetup = setupPinned || (!isReady() && !cardShowing && !settingsOpen);
  setupView.classList.toggle('hidden', !showSetup);
  setupStepLib.classList.toggle('is-done', hasFolder());
  setupStepRelay.classList.toggle('is-done', hasRelay());
  setupDoneBtn.classList.toggle('hidden', !(setupPinned && isReady()));

  // Search needs only the relay.
  const blocked = !hasRelay();
  searchBtn.disabled = blocked || searchInFlight;
  searchField.classList.toggle('is-disabled', blocked);
  if (blocked) {
    setText(searchHint, 'Add your relay URL to start searching.');
    show(searchHint);
  } else if (!hasFolder()) {
    setText(searchHint, folderPermission === 'prompt' && !runningInOverlay
      ? 'Search and preview work now. Click “Reconnect folder” before installing.'
      : 'Search and preview work now. Choose a library folder to install.');
    show(searchHint);
  } else {
    hide(searchHint);
  }

  refreshInstallEnabled();
}

// --- Search / convert -------------------------------------------------------------------
const LCSC_RE = /^C\d+$/i;

function beginSearch(): number {
  searchInFlight = true;
  searchBtn.disabled = true;
  searchBtn.classList.add('is-busy');
  searchBtn.textContent = 'Searching…';
  return ++searchSeq;
}
function endSearch() {
  searchInFlight = false;
  searchBtn.classList.remove('is-busy');
  searchBtn.textContent = 'Search';
  searchBtn.disabled = !hasRelay();
}
function stale(seq: number): boolean {
  return seq !== searchSeq;
}

async function runSearch(rawQuery: string) {
  const query = rawQuery.trim();
  searchDirty = false;
  hideOffer();
  hide(candidateSection);
  hide(partCard);
  hide(secondarySources);
  preview?.reset();
  current = null;
  currentMatch = null;
  candidates = [];
  setupPinned = false;

  if (!hasRelay()) {
    refreshReadiness();
    setStatus(searchStatus, 'Add your relay URL first.', 'error');
    return;
  }
  if (!query) {
    setStatus(searchStatus, 'Enter an LCSC number (like C3235557) or a part number.', 'error');
    return;
  }

  const seq = beginSearch();
  try {
    if (LCSC_RE.test(query)) {
      await convertAndShow(query.toUpperCase(), null, undefined, seq);
      return;
    }

    setStatus(searchStatus, `Looking up ${query} on JLCPCB…`, 'loading');
    let matches: JlcMatch[] = [];
    let relaxed = false;
    let matchedQuery = '';
    let diagnostic = 'no response';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'RESOLVE_MPN', mpn: query });
      if (resp?.ok) {
        matches = Array.isArray(resp.matches) ? (resp.matches as JlcMatch[]) : [];
        relaxed = Boolean(resp.relaxed);
        matchedQuery = (resp.matchedQuery as string) || '';
        diagnostic = (resp.diagnostic as string) || 'no diagnostic';
      } else if (resp?.error) {
        diagnostic = `worker error: ${resp.error}`;
      }
    } catch (err) {
      diagnostic = `message failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (stale(seq)) return;

    if (matches.length === 0) {
      const friendly = explainSearchFailure(diagnostic, query);
      setStatus(searchStatus, friendly.text, 'error', friendly.detail, friendly.action);
      showSecondarySources(query);
      return;
    }

    const note = relaxed ? `No exact match for ${query}. Showing the closest results for ${matchedQuery}.` : undefined;
    candidates = matches;
    if (matches.length > 1) renderCandidates(matches, matches[0].lcscId);
    await convertAndShow(matches[0].lcscId, matches[0], note, seq);
  } finally {
    if (!stale(seq)) endSearch();
  }
}

/** Turn a wire-level diagnostic into what to do next. */
function explainSearchFailure(diagnostic: string, query: string): { text: string; detail: string; action?: { label: string; run: () => void } } {
  const testAction = { label: 'Test relay', run: () => { toggleSettings(true); void testRelay(relayNote, relayUrlInput); } };
  if (/^worker error: relay URL not set/.test(diagnostic)) {
    return { text: 'Add your relay URL first.', detail: '' };
  }
  if (/fetch threw|message failed|timed out/.test(diagnostic)) {
    return { text: 'Could not reach your relay. Check the Relay URL in Settings.', detail: diagnostic, action: testAction };
  }
  if (/non-JSON/.test(diagnostic)) {
    return { text: 'Your relay answered with a web page instead of data. The URL is probably missing /api.', detail: diagnostic, action: testAction };
  }
  const m = diagnostic.match(/^http (\d+)(?:, (\d+) results)?/);
  if (m && m[2] === undefined) {
    const status = Number(m[1]);
    if (status === 403 || status === 429) {
      return { text: 'JLCPCB refused the request for now. Wait a minute, or paste the exact LCSC number (C…).', detail: diagnostic };
    }
    return { text: `Your relay returned HTTP ${status}. Check its logs or redeploy it.`, detail: diagnostic, action: testAction };
  }
  return { text: `No JLCPCB part matches “${query}”. Try the exact LCSC number (C…) or one of the sources below.`, detail: '' };
}

function renderCandidates(matches: JlcMatch[], selectedId: string) {
  candidateList.textContent = '';
  for (const m of matches) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'candidate';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(m.lcscId === selectedId));
    row.dataset.lcsc = m.lcscId;

    const mpn = document.createElement('span');
    mpn.className = 'candidate-mpn';
    mpn.textContent = m.mpn;
    if (m.mpn.toLowerCase() === searchInput.value.trim().toLowerCase()) {
      const exact = document.createElement('span');
      exact.className = 'candidate-exact';
      exact.textContent = 'exact';
      mpn.appendChild(exact);
    }
    const meta = document.createElement('span');
    meta.className = 'candidate-meta';
    meta.textContent = [m.package || '—', m.lcscId].join(' · ');
    const stock = document.createElement('span');
    stock.className = `candidate-stock${m.stock <= 0 ? ' is-none' : m.stock < 100 ? ' is-low' : ''}`;
    stock.textContent = m.stock > 0 ? `${m.stock.toLocaleString()} in stock${m.price !== null ? ` · ${formatPrice(m.price)}` : ''}` : 'No stock';

    row.appendChild(mpn);
    row.appendChild(stock);
    row.appendChild(meta);
    row.addEventListener('click', () => {
      for (const el of candidateList.querySelectorAll('.candidate')) el.setAttribute('aria-selected', String(el === row));
      const seq = beginSearch();
      void convertAndShow(m.lcscId, m, undefined, seq).finally(() => {
        if (!stale(seq)) endSearch();
      });
    });
    candidateList.appendChild(row);
  }
  show(candidateSection);
}

async function convertAndShow(lcscId: string, match: JlcMatch | null, note: string | undefined, seq: number) {
  setStatus(searchStatus, `Fetching and converting ${lcscId}…`, 'loading');
  hide(partCard);
  preview?.reset();

  let result: ConvertResult;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CONVERT', lcscId });
    if (!resp?.ok) throw new Error(resp?.error || 'Conversion failed.');
    result = resp.result as ConvertResult;
  } catch (err) {
    if (stale(seq)) return;
    const msg = err instanceof Error ? err.message : 'Conversion failed.';
    setStatus(searchStatus, msg === 'relay URL not set' ? 'Add your relay URL first.' : msg, 'error');
    showSecondarySources(match?.mpn || lcscId);
    return;
  }
  if (stale(seq)) return;

  current = result;
  currentMatch = match;
  if (note) setStatus(searchStatus, note, 'info');
  else setStatus(searchStatus, `Loaded ${result.meta.mpn || lcscId}.`, 'success');
  showCard(result, match);
  showSecondarySources(result.meta.mpn || lcscId);

  // A direct C-number search skips JLCPCB; fetch stock/price in the background.
  if (!match) void fillStockBadge(lcscId, seq);
}

async function fillStockBadge(lcscId: string, seq: number) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'RESOLVE_MPN', mpn: lcscId });
    if (stale(seq) || !resp?.ok) return;
    const hit = (resp.matches as JlcMatch[]).find((m) => m.lcscId === lcscId);
    if (hit) {
      currentMatch = hit;
      renderStockBadge(hit);
      if (!current?.meta.package && hit.package) fieldPackage.value = hit.package;
    }
  } catch {
    /* badge stays hidden */
  }
}

// --- Card ---------------------------------------------------------------------------------

function showCard(result: ConvertResult, match: JlcMatch | null) {
  const meta = result.meta;
  const lcsc = meta.lcsc || match?.lcscId || '';
  setText(cardLcsc, lcsc || 'C—');
  if (lcsc) cardLcsc.href = `https://www.lcsc.com/product-detail/${encodeURIComponent(lcsc)}.html`;
  else cardLcsc.removeAttribute('href');
  setText(cardMpn, meta.mpn || '(unknown MPN)');

  const manufacturer = meta.manufacturer || '';
  const pkg = meta.package || match?.package || '';
  renderCardSub(manufacturer, pkg);
  renderStockBadge(match);

  fieldMpn.value = meta.mpn || '';
  fieldManufacturer.value = manufacturer;
  fieldPackage.value = pkg;
  fieldDatasheet.value = meta.datasheet || '';

  toggleFlag(flagMpn, fieldMpn, !meta.mpn);
  toggleFlag(flagDatasheet, fieldDatasheet, !meta.datasheet);
  fieldMpn.oninput = () => toggleFlag(flagMpn, fieldMpn, !fieldMpn.value.trim());
  fieldDatasheet.oninput = () => {
    toggleFlag(flagDatasheet, fieldDatasheet, !fieldDatasheet.value.trim());
    updateDatasheetLink();
  };
  updateDatasheetLink();

  const category = match?.category || meta.package || '';
  bucketSelect.value = categoryToBucket(category);
  updateDestPath();

  setAssetState(symbolAvail, /\(pin\s/.test(result.symbol) ? 'Ready' : 'No pins', /\(pin\s/.test(result.symbol));
  setAssetState(footprintAvail, /\(pad\s/.test(result.footprint) ? 'Ready' : 'No pads', /\(pad\s/.test(result.footprint));
  setAssetState(model3dAvail, result.model3dUrl ? 'STEP' : 'None', !!result.model3dUrl);

  preview?.setResult(result, relayUrl);

  hide(installStatus);
  hide(successPanel);
  hide(closeHelperBtn);
  writtenList.textContent = '';
  setInstallButton('idle');
  show(partCard);
  refreshReadiness();
}

function renderCardSub(manufacturer: string, pkg: string) {
  cardSub.textContent = '';
  const parts = [manufacturer, pkg].filter(Boolean);
  if (!parts.length) {
    hide(cardSub);
    return;
  }
  parts.forEach((text, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      cardSub.appendChild(sep);
    }
    const span = document.createElement('span');
    span.textContent = text;
    if (text === pkg && pkg) span.className = 'mono';
    cardSub.appendChild(span);
  });
  show(cardSub);
}

function renderStockBadge(match: JlcMatch | null) {
  if (!match) {
    hide(stockBadge);
    return;
  }
  const stock = match.stock || 0;
  const tone = stock <= 0 ? 'no-stock' : stock < 100 ? 'low-stock' : 'in-stock';
  stockBadge.className = `stock-badge ${tone}`;
  stockBadge.textContent = '';
  const stockText = document.createElement('span');
  stockText.textContent = stock > 0 ? `${stock.toLocaleString()} in stock` : match.price === null ? 'Stock unknown' : 'No stock';
  stockBadge.appendChild(stockText);
  if (match.price !== null) {
    const price = document.createElement('span');
    price.className = 'badge-price';
    price.textContent = formatPrice(match.price);
    stockBadge.appendChild(price);
  }
  show(stockBadge);
}

function formatPrice(price: number): string {
  return `$${price.toFixed(price < 1 ? 4 : 2)}`;
}

function updateDatasheetLink() {
  const url = safeHttpUrl(fieldDatasheet.value);
  if (url) {
    datasheetLink.href = url;
    show(datasheetLink);
  } else {
    datasheetLink.removeAttribute('href');
    hide(datasheetLink);
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function updateDestPath() {
  const lib = bucketLabel(bucketSelect.value);
  setText(destPath, `symbols/${lib}.kicad_sym · footprints/${lib}.pretty/`);
}

// --- Install --------------------------------------------------------------------------------

type InstallButtonState = 'idle' | 'busy' | 'done' | 'error' | 'partial';
function setInstallButton(state: InstallButtonState, label?: string) {
  installBtn.className = `btn btn-primary${state === 'idle' ? '' : ` is-${state}`}`;
  setText(installBtnText, label ?? (state === 'busy' ? 'Installing…' : 'Install to KiCad'));
  installBtn.disabled = state === 'busy' || state === 'done';
  if (state === 'idle' || state === 'error' || state === 'partial') refreshInstallEnabled();
}

/** After a change that makes re-installing meaningful (bucket / folder), leave the done state. */
function rearmInstallButton() {
  if (installBtn.classList.contains('is-done') || installBtn.classList.contains('is-partial')) {
    setInstallButton('idle');
    hide(successPanel);
    hide(installStatus);
  }
}

async function onInstall() {
  if (!current || !hasRelay() || installInFlight) return;
  if (detectDebounce) {
    clearTimeout(detectDebounce);
    detectDebounce = null;
  }
  const bucket = bucketSelect.value as LibraryChoice;

  if (runningInOverlay) {
    const lcscId = current.meta.lcsc;
    if (!lcscId) {
      failInstall('Missing LCSC id. Run the search again.');
      return;
    }
    setInstallButton('busy', 'Installing in a separate window…');
    hide(successPanel);
    setStatus(installStatus, 'A small window is writing the files. It closes by itself.', 'loading');
    installInFlight = true;
    clearOverlayWatchdog();
    overlayInstallWatchdog = setTimeout(() => {
      if (!installInFlight) return;
      installInFlight = false;
      markOverlayInstallFailed(false, 'No answer from the install window. Try again.');
    }, OVERLAY_INSTALL_WATCHDOG_MS);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'OVERLAY_INSTALL', lcscId, bucket });
      if (!resp?.ok) throw new Error(resp?.error || 'Could not open the install window.');
    } catch (err) {
      clearOverlayWatchdog();
      installInFlight = false;
      failInstall(err instanceof Error ? err.message : 'Could not open the install window.');
    }
    return;
  }

  if (!libraryFolder) {
    refreshInstallEnabled();
    return;
  }

  setInstallButton('busy');
  hide(installStatus);
  hide(successPanel);

  const mpn = fieldMpn.value.trim() || current.meta.mpn;
  const partName = mpn || current.meta.lcsc || 'part';
  const installInput = {
    bucket,
    symbol: current.symbol,
    footprint: current.footprint,
    model3dUrl: current.model3dUrl,
    meta: {
      ...current.meta,
      mpn,
      manufacturer: fieldManufacturer.value.trim(),
      package: fieldPackage.value.trim(),
      datasheet: fieldDatasheet.value.trim(),
    },
  };

  installInFlight = true;
  let res: InstallPartResult;
  try {
    res = await installPart(libraryFolder, installInput, relayUrl);
  } catch (err) {
    failInstall(err instanceof Error ? err.message : 'Install failed.');
    return;
  } finally {
    installInFlight = false;
  }

  const lib = bucketLabel(bucket);
  renderWritten(res.written);
  successPanel.classList.toggle('is-partial', !res.ok);
  restartNote.classList.toggle('hidden', !(res.ok && res.libraryCreated));
  reloadNote.classList.toggle('hidden', !(res.ok && !res.libraryCreated));

  if (res.ok) {
    setInstallButton('done', `Installed ${truncate(partName, 22)} → ${lib}`);
    const files = res.written.filter((w) => !w.includes('(deduped)')).length;
    const summary = res.symbolAdded
      ? `Installed into ${lib}. ${files} file${files === 1 ? '' : 's'} written.`
      : `${partName} was already in ${lib}. Footprint refreshed.`;
    const model = res.modelStatus && res.modelStatus !== 'ok' ? ` 3D model ${res.modelStatus}.` : '';
    setStatus(installStatus, summary + model, 'success');
    show(successPanel);
    installAnotherBtn.focus();
  } else {
    setInstallButton(res.written.length ? 'partial' : 'error', res.written.length ? 'Partly installed. Retry' : 'Install failed. Retry');
    setStatus(installStatus, res.written.length ? `Some files were not written: ${res.errors.join('; ')}` : res.errors.join('; ') || 'Install failed.', 'error');
    if (res.written.length) show(successPanel);
  }
}

function bucketLabel(bucket: string): string {
  return bucket === 'KiCadPartFinder' ? 'KiCadPartFinder' : `DavidLib_${bucket}`;
}

function failInstall(msg: string) {
  setInstallButton('error', 'Install failed. Retry');
  setStatus(installStatus, msg, 'error');
}

function renderWritten(paths: string[]) {
  writtenList.textContent = '';
  for (const p of paths) {
    const li = document.createElement('li');
    li.textContent = p;
    writtenList.appendChild(li);
  }
}

function resetForAnother() {
  searchSeq++;
  current = null;
  currentMatch = null;
  candidates = [];
  preview?.reset();
  hide(partCard);
  hide(candidateSection);
  hide(secondarySources);
  hide(successPanel);
  hide(installStatus);
  hide(searchStatus);
  successPanel.classList.remove('is-partial');
  setInstallButton('idle');
  setSearchValue('');
  searchInput.focus();
  refreshReadiness();
}

// --- Secondary sources ---------------------------------------------------------------------

function showSecondarySources(mpn: string) {
  sourceLinks.textContent = '';
  for (const link of getSecondarySourceLinks(mpn)) sourceLinks.appendChild(createSourceLink(link));
  show(secondarySources);
}

function createSourceLink(link: { name: string; url: string; description: string }): HTMLElement {
  const a = document.createElement('a');
  a.className = 'source-link';
  a.href = link.url;
  a.target = '_blank';
  a.rel = 'noopener';
  const info = document.createElement('div');
  info.className = 'source-link-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'source-link-name';
  nameEl.textContent = link.name;
  const descEl = document.createElement('div');
  descEl.className = 'source-link-desc';
  descEl.textContent = link.description;
  info.appendChild(nameEl);
  info.appendChild(descEl);
  const arrow = document.createElement('span');
  arrow.className = 'source-link-arrow';
  arrow.textContent = '→';
  a.appendChild(info);
  a.appendChild(arrow);
  return a;
}

// --- Small helpers ----------------------------------------------------------------------------

function refreshInstallEnabled() {
  if (installBtn.classList.contains('is-done') || installBtn.classList.contains('is-busy')) return;
  installBtn.disabled = !(hasFolder() && current && hasRelay());
  installBtn.title = !hasRelay()
    ? 'Add your relay URL first.'
    : hasFolder()
      ? ''
      : folderPermission === 'prompt' && !runningInOverlay
        ? 'Click “Reconnect folder” first.'
        : 'Choose a library folder first.';
}

function toggleFlag(flag: HTMLElement, input: HTMLInputElement, missing: boolean) {
  flag.classList.toggle('hidden', !missing);
  input.classList.toggle('needs-confirm', missing);
}

function setAssetState(element: HTMLElement, label: string, available: boolean) {
  const stateEl = element.querySelector('.asset-state')!;
  stateEl.textContent = label;
  element.classList.toggle('is-ready', available);
  element.classList.toggle('is-off', !available);
}

type StatusKind = 'success' | 'error' | 'loading' | 'info';
function setStatus(
  el: HTMLElement,
  msg: string,
  kind: StatusKind,
  detail = '',
  action?: { label: string; run: () => void },
) {
  el.textContent = '';
  el.className = `status ${kind}`;
  el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn status-action';
    btn.textContent = action.label;
    btn.addEventListener('click', action.run);
    el.appendChild(btn);
  }
  if (detail) {
    const d = document.createElement('span');
    d.className = 'status-detail';
    d.textContent = detail;
    el.appendChild(d);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function setText(el: Element | null, text: string) {
  if (el) el.textContent = text;
}
function show(el: HTMLElement) {
  el.classList.remove('hidden');
}
function hide(el: HTMLElement) {
  el.classList.add('hidden');
}

void init();
