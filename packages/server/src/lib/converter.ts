/**
 * Interface to easyeda2kicad Python CLI for converting
 * EasyEDA component data to KiCad format.
 *
 * easyeda2kicad output structure for `--output=/tmp/dir/Part`:
 *   /tmp/dir/Part.kicad_sym          (symbol library)
 *   /tmp/dir/Part.pretty/            (footprint directory)
 *   /tmp/dir/Part.pretty/FP.kicad_mod
 *   /tmp/dir/Part.3dshapes/          (3D models directory)
 *   /tmp/dir/Part.3dshapes/Model.step
 *   /tmp/dir/Part.3dshapes/Model.wrl
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import type { ComponentFile } from '@kicad-part-finder/shared';

const execFileAsync = promisify(execFile);

interface ConverterResult {
  files: ComponentFile[];
  error?: string;
}

/** Check if easyeda2kicad CLI is available */
export async function checkConverterAvailable(converterPath: string): Promise<boolean> {
  try {
    await execFileAsync(converterPath, ['--help'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Run easyeda2kicad to fetch and convert a component by LCSC ID */
export async function runConverter(
  converterPath: string,
  lcscId: string,
  mpn?: string
): Promise<ConverterResult> {
  // Validate LCSC ID format: must be 'C' followed by digits only
  if (!/^C\d+$/.test(lcscId)) {
    return {
      files: [],
      error: `Invalid LCSC ID format: ${lcscId}. Expected 'C' followed by digits (e.g., C12345).`,
    };
  }

  const available = await checkConverterAvailable(converterPath);
  if (!available) {
    return {
      files: [],
      error: `easyeda2kicad not found. Install it with: pip install easyeda2kicad`,
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'kicad-part-'));
  const outputBase = join(tempDir, 'component');

  try {
    // --output is a base path: creates component.kicad_sym, component.pretty/, component.3dshapes/
    await execFileAsync(converterPath, [
      '--full',
      `--lcsc_id=${lcscId}`,
      `--output=${outputBase}`,
    ], {
      timeout: 60_000,
      cwd: tempDir,
    });

    const files: ComponentFile[] = [];

    // Read symbol file: component.kicad_sym
    const symPath = `${outputBase}.kicad_sym`;
    if (existsSync(symPath)) {
      const content = await readFile(symPath, 'utf-8');
      files.push({
        filename: `${lcscId}.kicad_sym`,
        content,
        encoding: 'utf-8',
        type: 'symbol',
      });
    }

    // Read footprint files: component.pretty/*.kicad_mod
    const prettyDir = `${outputBase}.pretty`;
    if (existsSync(prettyDir)) {
      const modFiles = await readdir(prettyDir);
      for (const modFile of modFiles) {
        if (modFile.endsWith('.kicad_mod')) {
          const content = await readFile(join(prettyDir, modFile), 'utf-8');
          files.push({
            filename: modFile,
            content,
            encoding: 'utf-8',
            type: 'footprint',
          });
        }
      }
    }

    // Read 3D model files: component.3dshapes/*.step and *.wrl
    const shapesDir = `${outputBase}.3dshapes`;
    if (existsSync(shapesDir)) {
      const modelFiles = await readdir(shapesDir);
      for (const modelFile of modelFiles) {
        if (modelFile.endsWith('.step') || modelFile.endsWith('.wrl')) {
          const content = await readFile(join(shapesDir, modelFile));
          files.push({
            filename: modelFile,
            content: content.toString('base64'),
            encoding: 'base64',
            type: '3dmodel',
          });
        }
      }
    }

    if (files.length === 0) {
      return {
        files: [],
        error: `easyeda2kicad produced no output for ${lcscId}. The part may not exist in the EasyEDA library.`,
      };
    }

    return { files };
  } catch (err) {
    return {
      files: [],
      error: `Converter failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
