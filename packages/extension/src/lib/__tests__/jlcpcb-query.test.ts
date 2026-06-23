/**
 * Unit tests for the pure MPN query-relaxation helper.
 * No DOM, no network, no FS.
 */
import { describe, it, expect } from 'vitest';
import { relaxMpnQuery } from '../jlcpcb';

describe('relaxMpnQuery', () => {
  it('relaxes a grade-suffixed MPN down to its numeric stem', () => {
    // The canonical failing case: TPS2116A is not a real catalog string, but
    // dropping the trailing letter run yields the real part TPS2116.
    const queries = relaxMpnQuery('TPS2116A');
    expect(queries[0]).toBe('TPS2116A'); // original always first
    expect(queries).toContain('TPS2116');
  });

  it('returns a pure LCSC id verbatim, never relaxed', () => {
    expect(relaxMpnQuery('C3235557')).toEqual(['C3235557']);
    // Case-insensitive on the prefix; still treated as an exact id.
    expect(relaxMpnQuery('c25804')).toEqual(['c25804']);
  });

  it('strips a multi-letter ordering suffix (LM358DR → LM358)', () => {
    const queries = relaxMpnQuery('LM358DR');
    expect(queries[0]).toBe('LM358DR');
    expect(queries).toContain('LM358');
  });

  it('falls back to the leading alphanumeric stem before a separator', () => {
    const queries = relaxMpnQuery('STM32F103C8T6-foo');
    expect(queries[0]).toBe('STM32F103C8T6-foo');
    // Leading stem up to the first separator.
    expect(queries).toContain('STM32F103C8T6');
  });

  it('de-dupes and caps at three queries', () => {
    const queries = relaxMpnQuery('TPS2116A');
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it('returns just the original when no relaxation applies', () => {
    // A plain stem with no digit-then-letter suffix and no separators.
    expect(relaxMpnQuery('NE555')).toEqual(['NE555']);
  });

  it('returns an empty list for blank input', () => {
    expect(relaxMpnQuery('')).toEqual([]);
    expect(relaxMpnQuery('   ')).toEqual([]);
  });

  it('trims surrounding whitespace before relaxing', () => {
    const queries = relaxMpnQuery('  TPS2116A  ');
    expect(queries[0]).toBe('TPS2116A');
    expect(queries).toContain('TPS2116');
  });
});
