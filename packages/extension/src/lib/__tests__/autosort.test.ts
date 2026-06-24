/**
 * Unit tests for the pure category -> bucket auto-sort map.
 * No DOM, no network, no FS.
 */
import { describe, it, expect } from 'vitest';
import {
  BUCKETS,
  DEFAULT_BUCKET,
  LIBRARY_CHOICES,
  categoryToBucket,
} from '../autosort';

describe('categoryToBucket', () => {
  it('maps the canonical example categories from the spec', () => {
    expect(categoryToBucket('Power Management')).toBe('Power');
    expect(categoryToBucket('Connectors')).toBe('Connector');
    expect(categoryToBucket('LED')).toBe('Light');
    expect(categoryToBucket('Optoelectronic')).toBe('Light');
    expect(categoryToBucket('MOSFET')).toBe('Discrete');
    expect(categoryToBucket('Diode')).toBe('Discrete');
    expect(categoryToBucket('Resistor')).toBe('Discrete');
    expect(categoryToBucket('Capacitor')).toBe('Discrete');
    expect(categoryToBucket('Switch')).toBe('Switch');
    expect(categoryToBucket('Logic')).toBe('IC');
    expect(categoryToBucket('Microcontroller')).toBe('IC');
    expect(categoryToBucket('Amplifier')).toBe('IC');
    expect(categoryToBucket('Sensor')).toBe('IC');
    expect(categoryToBucket('Mechanical')).toBe('Mechanical');
    expect(categoryToBucket('Hardware')).toBe('Mechanical');
  });

  it('is case-insensitive and matches substrings within real JLCPCB category text', () => {
    expect(categoryToBucket('Power Management ICs')).toBe('Power');
    expect(categoryToBucket('optoelectronic devices / LEDs')).toBe('Light');
    expect(categoryToBucket('Connectors / USB Connectors')).toBe('Connector');
    expect(categoryToBucket('MOSFETs / N-Channel')).toBe('Discrete');
    expect(categoryToBucket('Embedded / Microcontroller Units (MCUs)')).toBe('IC');
  });

  it('prefers the more specific rule when several keywords could match', () => {
    // "Power Management" must win over a stray generic word; "gate driver" is an
    // IC even though "driver" alone could be ambiguous.
    expect(categoryToBucket('Power Management')).toBe('Power');
    expect(categoryToBucket('Gate Drivers')).toBe('IC');
    // A tactile switch is a Switch, not mis-bucketed.
    expect(categoryToBucket('Tactile Switches')).toBe('Switch');
  });

  it('classifies a spread of additional common categories', () => {
    expect(categoryToBucket('Voltage Regulators - Linear, LDO')).toBe('Power');
    expect(categoryToBucket('Crystals')).toBe('IC');
    expect(categoryToBucket('Crystal Resonators')).toBe('Discrete');
    expect(categoryToBucket('Inductors, Coils, Chokes')).toBe('Discrete');
    expect(categoryToBucket('TVS Diodes')).toBe('Discrete');
    expect(categoryToBucket('Pin Headers')).toBe('Connector');
    expect(categoryToBucket('Standoffs / Spacers')).toBe('Mechanical');
    expect(categoryToBucket('Tactile')).toBe('Switch');
    expect(categoryToBucket('Relays')).toBe('Switch');
    expect(categoryToBucket('LCD Displays')).toBe('Light');
  });

  it('falls back to the default bucket (IC) for empty/unknown input', () => {
    expect(categoryToBucket('')).toBe(DEFAULT_BUCKET);
    expect(categoryToBucket(null)).toBe(DEFAULT_BUCKET);
    expect(categoryToBucket(undefined)).toBe(DEFAULT_BUCKET);
    expect(categoryToBucket('Some Wholly Unrecognised Category')).toBe(DEFAULT_BUCKET);
    expect(DEFAULT_BUCKET).toBe('IC');
  });

  it('only ever returns one of the seven buckets', () => {
    const samples = [
      'Power', 'LED', 'Connector', 'MOSFET', 'Switch', 'Logic', 'Hardware',
      'gibberish', '', 'Capacitor', 'Sensor',
    ];
    for (const s of samples) {
      expect(BUCKETS).toContain(categoryToBucket(s));
    }
  });
});

describe('LIBRARY_CHOICES', () => {
  it('is the seven buckets plus the KiCadPartFinder catch-all', () => {
    expect(LIBRARY_CHOICES).toEqual([...BUCKETS, 'KiCadPartFinder']);
    expect(LIBRARY_CHOICES).toHaveLength(8);
  });
});
