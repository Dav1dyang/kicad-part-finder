/**
 * Fastify server setup with CORS, auth token, and routes.
 *
 * Security model:
 * - Server binds to 127.0.0.1 only (no network exposure)
 * - CORS restricted to chrome-extension:// origins only
 * - Startup-generated auth token required on all mutating endpoints
 * - Token stored in ~/.kicad-part-finder/auth-token and returned via GET /health
 *   (extension reads it once, includes in subsequent requests)
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomBytes } from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ServerConfig } from '@kicad-part-finder/shared';
import { registerHealthRoute } from './routes/health.js';
import { registerConfigRoute } from './routes/config.js';
import { registerInstallRoute } from './routes/install.js';
import { registerSearchRoute } from './routes/search.js';
import { registerUploadRoute } from './routes/upload.js';

const AUTH_TOKEN_FILE = join(homedir(), '.kicad-part-finder', 'auth-token');

/** Generate or load the auth token */
function getOrCreateAuthToken(): string {
  const dir = join(homedir(), '.kicad-part-finder');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(AUTH_TOKEN_FILE)) {
    const token = readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
    if (token.length >= 32) return token;
  }

  const token = randomBytes(32).toString('hex');
  writeFileSync(AUTH_TOKEN_FILE, token, { mode: 0o600 }); // Owner-only read/write
  return token;
}

export async function createServer(config: ServerConfig) {
  const app = Fastify({ logger: false });
  const authToken = getOrCreateAuthToken();

  // CORS: only allow Chrome extension origins (not arbitrary websites)
  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow: chrome-extension://, moz-extension://, no origin (curl/localhost tools)
      if (
        !origin ||
        origin.startsWith('chrome-extension://') ||
        origin.startsWith('moz-extension://') ||
        origin === 'http://localhost:3456'
      ) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'), false);
      }
    },
    methods: ['GET', 'PUT', 'POST'],
  });

  // Auth token check for mutating endpoints
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    const method = request.method;

    // GET /health returns the token (so the extension can read it)
    // GET /config and GET /search are read-only — allow without token
    if (method === 'GET') return;

    // All POST/PUT requests require the auth token
    const provided = request.headers['x-auth-token'] || request.headers['authorization']?.replace('Bearer ', '');
    if (provided !== authToken) {
      return reply.status(401).send({ error: 'Invalid or missing auth token' });
    }
  });

  // Store config and token in app decoration
  app.decorate('config', config);
  app.decorate('authToken', authToken);

  // Register routes
  registerHealthRoute(app);
  registerConfigRoute(app);
  registerSearchRoute(app);
  registerInstallRoute(app);
  registerUploadRoute(app);

  return app;
}

// Augment Fastify types
declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
    authToken: string;
  }
}
