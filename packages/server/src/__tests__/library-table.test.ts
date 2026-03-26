/**
 * Tests for KiCad library table parsing and updating.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { ensureLibraryTableEntry } from '../kicad/library-table.js';
import type { ServerConfig } from '@kicad-part-finder/shared';

describe('Library Table Updates', () => {
  let tempDir: string;
  let config: ServerConfig;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kicad-test-'));

    config = {
      port: 3456,
      kicadVersion: '10.0',
      libraryMode: 'global',
      paths: {
        symbolDir: join(tempDir, 'symbols'),
        footprintDir: join(tempDir, 'footprints'),
        model3dDir: join(tempDir, '3dmodels'),
        globalConfigDir: tempDir,
        projectDir: null,
      },
      libraryName: 'KiCadPartFinder',
      converterPath: 'easyeda2kicad',
    };

    // Create mock library table files
    await writeFile(
      join(tempDir, 'sym-lib-table'),
      `(sym_lib_table\n  (version 7)\n  (lib (name "Device") (type "KiCad") (uri "\${KICAD10_SYMBOL_DIR}/Device.kicad_symdir") (options "") (descr ""))\n)\n`,
      'utf-8'
    );

    await writeFile(
      join(tempDir, 'fp-lib-table'),
      `(fp_lib_table\n  (version 7)\n  (lib (name "Package_SO") (type "KiCad") (uri "\${KICAD10_FOOTPRINT_DIR}/Package_SO.pretty") (options "") (descr ""))\n)\n`,
      'utf-8'
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('adds KiCadPartFinder entry to sym-lib-table', async () => {
    const result = await ensureLibraryTableEntry(config);
    expect(result.updated).toBe(true);

    const content = await readFile(join(tempDir, 'sym-lib-table'), 'utf-8');
    expect(content).toContain('(name "KiCadPartFinder")');
    expect(content).toContain('KiCadPartFinder.kicad_sym');
    // Original entry should still be there
    expect(content).toContain('(name "Device")');
  });

  it('adds KiCadPartFinder entry to fp-lib-table', async () => {
    await ensureLibraryTableEntry(config);

    const content = await readFile(join(tempDir, 'fp-lib-table'), 'utf-8');
    expect(content).toContain('(name "KiCadPartFinder")');
    expect(content).toContain('KiCadPartFinder.pretty');
    // Original entry should still be there
    expect(content).toContain('(name "Package_SO")');
  });

  it('does not duplicate entry on second call', async () => {
    await ensureLibraryTableEntry(config);
    const result2 = await ensureLibraryTableEntry(config);
    expect(result2.updated).toBe(false);

    const content = await readFile(join(tempDir, 'sym-lib-table'), 'utf-8');
    const matches = content.match(/KiCadPartFinder/g);
    // Should appear only in one lib entry (name + uri = 2 occurrences)
    expect(matches!.length).toBe(2);
  });

  it('creates backup before modifying', async () => {
    await ensureLibraryTableEntry(config);

    const backupExists = await readFile(join(tempDir, 'sym-lib-table.bak'), 'utf-8');
    expect(backupExists).toContain('(name "Device")');
    expect(backupExists).not.toContain('KiCadPartFinder');
  });

  it('preserves valid S-expression structure', async () => {
    await ensureLibraryTableEntry(config);

    const content = await readFile(join(tempDir, 'sym-lib-table'), 'utf-8');
    // Should start with ( and end with )
    const trimmed = content.trim();
    expect(trimmed.startsWith('(sym_lib_table')).toBe(true);
    expect(trimmed.endsWith(')')).toBe(true);

    // Count parens should be balanced
    const opens = (trimmed.match(/\(/g) || []).length;
    const closes = (trimmed.match(/\)/g) || []).length;
    expect(opens).toBe(closes);
  });
});
