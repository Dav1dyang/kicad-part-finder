/**
 * Tests for the Fastify server routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { ServerConfig } from '@kicad-part-finder/shared';
import type { FastifyInstance } from 'fastify';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { writeFile, rm } from 'fs/promises';

describe('Server Routes', () => {
  let app: FastifyInstance;
  let tempDir: string;
  let authToken: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kicad-server-test-'));

    const config: ServerConfig = {
      port: 3456,
      kicadVersion: '10.0',
      libraryMode: 'global',
      paths: {
        symbolDir: join(tempDir, 'symbols'),
        footprintDir: join(tempDir, 'footprints'),
        model3dDir: join(tempDir, '3dmodels'),
        globalConfigDir: tempDir,
        projectDir: null,
      },
      libraryName: 'KiCadPartFinder',
      converterPath: 'easyeda2kicad',
    };

    app = await createServer(config);
    authToken = app.authToken;
  });

  afterAll(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /health returns ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.1.0');
  });

  it('GET /config returns current config', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/config',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.libraryName).toBe('KiCadPartFinder');
    expect(body.kicadVersion).toBe('10.0');
    expect(body.paths).toBeDefined();
  });

  it('PUT /config updates configuration', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/config',
      headers: { 'x-auth-token': authToken },
      payload: {
        libraryName: 'MyCustomLib',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.libraryName).toBe('MyCustomLib');

    // Reset for other tests
    await app.inject({
      method: 'PUT',
      url: '/config',
      headers: { 'x-auth-token': authToken },
      payload: { libraryName: 'KiCadPartFinder' },
    });
  });

  it('POST /install rejects request without mpn or lcscId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/install',
      headers: { 'x-auth-token': authToken },
      payload: { files: [] },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.errors).toContain('Either mpn or lcscId is required');
  });

  it('POST /install with files places them correctly', async () => {
    await writeFile(
      join(tempDir, 'sym-lib-table'),
      '(sym_lib_table\n  (version 7)\n)\n',
      'utf-8'
    );
    await writeFile(
      join(tempDir, 'fp-lib-table'),
      '(fp_lib_table\n  (version 7)\n)\n',
      'utf-8'
    );

    const response = await app.inject({
      method: 'POST',
      url: '/install',
      headers: { 'x-auth-token': authToken },
      payload: {
        mpn: 'TEST-PART',
        lcscId: 'C12345',
        files: [
          {
            filename: 'TEST-PART.kicad_sym',
            content: '(kicad_symbol_lib (version 20241001))',
            encoding: 'utf-8',
            type: 'symbol',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.installed).toHaveLength(1);
    expect(body.installed[0].type).toBe('symbol');
  });
});
