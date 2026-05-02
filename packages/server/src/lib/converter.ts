/**
 * Interface to easyeda2kicad Python CLI for converting
 * EasyEDA component data to KiCad format.
 *
 * easyeda2kicad output structure for `--output=/tmp/dir/Part`:
 *   /tmp/dir/Part.kicad_sym          (symbol library)
 *   /tmp/dir/Part.pretty/            (footprint directory)
 *   /tmp/dir/Part.pretty/FP.kicad_mod
 *   /tmp/dir/Part.3dshapes/          (3D models directory)
 *   /tmp/dir/Part.3dshapes/Model.step
 *   /tmp/dir/Part.3dshapes/Model.wrl
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import type { ComponentFile } from '@kicad-part-finder/shared';
import { preflightEasyeda } from './easyeda-client.js';

const execFileAsync = promisify(execFile);

interface ConverterResult {
  files: ComponentFile[];
  error?: string;
}

export interface ConverterStatus {
  available: boolean;
  version?: string;
}

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

const statusCache = new Map<string, ConverterStatus>();

/** Get converter availability + version. Cached per converterPath for the process lifetime. */
export async function getConverterStatus(converterPath: string): Promise<ConverterStatus> {
  const cached = statusCache.get(converterPath);
  if (cached) return cached;

  let status: ConverterStatus = { available: false };
  try {
    const { stdout } = await execFileAsync(converterPath, ['--version'], { timeout: 5000 });
    const match = stdout.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    status = { available: true, version: match?.[1] };
  } catch {
    // --version may not exist on very old releases; fall back to --help
    try {
      await execFileAsync(converterPath, ['--help'], { timeout: 5000 });
      status = { available: true };
    } catch {
      status = { available: false };
    }
  }

  statusCache.set(converterPath, status);
  return status;
}

/** Boolean shim for callers that only need availability. */
export async function checkConverterAvailable(converterPath: string): Promise<boolean> {
  return (await getConverterStatus(converterPath)).available;
}

/** Run easyeda2kicad to fetch and convert a component by LCSC ID */
export async function runConverter(
  converterPath: string,
  lcscId: string,
  _mpn?: string,
): Promise<ConverterResult> {
  // Validate LCSC ID format: must be 'C' followed by digits only
  if (!/^C\d+$/.test(lcscId)) {
    return {
      files: [],
      error: `Invalid LCSC ID format: ${lcscId}. Expected 'C' followed by digits (e.g., C12345).`,
    };
  }

  const status = await getConverterStatus(converterPath);
  if (!status.available) {
    return {
      files: [],
      error: `easyeda2kicad not found at ${converterPath}. Install it with: pip install easyeda2kicad`,
    };
  }

  // Pre-flight EasyEDA from Node so we never feed a known-broken state to the Python CLI.
  // If our healthy Node fetch can't reach the API, the Python CLI's request — which uses
  // a stale API contract and a different UA — has zero chance.
  const preflight = await preflightEasyeda(lcscId);
  if (preflight.status === 'unreachable') {
    return {
      files: [],
      error: `EasyEDA API is unreachable (${preflight.reason}). Try again in a few minutes.`,
    };
  }
  if (preflight.status === 'not_found') {
    return {
      files: [],
      error: `${lcscId} not found in EasyEDA library. Try a SnapEDA ZIP drop instead.`,
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'kicad-part-'));
  const outputBase = join(tempDir, 'component');

  try {
    // --output is a base path: creates component.kicad_sym, component.pretty/, component.3dshapes/
    await execFileAsync(
      converterPath,
      ['--full', `--lcsc_id=${lcscId}`, `--output=${outputBase}`],
      { timeout: 60_000, cwd: tempDir },
    );

    const files: ComponentFile[] = [];

    // Read symbol file: component.kicad_sym
    const symPath = `${outputBase}.kicad_sym`;
    if (existsSync(symPath)) {
      const content = await readFile(symPath, 'utf-8');
      files.push({
        filename: `${lcscId}.kicad_sym`,
        content,
        encoding: 'utf-8',
        type: 'symbol',
      });
    }

    // Read footprint files: component.pretty/*.kicad_mod
    const prettyDir = `${outputBase}.pretty`;
    if (existsSync(prettyDir)) {
      const modFiles = await readdir(prettyDir);
      for (const modFile of modFiles) {
        if (modFile.endsWith('.kicad_mod')) {
          const content = await readFile(join(prettyDir, modFile), 'utf-8');
          files.push({
            filename: modFile,
            content,
            encoding: 'utf-8',
            type: 'footprint',
          });
        }
      }
    }

    // Read 3D model files: component.3dshapes/*.step and *.wrl
    const shapesDir = `${outputBase}.3dshapes`;
    if (existsSync(shapesDir)) {
      const modelFiles = await readdir(shapesDir);
      for (const modelFile of modelFiles) {
        if (modelFile.endsWith('.step') || modelFile.endsWith('.wrl')) {
          const content = await readFile(join(shapesDir, modelFile));
          files.push({
            filename: modelFile,
            content: content.toString('base64'),
            encoding: 'base64',
            type: '3dmodel',
          });
        }
      }
    }

    if (files.length === 0) {
      return {
        files: [],
        error: `easyeda2kicad produced no output for ${lcscId}. The part may not exist in the EasyEDA library.`,
      };
    }

    return { files };
  } catch (err) {
    return {
      files: [],
      error: translateConverterError(err, { converterPath, lcscId, version: status.version }),
    };
  }
}

/**
 * Map raw CLI failures to a single, actionable message. The full traceback should
 * be logged on the server; only this short message is returned to the client.
 */
function translateConverterError(
  err: unknown,
  ctx: { converterPath: string; lcscId: string; version?: string },
): string {
  const e = err as ExecError;
  const stderr = e?.stderr ?? '';
  const stdout = e?.stdout ?? '';
  const combined = `${stderr}\n${stdout}`;
  const versionLabel = ctx.version ? `v${ctx.version}` : 'unknown version';
  const venvDir = dirname(dirname(ctx.converterPath)); // .../venv/bin/foo -> .../venv

  // The exact traceback we keep seeing: easyeda2kicad's API call returned a non-JSON
  // body and r.json() blew up. EasyEDA was reachable from the Node pre-flight, so
  // the CLI itself is the problem — almost always a stale install.
  if (/JSONDecodeError|Expecting value/.test(combined)) {
    return (
      `easyeda2kicad (${versionLabel}) failed to fetch ${ctx.lcscId}, but the EasyEDA API is responding to the server. ` +
      `Your easyeda2kicad install at ${ctx.converterPath} is probably stale. ` +
      `Run: ${venvDir}/bin/pip install --upgrade easyeda2kicad`
    );
  }

  if (/ModuleNotFoundError|ImportError/.test(combined)) {
    return (
      `easyeda2kicad install at ${ctx.converterPath} is broken (missing module). ` +
      `Run: ${venvDir}/bin/pip install --upgrade --force-reinstall easyeda2kicad`
    );
  }

  if (e?.code === 'ETIMEDOUT' || /timed? ?out/i.test(e?.message ?? '')) {
    return `Conversion timed out after 60s. The EasyEDA API may be slow — try again.`;
  }

  // Fallback: surface the first non-empty stderr line (without the full traceback).
  const firstStderrLine = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('[INFO]'));
  if (firstStderrLine) {
    return `easyeda2kicad failed: ${firstStderrLine}`;
  }

  return `Converter failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
}
