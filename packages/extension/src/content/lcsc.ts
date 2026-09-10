/**
 * LCSC content script — extracts LCSC part number from URL and MPN from DOM.
 * LCSC is a Vue SPA, so DOM content requires MutationObserver.
 * The C-number in the URL is the primary key for the EasyEDA API.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';

/** Extract LCSC C-number from the URL path */
function extractLcscIdFromUrl(): string | null {
  // Patterns:
  //   /product-detail/C2040.html
  //   /product-detail/Some-Part-Name_C2040.html
  const match = window.location.pathname.match(/product-detail\/(?:.*_)?(C\d+)\.html/);
  return match ? match[1] : null;
}

/** Observe the DOM for MPN after Vue renders the product detail table */
function observeForMpn(callback: (mpn: string) => void): void {
  // Try immediately first (page may already be rendered)
  const immediate = tryExtractMpn();
  if (immediate) {
    callback(immediate);
    return;
  }

  const observer = new MutationObserver(() => {
    const mpn = tryExtractMpn();
    if (mpn) {
      observer.disconnect();
      callback(mpn);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Timeout after 10 seconds
  setTimeout(() => observer.disconnect(), 10_000);
}

/** Try to extract MPN from the rendered product detail table */
function tryExtractMpn(): string | null {
  // LCSC renders part info in table rows with labels like "Mfr.Part" or "MPN"
  const rows = document.querySelectorAll(
    '.product-info-table tr, .info-cont tr, [class*="product-detail"] tr, table tr'
  );

  for (const row of rows) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length >= 2) {
      const label = (cells[0].textContent || '').trim().toLowerCase();
      if (label.includes('mfr') || label.includes('mpn') || label.includes('manufacturer part')) {
        const value = (cells[1].textContent || '').trim();
        if (value && value.length > 1) {
          return value;
        }
      }
    }
  }

  return null;
}

// Run extraction (IIFE to avoid redeclaration on re-inject). LCSC is a Vue SPA:
// clicking a related part changes the URL without a reload, so the C-number is
// re-read whenever the location changes and the part is re-announced.
(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__kicadLcscActive) return;
  w.__kicadLcscActive = true;

  function send(message: Record<string, unknown>) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => {});
    } catch {
      /* extension reloaded underneath the page */
    }
  }

  let announcedFor = '';

  function announce() {
    const lcscId = extractLcscIdFromUrl();
    const key = `${lcscId ?? ''}@${location.pathname}`;
    if (key === announcedFor) return;
    announcedFor = key;

    if (!lcscId) {
      send({ type: 'NO_PART_FOUND' });
      return;
    }
    const part: DetectedPart = { mpn: lcscId, lcscId, source: 'lcsc', pageUrl: window.location.href };
    send({ type: 'PART_DETECTED', part });
    observeForMpn((mpn) => {
      // The page may have moved on while we waited for the table to render.
      if (extractLcscIdFromUrl() !== lcscId) return;
      part.mpn = mpn;
      send({ type: 'PART_DETECTED', part });
    });
  }

  announce();

  // Detect client-side navigation: history API + a light poll as a safety net.
  let lastHref = location.href;
  const check = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      announce();
    }
  };
  window.addEventListener('popstate', check);
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = ((...args: Parameters<History['pushState']>) => {
    origPush(...args);
    check();
  }) as History['pushState'];
  history.replaceState = ((...args: Parameters<History['replaceState']>) => {
    origReplace(...args);
    check();
  }) as History['replaceState'];
  setInterval(check, 1000);
})();

// Re-export for testing
export { extractLcscIdFromUrl, tryExtractMpn };
