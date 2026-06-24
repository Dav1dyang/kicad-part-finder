/**
 * Side panel UI — self-contained (no companion server).
 *
 * One calm surface with three states:
 *   • Readiness strip (always visible): Library + Relay status pills. Click to
 *     change. The full Setup view only takes over on first run / when something
 *     is missing; the relay URL field lives in a settings disclosure (gear).
 *   • Search: a prominent LCSC#/MPN input (auto-filled from a detected part),
 *     disabled with a hint until both library + relay are ready.
 *   • Result card → Install: MPN headline, a stock/price badge (from JLCPCB),
 *     editable metadata with empty/uncertain fields flagged amber, an auto-
 *     selected destination bucket, then a confident Install → loading → success
 *     state listing the written files, with "Install another" to reset.
 *
 * Data flow is unchanged from before:
 *   relayUrl (chrome.storage.local) → service worker → relay → JLCPCB/EasyEDA.
 *   Install writes symbol/footprint/STEP via the File System Access API.
 *
 * "Float on top" (Document Picture-in-Picture, see ./float.ts) moves the whole
 * `#app` node into an always-on-top window and back; it's feature-detected and
 * only offered where it can actually work.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';
import type { ConvertResult } from '../lib/converter/easyeda.js';
import type { JlcMatch } from '../lib/jlcpcb.js';
import { LIBRARY_CHOICES, categoryToBucket, type LibraryChoice } from '../lib/autosort.js';
import {
  getSavedFolder,
  pickLibraryFolder,
  installPart,
  type InstallPartResult,
} from '../lib/library-writer.js';
import { getSecondarySourceLinks } from '../lib/mpn-sources.js';
import { parseSourceTabId, isWindowMode } from './source-tab.js';
import {
  isOverlayMode,
  isSetupMode,
  parseInstallLcsc,
  parseBucket,
} from '../content/overlay-params.js';
import { isPipSupported, floatOnTop, type FloatHandle } from './float.js';
import { createPreviewController, type PreviewController } from './preview-controller.js';

// --- DOM ---------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $('app');

// Top bar
const floatBtn = $<HTMLButtonElement>('floatBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsPanel = $('settingsPanel');
const floatingNote = $('floatingNote');
const windowNote = $('windowNote');

// Settings — open mode (3-way segmented selector: auto / window / overlay)
const openModeSelector = $('openModeSelector');
const windowModeNote = $('windowModeNote');

// Readiness strip
const libPill = $<HTMLButtonElement>('libPill');
const libPillValue = $('libPillValue');
const relayPill = $<HTMLButtonElement>('relayPill');
const relayPillValue = $('relayPillValue');

// Setup view
const setupView = $('setupView');
const setupStepLib = $('setupStepLib');
const setupStepRelay = $('setupStepRelay');
const chooseFolderBtn = $<HTMLButtonElement>('chooseFolderBtn');
const relayUrlInputSetup = $<HTMLInputElement>('relayUrlInputSetup');

// Settings
const relayUrlInput = $<HTMLInputElement>('relayUrlInput');

// Search
const searchInput = $<HTMLInputElement>('searchInput');
const searchField = document.querySelector('.search-field') as HTMLElement;
const searchBtn = $<HTMLButtonElement>('searchBtn');
const searchHint = $('searchHint');
const searchStatus = $('searchStatus');

// Candidates
const candidateSection = $('candidateSection');
const candidateSelect = $<HTMLSelectElement>('candidateSelect');

// Card
const partCard = $('partCard');
const cardLcsc = $('cardLcsc');
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
const model3dAvail = $('model3dAvail');
const installBtn = $<HTMLButtonElement>('installBtn');
const installStatus = $('installStatus');
const successPanel = $('successPanel');
const writtenList = $<HTMLUListElement>('writtenList');
const installAnotherBtn = $<HTMLButtonElement>('installAnotherBtn');

// Secondary sources
const secondarySources = $('secondarySources');
const sourceLinks = $('sourceLinks');

// --- State -------------------------------------------------------------------
let libraryFolder: FileSystemDirectoryHandle | null = null;
let current: ConvertResult | null = null;
let candidates: JlcMatch[] = [];
// The deployed relay origin (chrome.storage.local `relayUrl`). All search /
// convert / model fetches go through it; empty disables Search + Install.
let relayUrl = '';
// Debounce live highlight-to-search so rapid re-selections don't spam searches.
let detectDebounce: ReturnType<typeof setTimeout> | null = null;
// True while an install is mid-`await` (top-level or delegated). A live
// PART_DETECTED broadcast must not re-run the search then — runSearch nulls
// `current` synchronously, which would make onInstall's post-await deref throw.
let installInFlight = false;
// Overlay iframe only: true while a delegated folder-grant window is open. Guards
// against a second OVERLAY_PICK_FOLDER (double-click on the Library pill) opening
// a duplicate folder picker. Cleared on OVERLAY_FOLDER_READY / OVERLAY_FOLDER_DISMISSED.
let pickFolderInFlight = false;
// Active Document PiP float, if any.
let floatHandle: FloatHandle | null = null;
// True when this document is the standalone floating popup window (URL `&win=1`).
// Document PiP can't be used here, so the Float button is hidden and a tag shown.
const runningInWindow = isWindowMode(location.search);
// True when this document is the finder UI running INSIDE the in-page overlay
// iframe (`?overlay=1`). File System Access is blocked in that cross-origin
// iframe, so folder-pick + install are delegated to a real window via the SW.
const runningInOverlay = isOverlayMode(location.search);
// True when this document is the one-time folder-grant helper window the SW
// opens for the overlay (`?win=1&setup=1`): focus the picker, grant, close.
const runningInSetup = isSetupMode(location.search);
// The LCSC id this auto-install helper window must install (`?win=1&install=…`),
// or null. Set → on load, auto-convert + install against the saved folder, then
// close (no extra click when the folder grant is valid).
const autoInstallLcsc = parseInstallLcsc(location.search);
// chrome.storage.local key recording that the overlay's library folder is
// granted (the overlay iframe can't hold the FS handle, so it tracks readiness
// + the folder name here; the real handle lives in the helper windows' IndexedDB).
const OVERLAY_LIB_KEY = 'overlayLibraryName';
// Mirror of OVERLAY_LIB_KEY for the overlay iframe (which has no real handle).
let overlayLibraryName = '';
// Symbol/Footprint/3D preview block in the result card (lazy per-tab render).
let preview: PreviewController | null = null;

// --- Init --------------------------------------------------------------------
async function init() {
  // Populate the destination bucket dropdown once.
  for (const choice of LIBRARY_CHOICES) {
    const opt = document.createElement('option');
    opt.value = choice;
    opt.textContent =
      choice === 'KiCadPartFinder' ? 'KiCadPartFinder (catch-all)' : `DavidLib_${choice}`;
    bucketSelect.appendChild(opt);
  }

  // --- Readiness strip + setup wiring ---
  libPill.addEventListener('click', onLibraryAction);
  chooseFolderBtn.addEventListener('click', onLibraryAction);
  relayPill.addEventListener('click', () => {
    // If the relay isn't set, open the inline setup; otherwise reveal settings.
    if (!hasRelay()) openSetupFocusRelay();
    else toggleSettings(true);
  });

  // --- Settings disclosure ---
  settingsBtn.addEventListener('click', () => toggleSettings());
  // Keep the two relay inputs (settings + setup) mirrored and persisted. Persist
  // live on input (without rewriting the field being typed in — that jumps the
  // caret + strips trailing spaces mid-type); normalize the displayed value on blur.
  relayUrlInput.addEventListener('input', () => void onRelayUrlChange(relayUrlInput.value, relayUrlInput));
  relayUrlInputSetup.addEventListener('input', () => void onRelayUrlChange(relayUrlInputSetup.value, relayUrlInputSetup));
  relayUrlInput.addEventListener('blur', () => normalizeRelayInput(relayUrlInput));
  relayUrlInputSetup.addEventListener('blur', () => normalizeRelayInput(relayUrlInputSetup));
  // Open-mode selector: side panel/tab (auto) · floating window · in-page overlay.
  openModeSelector.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (target?.name === 'openMode') void onOpenModeChange(target.value);
  });

  // --- Search ---
  searchBtn.addEventListener('click', () => void runSearch(searchInput.value.trim()));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSearch(searchInput.value.trim());
  });
  candidateSelect.addEventListener('change', () => {
    const m = candidates[candidateSelect.selectedIndex];
    if (m) void convertAndShow(m.lcscId, m);
  });

  // --- Install ---
  installBtn.addEventListener('click', () => void onInstall());
  installAnotherBtn.addEventListener('click', resetForAnother);

  // --- Previews (Symbol · Footprint · 3D) ---
  preview = createPreviewController(partCard);

  // --- Float on top (Document PiP) ---
  setupFloatButton();

  // Load the saved relay URL + open-mode preference. Until the relay is set,
  // search/convert/install are disabled and the setup view nudges the user.
  try {
    const stored = await chrome.storage.local.get(['relayUrl', 'openMode']);
    relayUrl = typeof stored.relayUrl === 'string' ? stored.relayUrl.trim() : '';
    // Missing/unknown openMode → 'auto' (default). Reflect it in the selector.
    selectOpenMode(normalizeOpenMode(stored.openMode));
  } catch {
    relayUrl = '';
  }
  relayUrlInput.value = relayUrl;
  relayUrlInputSetup.value = relayUrl;

  if (runningInOverlay) {
    // Inside the overlay iframe FS-Access is blocked, so we can't hold the real
    // directory handle. Track readiness via chrome.storage (shared across all
    // extension contexts, unlike the partitioned iframe IndexedDB): the helper
    // windows record the granted folder's name there.
    try {
      const stored = await chrome.storage.local.get(OVERLAY_LIB_KEY);
      overlayLibraryName = typeof stored[OVERLAY_LIB_KEY] === 'string' ? stored[OVERLAY_LIB_KEY] : '';
    } catch {
      overlayLibraryName = '';
    }
  } else {
    // Top-level document (side panel / tab / window / helper): silently restore
    // the saved folder. Chrome requires a user gesture to (re-)grant permission,
    // so if the grant lapsed we leave the pill to prompt.
    try {
      const saved = await getSavedFolder();
      if (saved) libraryFolder = saved;
    } catch {
      /* needs a gesture — user clicks the Library pill / "Choose folder" */
    }
  }

  refreshReadiness();

  // Pre-fill from a detected part (DigiKey/LCSC content script), if any.
  //  - Side-panel mode: no `?tab=` → service worker reads the active tab.
  //  - Tab / popup mode: `?tab=<id>` identifies the originating page.
  const sourceTabId = parseSourceTabId(location.search);
  try {
    const msg =
      sourceTabId === null
        ? { type: 'GET_DETECTED_PART' }
        : { type: 'GET_DETECTED_PART', tabId: sourceTabId };
    const resp = await chrome.runtime.sendMessage(msg);
    const part = resp?.part as DetectedPart | undefined;
    if (part) {
      searchInput.value = part.lcscId || part.mpn || '';
    }
  } catch {
    /* no detected part */
  }

  // React to live detections while the UI is open. A highlighted selection (or
  // any detected part) fills the box AND auto-runs the search — debounced so
  // dragging across text doesn't fire a search per character. Also (overlay
  // iframe only) refresh readiness when a delegated folder-grant / install
  // window finishes.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PART_DETECTED' && message.part) {
      // Helper windows (`?win=1&setup=1` / `&install=`) are single-purpose: they
      // convert + install the part the SW handed them, then close. A live
      // detection from another page must NOT hijack them into searching a
      // different part. Likewise, never auto-search while an install is mid-flight
      // — runSearch nulls `current` synchronously, which would crash onInstall's
      // post-await deref (and re-point a helper at the wrong part).
      if (runningInSetup || autoInstallLcsc || installInFlight) return;
      const part = message.part as DetectedPart;
      const text = part.lcscId || part.mpn || '';
      if (!text) return;
      searchInput.value = text;
      if (detectDebounce) clearTimeout(detectDebounce);
      detectDebounce = setTimeout(() => void runSearch(searchInput.value.trim()), 350);
    } else if (runningInOverlay && message.type === 'OVERLAY_FOLDER_READY') {
      // The delegated folder grant succeeded — clear the in-flight guard + re-
      // enable the Library pill, then refresh readiness from the recorded name.
      pickFolderInFlight = false;
      libPill.disabled = false;
      void refreshOverlayReadiness();
    } else if (runningInOverlay && message.type === 'OVERLAY_FOLDER_DISMISSED') {
      // The grant window closed without granting (cancelled / closed) — re-enable
      // the Library pill so the user can try again.
      pickFolderInFlight = false;
      libPill.disabled = false;
      setStatus(searchStatus, 'Folder not granted — click Library to try again.', 'error');
    } else if (runningInOverlay && message.type === 'OVERLAY_INSTALLED') {
      installInFlight = false;
      void refreshOverlayReadiness();
      markOverlayInstalled();
    } else if (runningInOverlay && message.type === 'OVERLAY_INSTALL_FAILED') {
      // The delegated install ended without success (convert/install failed, the
      // helper window was closed, or the folder grant lapsed). Reset the Install
      // button out of its busy/disabled "Installing in a window…" state and
      // surface a short hint so the user can retry instead of waiting forever.
      installInFlight = false;
      void refreshOverlayReadiness();
      markOverlayInstallFailed(message.needsFolder === true);
    }
  });

  // Helper-window jobs the service worker opened on the overlay's behalf. These
  // run LAST so all the wiring + saved state above is in place first.
  if (runningInSetup) {
    void runFolderGrantHelper();
  } else if (autoInstallLcsc) {
    void runAutoInstallHelper(autoInstallLcsc);
  }
}

// --- Overlay delegation (iframe ↔ service worker ↔ helper window) -------------

/**
 * Re-read the overlay's library readiness from chrome.storage after a delegated
 * folder-grant finishes, and refresh the pills/search/install gating. Overlay-
 * iframe only (it has no real FS handle to restore).
 */
async function refreshOverlayReadiness() {
  try {
    const stored = await chrome.storage.local.get(OVERLAY_LIB_KEY);
    overlayLibraryName = typeof stored[OVERLAY_LIB_KEY] === 'string' ? stored[OVERLAY_LIB_KEY] : '';
  } catch {
    /* keep the last-known value */
  }
  refreshReadiness();
}

/** Briefly reflect a successful delegated install in the overlay iframe's card. */
function markOverlayInstalled() {
  if (current) {
    installBtn.textContent = 'Installed ✓';
    installBtn.className = 'btn btn-primary is-done';
    installBtn.disabled = true;
    setStatus(installStatus, 'Installed via helper window.', 'success');
  }
}

/**
 * Reset the overlay iframe's Install button out of the "Installing in a window…"
 * busy/disabled state after a delegated install ended without success, and
 * surface a short retry hint. `needsFolder` distinguishes the lapsed-permission
 * case (point the user at the popup window that's asking for the folder) from a
 * genuine convert/install failure (just retry). Without this the button stays
 * stuck on "Installing in a window…" forever.
 */
function markOverlayInstallFailed(needsFolder: boolean) {
  // Clear the busy state so the button is clickable again. refreshInstallEnabled()
  // then re-derives the disabled state from current readiness (relay + folder).
  installBtn.textContent = needsFolder ? 'Grant the folder, then retry' : 'Install failed — try again';
  installBtn.className = 'btn btn-primary';
  refreshInstallEnabled();
  setStatus(
    installStatus,
    needsFolder
      ? 'Grant your library folder in the popup window, then it installs.'
      : 'Install failed — try again.',
    'error',
  );
}

/**
 * Setup helper window (`?win=1&setup=1`): surface the setup view and focus the
 * "Choose folder" button so the user grants access in a single click.
 *
 * We can't call the picker on load — `showDirectoryPicker` needs a user gesture,
 * and the gesture that opened this window doesn't carry into it. So the actual
 * grant happens in `onLibraryAction` (click handler); when it succeeds in setup
 * mode it records the folder name + finishes the helper (see `afterGrantInHelper`).
 */
function runFolderGrantHelper() {
  setupView.classList.remove('hidden');
  setStatus(searchStatus, 'Choose your KiCad library folder to finish setup.', 'loading');
  // Focus the button so a single Enter/click grants the folder.
  chooseFolderBtn.focus();
}

/**
 * Called after a successful folder grant inside a helper window. In pure setup
 * mode it finishes + closes the helper (the folder name was already recorded to
 * chrome.storage by the caller). Returns true if it closed the helper.
 */
function afterGrantInHelper(handle: FileSystemDirectoryHandle): boolean {
  if (runningInSetup) {
    setStatus(searchStatus, `Granted “${handle.name}” ✓`, 'success');
    void finishHelper('folder');
    return true;
  }
  return false;
}

/**
 * Install helper window (`?win=1&install=<lcscId>&bucket=<bucket>`): auto-convert
 * the part via the relay and write it with the saved folder handle, render the
 * success state, then self-close — NO extra click when the folder grant is valid.
 *
 * If the folder isn't granted / the permission lapsed, `getSavedFolder()` above
 * returned null; we show the "Choose folder" button (a single click) and, once
 * granted, the user clicks Install — the converted card is already on screen.
 */
async function runAutoInstallHelper(lcscId: string) {
  // Convert first so the card (and its editable metadata) is on screen whether or
  // not the folder is ready.
  await convertAndShow(lcscId, null);
  if (!current) {
    // Convert failed — the status already explains why. Tell the overlay so it
    // un-sticks its "Installing in a window…" button instead of waiting forever.
    void finishHelper('failed');
    return;
  }

  // Honor an explicit destination bucket from the URL (the overlay passes the
  // user's chosen bucket); otherwise the auto-sorted default from showCard stays.
  const wantBucket = parseBucket(location.search, LIBRARY_CHOICES);
  if (wantBucket) bucketSelect.value = wantBucket;

  if (!libraryFolder) {
    // Permission lapsed / never granted (getSavedFolder couldn't re-grant without
    // a gesture). The always-visible "Library" pill grants it; clicking it grants
    // AND — via onLibraryAction's helper-mode branch — proceeds straight to the
    // install, so it's a single click. The converted card is already on screen.
    // Tell the overlay it needs a folder so it resets its button + surfaces a hint
    // (otherwise it stays stuck on "Installing in a window…" forever). We DON'T
    // close this helper — the user grants the folder right here, in this window.
    libPill.focus();
    setStatus(installStatus, 'Click the Library pill to confirm your folder, then it installs.', 'loading');
    void notifyOverlay('needs-folder');
    return;
  }

  // Folder is valid → install immediately, then finish (success or failure).
  await onInstall();
  void finishHelper(installBtn.classList.contains('is-done') ? 'installed' : 'failed');
}

/** A helper-window job's terminal outcome, broadcast back to the overlay iframe. */
type HelperOutcome = 'folder' | 'installed' | 'failed' | 'needs-folder';

/**
 * Tell the SW the helper job reached a terminal outcome so it can broadcast the
 * matching signal to the overlay iframe (folder-ready / installed / install-
 * failed). Does NOT close this window — used on its own for `needs-folder`, where
 * the helper must stay open so the user can grant the folder right here.
 *
 * We pass our own window id in the message: `sender.tab` is undefined for a
 * message sent from a popup-window extension page in MV3, so the SW can't derive
 * the window to force-close from the sender alone.
 */
async function notifyOverlay(kind: HelperOutcome) {
  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {
    /* not available — the SW just won't have a safety-net close */
  }
  try {
    void chrome.runtime.sendMessage({ type: 'OVERLAY_HELPER_DONE', kind, windowId }).catch(() => {});
  } catch {
    /* SW unreachable — the self-close (if any) still tidies up */
  }
}

/**
 * Wrap up a helper-window job: notify the SW (which broadcasts to the overlay so
 * it reflects readiness / "Installed ✓" / "Install failed" right away), keep the
 * terminal state on screen ~1.2s, then self-close. The SW also closes us after a
 * grace period as a safety net if `window.close()` is blocked.
 *
 * Called on EVERY terminal outcome that ends the helper — success ('installed'/
 * 'folder') AND failure ('failed') — so the overlay never stays stuck on
 * "Installing in a window…". The lapsed-folder case ('needs-folder') uses
 * `notifyOverlay` directly instead, since that window stays open for the grant.
 */
async function finishHelper(kind: HelperOutcome) {
  await notifyOverlay(kind);
  setTimeout(() => {
    try {
      window.close();
    } catch {
      /* close blocked — the SW's grace-period close handles it */
    }
  }, 1200);
}

// --- Float on top (Document Picture-in-Picture) ------------------------------
/**
 * Wire up the Float button. Shown only where Document PiP is available AND we're
 * not already in the standalone floating window (Document PiP can't be requested
 * from a popup window — `requestWindow` rejects — so the button is pointless
 * there; we show a "Floating window" tag instead). The PiP window also can't be
 * requested from a side panel, so if `requestWindow` rejects at click time we
 * hide the button and explain once.
 */
function setupFloatButton() {
  // Inside the overlay iframe, or a transient folder-grant / install helper
  // window: Document PiP is pointless (the overlay already floats; the helper
  // closes itself). Hide the button and skip the "Floating window" tag.
  if (runningInOverlay || runningInSetup || autoInstallLcsc) {
    floatBtn.classList.add('hidden');
    return;
  }
  // Running inside the standalone popup window (service worker added `&win=1`):
  // hide Float entirely and surface a subtle "Floating window" tag.
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
  // Already floating → bring it back.
  if (floatHandle) {
    floatHandle.close();
    return;
  }
  try {
    floatHandle = await floatOnTop({
      root: app,
      onEnter: () => {
        floatingNote.classList.remove('hidden');
        floatBtn.classList.add('is-active');
        floatBtn.title = 'Return from floating window';
        setText(floatBtn.querySelector('.icon-label'), 'Floating');
      },
      onLeave: () => {
        floatHandle = null;
        floatingNote.classList.add('hidden');
        floatBtn.classList.remove('is-active');
        floatBtn.title = 'Float on top — always-on-top window';
        setText(floatBtn.querySelector('.icon-label'), 'Float');
      },
    });
  } catch {
    // Most likely: called from a context that can't open Document PiP (a side
    // panel or extension popup). Hide the button and leave a one-line note.
    floatHandle = null;
    floatBtn.classList.add('hidden');
    setStatus(
      searchStatus,
      'Floating needs a normal browser tab — open the finder in a tab to float it.',
      'error',
    );
  }
}

// --- Settings disclosure -----------------------------------------------------
function toggleSettings(forceOpen?: boolean) {
  const open = forceOpen ?? settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden', !open);
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    // Keep the field in sync and focus it for a quick edit.
    relayUrlInput.value = relayUrl;
    relayUrlInput.focus();
  }
}

// --- Open mode (side panel/tab · floating window · in-page overlay) ----------
type OpenMode = 'auto' | 'window' | 'overlay';

/** Coerce a stored value to a known open mode (missing/unknown → 'auto'). */
function normalizeOpenMode(value: unknown): OpenMode {
  return value === 'window' || value === 'overlay' ? value : 'auto';
}

/** How THIS document was actually opened (for the "applies next time" note). */
function currentDocumentMode(): OpenMode {
  if (runningInOverlay) return 'overlay';
  if (runningInWindow) return 'window';
  return 'auto';
}

/** Check the matching radio in the segmented selector. */
function selectOpenMode(mode: OpenMode) {
  const input = openModeSelector.querySelector<HTMLInputElement>(
    `input[name="openMode"][value="${mode}"]`,
  );
  if (input) input.checked = true;
}

/**
 * Persist the chosen open mode and make the change discoverable. The new mode
 * only takes effect the *next* time the finder is opened (we can't re-home the
 * live document mid-task), so we surface a clear "reopen to apply" note whenever
 * the choice differs from how THIS document was actually opened.
 */
async function onOpenModeChange(value: string) {
  const mode = normalizeOpenMode(value);
  try {
    await chrome.storage.local.set({ openMode: mode });
  } catch {
    /* storage unavailable — keep the in-memory selection for this session */
  }

  const changesCurrent = mode !== currentDocumentMode();
  windowModeNote.textContent =
    mode === 'overlay'
      ? 'Reopen the finder via the toolbar icon to show it as an in-page overlay.'
      : mode === 'window'
        ? 'Reopen the finder via the toolbar icon to float it in a window.'
        : 'Reopen the finder via the toolbar icon to apply.';
  windowModeNote.classList.toggle('hidden', !changesCurrent);
}

// --- Library folder ----------------------------------------------------------
async function onLibraryAction() {
  // Overlay iframe: the folder picker is blocked here. Delegate to a real window
  // via the SW (which opens `?win=1&setup=1`, grants, then broadcasts back).
  if (runningInOverlay) {
    // Guard against a double-click spawning a second folder picker. (The SW also
    // dedups setup windows; this gives immediate feedback + avoids a stray send.)
    if (pickFolderInFlight) return;
    pickFolderInFlight = true;
    libPill.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'OVERLAY_PICK_FOLDER' });
      setStatus(searchStatus, 'Opening a window to grant your library folder…', 'loading');
    } catch {
      // Couldn't even reach the SW — re-enable so the user can retry.
      pickFolderInFlight = false;
      libPill.disabled = false;
      setStatus(searchStatus, 'Could not open the folder-grant window.', 'error');
    }
    return;
  }

  try {
    const handle = await pickLibraryFolder();
    libraryFolder = handle;
    refreshReadiness();
    // Record the folder name for the overlay (which can't hold the FS handle), so
    // its Library pill reflects readiness no matter where setup happened.
    try {
      await chrome.storage.local.set({ [OVERLAY_LIB_KEY]: handle.name });
    } catch {
      /* storage unavailable — overlay just won't auto-reflect the new folder */
    }
    // In a helper window (setup / install re-confirm), finish the delegated job.
    if (runningInSetup || autoInstallLcsc) {
      const closed = afterGrantInHelper(handle);
      // Install helper: the user re-confirmed the lapsed permission mid-install —
      // now that the folder's valid, install and finish (notify SW + auto-close)
      // on success OR failure so the overlay never stays stuck.
      if (!closed && autoInstallLcsc && current) {
        await onInstall();
        void finishHelper(installBtn.classList.contains('is-done') ? 'installed' : 'failed');
      }
    }
  } catch (err) {
    // AbortError = user cancelled the picker — stay quiet.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    setStatus(
      searchStatus,
      err instanceof Error ? err.message : 'Could not open folder.',
      'error',
    );
  }
}

// --- Relay URL ---------------------------------------------------------------
/**
 * Persist the edited relay URL to chrome.storage.local and refresh UI state, on
 * every keystroke. We DON'T rewrite the `source` input the user is typing in —
 * doing so on each input event stripped a trailing space mid-type and jumped the
 * caret to the end. Normalization (trim) of the *displayed* value happens only on
 * blur (see `normalizeRelayInput`). The OTHER (mirror) input is safe to overwrite
 * since the user isn't editing it.
 */
async function onRelayUrlChange(value: string, source: HTMLInputElement) {
  relayUrl = value.trim();
  // Mirror the trimmed value into the OTHER input so settings and setup agree,
  // but leave the input being typed in untouched (no caret jump / space-strip).
  const mirror = source === relayUrlInput ? relayUrlInputSetup : relayUrlInput;
  if (mirror.value !== relayUrl) mirror.value = relayUrl;
  refreshReadiness();
  try {
    await chrome.storage.local.set({ relayUrl });
  } catch {
    /* storage unavailable — keep the in-memory value so the session still works */
  }
}

/** On blur, normalize an input's displayed value to the trimmed relay URL. */
function normalizeRelayInput(input: HTMLInputElement) {
  if (input.value !== relayUrl) input.value = relayUrl;
}

/** Whether a relay URL has been configured (search/convert is possible). */
function hasRelay(): boolean {
  return relayUrl.length > 0;
}
/**
 * Whether a library folder is available for install. In the overlay iframe we
 * can't hold the FS handle, so readiness is the recorded folder name from
 * chrome.storage; everywhere else it's the live directory handle.
 */
function hasFolder(): boolean {
  return runningInOverlay ? overlayLibraryName.length > 0 : libraryFolder !== null;
}
/** The granted library folder's display name (handle name, or the overlay mirror). */
function folderName(): string {
  return runningInOverlay ? overlayLibraryName : (libraryFolder?.name ?? '');
}
/** Both prerequisites met → the main flow is usable. */
function isReady(): boolean {
  return hasRelay() && hasFolder();
}

/** Open the setup view and focus the relay field within it. */
function openSetupFocusRelay() {
  setupView.classList.remove('hidden');
  relayUrlInputSetup.focus();
}

/**
 * Single source of truth for "what's set up". Updates the two pills, shows/hides
 * the Setup view (only when something's missing AND no result is on screen), and
 * re-evaluates the Search + Install enabled states.
 */
function refreshReadiness() {
  // --- Library pill ---
  if (hasFolder()) {
    const name = folderName();
    libPill.classList.add('is-ready');
    libPill.classList.remove('is-missing');
    setText(libPillValue, name);
    libPill.title = `Library folder: ${name} — click to change`;
  } else {
    libPill.classList.remove('is-ready');
    libPill.classList.add('is-missing');
    setText(libPillValue, 'Choose folder');
    libPill.title = 'Choose your KiCad library folder';
  }

  // --- Relay pill ---
  if (hasRelay()) {
    relayPill.classList.add('is-ready');
    relayPill.classList.remove('is-missing');
    setText(relayPillValue, prettyRelay(relayUrl));
    relayPill.title = `Relay: ${relayUrl} — click to edit`;
  } else {
    relayPill.classList.remove('is-ready');
    relayPill.classList.add('is-missing');
    setText(relayPillValue, 'Set relay');
    relayPill.title = 'Set your relay URL';
  }

  // --- Setup view: only takes over on first run / when something's missing,
  //     and never while a result card is showing (don't yank it away mid-task).
  const cardShowing = !partCard.classList.contains('hidden');
  const showSetup = !isReady() && !cardShowing;
  setupView.classList.toggle('hidden', !showSetup);
  setupStepLib.classList.toggle('is-done', hasFolder());
  setupStepRelay.classList.toggle('is-done', hasRelay());

  // --- Search affordance ---
  // Search/convert/preview only need the relay; the folder is required at INSTALL
  // time only. So disable Search solely for a missing relay — a relay-set user
  // with no folder can still search + preview, then grant a folder to install.
  const blocked = !hasRelay();
  searchBtn.disabled = blocked;
  searchField.classList.toggle('is-disabled', blocked);
  if (blocked) {
    const what = 'Set your relay URL to search.';
    setText(searchHint, what);
    searchHint.classList.remove('hidden');
    searchBtn.title = what;
  } else if (!hasFolder()) {
    // Relay's set but no folder yet: searching/previewing works; nudge that a
    // folder is needed before installing (Install stays gated below).
    const what = 'Search + preview work now — choose a library folder to install.';
    setText(searchHint, what);
    searchHint.classList.remove('hidden');
    searchBtn.title = '';
  } else {
    searchHint.classList.add('hidden');
    searchBtn.title = '';
  }

  refreshInstallEnabled();
}

/** Shorten a relay origin for the pill (drop scheme; keep host + a short tail). */
function prettyRelay(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '');
    return tail && tail !== '/' ? `${u.host}${tail}` : u.host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

// --- Search / convert --------------------------------------------------------
const LCSC_RE = /^C\d+$/i;

async function runSearch(query: string) {
  hide(candidateSection);
  hide(partCard);
  hide(secondarySources);
  // Tear down the previous part's previews (stops any 3D scene + frees WebGL).
  preview?.reset();
  current = null;
  candidates = [];

  // Search / convert / preview only need the relay (the folder is required only
  // at INSTALL time — onInstall guards on it). So gate Search on the relay alone:
  // a relay-set / no-folder user can search → preview symbol/footprint/3D → then
  // grant a folder → install (the v1 flow).
  if (!hasRelay()) {
    refreshReadiness();
    setStatus(searchStatus, 'Set your relay URL first.', 'error');
    return;
  }

  if (!query) {
    setStatus(searchStatus, 'Enter an LCSC# (e.g. C3235557) or an MPN.', 'error');
    return;
  }

  // Direct LCSC id → convert immediately.
  if (LCSC_RE.test(query)) {
    await convertAndShow(query.toUpperCase(), null);
    return;
  }

  // Otherwise treat as MPN: resolve to LCSC candidates via JLCPCB.
  setStatus(searchStatus, `Looking up "${query}" on JLCPCB…`, 'loading');
  let matches: JlcMatch[] = [];
  let relaxed = false;
  let matchedQuery = '';
  // Precise network/parse outcome from the service worker so a failed search
  // shows the REAL cause instead of a generic "no match".
  let diagnostic = 'no response';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'RESOLVE_MPN', mpn: query });
    if (resp?.ok) {
      matches = resp.matches as JlcMatch[];
      relaxed = Boolean(resp.relaxed);
      matchedQuery = (resp.matchedQuery as string) || '';
      diagnostic = (resp.diagnostic as string) || 'no diagnostic';
    } else if (resp?.error) {
      diagnostic = `worker error: ${resp.error}`;
    }
  } catch (err) {
    diagnostic = `message failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Only when even the relaxed fallbacks came back empty do we surface the real
  // failure and suggest entering the exact LCSC#.
  if (matches.length === 0) {
    setStatus(
      searchStatus,
      `Search failed — JLCPCB ${diagnostic}. Try the exact LCSC# (C…).`,
      'error',
    );
    showSecondarySources(query);
    return;
  }

  // The input wasn't an exact catalog hit — these are the closest matches.
  const note = relaxed ? `No exact match — closest results for ${matchedQuery}` : undefined;

  candidates = matches;
  if (matches.length === 1) {
    await convertAndShow(matches[0].lcscId, matches[0], note);
    return;
  }

  // Multiple matches — let the user pick (auto-convert the top/most-in-stock).
  renderCandidates(matches);
  await convertAndShow(matches[0].lcscId, matches[0], note);
}

function renderCandidates(matches: JlcMatch[]) {
  candidateSelect.textContent = '';
  for (const m of matches) {
    const opt = document.createElement('option');
    opt.value = m.lcscId;
    const stock = m.stock ? `${m.stock.toLocaleString()} in stock` : 'no stock';
    opt.textContent = `${m.mpn} · ${m.package || '—'} · ${m.lcscId} · ${stock}`;
    candidateSelect.appendChild(opt);
  }
  candidateSelect.selectedIndex = 0;
  show(candidateSection);
}

async function convertAndShow(lcscId: string, match: JlcMatch | null, note?: string) {
  setStatus(searchStatus, `Fetching + converting ${lcscId}…`, 'loading');
  hide(partCard);

  let result: ConvertResult;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CONVERT', lcscId });
    if (!resp?.ok) throw new Error(resp?.error || 'Conversion failed.');
    result = resp.result as ConvertResult;
  } catch (err) {
    setStatus(searchStatus, err instanceof Error ? err.message : 'Conversion failed.', 'error');
    return;
  }

  current = result;
  // Keep the "closest results" hint visible when the match came from a relaxed
  // query; otherwise clear the transient status.
  if (note) {
    setStatus(searchStatus, note, 'loading');
  } else {
    hide(searchStatus);
  }
  showCard(result, match);
  showSecondarySources(result.meta.mpn || lcscId);
}

// --- Card --------------------------------------------------------------------
function showCard(result: ConvertResult, match: JlcMatch | null) {
  const meta = result.meta;
  setText(cardLcsc, meta.lcsc || match?.lcscId || 'C—');
  setText(cardMpn, meta.mpn || '(unknown MPN)');

  // Subtitle: manufacturer · package, from metadata (fall back to the JLC match).
  const manufacturer = meta.manufacturer || '';
  const pkg = meta.package || match?.package || '';
  renderCardSub(manufacturer, pkg);

  // Stock / price badge from the JLCPCB match (only present on an MPN search).
  renderStockBadge(match);

  fieldMpn.value = meta.mpn || '';
  fieldManufacturer.value = manufacturer;
  fieldPackage.value = pkg;
  fieldDatasheet.value = meta.datasheet || '';

  // Prompt-on-uncertain: flag empty datasheet / MPN for confirmation.
  toggleFlag(flagMpn, fieldMpn, !meta.mpn);
  toggleFlag(flagDatasheet, fieldDatasheet, !meta.datasheet);
  fieldMpn.oninput = () => toggleFlag(flagMpn, fieldMpn, !fieldMpn.value.trim());
  fieldDatasheet.oninput = () => {
    toggleFlag(flagDatasheet, fieldDatasheet, !fieldDatasheet.value.trim());
    updateDatasheetLink();
  };
  updateDatasheetLink();

  // Auto-sort the bucket from the JLCPCB category (best) or the package text.
  const category = match?.category || meta.package || '';
  bucketSelect.value = categoryToBucket(category);

  // 3D model status indicator.
  setAssetState(model3dAvail, result.model3dUrl ? 'STEP' : 'None', !!result.model3dUrl);

  // Point the preview block at this part. It renders the Symbol tab now and the
  // others lazily on first open (3D only imports three.js when its tab opens).
  preview?.setResult(result, relayUrl);

  // Reset the install footer to its initial state.
  hide(installStatus);
  hide(successPanel);
  writtenList.textContent = '';
  installBtn.textContent = 'Install to KiCad';
  installBtn.className = 'btn btn-primary';
  installBtn.disabled = false;
  show(partCard);
  refreshInstallEnabled();
}

function renderCardSub(manufacturer: string, pkg: string) {
  cardSub.textContent = '';
  const parts: string[] = [];
  if (manufacturer) parts.push(manufacturer);
  if (pkg) parts.push(pkg);
  if (parts.length === 0) {
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
    if (i === 1) span.className = 'mono';
    cardSub.appendChild(span);
  });
  show(cardSub);
}

/** Render a subtle stock/price badge from the JLCPCB match, when present. */
function renderStockBadge(match: JlcMatch | null) {
  if (!match || (match.stock === 0 && match.price === null)) {
    hide(stockBadge);
    return;
  }
  const stock = match.stock || 0;
  const tone = stock <= 0 ? 'no-stock' : stock < 100 ? 'low-stock' : 'in-stock';
  stockBadge.className = `stock-badge ${tone}`;
  stockBadge.textContent = '';

  const stockText = document.createElement('span');
  stockText.textContent = stock > 0 ? `${stock.toLocaleString()} in stock` : 'No stock';
  stockBadge.appendChild(stockText);

  if (match.price !== null) {
    const price = document.createElement('span');
    price.className = 'badge-price';
    price.textContent = `$${match.price.toFixed(match.price < 1 ? 4 : 2)}`;
    stockBadge.appendChild(price);
  }
  show(stockBadge);
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

// --- Install -----------------------------------------------------------------
async function onInstall() {
  if (!current || !hasRelay()) return;

  const bucket = bucketSelect.value as LibraryChoice;

  // Overlay iframe: FS writes are blocked here. Delegate to a real window via the
  // SW (which opens `?win=1&install=<lcscId>&bucket=<bucket>`, auto-writes against
  // the saved handle, then closes + broadcasts OVERLAY_INSTALLED back to us).
  if (runningInOverlay) {
    const lcscId = current.meta.lcsc;
    if (!lcscId) {
      failInstall('Missing LCSC id — re-run the search.');
      return;
    }
    installBtn.disabled = true;
    installBtn.textContent = 'Installing in a window…';
    installBtn.className = 'btn btn-primary is-busy';
    hide(successPanel);
    setStatus(installStatus, 'A helper window is writing the files…', 'loading');
    // Stay "in flight" until the helper's terminal broadcast (OVERLAY_INSTALLED /
    // OVERLAY_INSTALL_FAILED) lands, so a live detection can't null `current` out
    // from under markOverlayInstalled() while the helper window works.
    installInFlight = true;
    try {
      await chrome.runtime.sendMessage({ type: 'OVERLAY_INSTALL', lcscId, bucket });
    } catch {
      installInFlight = false;
      failInstall('Could not open the install window.');
    }
    return;
  }

  // Top-level document: write directly via File System Access. A relay URL is
  // required even here — the 3D-model STEP is fetched through it.
  if (!libraryFolder) return;

  installBtn.disabled = true;
  installBtn.textContent = 'Installing…';
  installBtn.className = 'btn btn-primary is-busy';
  hide(installStatus);
  hide(successPanel);

  // Snapshot everything we need from `current` + the editable fields BEFORE the
  // `await installPart`. A live PART_DETECTED that slips through during the await
  // would null `current` via runSearch, so reading `current.meta.*` afterwards
  // (the old success branch did) could throw; the in-flight guard now suppresses
  // that re-search too, but capturing locals keeps onInstall correct regardless.
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

  if (res.ok) {
    installBtn.textContent = `Installed ${partName} → ${bucketLabel(bucket)}`;
    installBtn.className = 'btn btn-primary is-done';
    installBtn.disabled = true;

    const summary = res.symbolAdded
      ? `Installed into ${bucketLabel(bucket)}.`
      : `Symbol already in ${bucketLabel(bucket)} — footprint refreshed.`;
    setStatus(installStatus, `${summary} 3D model: ${res.modelStatus || 'none'}.`, 'success');
    renderWritten(res.written);
    show(successPanel);
  } else {
    failInstall(res.errors.join('; ') || 'Install failed.');
    renderWritten(res.written);
    if (res.written.length) show(successPanel);
  }
}

/** The user-facing library name for a bucket value. */
function bucketLabel(bucket: string): string {
  return bucket === 'KiCadPartFinder' ? 'KiCadPartFinder' : `DavidLib_${bucket}`;
}

function failInstall(msg: string) {
  installBtn.textContent = 'Install failed — retry';
  installBtn.className = 'btn btn-primary is-error';
  installBtn.disabled = false;
  setStatus(installStatus, msg, 'error');
}

function renderWritten(paths: string[]) {
  writtenList.textContent = '';
  if (!paths.length) return;
  for (const p of paths) {
    const li = document.createElement('li');
    li.textContent = p;
    writtenList.appendChild(li);
  }
}

/** Reset back to a clean search-and-install state for the next part. */
function resetForAnother() {
  current = null;
  candidates = [];
  preview?.reset();
  hide(partCard);
  hide(candidateSection);
  hide(secondarySources);
  hide(successPanel);
  hide(installStatus);
  hide(searchStatus);
  searchInput.value = '';
  searchInput.focus();
  refreshReadiness();
}

// --- Secondary sources -------------------------------------------------------
function showSecondarySources(mpn: string) {
  sourceLinks.textContent = '';
  for (const link of getSecondarySourceLinks(mpn)) {
    sourceLinks.appendChild(createSourceLink(link));
  }
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

// --- Small helpers -----------------------------------------------------------
function refreshInstallEnabled() {
  // Don't override the terminal success state's disabled button.
  if (installBtn.classList.contains('is-done')) return;
  // Overlay mode gates on the recorded folder (hasFolder()) since the iframe
  // holds no FS handle; top-level modes gate on the live handle.
  installBtn.disabled = !(hasFolder() && current && hasRelay());
  installBtn.title = !hasRelay()
    ? 'Set your relay URL first.'
    : hasFolder()
      ? ''
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

type StatusKind = 'success' | 'error' | 'loading';
function setStatus(el: HTMLElement, msg: string, kind: StatusKind) {
  el.textContent = msg;
  el.className = `status ${kind}`;
  el.classList.remove('hidden');
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

init();
