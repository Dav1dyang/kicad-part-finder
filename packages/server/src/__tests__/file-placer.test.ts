/**
 * Tests for file placement into KiCad library directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, existsSync } from 'fs';
import { placeFiles } from '../kicad/file-placer.js';
import type { ComponentFile, ServerConfig } from '@kicad-part-finder/shared';

describe('File Placer', () => {
  let tempDir: string;
  let config: ServerConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kicad-placer-'));
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
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('places a symbol file in the symbols directory', async () => {
    const files: ComponentFile[] = [{
      filename: 'STM32F103C8T6.kicad_sym',
      content: '(kicad_symbol_lib (version 20241001) (symbol "STM32F103C8T6" (pin_names)))',
      encoding: 'utf-8',
      type: 'symbol',
    }];

    const placed = await placeFiles(files, config);
    expect(placed).toHaveLength(1);
    expect(placed[0].type).toBe('symbol');

    const content = await readFile(placed[0].path, 'utf-8');
    expect(content).toContain('STM32F103C8T6');
  });

  it('places a footprint file in the .pretty directory', async () => {
    const files: ComponentFile[] = [{
      filename: 'LQFP-48.kicad_mod',
      content: '(module "LQFP-48" (layer "F.Cu"))',
      encoding: 'utf-8',
      type: 'footprint',
    }];

    const placed = await placeFiles(files, config);
    expect(placed).toHaveLength(1);
    expect(placed[0].type).toBe('footprint');
    expect(placed[0].path).toContain('KiCadPartFinder.pretty');
  });

  it('places a 3D model file from base64', async () => {
    const stepContent = 'ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION();';
    const files: ComponentFile[] = [{
      filename: 'STM32F103C8T6.step',
      content: Buffer.from(stepContent).toString('base64'),
      encoding: 'base64',
      type: '3dmodel',
    }];

    const placed = await placeFiles(files, config);
    expect(placed).toHaveLength(1);
    expect(placed[0].type).toBe('3dmodel');

    const content = await readFile(placed[0].path, 'utf-8');
    expect(content).toContain('ISO-10303-21');
  });

  it('creates directories that do not exist', async () => {
    const files: ComponentFile[] = [{
      filename: 'test.kicad_sym',
      content: '(kicad_symbol_lib)',
      encoding: 'utf-8',
      type: 'symbol',
    }];

    expect(existsSync(join(tempDir, 'symbols'))).toBe(false);
    await placeFiles(files, config);
    expect(existsSync(join(tempDir, 'symbols'))).toBe(true);
  });

  it('handles multiple files at once', async () => {
    const files: ComponentFile[] = [
      { filename: 'sym.kicad_sym', content: '(sym)', encoding: 'utf-8', type: 'symbol' },
      { filename: 'fp.kicad_mod', content: '(mod)', encoding: 'utf-8', type: 'footprint' },
      { filename: 'model.step', content: Buffer.from('STEP').toString('base64'), encoding: 'base64', type: '3dmodel' },
    ];

    const placed = await placeFiles(files, config);
    expect(placed).toHaveLength(3);
  });
});
