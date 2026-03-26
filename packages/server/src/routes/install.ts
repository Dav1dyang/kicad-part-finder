import type { FastifyInstance } from 'fastify';
import type { InstallRequest, InstallResult } from '@kicad-part-finder/shared';
import { runConverter } from '../lib/converter.js';
import { placeFiles } from '../kicad/file-placer.js';
import { ensureLibraryTableEntry } from '../kicad/library-table.js';

export function registerInstallRoute(app: FastifyInstance) {
  app.post<{ Body: InstallRequest }>('/install', async (request, reply) => {
    const { mpn, lcscId, files } = request.body;
    const config = app.config;
    const result: InstallResult = {
      success: false,
      installed: [],
      libraryTablesUpdated: false,
      errors: [],
    };

    if (!mpn && !lcscId) {
      result.errors.push('Either mpn or lcscId is required');
      return reply.status(400).send(result);
    }

    try {
      let filesToInstall = files;

      // If no files provided, use easyeda2kicad to fetch and convert
      if (!filesToInstall || filesToInstall.length === 0) {
        if (!lcscId) {
          result.errors.push('lcscId is required when no files are provided (needed for easyeda2kicad)');
          return reply.status(400).send(result);
        }

        const converted = await runConverter(config.converterPath, lcscId, mpn);
        if (converted.error) {
          result.errors.push(converted.error);
          return reply.status(500).send(result);
        }
        filesToInstall = converted.files;
      }

      // Place files into KiCad library directories
      const placed = await placeFiles(filesToInstall, config);
      result.installed = placed;

      // Update library tables if needed
      if (placed.length > 0) {
        const tableResult = await ensureLibraryTableEntry(config);
        result.libraryTablesUpdated = tableResult.updated;
        if (tableResult.error) {
          result.errors.push(tableResult.error);
        }
      }

      result.success = result.errors.length === 0 && placed.length > 0;
      return reply.send(result);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : 'Unknown error');
      return reply.status(500).send(result);
    }
  });
}
