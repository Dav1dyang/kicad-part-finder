/**
 * Persists server configuration to ~/.kicad-part-finder.json
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import type { ServerConfig } from '@kicad-part-finder/shared';
import { DEFAULT_PORT, LIBRARY_NAME } from '@kicad-part-finder/shared';

const CONFIG_PATH = join(homedir(), '.kicad-part-finder.json');

/** Resolve the project root from the running file path. Returns null if it can't be located. */
function findProjectVenv(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    // src/lib/config-store.ts or dist/lib/config-store.js → project root is 4 levels up
    // (lib → src|dist → server → packages → project root).
    const projectRoot = resolve(dirname(here), '..', '..', '..', '..');
    const candidate = join(projectRoot, '.venv', 'bin', 'easyeda2kicad');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Find easyeda2kicad in common locations. Order matters: env var > project venv > home venvs > PATH. */
function findConverterPath(): string {
  if (process.env.EASYEDA2KICAD_PATH) return process.env.EASYEDA2KICAD_PATH;

  const projectVenv = findProjectVenv();
  if (projectVenv) return projectVenv;

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
