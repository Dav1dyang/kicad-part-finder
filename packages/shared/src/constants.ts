export const DEFAULT_PORT = 3456;
export const SERVER_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
export const LIBRARY_NAME = 'KiCadPartFinder';

/** EasyEDA API endpoints (no auth required) */
export const EASYEDA_API = {
  /** Fetch component data by LCSC ID */
  componentByLcsc: (lcscId: string) =>
    `https://easyeda.com/api/products/${lcscId}/components?version=6.4.19.5`,
  /** Search for components by keyword/MPN */
  search: (keyword: string) =>
    `https://easyeda.com/api/components/search?keyword=${encodeURIComponent(keyword)}`,
  /** Download 3D STEP model by UUID */
  stepModel: (uuid: string) =>
    `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${uuid}`,
} as const;

/** Secondary source search URLs */
export const SECONDARY_SOURCES = {
  /** SnapEDA/SnapMagic Search — search by part number */
  snapeda: (mpn: string) =>
    `https://www.snapeda.com/search/?q=${encodeURIComponent(mpn)}&search-type=parts`,
  componentSearchEngine: (mpn: string) =>
    `https://componentsearchengine.com/part-view/${encodeURIComponent(mpn)}`,
  ultraLibrarian: (mpn: string) =>
    `https://app.ultralibrarian.com/search?q=${encodeURIComponent(mpn)}`,
} as const;

/** Supported distributor sites for content script matching */
export const SUPPORTED_SITES = {
  digikey: {
    name: 'DigiKey',
    matchPatterns: [
      'https://www.digikey.com/*/products/detail/*',
      'https://www.digikey.*/*/products/detail/*',
    ],
  },
  lcsc: {
    name: 'LCSC',
    matchPatterns: [
      'https://www.lcsc.com/product-detail/*',
      'https://lcsc.com/product-detail/*',
    ],
  },
} as const;
