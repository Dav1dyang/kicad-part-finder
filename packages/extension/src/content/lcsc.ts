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

// Run extraction (IIFE to avoid redeclaration on re-inject)
(() => {
  const lcscId = extractLcscIdFromUrl();

  if (lcscId) {
    const part: DetectedPart = {
      mpn: lcscId,
      lcscId,
      source: 'lcsc',
      pageUrl: window.location.href,
    };

    chrome.runtime.sendMessage({ type: 'PART_DETECTED', part });

    observeForMpn((mpn) => {
      part.mpn = mpn;
      chrome.runtime.sendMessage({ type: 'PART_DETECTED', part });
    });
  } else {
    chrome.runtime.sendMessage({ type: 'NO_PART_FOUND' });
  }
})();

// Re-export for testing
export { extractLcscIdFromUrl, tryExtractMpn };
