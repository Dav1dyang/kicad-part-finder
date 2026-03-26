/**
 * Persists server configuration to ~/.kicad-part-finder.json
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ServerConfig } from '@kicad-part-finder/shared';
import { DEFAULT_PORT, LIBRARY_NAME } from '@kicad-part-finder/shared';

const CONFIG_PATH = join(homedir(), '.kicad-part-finder.json');

/** Find easyeda2kicad in common locations */
function findConverterPath(): string {
  if (process.env.EASYEDA2KICAD_PATH) return process.env.EASYEDA2KICAD_PATH;

  const home = homedir();
  const candidates = [
    join(home, 'kicad-venv', 'bin', 'easyeda2kicad'),
    join(home, '.local', 'bin', 'easyeda2kicad'),
    join(home, '.venv', 'bin', 'easyeda2kicad'),
    'easyeda2kicad', // system PATH fallback
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'easyeda2kicad';
}

const DEFAULT_CONFIG: ServerConfig = {
  port: DEFAULT_PORT,
  kicadVersion: '10.0',
  libraryMode: 'global',
  paths: {
    symbolDir: join(homedir(), 'KiCad', 'custom-libs', 'symbols'),
    footprintDir: join(homedir(), 'KiCad', 'custom-libs', 'footprints'),
    model3dDir: join(homedir(), 'KiCad', 'custom-libs', '3dmodels'),
    globalConfigDir: 'auto-detected',
    projectDir: null,
  },
  libraryName: LIBRARY_NAME,
  converterPath: findConverterPath(),
};

export async function loadConfig(): Promise<ServerConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const stored = JSON.parse(raw);
    // Merge with defaults to fill any missing fields
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      paths: { ...DEFAULT_CONFIG.paths, ...stored.paths },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: ServerConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
