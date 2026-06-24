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

  // Basenames of the 3D models in this batch + the directory they land in.
  // Used to repair model references baked into footprints (see rewriteModelPaths).
  const modelNames = new Set(
    files.filter((f) => f.type === '3dmodel').map((f) => basename(f.filename))
  );
  const modelDir = expandHome(config.paths.model3dDir);

  for (const file of files) {
    // Reject filenames with path traversal characters
    if (file.filename.includes('..') || file.filename.includes('/') || file.filename.includes('\\')) {
      continue;
    }

    if (file.type === 'symbol') {
      const result = await mergeSymbol(file, config);
      if (result) placed.push(result);
    } else if (file.type === 'footprint') {
      const targetPath = getTargetPath(file, config);
      if (!targetPath) continue;

      await ensureParentDir(targetPath);

      // Footprints are text. Repair any baked-in 3D-model paths so the model
      // resolves from where we actually place it (easyeda2kicad writes the
      // now-deleted conversion temp dir into each `(model ...)` line).
      const raw = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64').toString('utf-8')
        : file.content;
      const content = rewriteModelPaths(raw, modelDir, modelNames);

      await writeFile(targetPath, content, 'utf-8');
      placed.push({ type: file.type, path: targetPath });
    } else {
      // 3D models and any other binary asset — write verbatim.
      const targetPath = getTargetPath(file, config);
      if (!targetPath) continue;

      await ensureParentDir(targetPath);

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

/** Ensure the parent directory of a file path exists. */
async function ensureParentDir(filePath: string): Promise<void> {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Repair 3D-model references inside a footprint.
 *
 * easyeda2kicad (and some SnapEDA exports) write an ABSOLUTE path to the
 * conversion temp directory into each `(model "...")` line, e.g.
 *   (model "/var/folders/.../T/kicad-part-XXXX/component.3dshapes/Foo.wrl" ...)
 * That temp dir is deleted immediately after conversion, so KiCad can never
 * find the model. We rewrite any model whose basename matches a model file we
 * are installing in this batch to point at its final location. Standard
 * references (e.g. `${KICAD9_3DMODEL_DIR}/...`) are left untouched because
 * their basename is not part of the batch. KiCad accepts forward slashes on
 * every platform, so we normalise to them.
 */
function rewriteModelPaths(
  content: string,
  modelDir: string,
  modelNames: Set<string>
): string {
  if (modelNames.size === 0) return content;
  const base = modelDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return content.replace(/\(model\s+"([^"]+)"/g, (whole, modelPath: string) => {
    const name = modelPath.split(/[\\/]/).pop() ?? '';
    return modelNames.has(name) ? `(model "${base}/${name}"` : whole;
  });
}
