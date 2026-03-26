/**
 * Tests for LCSC MPN/C-number extraction.
 */
import { describe, it, expect } from 'vitest';

// Pure extraction functions (no chrome API dependency)
function extractLcscIdFromUrl(pathname: string): string | null {
  const match = pathname.match(/product-detail\/(?:.*_)?(C\d+)\.html/);
  return match ? match[1] : null;
}

describe('LCSC C-Number Extraction from URL', () => {
  it('extracts C-number from simple URL', () => {
    expect(extractLcscIdFromUrl('/product-detail/C2040.html')).toBe('C2040');
  });

  it('extracts C-number from URL with part name prefix', () => {
    expect(
      extractLcscIdFromUrl('/product-detail/STMicroelectronics-STM32F103C8T6_C8734.html')
    ).toBe('C8734');
  });

  it('extracts large C-numbers', () => {
    expect(extractLcscIdFromUrl('/product-detail/C123456789.html')).toBe('C123456789');
  });

  it('returns null for non-product URLs', () => {
    expect(extractLcscIdFromUrl('/search?q=stm32')).toBeNull();
  });

  it('returns null for category pages', () => {
    expect(extractLcscIdFromUrl('/products/Microcontrollers-MCU_11027.html')).toBeNull();
  });

  it('handles URL with multiple underscores in name', () => {
    expect(
      extractLcscIdFromUrl('/product-detail/Texas-Instruments_LM7805CT_NOPB_C55450.html')
    ).toBe('C55450');
  });
});
