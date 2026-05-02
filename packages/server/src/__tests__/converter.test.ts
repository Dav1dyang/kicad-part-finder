/**
 * Tests for the converter pre-flight + error translation logic.
 *
 * Covers: EasyEDA pre-flight short-circuits the CLI when upstream is broken or
 * the part isn't in the library, and CLI failures translate to friendly messages
 * (no Python tracebacks leak to the client).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promisify } from 'util';

type ExecResponse =
  | { stdout?: string; stderr?: string; error?: undefined }
  | { error: Error & { code?: string; stdout?: string; stderr?: string }; stdout?: string; stderr?: string };

let responder: (file: string, args: string[]) => ExecResponse = () => ({ stdout: '' });

vi.mock('child_process', () => {
  // Build a mock that promisify will treat as `(file, args, opts) => Promise<{stdout, stderr}>`.
  const fn = (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, stdout: string, stderr: string) => void,
  ) => {
    let r: ExecResponse;
    try {
      r = responder(file, args);
    } catch (e) {
      cb(e, '', '');
      return;
    }
    if (r.error) {
      const err = r.error;
      err.stdout = r.stdout ?? '';
      err.stderr = r.stderr ?? '';
      cb(err, r.stdout ?? '', r.stderr ?? '');
    } else {
      cb(null, r.stdout ?? '', r.stderr ?? '');
    }
  };
  // Hand promisify a custom resolver that returns {stdout, stderr} like the real execFile.
  (fn as unknown as { [k: symbol]: unknown })[promisify.custom] = (
    file: string,
    args: string[],
    opts: unknown,
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      fn(file, args, opts, (err: unknown, stdout: string, stderr: string) => {
        if (err) {
          (err as { stdout?: string; stderr?: string }).stdout = stdout;
          (err as { stdout?: string; stderr?: string }).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { execFile: fn };
});

import { runConverter, getConverterStatus } from '../lib/converter.js';

function setExecFileResponses(fn: (file: string, args: string[]) => ExecResponse) {
  responder = fn;
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('getConverterStatus', () => {
  beforeEach(() => {
    // Each test uses a unique converterPath to bypass the in-process status cache.
  });

  it('parses --version output', async () => {
    setExecFileResponses(() => ({ stdout: 'easyeda2kicad 0.8.5\n' }));
    const status = await getConverterStatus('/tmp/path-version-1/easyeda2kicad');
    expect(status).toEqual({ available: true, version: '0.8.5' });
  });

  it('falls back to --help if --version is unsupported', async () => {
    let calls = 0;
    setExecFileResponses(() => {
      calls += 1;
      if (calls === 1) {
        return { error: new Error('unrecognized arguments') };
      }
      return { stdout: 'usage: easyeda2kicad ...' };
    });
    const status = await getConverterStatus('/tmp/path-version-2/easyeda2kicad');
    expect(status).toEqual({ available: true });
  });

  it('reports unavailable when binary is missing', async () => {
    setExecFileResponses(() => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }));
    const status = await getConverterStatus('/tmp/path-version-3/easyeda2kicad');
    expect(status.available).toBe(false);
  });
});

describe('runConverter pre-flight', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Make the converter look available so we exercise pre-flight, not availability.
    setExecFileResponses(() => ({ stdout: 'easyeda2kicad 0.8.5\n' }));
  });

  it('rejects malformed LCSC IDs without spawning anything', async () => {
    const result = await runConverter('/tmp/preflight-1/easyeda2kicad', 'not-an-id');
    expect(result.error).toMatch(/Invalid LCSC ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "API unreachable" when EasyEDA returns non-JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const result = await runConverter('/tmp/preflight-2/easyeda2kicad', 'C461105');

    expect(result.error).toMatch(/EasyEDA API is unreachable/);
    expect(result.files).toEqual([]);
  });

  it('returns "not found" when EasyEDA reports success: false', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, code: 0, message: 'not found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await runConverter('/tmp/preflight-3/easyeda2kicad', 'C99999999');

    expect(result.error).toMatch(/not found in EasyEDA library/);
    expect(result.files).toEqual([]);
  });
});

describe('runConverter error translation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // EasyEDA pre-flight succeeds — the CLI itself is what blows up.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: { title: 'Test Part', dataStr: {}, packageDetail: { dataStr: {} } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });

  it('translates JSONDecodeError into the "stale install" message', async () => {
    setExecFileResponses((_file, args) => {
      if (args.includes('--version')) return { stdout: 'easyeda2kicad 0.7.0\n' };
      if (args.includes('--full')) {
        return {
          error: new Error('Command failed'),
          stderr: [
            '[INFO] Create component.pretty footprint folder',
            'Traceback (most recent call last):',
            '  File "easyeda_api.py", line 27, in get_info_from_easyeda_api',
            '    api_response = r.json()',
            'json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
          ].join('\n'),
        };
      }
      return { stdout: '' };
    });

    const result = await runConverter('/tmp/translate-1/bin/easyeda2kicad', 'C461105');

    expect(result.error).toMatch(/easyeda2kicad \(v0\.7\.0\) failed to fetch C461105/);
    expect(result.error).toMatch(/install.*is probably stale/);
    expect(result.error).toMatch(/pip install --upgrade easyeda2kicad/);
    // Ensure we didn't leak the raw Python traceback.
    expect(result.error).not.toMatch(/Traceback/);
    expect(result.error).not.toMatch(/JSONDecodeError/);
  });

  it('translates ModuleNotFoundError into a reinstall hint', async () => {
    setExecFileResponses((_file, args) => {
      if (args.includes('--version')) return { stdout: 'easyeda2kicad 0.8.5\n' };
      return {
        error: new Error('Command failed'),
        stderr: "ModuleNotFoundError: No module named 'pydantic'",
      };
    });

    const result = await runConverter('/tmp/translate-2/bin/easyeda2kicad', 'C461105');

    expect(result.error).toMatch(/install.*is broken/);
    expect(result.error).toMatch(/--force-reinstall easyeda2kicad/);
  });
});
