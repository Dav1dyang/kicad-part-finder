/**
 * Auto-detect KiCad installation paths per OS.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

interface KicadPaths {
  configDir: string;
  defaultLibDir: string;
}

const KICAD_VERSIONS = ['10.0', '9.0', '8.0', '7.0'];

export function detectKicadPaths(): KicadPaths | null {
  const home = homedir();
  const os = platform();

  for (const version of KICAD_VERSIONS) {
    let configDir: string;

    switch (os) {
      case 'darwin':
        configDir = join(home, 'Library', 'Preferences', 'kicad', version);
        break;
      case 'linux':
        configDir = join(home, '.config', 'kicad', version);
        break;
      case 'win32':
        configDir = join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'kicad', version);
        break;
      default:
        continue;
    }

    if (existsSync(configDir)) {
      // Use a custom libs directory in user's home
      const defaultLibDir = join(home, 'KiCad', 'custom-libs');
      return { configDir, defaultLibDir };
    }
  }

  return null;
}

/** Get the path to a specific library table file */
export function getLibraryTablePath(
  configDir: string,
  type: 'symbol' | 'footprint'
): string {
  const filename = type === 'symbol' ? 'sym-lib-table' : 'fp-lib-table';
  return join(configDir, filename);
}
