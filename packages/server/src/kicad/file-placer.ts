/**
 * Places component files into the correct KiCad library directories.
 *
 * Symbols: Appended into a single {libraryName}.kicad_sym file.
 * Footprints: Individual .kicad_mod files in {libraryName}.pretty/
 * 3D Models: Individual files in the 3dmodels directory.
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { ComponentFile, ServerConfig } from '@kicad-part-finder/shared';

interface PlacedFile {
  type: ComponentFile['type'];
  path: string;
}

export async function placeFiles(
  files: ComponentFile[],
  config: ServerConfig
): Promise<PlacedFile[]> {
  const placed: PlacedFile[] = [];

  for (const file of files) {
    // Reject filenames with path traversal characters
    if (file.filename.includes('..') || file.filename.includes('/') || file.filename.includes('\\')) {
      continue;
    }

    if (file.type === 'symbol') {
      const result = await mergeSymbol(file, config);
      if (result) placed.push(result);
    } else {
      const targetPath = getTargetPath(file, config);
      if (!targetPath) continue;

      const dir = join(targetPath, '..');
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content;

      await writeFile(targetPath, content);
      placed.push({ type: file.type, path: targetPath });
    }
  }

  return placed;
}

/**
 * Merge a new symbol into the single KiCadPartFinder.kicad_sym library file.
 * If the file doesn't exist, use the new file as-is.
 * If it exists, extract symbol definitions and append them.
 */
async function mergeSymbol(
  file: ComponentFile,
  config: ServerConfig
): Promise<PlacedFile | null> {
  const symDir = expandHome(config.paths.symbolDir);
  if (!existsSync(symDir)) {
    await mkdir(symDir, { recursive: true });
  }

  const libPath = join(symDir, `${config.libraryName}.kicad_sym`);
  const newContent = file.content;

  if (!existsSync(libPath)) {
    await writeFile(libPath, newContent, 'utf-8');
    return { type: 'symbol', path: libPath };
  }

  const existingContent = await readFile(libPath, 'utf-8');
  const newSymbols = extractSymbolBlocks(newContent);

  if (newSymbols.length === 0) {
    await writeFile(libPath, newContent, 'utf-8');
    return { type: 'symbol', path: libPath };
  }

  // Skip duplicates
  const newBlocks: string[] = [];
  for (const sym of newSymbols) {
    if (!existingContent.includes(`(symbol "${sym.name}"`)) {
      newBlocks.push(sym.block);
    }
  }

  if (newBlocks.length === 0) {
    return { type: 'symbol', path: libPath };
  }

  // Insert before closing )
  const lastParen = existingContent.lastIndexOf(')');
  const merged = existingContent.slice(0, lastParen) +
    '\n' + newBlocks.join('\n') + '\n)';

  await writeFile(libPath, merged, 'utf-8');
  return { type: 'symbol', path: libPath };
}

interface SymbolBlock {
  name: string;
  block: string;
}

/** Extract top-level (symbol "Name" ...) blocks from a .kicad_sym file. */
function extractSymbolBlocks(content: string): SymbolBlock[] {
  const blocks: SymbolBlock[] = [];
  const symbolRegex = /^\s*\(symbol\s+"([^"]+)"/gm;
  let match;

  while ((match = symbolRegex.exec(content)) !== null) {
    const name = match[1];
    if (name.includes(':')) continue; // Skip sub-symbols

    const startIdx = match.index;
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < content.length; i++) {
      if (content[i] === '(') depth++;
      if (content[i] === ')') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }

    blocks.push({ name, block: content.slice(startIdx, endIdx) });
  }

  return blocks;
}

function getTargetPath(file: ComponentFile, config: ServerConfig): string | null {
  const name = basename(file.filename);

  switch (file.type) {
    case 'footprint': {
      const prettyDir = join(
        expandHome(config.paths.footprintDir),
        `${config.libraryName}.pretty`
      );
      return join(prettyDir, name);
    }

    case '3dmodel':
      return join(expandHome(config.paths.model3dDir), name);

    default:
      return null;
  }
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}
