/**
 * Side panel UI — self-contained (no companion server).
 *
 * Flow:
 *   0. User pastes their deployed Worker relay URL (stored in chrome.storage.local
 *      `relayUrl`); until it's set a banner shows and Search/Install are disabled.
 *   1. User grants a KiCad library folder (File System Access, persisted in IDB).
 *   2. User enters an LCSC# or MPN (auto-filled from a detected part if present).
 *   3. The service worker fetches + converts through the relay (JLCPCB/EasyEDA
 *      WAF-block the browser directly); an MPN is first resolved to candidate
 *      LCSC parts via JLCPCB.
 *   4. A card shows editable metadata + an auto-selected library bucket; empty
 *      datasheet/MPN fields are flagged for the user to fill.
 *   5. "Install" writes symbol/footprint/3D-model into the granted folder (the
 *      STEP model is fetched through the relay too).
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

// --- DOM ---------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const chooseFolderBtn = $<HTMLButtonElement>('chooseFolderBtn');
const folderName = $('folderName');

const relayUrlInput = $<HTMLInputElement>('relayUrlInput');
const relayBanner = $('relayBanner');

const searchInput = $<HTMLInputElement>('searchInput');
const searchBtn = $<HTMLButtonElement>('searchBtn');
const searchStatus = $('searchStatus');

const candidateSection = $('candidateSection');
const candidateSelect = $<HTMLSelectElement>('candidateSelect');

const partCard = $('partCard');
const cardLcsc = $('cardLcsc');
const cardMpn = $('cardMpn');
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
const writtenList = $<HTMLUListElement>('writtenList');

const secondarySources = $('secondarySources');
const sourceLinks = $('sourceLinks');

// --- State -------------------------------------------------------------------
let libraryFolder: FileSystemDirectoryHandle | null = null;
let current: ConvertResult | null = null;
let candidates: JlcMatch[] = [];
// The deployed Worker relay URL (chrome.storage.local `relayUrl`). All search /
// convert / model fetches go through it; empty disables Search + Install.
let relayUrl = '';
// Debounce live highlight-to-search so rapid re-selections don't spam searches.
let detectDebounce: ReturnType<typeof setTimeout> | null = null;

// --- Init --------------------------------------------------------------------
async function init() {
  // Populate the bucket dropdown once.
  for (const choice of LIBRARY_CHOICES) {
    const opt = document.createElement('option');
    opt.value = choice;
    opt.textContent = choice === 'KiCadPartFinder' ? 'KiCadPartFinder (catch-all)' : `DavidLib_${choice}`;
    bucketSelect.appendChild(opt);
  }

  chooseFolderBtn.addEventListener('click', onChooseFolder);
  searchBtn.addEventListener('click', () => void runSearch(searchInput.value.trim()));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSearch(searchInput.value.trim());
  });
  candidateSelect.addEventListener('change', () => {
    const m = candidates[candidateSelect.selectedIndex];
    if (m) void convertAndShow(m.lcscId, m);
  });
  installBtn.addEventListener('click', () => void onInstall());

  // Persist the relay URL on every edit; update the banner + disabled states.
  relayUrlInput.addEventListener('input', () => void onRelayUrlChange());

  // Load the saved relay URL (the deployed Worker). Until it's set, search /
  // convert / install are disabled and a banner explains why.
  try {
    const stored = await chrome.storage.local.get('relayUrl');
    relayUrl = typeof stored.relayUrl === 'string' ? stored.relayUrl.trim() : '';
  } catch {
    relayUrl = '';
  }
  relayUrlInput.value = relayUrl;
  refreshRelayState();

  // Try to silently restore the saved folder. Chrome requires a user gesture to
  // (re-)grant permission, so if the grant lapsed we leave the button to prompt.
  try {
    const saved = await getSavedFolder();
    if (saved) setFolder(saved);
  } catch {
    /* needs a gesture — user clicks "Choose library folder" */
  }

  // Pre-fill from a detected part (DigiKey/LCSC content script), if any.
  //  - Side-panel mode: no `?tab=` → service worker reads the active tab.
  //  - Popup-window mode: `?tab=<id>` identifies the originating page, since the
  //    active tab here is the popup window itself.
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

  // React to live detections while the UI is open. Runtime messages are global
  // broadcasts (not tab-scoped), so this fires whether the UI is a side panel or
  // a popup window opened with `?tab=`. A highlighted selection (or any detected
  // part) fills the box AND auto-runs the search — matching v1 behaviour —
  // debounced so dragging across text doesn't fire a search per character.
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

// --- Folder ------------------------------------------------------------------
function setFolder(handle: FileSystemDirectoryHandle) {
  libraryFolder = handle;
  folderName.textContent = handle.name;
  folderName.classList.remove('muted');
  folderName.classList.add('folder-set');
  refreshInstallEnabled();
}

async function onChooseFolder() {
  try {
    const handle = await pickLibraryFolder();
    setFolder(handle);
    setStatus(searchStatus, `Library folder set to "${handle.name}".`, 'success');
  } catch (err) {
    // AbortError = user cancelled the picker — stay quiet.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    setStatus(searchStatus, err instanceof Error ? err.message : 'Could not open folder.', 'error');
  }
}

// --- Relay URL ---------------------------------------------------------------
/** Persist the edited relay URL to chrome.storage.local and refresh UI state. */
async function onRelayUrlChange() {
  relayUrl = relayUrlInput.value.trim();
  refreshRelayState();
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

/**
 * Reflect the relay-configured state: toggle the "set your Relay URL" banner and
 * the Search button, and re-evaluate the Install button (which also needs it).
 */
function refreshRelayState() {
  const missing = !hasRelay();
  relayBanner.classList.toggle('hidden', !missing);
  searchBtn.disabled = missing;
  searchBtn.title = missing ? 'Set your Relay URL first (deploy packages/relay).' : '';
  refreshInstallEnabled();
}

// --- Search / convert --------------------------------------------------------
const LCSC_RE = /^C\d+$/i;

async function runSearch(query: string) {
  hide(candidateSection);
  hide(partCard);
  hide(secondarySources);
  current = null;
  candidates = [];

  // No relay configured → nothing can be fetched. The banner already explains
  // this; reinforce it on the search status and bail before any message.
  if (!hasRelay()) {
    setStatus(searchStatus, 'Set your Relay URL first (deploy packages/relay).', 'error');
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
  // Precise network/parse outcome from the service worker (http 403, fetch
  // threw, non-JSON body, …) so a failed search shows the REAL cause instead of
  // a generic "no match". Defaults cover the worker not answering at all.
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
  cardLcsc.textContent = meta.lcsc || '';
  cardMpn.textContent = meta.mpn || '(unknown MPN)';

  fieldMpn.value = meta.mpn || '';
  fieldManufacturer.value = meta.manufacturer || '';
  fieldPackage.value = meta.package || '';
  fieldDatasheet.value = meta.datasheet || '';

  // Prompt-on-uncertain: flag empty datasheet / MPN.
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
  const bucket = categoryToBucket(category);
  bucketSelect.value = bucket;

  // 3D model status indicator.
  setFileStatus(model3dAvail, result.model3dUrl ? 'Will fetch (STEP)' : 'None', !!result.model3dUrl);

  hide(installStatus);
  hide(writtenList);
  writtenList.textContent = '';
  installBtn.textContent = 'Install to KiCad';
  installBtn.className = 'btn-primary';
  show(partCard);
  refreshInstallEnabled();
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
  installBtn.className = 'btn-primary installing';
  hide(installStatus);
  hide(writtenList);

  // Apply any user edits back onto the converted result's metadata. (The symbol
  // text itself was stamped at convert time; edits here update the card record
  // and the chosen bucket. Datasheet/MPN edits are surfaced for the user; the
  // already-converted symbol/footprint text is installed as-is.)
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
    installBtn.textContent = 'Installed ✓';
    installBtn.className = 'btn-primary success';
    const summary = res.symbolAdded
      ? `Installed into ${bucket}.`
      : `Installed (symbol already present in ${bucket}, footprint refreshed).`;
    setStatus(installStatus, `${summary} 3D model: ${res.modelStatus || 'none'}.`, 'success');
    renderWritten(res.written);
  } else {
    failInstall(res.errors.join('; ') || 'Install failed.');
    renderWritten(res.written);
  }
}

function failInstall(msg: string) {
  installBtn.textContent = 'Install Failed';
  installBtn.className = 'btn-primary error';
  setStatus(installStatus, msg, 'error');
  setTimeout(() => {
    installBtn.textContent = 'Install to KiCad';
    installBtn.className = 'btn-primary';
    refreshInstallEnabled();
  }, 3500);
}

function renderWritten(paths: string[]) {
  writtenList.textContent = '';
  if (!paths.length) return;
  for (const p of paths) {
    const li = document.createElement('li');
    li.textContent = p;
    writtenList.appendChild(li);
  }
  show(writtenList);
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
  installBtn.disabled = !(libraryFolder && current && hasRelay());
  installBtn.title = !hasRelay()
    ? 'Set your Relay URL first (deploy packages/relay).'
    : libraryFolder
      ? ''
      : 'Choose a library folder first.';
}

function toggleFlag(flag: HTMLElement, input: HTMLInputElement, missing: boolean) {
  flag.classList.toggle('hidden', !missing);
  input.classList.toggle('input-missing', missing);
}

function setFileStatus(element: HTMLElement, label: string, available: boolean) {
  const statusEl = element.querySelector('.file-status')!;
  statusEl.textContent = label;
  element.classList.toggle('available', available);
  element.classList.toggle('unavailable', !available);
}

type StatusKind = 'success' | 'error' | 'loading';
function setStatus(el: HTMLElement, msg: string, kind: StatusKind) {
  el.textContent = msg;
  el.className = `install-status ${kind}`;
  el.classList.remove('hidden');
}

function show(el: HTMLElement) {
  el.classList.remove('hidden');
}
function hide(el: HTMLElement) {
  el.classList.add('hidden');
}

init();
