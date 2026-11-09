/**
 * Other places to get a symbol and footprint when EasyEDA has nothing usable.
 * None of them offers a public API, so these are search links the user opens.
 * Each one publishes native KiCad files and needs a free account to download.
 */

export interface SourceLink {
  name: string;
  url: string;
  description: string;
}

export function getSecondarySourceLinks(mpn: string): SourceLink[] {
  const q = encodeURIComponent(mpn.trim());
  return [
    {
      name: 'Ultra Librarian',
      url: `https://app.ultralibrarian.com/search?q=${q}`,
      description: 'Often made with the manufacturer. Free account.',
    },
    {
      name: 'SnapMagic (SnapEDA)',
      url: `https://www.snapeda.com/search/?q=${q}&search-type=parts`,
      description: 'KiCad files with a quality check. Free account.',
    },
    {
      name: 'Component Search Engine',
      url: `https://componentsearchengine.com/part-view/${q}`,
      description: 'SamacSys models, also behind Mouser. Free account.',
    },
  ];
}
