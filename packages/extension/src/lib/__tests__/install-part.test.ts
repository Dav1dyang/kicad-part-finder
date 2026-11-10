/**
 * installPart and inspectLibraryFolder against an in-memory directory that
 * behaves like the File System Access API (only the calls the writer uses).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../converter/__tests__/fixtures/C3235557.json';
import { convertFromResult, type EasyedaResult } from '../converter/easyeda';
import { inspectLibraryFolder, installPart, type InstallPartInput } from '../library-writer';

class MemFile {
  constructor(public data: string | Uint8Array = '', public failWrite = false) {}
  async getFile() {
    const data = this.data;
    return { text: async () => (typeof data === 'string' ? data : new TextDecoder().decode(data)) };
  }
  async createWritable() {
    if (this.failWrite) throw new DOMException('disk full', 'QuotaExceededError');
    let next: string | Uint8Array = '';
    return {
      write: async (chunk: string | Uint8Array) => {
        next = chunk;
      },
      close: async () => {
        this.data = next;
      },
    };
  }
  readonly kind = 'file';
}

class MemDir {
  readonly kind = 'directory';
  entries = new Map<string, MemDir | MemFile>();
  constructor(public name = 'lib') {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.entries.get(name);
    if (!d) {
      if (!opts?.create) throw new DOMException(name, 'NotFoundError');
      d = new MemDir(name);
      this.entries.set(name, d);
    }
    return d as MemDir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.entries.get(name);
    if (!f) {
      if (!opts?.create) throw new DOMException(name, 'NotFoundError');
      f = new MemFile();
      this.entries.set(name, f);
    }
    return f as MemFile;
  }
  async *[Symbol.asyncIterator]() {
    yield* this.entries.entries();
  }
  /** Read a file by path, for assertions. */
  async read(path: string): Promise<string> {
    const parts = path.split('/');
    let dir: MemDir = this;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text();
  }
}

const part = convertFromResult((fixture as { result: EasyedaResult }).result, 'C3235557');
const input = (over: Partial<InstallPartInput> = {}): InstallPartInput => ({
  bucket: 'Power',
  symbol: part.symbol,
  footprint: part.footprint,
  model3dUrl: part.model3dUrl,
  meta: part.meta,
  ...over,
});
const asRoot = (d: MemDir) => d as unknown as FileSystemDirectoryHandle;
const step = () => new Response('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n'.repeat(4), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('installPart', () => {
  it('writes symbol, footprint and STEP into a new library and links them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => step()));
    const root = new MemDir();
    const res = await installPart(asRoot(root), input(), 'https://relay.test');
    expect(res).toMatchObject({ ok: true, symbolAdded: true, libraryCreated: true, modelStatus: 'ok', errors: [] });
    expect(res.written).toHaveLength(3);
    const sym = await root.read('symbols/DavidLib_Power.kicad_sym');
    expect(sym).toContain(`(property "Footprint" "DavidLib_Power:${res.footprintName}"`);
    const fp = await root.read(`footprints/DavidLib_Power.pretty/${res.footprintName}.kicad_mod`);
    expect(fp).toContain('${DAVID_KICAD_LIB}/3dmodels/');
  });

  it('adds nothing twice: a second install dedupes the symbol and keeps the library', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => step()));
    const root = new MemDir();
    await installPart(asRoot(root), input(), 'https://relay.test');
    const again = await installPart(asRoot(root), input(), 'https://relay.test');
    expect(again).toMatchObject({ ok: true, symbolAdded: false, libraryCreated: false });
    const sym = await root.read('symbols/DavidLib_Power.kicad_sym');
    expect(sym.match(/\(symbol "TPS2116DRLR"/g)).toHaveLength(1);
  });

  it('uses the configured prefix and path variable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => step()));
    const root = new MemDir();
    const res = await installPart(asRoot(root), input({ library: { prefix: 'Lab', pathVar: 'LAB_KICAD' } }), 'https://relay.test');
    expect(res.ok).toBe(true);
    expect(await root.read('symbols/Lab_Power.kicad_sym')).toContain('"Lab_Power:');
    expect(await root.read(`footprints/Lab_Power.pretty/${res.footprintName}.kicad_mod`)).toContain('${LAB_KICAD}/3dmodels/');
  });

  it('skips a model that is really an HTML page, and still installs the rest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html><body>blocked</body></html>', { status: 200 })));
    const root = new MemDir();
    const res = await installPart(asRoot(root), input(), 'https://relay.test');
    expect(res.ok).toBe(true);
    expect(res.modelStatus).toMatch(/not a STEP/);
    expect(res.written.some((w) => w.startsWith('3dmodels/'))).toBe(false);
    expect(await root.read(`footprints/DavidLib_Power.pretty/${res.footprintName}.kicad_mod`)).not.toContain('(model');
  });

  it('reports a failed or timed-out model download without failing the install', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    expect((await installPart(asRoot(new MemDir()), input(), 'https://relay.test')).modelStatus).toBe('skipped (HTTP 404)');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('slow', 'TimeoutError'); }));
    expect((await installPart(asRoot(new MemDir()), input(), 'https://relay.test')).modelStatus).toBe('skipped (download timed out)');
  });

  it('installs a part with no 3D model without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await installPart(asRoot(new MemDir()), input({ model3dUrl: null }), 'https://relay.test');
    expect(res).toMatchObject({ ok: true, modelStatus: '' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a partial install when the footprint cannot be written', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => step()));
    const root = new MemDir();
    const fps = await root.getDirectoryHandle('footprints', { create: true });
    const pretty = await fps.getDirectoryHandle('DavidLib_Power.pretty', { create: true });
    const fpName = `${part.footprint.match(/\(footprint\s+"([^"]+)"/)![1].replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')}.kicad_mod`;
    pretty.entries.set(fpName, new MemFile('', true));
    const res = await installPart(asRoot(root), input(), 'https://relay.test');
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/footprint/);
    expect(res.written.some((w) => w.startsWith('symbols/'))).toBe(true);
  });

  it('applies edited fields from the card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => step()));
    const root = new MemDir();
    await installPart(asRoot(root), input({ meta: { ...part.meta, mpn: 'TPS2116DRLR-EDIT', manufacturer: 'Texas Instruments' } }), 'https://relay.test');
    const sym = await root.read('symbols/DavidLib_Power.kicad_sym');
    expect(sym).toContain('(symbol "TPS2116DRLR-EDIT"');
    expect(sym).toContain('"Texas Instruments"');
  });
});

describe('inspectLibraryFolder', () => {
  it('lists symbol libraries and notes which folders exist', async () => {
    const root = new MemDir();
    const sym = await root.getDirectoryHandle('symbols', { create: true });
    await sym.getFileHandle('Lab_IC.kicad_sym', { create: true });
    await sym.getFileHandle('notes.txt', { create: true });
    expect(await inspectLibraryFolder(asRoot(root))).toMatchObject({ hasSymbols: true, hasFootprints: false, symbolFiles: ['Lab_IC.kicad_sym'], isGitRepo: false, hasSetupScript: false });
  });

  it('spots a git repo with setup and catalog scripts and a table fragment', async () => {
    const root = new MemDir('kicad-libraries');
    await root.getDirectoryHandle('.git', { create: true });
    const tools = await root.getDirectoryHandle('tools', { create: true });
    await tools.getFileHandle('setup', { create: true });
    await tools.getFileHandle('catalog', { create: true });
    const tables = await root.getDirectoryHandle('tables', { create: true });
    (await tables.getFileHandle('sym-lib-table.fragment', { create: true })).data = '  (lib (name "A")(type "KiCad")(uri "x")(options "")(descr ""))\n';
    expect(await inspectLibraryFolder(asRoot(root))).toMatchObject({
      isGitRepo: true,
      hasSetupScript: true,
      hasCatalogScript: true,
      symTableFragment: expect.stringContaining('(name "A")'),
    });
  });

  it('treats a .git file (worktree) as a git repo', async () => {
    const root = new MemDir();
    await root.getFileHandle('.git', { create: true });
    expect((await inspectLibraryFolder(asRoot(root))).isGitRepo).toBe(true);
  });

  it('reports an empty folder, and never throws on an unreadable one', async () => {
    expect(await inspectLibraryFolder(asRoot(new MemDir()))).toEqual({ hasSymbols: false, hasFootprints: false, symbolFiles: [], isGitRepo: false, hasSetupScript: false, hasCatalogScript: false, symTableFragment: '' });
    const broken = { async *[Symbol.asyncIterator]() { throw new Error('denied'); } };
    expect(await inspectLibraryFolder(broken as unknown as FileSystemDirectoryHandle)).toEqual({ hasSymbols: false, hasFootprints: false, symbolFiles: [], isGitRepo: false, hasSetupScript: false, hasCatalogScript: false, symTableFragment: '' });
  });
});
