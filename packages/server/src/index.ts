#!/usr/bin/env node
/**
 * KiCad Part Server — CLI entry point.
 * Runs a local HTTP server that receives component files from
 * the Chrome extension and places them into KiCad libraries.
 *
 * Usage: npx kicad-part-server [--port 3456]
 */

import { createServer } from './server.js';
import { loadConfig, saveConfig } from './lib/config-store.js';
import { detectKicadPaths } from './kicad/paths.js';
import { DEFAULT_PORT } from '@kicad-part-finder/shared';

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const portArgIdx = args.indexOf('--port');
  const cliPort = portArgIdx >= 0 ? parseInt(args[portArgIdx + 1], 10) : undefined;

  // Load or create config
  let config = await loadConfig();

  // Auto-detect KiCad paths on first run
  if (!config.paths.globalConfigDir || config.paths.globalConfigDir === 'auto-detected') {
    const detected = detectKicadPaths();
    if (detected) {
      config.paths.globalConfigDir = detected.configDir;
      config.paths.symbolDir = config.paths.symbolDir || detected.defaultLibDir + '/symbols';
      config.paths.footprintDir = config.paths.footprintDir || detected.defaultLibDir + '/footprints';
      config.paths.model3dDir = config.paths.model3dDir || detected.defaultLibDir + '/3dmodels';
      await saveConfig(config);
      console.log(`  KiCad ${config.kicadVersion} config detected at: ${detected.configDir}`);
    } else {
      console.log('  KiCad installation not auto-detected. Configure paths via PUT /config');
    }
  }

  const port = cliPort || config.port || DEFAULT_PORT;
  config.port = port;

  const server = await createServer(config);

  try {
    await server.listen({ port, host: '127.0.0.1' });
    console.log('');
    console.log('  KiCad Part Server running');
    console.log(`  http://localhost:${port}`);
    console.log('');
    console.log('  Endpoints:');
    console.log(`    GET  /health  — Server status`);
    console.log(`    GET  /config  — View configuration`);
    console.log(`    PUT  /config  — Update configuration`);
    console.log(`    POST /install — Install component to KiCad`);
    console.log('');
    console.log('  Press Ctrl+C to stop');
    console.log('');
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
