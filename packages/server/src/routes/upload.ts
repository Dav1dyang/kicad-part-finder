/**
 * Upload route — accepts ZIP files from SnapEDA, ComponentSearchEngine, or Ultra Librarian.
 * Extracts KiCad-compatible files and installs them.
 *
 * SnapEDA ZIPs typically contain:
 *   - {partname}.kicad_sym (symbol)
 *   - {partname}.kicad_mod (footprint)
 *   - {partname}.step (3D model)
 */

import type { FastifyInstance } from 'fastify';
import type { InstallResult, ComponentFile } from '@kicad-part-finder/shared';
import { placeFiles } from '../kicad/file-placer.js';
import { ensureLibraryTableEntry } from '../kicad/library-table.js';
import { createWriteStream } from 'fs';
import { readFile, readdir, rm, mkdir } from 'fs/promises';
import { join, basename, extname } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';

const execFileAsync = promisify(execFile);

export function registerUploadRoute(app: FastifyInstance) {
  // Accept raw body for file uploads
  app.addContentTypeParser(
    'application/zip',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );

  app.post<{ Querystring: { mpn?: string } }>('/upload', async (request, reply) => {
    const config = app.config;
    const mpn = request.query.mpn || 'unknown';
    const result: InstallResult = {
      success: false,
      installed: [],
      libraryTablesUpdated: false,
      errors: [],
    };

    const body = request.body as Buffer;
    if (!body || body.length === 0) {
      result.errors.push('No file data received');
      return reply.status(400).send(result);
    }

    // Reject uploads larger than 50MB to prevent ZIP bombs
    const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
    if (body.length > MAX_UPLOAD_SIZE) {
      result.errors.push(`File too large (${(body.length / 1024 / 1024).toFixed(1)}MB). Maximum upload size is 50MB.`);
      return reply.status(413).send(result);
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'kicad-upload-'));

    try {
      // Write ZIP to temp file
      const zipPath = join(tempDir, 'upload.zip');
      const extractDir = join(tempDir, 'extracted');
      await mkdir(extractDir, { recursive: true });
      await writeBuffer(zipPath, body);

      // Extract ZIP using system unzip
      await execFileAsync('unzip', ['-o', zipPath, '-d', extractDir], {
        timeout: 10_000,
      });

      // Find KiCad files recursively
      const files = await findKicadFiles(extractDir);

      if (files.length === 0) {
        result.errors.push('No KiCad files found in ZIP (expected .kicad_sym, .kicad_mod, .step, or .wrl files)');
        return reply.status(400).send(result);
      }

      // Place files
      const placed = await placeFiles(files, config);
      result.installed = placed;

      if (placed.length > 0) {
        const tableResult = await ensureLibraryTableEntry(config);
        result.libraryTablesUpdated = tableResult.updated;
        if (tableResult.error) result.errors.push(tableResult.error);
      }

      result.success = placed.length > 0;
      return reply.send(result);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : 'Unknown error');
      return reply.status(500).send(result);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function writeBuffer(path: string, data: Buffer): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await writeFile(path, data);
}

async function findKicadFiles(dir: string): Promise<ComponentFile[]> {
  const files: ComponentFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Reject filenames with path traversal
    if (entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const subFiles = await findKicadFiles(fullPath);
      files.push(...subFiles);
    } else {
      const ext = extname(entry.name).toLowerCase();
      const name = entry.name;

      if (ext === '.kicad_sym') {
        const content = await readFile(fullPath, 'utf-8');
        files.push({ filename: name, content, encoding: 'utf-8', type: 'symbol' });
      } else if (ext === '.kicad_mod') {
        const content = await readFile(fullPath, 'utf-8');
        files.push({ filename: name, content, encoding: 'utf-8', type: 'footprint' });
      } else if (ext === '.step' || ext === '.stp') {
        const content = await readFile(fullPath);
        files.push({ filename: name, content: content.toString('base64'), encoding: 'base64', type: '3dmodel' });
      } else if (ext === '.wrl') {
        const content = await readFile(fullPath);
        files.push({ filename: name, content: content.toString('base64'), encoding: 'base64', type: '3dmodel' });
      }
    }
  }

  return files;
}
