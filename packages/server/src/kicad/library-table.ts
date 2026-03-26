/**
 * Parse and update KiCad sym-lib-table and fp-lib-table files.
 *
 * Uses text-based insertion to avoid reformatting user's files.
 * Always creates a backup before modifying.
 */

import { readFile, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ServerConfig } from '@kicad-part-finder/shared';
import { getLibraryTablePath } from './paths.js';

interface TableUpdateResult {
  updated: boolean;
  error?: string;
}

/** Ensure the KiCadPartFinder library entry exists in both table files */
export async function ensureLibraryTableEntry(
  config: ServerConfig
): Promise<TableUpdateResult> {
  // Validate libraryName contains only safe characters (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(config.libraryName)) {
    return {
      updated: false,
      error: `Invalid library name: "${config.libraryName}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
    };
  }

  const results: TableUpdateResult[] = [];

  // Update symbol library table
  const symResult = await ensureEntry(
    config,
    'symbol',
    expandHome(config.paths.symbolDir),
    `${config.libraryName}.kicad_sym`
  );
  results.push(symResult);

  // Update footprint library table
  const fpResult = await ensureEntry(
    config,
    'footprint',
    expandHome(config.paths.footprintDir),
    `${config.libraryName}.pretty`
  );
  results.push(fpResult);

  const errors = results.filter(r => r.error).map(r => r.error!);
  return {
    updated: results.some(r => r.updated),
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

async function ensureEntry(
  config: ServerConfig,
  type: 'symbol' | 'footprint',
  libDir: string,
  libFilename: string
): Promise<TableUpdateResult> {
  const tablePath = getLibraryTablePath(config.paths.globalConfigDir, type);

  if (!existsSync(tablePath)) {
    return { updated: false, error: `Library table not found: ${tablePath}` };
  }

  try {
    const content = await readFile(tablePath, 'utf-8');

    // Check if entry already exists
    if (content.includes(`(name "${config.libraryName}")`)) {
      return { updated: false };
    }

    // Create backup
    const backupPath = tablePath + '.bak';
    await copyFile(tablePath, backupPath);

    // Build the new entry
    const uri = join(libDir, libFilename);
    const entry = `  (lib (name "${config.libraryName}") (type "KiCad") (uri "${uri}") (options "") (descr "Parts from KiCad Part Finder"))`;

    // Insert before the last closing parenthesis
    const lastParen = content.lastIndexOf(')');
    if (lastParen === -1) {
      return { updated: false, error: `Malformed library table: ${tablePath}` };
    }

    const updated = content.slice(0, lastParen) + '\n' + entry + '\n)';
    await writeFile(tablePath, updated, 'utf-8');

    return { updated: true };
  } catch (err) {
    return {
      updated: false,
      error: `Failed to update ${type} table: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}
