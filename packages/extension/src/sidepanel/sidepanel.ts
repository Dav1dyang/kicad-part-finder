/**
 * Side panel UI logic — displays detected part info, EasyEDA results,
 * secondary source links, and install controls.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';
import { checkHealth, installComponent, searchComponent, uploadZip } from '../lib/companion.js';
import { getSecondarySourceLinks } from '../lib/mpn-sources.js';

// DOM elements
const emptyState = document.getElementById('emptyState')!;
const partInfo = document.getElementById('partInfo')!;
const partSource = document.getElementById('partSource')!;
const partMpn = document.getElementById('partMpn')!;
const partManufacturer = document.getElementById('partManufacturer')!;
const partDescription = document.getElementById('partDescription')!;
const easyedaResults = document.getElementById('easyedaResults')!;
const easyedaLoading = document.getElementById('easyedaLoading')!;
const easyedaFiles = document.getElementById('easyedaFiles')!;
const symbolAvail = document.getElementById('symbolAvail')!;
const footprintAvail = document.getElementById('footprintAvail')!;
const model3dAvail = document.getElementById('model3dAvail')!;
const installBtn = document.getElementById('installBtn')! as HTMLButtonElement;
const installStatus = document.getElementById('installStatus')!;
const secondarySources = document.getElementById('secondarySources')!;
const sourceLinks = document.getElementById('sourceLinks')!;
const serverStatus = document.getElementById('serverStatus')!;
const serverUrlInput = document.getElementById('serverUrl')! as HTMLInputElement;
const saveSettingsBtn = document.getElementById('saveSettings')!;

let currentPart: DetectedPart | null = null;
let currentAvailability: Awaited<ReturnType<typeof searchComponent>> | null = null;

// Initialize
async function init() {
  // Check companion server status
  await updateServerStatus();
  setInterval(updateServerStatus, 10_000);

  // Load saved settings
  const stored = await chrome.storage.sync.get({ serverUrl: 'http://localhost:3456' });
  serverUrlInput.value = stored.serverUrl;

  // Save settings
  saveSettingsBtn.addEventListener('click', async () => {
    await chrome.storage.sync.set({ serverUrl: serverUrlInput.value });
    await updateServerStatus();
  });

  // Listen for part detection messages
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PART_DETECTED') {
      showPart(message.part);
    }
  });

  // Request current part from background
  const response = await chrome.runtime.sendMessage({ type: 'GET_DETECTED_PART' });
  if (response?.part) {
    showPart(response.part);
  } else {
    // No cached part — re-inject the content script to scan the current page
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/digikey.js'],
        }).catch(() => {});
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/lcsc.js'],
        }).catch(() => {});
      }
    } catch {
      // Ignore — page may not match permissions
    }
  }

  // Install button
  installBtn.addEventListener('click', handleInstall);

  // Also listen for tab changes
  chrome.tabs.onActivated.addListener(async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_DETECTED_PART' });
    if (resp?.part) {
      showPart(resp.part);
    } else {
      showEmpty();
    }
  });

  // ZIP drop zone
  initDropZone();
}

async function updateServerStatus() {
  const health = await checkHealth();
  if (health?.ok) {
    serverStatus.className = 'status-dot connected';
    serverStatus.title = `Server v${health.version} — KiCad ${health.kicadDetected ? 'detected' : 'not found'}`;
  } else {
    serverStatus.className = 'status-dot disconnected';
    serverStatus.title = 'Server disconnected — run: npx kicad-part-server';
  }
}

function showEmpty() {
  emptyState.classList.remove('hidden');
  partInfo.classList.add('hidden');
  easyedaResults.classList.add('hidden');
  secondarySources.classList.add('hidden');
}

async function showPart(part: DetectedPart) {
  currentPart = part;

  // Show part info
  emptyState.classList.add('hidden');
  partInfo.classList.remove('hidden');
  const sourceLabels: Record<string, string> = { digikey: 'DigiKey', lcsc: 'LCSC', selection: 'Selected' };
  partSource.textContent = sourceLabels[part.source] || part.source;
  partMpn.textContent = part.mpn;
  partManufacturer.textContent = part.manufacturer || '';
  partDescription.textContent = part.description || '';

  // Show EasyEDA search
  easyedaResults.classList.remove('hidden');
  easyedaLoading.classList.remove('hidden');
  easyedaFiles.classList.add('hidden');
  installBtn.classList.add('hidden');
  installStatus.classList.add('hidden');

  // Search via companion server (proxies JLCPCB + EasyEDA to avoid CORS)
  const availability = await searchComponent(part.mpn, part.lcscId);
  currentAvailability = availability;

  easyedaLoading.classList.add('hidden');
  easyedaFiles.classList.remove('hidden');

  updateFileStatus(symbolAvail, availability.hasSymbol);
  updateFileStatus(footprintAvail, availability.hasFootprint);
  updateFileStatus(model3dAvail, availability.has3DModel);

  // Show install button if any files available
  if (availability.hasSymbol || availability.hasFootprint || availability.has3DModel) {
    installBtn.classList.remove('hidden');
    installBtn.disabled = false;
    installBtn.textContent = 'Install to KiCad';
    installBtn.className = 'btn-primary';
  }

  // Show LCSC stock info and variants
  renderStockInfo(availability);

  // Show secondary source links
  secondarySources.classList.remove('hidden');
  sourceLinks.textContent = ''; // Clear previous links safely
  const links = getSecondarySourceLinks(part.mpn);
  for (const link of links) {
    sourceLinks.appendChild(createSourceLink(link));
  }
}

/** Create a source link element using safe DOM methods (no innerHTML) */
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
  arrow.textContent = '\u2192'; // →

  a.appendChild(info);
  a.appendChild(arrow);
  return a;
}

function renderStockInfo(result: Awaited<ReturnType<typeof searchComponent>>) {
  const stockInfo = document.getElementById('stockInfo')!;
  const stockPrimary = document.getElementById('stockPrimary')!;
  const variantList = document.getElementById('variantList')!;

  if (result.stock === undefined && !result.variants?.length) {
    stockInfo.classList.add('hidden');
    return;
  }

  stockInfo.classList.remove('hidden');
  stockPrimary.textContent = '';
  variantList.textContent = '';

  // Primary stock display
  if (result.stock !== undefined) {
    const stockClass = result.stock > 1000 ? 'in-stock' : result.stock > 0 ? 'low-stock' : 'no-stock';

    const count = document.createElement('span');
    count.className = `stock-count ${stockClass}`;
    count.textContent = result.stock.toLocaleString();

    const meta = document.createElement('div');
    meta.className = 'stock-meta';

    if (result.price) {
      const price = document.createElement('span');
      price.className = 'stock-price';
      price.textContent = `$${result.price.toFixed(4)}`;
      meta.appendChild(price);
    }
    if (result.package) {
      if (meta.childNodes.length > 0) meta.appendChild(document.createTextNode(' \u00b7 '));
      const pkg = document.createElement('span');
      pkg.className = 'stock-package';
      pkg.textContent = result.package;
      meta.appendChild(pkg);
    }

    stockPrimary.appendChild(count);
    stockPrimary.appendChild(meta);
  }

  // Variants
  if (result.variants?.length) {
    for (const v of result.variants) {
      const item = document.createElement('a');
      item.className = 'variant-item';
      item.href = v.lcscUrl;
      item.target = '_blank';
      item.rel = 'noopener';

      const mpn = document.createElement('span');
      mpn.className = 'variant-mpn';
      mpn.textContent = v.mpn;

      const right = document.createElement('span');
      right.className = 'variant-right';

      if (v.package) {
        const pkg = document.createElement('span');
        pkg.className = 'variant-pkg';
        pkg.title = v.package;
        pkg.textContent = v.package;
        right.appendChild(pkg);
      }

      const stock = document.createElement('span');
      stock.className = 'variant-stock';
      stock.textContent = v.stock.toLocaleString();
      right.appendChild(stock);

      if (v.price) {
        const price = document.createElement('span');
        price.className = 'variant-price';
        price.textContent = `$${v.price.toFixed(2)}`;
        right.appendChild(price);
      }

      item.appendChild(mpn);
      item.appendChild(right);
      variantList.appendChild(item);
    }
  }
}

function updateFileStatus(element: HTMLElement, available: boolean) {
  const statusEl = element.querySelector('.file-status')!;
  if (available) {
    element.classList.add('available');
    element.classList.remove('unavailable');
    statusEl.textContent = 'Available';
  } else {
    element.classList.remove('available');
    element.classList.add('unavailable');
    statusEl.textContent = 'Not found';
  }
}

async function handleInstall() {
  if (!currentPart || !currentAvailability) return;

  installBtn.disabled = true;
  installBtn.textContent = 'Installing...';
  installBtn.className = 'btn-primary installing';
  installStatus.classList.add('hidden');

  // Use the resolved LCSC ID from server search (important for DigiKey parts)
  const lcscId = currentAvailability?.lcscId || currentPart.lcscId;

  const result = await installComponent({
    mpn: currentPart.mpn,
    manufacturer: currentPart.manufacturer,
    lcscId,
    files: [], // Server will fetch and convert via easyeda2kicad
  });

  if (result.success) {
    installBtn.textContent = 'Installed!';
    installBtn.className = 'btn-primary success';
    installStatus.className = 'install-status success';
    installStatus.classList.remove('hidden');
    installStatus.textContent = `Installed ${result.installed.length} file(s) to KiCad library`;
  } else {
    installBtn.textContent = 'Install Failed';
    installBtn.className = 'btn-primary error';
    installStatus.className = 'install-status error';
    installStatus.classList.remove('hidden');
    installStatus.textContent = result.errors.join('; ');

    // Re-enable after 3s
    setTimeout(() => {
      installBtn.disabled = false;
      installBtn.textContent = 'Install to KiCad';
      installBtn.className = 'btn-primary';
    }, 3000);
  }
}

/** Initialize ZIP drag-and-drop zone */
function initDropZone() {
  const dropZone = document.getElementById('dropZone')!;
  const fileInput = document.getElementById('fileInput')! as HTMLInputElement;
  const uploadStatus = document.getElementById('uploadStatus')!;

  // Click to browse
  dropZone.addEventListener('click', () => fileInput.click());

  // File selected via browse
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) {
      handleZipUpload(fileInput.files[0], dropZone, uploadStatus);
      fileInput.value = '';
    }
  });

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file && (file.name.endsWith('.zip') || file.type === 'application/zip')) {
      handleZipUpload(file, dropZone, uploadStatus);
    } else {
      uploadStatus.classList.remove('hidden');
      uploadStatus.className = 'install-status error';
      uploadStatus.textContent = 'Please drop a .zip file';
    }
  });
}

async function handleZipUpload(file: File, dropZone: HTMLElement, statusEl: HTMLElement) {
  dropZone.classList.add('uploading');
  statusEl.classList.remove('hidden');
  statusEl.className = 'install-status';
  statusEl.textContent = `Uploading ${file.name}...`;

  const mpn = currentPart?.mpn;
  const result = await uploadZip(file, mpn);

  dropZone.classList.remove('uploading');

  if (result.success) {
    statusEl.className = 'install-status success';
    statusEl.textContent = `Installed ${result.installed.length} file(s) from ${file.name}`;
  } else {
    statusEl.className = 'install-status error';
    statusEl.textContent = result.errors.join('; ');
  }
}

init();
