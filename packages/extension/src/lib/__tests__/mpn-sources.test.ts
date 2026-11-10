import { describe, expect, it } from 'vitest';
import { getSecondarySourceLinks } from '../mpn-sources';

describe('getSecondarySourceLinks', () => {
  it('links three sources, each with a short description', () => {
    const links = getSecondarySourceLinks('TPS2116DRLR');
    expect(links.map((l) => l.name)).toEqual(['Ultra Librarian', 'SnapMagic (SnapEDA)', 'Component Search Engine']);
    for (const l of links) {
      expect(l.url).toMatch(/^https:\/\//);
      expect(l.url).toContain('TPS2116DRLR');
      expect(l.description.length).toBeGreaterThan(0);
    }
  });

  it('trims and encodes the part number', () => {
    for (const l of getSecondarySourceLinks('  AB/12 #3&x  ')) {
      expect(l.url).toContain('AB%2F12%20%233%26x');
      expect(l.url).not.toMatch(/\s/);
    }
  });
});
