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
import { parseSourceTabId } from './source-tab.js';
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
// Active Document PiP float, if any.
let floatHandle: FloatHandle | null = null;
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
  // Keep the two relay inputs (settings + setup) mirrored and persisted.
  relayUrlInput.addEventListener('input', () => void onRelayUrlChange(relayUrlInput.value));
  relayUrlInputSetup.addEventListener('input', () => void onRelayUrlChange(relayUrlInputSetup.value));

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

  // Load the saved relay URL. Until it's set, search/convert/install are
  // disabled and the setup view nudges the user to set it.
  try {
    const stored = await chrome.storage.local.get('relayUrl');
    relayUrl = typeof stored.relayUrl === 'string' ? stored.relayUrl.trim() : '';
  } catch {
    relayUrl = '';
  }
  relayUrlInput.value = relayUrl;
  relayUrlInputSetup.value = relayUrl;

  // Try to silently restore the saved folder. Chrome requires a user gesture to
  // (re-)grant permission, so if the grant lapsed we leave the pill to prompt.
  try {
    const saved = await getSavedFolder();
    if (saved) libraryFolder = saved;
  } catch {
    /* needs a gesture — user clicks the Library pill / "Choose folder" */
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
  // dragging across text doesn't fire a search per character.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PART_DETECTED' && message.part) {
      const part = message.part as DetectedPart;
      const text = part.lcscId || part.mpn || '';
      if (!text) return;
      searchInput.value = text;
      if (detectDebounce) clearTimeout(detectDebounce);
      detectDebounce = setTimeout(() => void runSearch(searchInput.value.trim()), 350);
    }
  });
}

// --- Float on top (Document Picture-in-Picture) ------------------------------
/**
 * Wire up the Float button. Shown only where Document PiP is available. The PiP
 * window can't be requested from a side panel / extension popup — only a real
 * tab — so if `requestWindow` rejects we hide the button and explain once.
 */
function setupFloatButton() {
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

// --- Library folder ----------------------------------------------------------
async function onLibraryAction() {
  try {
    const handle = await pickLibraryFolder();
    libraryFolder = handle;
    refreshReadiness();
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
/** Persist the edited relay URL to chrome.storage.local and refresh UI state. */
async function onRelayUrlChange(value: string) {
  relayUrl = value.trim();
  // Mirror across both inputs so settings and setup never disagree.
  if (relayUrlInput.value !== relayUrl) relayUrlInput.value = relayUrl;
  if (relayUrlInputSetup.value !== relayUrl) relayUrlInputSetup.value = relayUrl;
  refreshReadiness();
  try {
    await chrome.storage.local.set({ relayUrl });
  } catch {
    /* storage unavailable — keep the in-memory value so the session still works */
  }
}

/** Whether a relay URL has been configured (search/convert is possible). */
function hasRelay(): boolean {
  return relayUrl.length > 0;
}
/** Whether a library folder has been granted (install is possible). */
function hasFolder(): boolean {
  return libraryFolder !== null;
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
    libPill.classList.add('is-ready');
    libPill.classList.remove('is-missing');
    setText(libPillValue, libraryFolder!.name);
    libPill.title = `Library folder: ${libraryFolder!.name} — click to change`;
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
  const blocked = !isReady();
  searchBtn.disabled = blocked;
  searchField.classList.toggle('is-disabled', blocked);
  if (blocked) {
    const what =
      !hasRelay() && !hasFolder()
        ? 'Set a relay URL and choose a library folder to search.'
        : !hasRelay()
          ? 'Set your relay URL to search.'
          : 'Choose a library folder to search.';
    setText(searchHint, what);
    searchHint.classList.remove('hidden');
    searchBtn.title = what;
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

  // Not ready → nothing can be fetched. The hint already explains it; reinforce
  // on the search status and bail before any message.
  if (!isReady()) {
    refreshReadiness();
    setStatus(
      searchStatus,
      !hasRelay() ? 'Set your relay URL first.' : 'Choose a library folder first.',
      'error',
    );
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
  // A relay URL is required even at install time — the 3D-model STEP is fetched
  // through it. (Search/convert already gate on it, so by here it's normally set.)
  if (!current || !libraryFolder || !hasRelay()) return;

  installBtn.disabled = true;
  installBtn.textContent = 'Installing…';
  installBtn.className = 'btn btn-primary is-busy';
  hide(installStatus);
  hide(successPanel);

  const bucket = bucketSelect.value as LibraryChoice;

  let res: InstallPartResult;
  try {
    res = await installPart(
      libraryFolder,
      {
        bucket,
        symbol: current.symbol,
        footprint: current.footprint,
        model3dUrl: current.model3dUrl,
        meta: {
          ...current.meta,
          mpn: fieldMpn.value.trim() || current.meta.mpn,
          manufacturer: fieldManufacturer.value.trim(),
          package: fieldPackage.value.trim(),
          datasheet: fieldDatasheet.value.trim(),
        },
      },
      relayUrl,
    );
  } catch (err) {
    failInstall(err instanceof Error ? err.message : 'Install failed.');
    return;
  }

  if (res.ok) {
    const partName = fieldMpn.value.trim() || current.meta.mpn || current.meta.lcsc || 'part';
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
  installBtn.disabled = !(libraryFolder && current && hasRelay());
  installBtn.title = !hasRelay()
    ? 'Set your relay URL first.'
    : libraryFolder
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
