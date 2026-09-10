/**
 * Auto-sort: deterministic mapping from EasyEDA / JLCPCB category text to one of
 * the seven `DavidLib_<bucket>` library buckets.
 *
 * This is PURE (no DOM, no network, no FS) so it is unit-tested directly. The UI
 * uses it to pre-select the bucket dropdown; the user can always override.
 */

/** The seven first-class library buckets the user organises parts into. */
export const BUCKETS = [
  'Power',
  'Connector',
  'Light',
  'Discrete',
  'Switch',
  'IC',
  'Mechanical',
] as const;

export type Bucket = (typeof BUCKETS)[number];

/** When no category rule matches, parts land in IC (the UI lets the user change it). */
export const DEFAULT_BUCKET: Bucket = 'IC';

/**
 * The full set of library nicknames the dropdown offers: the seven buckets plus
 * the catch-all `KiCadPartFinder` library. (`KiCadPartFinder` is intentionally
 * NOT a Bucket — it's the legacy single-library destination.)
 */
export const LIBRARY_CHOICES = [...BUCKETS, 'KiCadPartFinder'] as const;
export type LibraryChoice = (typeof LIBRARY_CHOICES)[number];

/**
 * Ordered keyword → bucket rules. The FIRST substring match (case-insensitive)
 * wins, so more specific keywords are listed before generic ones. Each rule's
 * keyword is matched against the lower-cased category string.
 *
 * Rationale for a few non-obvious choices:
 *  - "Optoelectronic" / "LED" → Light (LEDs, displays, opto-isolators are the
 *    light bucket).
 *  - MOSFET / diode / resistor / capacitor / inductor → Discrete (two-/three-
 *    terminal passives & discretes).
 *  - Logic / MCU / amplifier / sensor / regulator-as-IC → IC.
 *  - "Power Management" → Power (PMICs, LDOs, DC-DC, battery management).
 */
const RULES: ReadonlyArray<readonly [keyword: string, bucket: Bucket]> = [
  // --- Power (checked early so "Power Management" beats a stray "Management") ---
  ['power management', 'Power'],
  ['power supply', 'Power'],
  ['dc-dc', 'Power'],
  ['dc dc', 'Power'],
  ['ldo', 'Power'],
  ['voltage regulator', 'Power'],
  ['battery management', 'Power'],
  ['battery protection', 'Power'],
  ['pmic', 'Power'],
  ['power', 'Power'],

  // --- IC families that contain a Light/Connector keyword (checked first) ---
  ['led driver', 'IC'],
  ['display driver', 'IC'],
  ['usb interface', 'IC'],
  ['usb converter', 'IC'],
  ['interface ic', 'IC'],
  ['driver ic', 'IC'],
  ['gate driver', 'IC'],
  ['motor driver', 'IC'],

  // --- Light / optoelectronics ---
  ['optoelectronic', 'Light'],
  ['opto', 'Light'],
  ['led', 'Light'],
  ['light emitting', 'Light'],
  ['display', 'Light'],
  ['lcd', 'Light'],
  ['oled', 'Light'],
  ['photodiode', 'Light'],
  ['phototransistor', 'Light'],
  ['laser', 'Light'],
  ['lamp', 'Light'],

  // --- Connector ---
  ['connector', 'Connector'],
  ['header', 'Connector'],
  ['terminal block', 'Connector'],
  ['usb', 'Connector'],
  ['socket', 'Connector'],
  ['jack', 'Connector'],
  ['receptacle', 'Connector'],
  ['ffc', 'Connector'],
  ['fpc', 'Connector'],

  // --- Switch ---
  ['tactile', 'Switch'],
  ['push button', 'Switch'],
  ['pushbutton', 'Switch'],
  ['dip switch', 'Switch'],
  ['rotary switch', 'Switch'],
  ['slide switch', 'Switch'],
  ['toggle switch', 'Switch'],
  ['rocker switch', 'Switch'],
  ['encoder', 'Switch'],
  ['relay', 'Switch'],
  ['switch', 'Switch'],

  // --- IC (named families before the generic discretes below) ---
  ['microcontroller', 'IC'],
  ['microprocessor', 'IC'],
  ['mcu', 'IC'],
  ['fpga', 'IC'],
  ['logic', 'IC'],
  ['amplifier', 'IC'],
  ['op-amp', 'IC'],
  ['op amp', 'IC'],
  ['opamp', 'IC'],
  ['comparator', 'IC'],
  ['sensor', 'IC'],
  ['adc', 'IC'],
  ['dac', 'IC'],
  ['interface', 'IC'],
  ['driver ic', 'IC'],
  ['gate driver', 'IC'],
  ['motor driver', 'IC'],
  ['memory', 'IC'],
  ['eeprom', 'IC'],
  ['flash', 'IC'],
  ['rtc', 'IC'],
  ['clock', 'IC'],
  ['crystal resonator', 'Discrete'],
  ['oscillator', 'IC'],
  ['crystal', 'IC'],
  ['transceiver', 'IC'],
  ['rf', 'IC'],
  ['wireless', 'IC'],
  ['embedded', 'IC'],
  ['integrated circuit', 'IC'],

  // --- Discrete (passives & two/three-terminal discretes) ---
  ['mosfet', 'Discrete'],
  ['transistor', 'Discrete'],
  ['bjt', 'Discrete'],
  ['igbt', 'Discrete'],
  ['thyristor', 'Discrete'],
  ['triac', 'Discrete'],
  ['diode', 'Discrete'],
  ['rectifier', 'Discrete'],
  ['zener', 'Discrete'],
  ['schottky', 'Discrete'],
  ['tvs', 'Discrete'],
  ['varistor', 'Discrete'],
  ['resistor', 'Discrete'],
  ['potentiometer', 'Discrete'],
  ['capacitor', 'Discrete'],
  ['inductor', 'Discrete'],
  ['ferrite', 'Discrete'],
  ['bead', 'Discrete'],
  ['fuse', 'Discrete'],
  ['resonator', 'Discrete'],

  // --- Mechanical / hardware ---
  ['mechanical', 'Mechanical'],
  ['hardware', 'Mechanical'],
  ['standoff', 'Mechanical'],
  ['screw', 'Mechanical'],
  ['spacer', 'Mechanical'],
  ['nut', 'Mechanical'],
  ['washer', 'Mechanical'],
  ['mounting', 'Mechanical'],
  ['heatsink', 'Mechanical'],
  ['heat sink', 'Mechanical'],
  ['enclosure', 'Mechanical'],
  ['bracket', 'Mechanical'],
];

/**
 * Map a free-text category string (e.g. "Power Management ICs", "LEDs",
 * "Connectors") to a library bucket. Returns {@link DEFAULT_BUCKET} when nothing
 * matches or the input is empty.
 *
 * Matching is case-insensitive substring against an ordered rule list, so
 * "Optoelectronic Devices / LEDs" resolves to `Light`.
 */
export function categoryToBucket(category: string | null | undefined): Bucket {
  if (!category) return DEFAULT_BUCKET;
  const haystack = category.toLowerCase();
  for (const [keyword, bucket] of RULES) {
    if (haystack.includes(keyword)) return bucket;
  }
  return DEFAULT_BUCKET;
}
