/**
 * Generate search URLs for secondary component sources.
 * These don't have APIs — we just link the user to the search page.
 */

import { SECONDARY_SOURCES } from '@kicad-part-finder/shared';

export interface SourceLink {
  name: string;
  url: string;
  description: string;
}

export function getSecondarySourceLinks(mpn: string): SourceLink[] {
  return [
    {
      name: 'SnapEDA',
      url: SECONDARY_SOURCES.snapeda(mpn),
      description: 'Native KiCad files, free download',
    },
    {
      name: 'Component Search Engine',
      url: SECONDARY_SOURCES.componentSearchEngine(mpn),
      description: 'SamacSys library, free account required',
    },
    {
      name: 'Ultra Librarian',
      url: SECONDARY_SOURCES.ultraLibrarian(mpn),
      description: 'Verified symbols & footprints',
    },
  ];
}
