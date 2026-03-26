/**
 * DigiKey content script — extracts MPN from JSON-LD structured data.
 * DigiKey server-renders JSON-LD in <script type="application/ld+json"> tags,
 * so this is available immediately at document_idle.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';

function extractPartFromJsonLd(): DetectedPart | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || '');

      // DigiKey puts product data either at top level or in @graph array
      const products: unknown[] = [];

      if (data?.['@type'] === 'Product') {
        products.push(data);
      }
      if (Array.isArray(data?.['@graph'])) {
        for (const item of data['@graph']) {
          if (item?.['@type'] === 'Product') {
            products.push(item);
          }
        }
      }

      for (const product of products) {
        const p = product as Record<string, unknown>;
        const mpn = p.mpn as string | undefined;
        if (mpn) {
          return {
            mpn,
            manufacturer: (p.brand as Record<string, string>)?.name || undefined,
            description: (p.name as string) || undefined,
            source: 'digikey',
            pageUrl: window.location.href,
          };
        }
      }
    } catch {
      // Ignore JSON parse errors — try next script tag
    }
  }
  return null;
}

// Run extraction and notify background (IIFE to avoid redeclaration on re-inject)
(() => {
  const part = extractPartFromJsonLd();
  if (part) {
    chrome.runtime.sendMessage({ type: 'PART_DETECTED', part });
  } else {
    chrome.runtime.sendMessage({ type: 'NO_PART_FOUND' });
  }
})();

// Re-export for testing
export { extractPartFromJsonLd };
