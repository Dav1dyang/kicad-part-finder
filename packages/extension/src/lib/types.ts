/** A part found on a distributor page, or text the user highlighted. */
export interface DetectedPart {
  mpn: string;
  manufacturer?: string;
  description?: string;
  lcscId?: string;
  source: 'digikey' | 'lcsc' | 'selection';
  pageUrl: string;
  /** Set by "Search highlighted text": search as soon as the finder opens. */
  autoSearch?: boolean;
}
