import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '@kicad-part-finder/shared';
import { saveConfig } from '../lib/config-store.js';

export function registerConfigRoute(app: FastifyInstance) {
  app.get('/config', async (): Promise<ServerConfig> => {
    return app.config;
  });

  app.put<{ Body: Partial<ServerConfig> }>('/config', async (request, reply) => {
    const updates = request.body;

    // Merge updates into config
    if (updates.paths) {
      Object.assign(app.config.paths, updates.paths);
    }
    if (updates.libraryName) app.config.libraryName = updates.libraryName;
    if (updates.libraryMode) app.config.libraryMode = updates.libraryMode;
    if (updates.converterPath) app.config.converterPath = updates.converterPath;
    if (updates.kicadVersion) app.config.kicadVersion = updates.kicadVersion;

    await saveConfig(app.config);
    return reply.send(app.config);
  });
}
