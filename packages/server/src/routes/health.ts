import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@kicad-part-finder/shared';
import { getConverterStatus } from '../lib/converter.js';
import { existsSync } from 'fs';

export function registerHealthRoute(app: FastifyInstance) {
  app.get('/health', async (request): Promise<HealthResponse & { authToken?: string }> => {
    const config = app.config;
    const kicadDetected = existsSync(config.paths.globalConfigDir);
    const converter = await getConverterStatus(config.converterPath);

    // Only include auth token if request comes from extension or localhost (no origin = curl/local)
    const origin = request.headers.origin || '';
    const isTrusted = !origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');

    return {
      ok: true,
      version: '0.1.0',
      kicadDetected,
      converterAvailable: converter.available,
      ...(converter.version ? { converterVersion: converter.version } : {}),
      ...(isTrusted ? { authToken: app.authToken } : {}),
    };
  });
}
