/**
 * Tests for DigiKey MPN extraction from JSON-LD.
 * Uses pure data parsing — no DOM dependency.
 */
import { describe, it, expect } from 'vitest';

/** Parse JSON-LD data and extract MPN (mirrors the logic in digikey.ts) */
function extractPartFromJsonLdData(jsonLdItems: unknown[]) {
  for (const data of jsonLdItems) {
    try {
      const products: unknown[] = [];
      const d = data as Record<string, unknown>;
      if (d?.['@type'] === 'Product') products.push(d);
      if (Array.isArray(d?.['@graph'])) {
        for (const item of d['@graph']) {
          if (item?.['@type'] === 'Product') products.push(item);
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
            source: 'digikey' as const,
          };
        }
      }
    } catch {}
  }
  return null;
}

describe('DigiKey MPN Extraction', () => {
  it('extracts MPN from top-level Product', () => {
    const result = extractPartFromJsonLdData([{
      '@type': 'Product',
      mpn: 'STM32F103C8T6',
      name: 'IC MCU 32BIT 64KB FLASH 48LQFP',
      brand: { name: 'STMicroelectronics' },
    }]);

    expect(result).not.toBeNull();
    expect(result!.mpn).toBe('STM32F103C8T6');
    expect(result!.manufacturer).toBe('STMicroelectronics');
    expect(result!.description).toBe('IC MCU 32BIT 64KB FLASH 48LQFP');
  });

  it('extracts MPN from @graph array', () => {
    const result = extractPartFromJsonLdData([{
      '@graph': [
        { '@type': 'BreadcrumbList' },
        { '@type': 'Organization' },
        {
          '@type': 'Product',
          mpn: 'LM7805CT',
          name: 'IC REG LINEAR 5V 1.5A TO220-3',
          brand: { name: 'Texas Instruments' },
        },
      ],
    }]);

    expect(result).not.toBeNull();
    expect(result!.mpn).toBe('LM7805CT');
    expect(result!.manufacturer).toBe('Texas Instruments');
  });

  it('returns null when no data provided', () => {
    expect(extractPartFromJsonLdData([])).toBeNull();
  });

  it('returns null when data has no Product type', () => {
    const result = extractPartFromJsonLdData([{
      '@type': 'WebPage',
      name: 'DigiKey Product Page',
    }]);
    expect(result).toBeNull();
  });

  it('returns null when Product has no mpn field', () => {
    const result = extractPartFromJsonLdData([{
      '@type': 'Product',
      name: 'Some component',
      brand: { name: 'Acme' },
    }]);
    expect(result).toBeNull();
  });

  it('handles Product without brand', () => {
    const result = extractPartFromJsonLdData([{
      '@type': 'Product',
      mpn: 'ATMEGA328P-AU',
      name: 'IC MCU 8BIT 32KB FLASH 32TQFP',
    }]);

    expect(result).not.toBeNull();
    expect(result!.mpn).toBe('ATMEGA328P-AU');
    expect(result!.manufacturer).toBeUndefined();
  });

  it('skips non-Product items and finds the Product', () => {
    const result = extractPartFromJsonLdData([
      { '@type': 'WebPage', name: 'Page' },
      { '@type': 'Product', mpn: 'NE555P', brand: { name: 'Texas Instruments' } },
    ]);

    expect(result).not.toBeNull();
    expect(result!.mpn).toBe('NE555P');
  });

  it('picks first Product with mpn when multiple exist', () => {
    const result = extractPartFromJsonLdData([{
      '@graph': [
        { '@type': 'Product', mpn: 'FIRST-PART', brand: { name: 'A' } },
        { '@type': 'Product', mpn: 'SECOND-PART', brand: { name: 'B' } },
      ],
    }]);

    expect(result!.mpn).toBe('FIRST-PART');
  });
});
