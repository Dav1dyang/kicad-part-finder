/**
 * File System Access library writer — the core new capability of the self-
 * contained extension.
 *
 * The user grants a single directory handle (their KiCad library root, e.g.
 * `~/Documents/GitHub/kicad-libraries`). Everything we write lives INSIDE that
 * folder; we never touch KiCad's global `sym-lib-table` / `fp-lib-table` (the
 * one-time `tools/setup` already registered the `DavidLib_<bucket>` and
 * `KiCadPartFinder` nicknames against `${DAVID_KICAD_LIB}`).
 *
 * Layout inside the granted folder:
 *   symbols/DavidLib_<bucket>.kicad_sym
 *   footprints/DavidLib_<bucket>.pretty/<fpname>.kicad_mod
 *   3dmodels/<uuid>.step
 *
 * The pure string helpers (mergeSymbolLibrary / extractSymbolName /
 * extractFootprintName / setFootprintModel) are exported separately so they can
 * be unit-tested with no DOM or FS.
 */

/** KiCad path-substitution var the lib tables resolve to the granted folder. */
const KICAD_LIB_VAR = '${DAVID_KICAD_LIB}';

/** Wrapper emitted when a `DavidLib_<bucket>.kicad_sym` file doesn't yet exist. */
const SYM_LIB_HEADER = '(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)';

// ---------------------------------------------------------------------------
// Pure string helpers (unit-tested in __tests__/library-writer.test.ts)
// ---------------------------------------------------------------------------

/**
 * Pull the symbol name from a `(kicad_symbol_lib …)` document or a bare
 * `(symbol "NAME" …)` block — i.e. the first top-level `(symbol "NAME"`.
 * Returns null if none is found.
 */
export function extractSymbolName(symbolText: string): string | null {
  const m = symbolText.match(/\(symbol\s+"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Extract the inner `(symbol "NAME" … )` block(s) from a full
 * `(kicad_symbol_lib … )` document, returned verbatim (without the library
 * wrapper). If the text is already a bare symbol block (no wrapper), it's
 * returned as-is (trimmed). Returns '' when no symbol is present.
 *
 * Implemented with a paren-depth scan so nested `(…)` inside the symbol don't
 * confuse it.
 */
export function extractSymbolBlocks(symbolText: string): string {
  const blocks: string[] = [];
  const re = /\(symbol\s+"[^"]+"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(symbolText)) !== null) {
    const start = match.index;
    // Walk forward counting parens until the symbol block closes.
    let depth = 0;
    let i = start;
    let inString = false;
    for (; i < symbolText.length; i++) {
      const ch = symbolText[i];
      if (inString) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    blocks.push(symbolText.slice(start, i));
    re.lastIndex = i;
  }
  return blocks.join('\n');
}

/**
 * Merge a new symbol into an existing `.kicad_sym` library file's text.
 *
 * Pure & deterministic — this is the testable heart of symbol installation.
 *
 * Behaviour:
 *  - If `existing` is empty/whitespace, a fresh `(kicad_symbol_lib …)` wrapper is
 *    created around the new symbol block.
 *  - If a `(symbol "<name>"` with the SAME name already exists, the file is
 *    returned UNCHANGED (dedupe — first writer wins).
 *  - Otherwise the new symbol block is inserted immediately before the file's
 *    final top-level `)` (the library's closing paren).
 *
 * @param existing  current file text ('' if the file doesn't exist yet)
 * @param newSymbolText  a `(kicad_symbol_lib …)` doc OR a bare `(symbol …)` block
 * @returns `{ text, name, added }` — merged text, the symbol name, and whether a
 *   new block was inserted (false on dedupe).
 */
export function mergeSymbolLibrary(
  existing: string,
  newSymbolText: string,
): { text: string; name: string | null; added: boolean } {
  const block = extractSymbolBlocks(newSymbolText).trim();
  const name = extractSymbolName(block);

  // Nothing usable to insert — return existing unchanged.
  if (!block) {
    return { text: existing, name, added: false };
  }

  const trimmedExisting = existing.trim();

  // Fresh file: wrap the new block in a library header.
  if (trimmedExisting === '') {
    const text = `${SYM_LIB_HEADER}\n${indentBlock(block)}\n)\n`;
    return { text, name, added: true };
  }

  // Dedupe: if a symbol with this name already exists, leave the file alone.
  if (name) {
    const dupRe = new RegExp(`\\(symbol\\s+"${escapeRegExp(name)}"`);
    if (dupRe.test(existing)) {
      return { text: existing, name, added: false };
    }
  }

  // Insert before the final top-level ')'.
  const lastParen = existing.lastIndexOf(')');
  if (lastParen === -1) {
    // Malformed (no closing paren) — append defensively.
    const text = `${existing.replace(/\s*$/, '')}\n${indentBlock(block)}\n`;
    return { text, name, added: true };
  }

  const before = existing.slice(0, lastParen).replace(/\s*$/, '');
  const after = existing.slice(lastParen); // starts at the ')'
  const text = `${before}\n${indentBlock(block)}\n${after}`;
  return { text, name, added: true };
}

/** Indent every line of a block by two spaces (matches the file's symbol style). */
function indentBlock(block: string): string {
  return block
    .split('\n')
    .map((line) => (line.length ? `  ${line}` : line))
    .join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the footprint name (the token right after `(footprint "`) from a
 * `.kicad_mod` text. Falls back to `'Footprint'` if it can't be parsed (the
 * converter always emits one, so this is belt-and-braces).
 */
export function extractFootprintName(footprintText: string): string {
  const m = footprintText.match(/\(footprint\s+"([^"]+)"/);
  return m ? m[1] : 'Footprint';
}

/**
 * Ensure a footprint's `.kicad_mod` text references a 3D model at
 * `${DAVID_KICAD_LIB}/3dmodels/<fileName>`.
 *
 * The converter emits footprints WITHOUT a `(model …)` line, so normally we
 * INSERT one just before the footprint's final `)`. If a `(model …)` line is
 * already present (future-proofing), it's rewritten in place instead.
 *
 * Pure — returns the new text.
 */
export function setFootprintModel(footprintText: string, fileName: string): string {
  const modelPath = `${KICAD_LIB_VAR}/3dmodels/${fileName}`;
  const modelBlock =
    `  (model "${modelPath}"\n` +
    '    (offset (xyz 0 0 0))\n' +
    '    (scale (xyz 1 1 1))\n' +
    '    (rotate (xyz 0 0 0))\n' +
    '  )';

  // If a (model "…") line is already present, rewrite just its path in place.
  if (/\(model\s+"/.test(footprintText)) {
    return footprintText.replace(/\(model\s+"[^"]*"/, `(model "${modelPath}"`);
  }

  // Otherwise insert a fresh (model …) block before the footprint's final ')'.
  const lastParen = footprintText.lastIndexOf(')');
  if (lastParen === -1) return footprintText;
  const before = footprintText.slice(0, lastParen).replace(/\s*$/, '');
  const after = footprintText.slice(lastParen);
  return `${before}\n${modelBlock}\n${after}`;
}

/**
 * Decide the on-disk 3D-model filename + a fetchable STEP URL from a converter
 * `model3dUrl` (shape: `https://easyeda.com/api/v2/components/<uuid>/3d`).
 *
 * KiCad accepts STEP, so we target the upstream STEP endpoint and skip OBJ→WRL.
 * Returns null if the uuid can't be extracted.
 */
export function resolveModelDownload(
  model3dUrl: string,
): { fileName: string; stepUrl: string; uuid: string } | null {
  // The uuid is a 32-hex token somewhere in the URL.
  const m = model3dUrl.match(/([0-9a-fA-F]{32})/);
  if (!m) return null;
  const uuid = m[1];
  return {
    uuid,
    fileName: `${uuid}.step`,
    // STEP endpoint (per upstream easyeda2kicad). The OBJ endpoint
    // (modules.easyeda.com/3dmodel/<uuid>) is intentionally not used.
    stepUrl: `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${uuid}`,
  };
}

// ---------------------------------------------------------------------------
// File System Access + IndexedDB (browser-only; not unit-tested)
// ---------------------------------------------------------------------------

const IDB_NAME = 'kicad-part-finder';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'libraryFolder';

/** Open (creating if needed) the tiny IndexedDB used to persist the dir handle. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Prompt the user to pick their KiCad library root folder (read-write) and
 * persist the handle in IndexedDB for next session. Must be called from a user
 * gesture (e.g. a button click).
 *
 * @returns the granted directory handle.
 * @throws if the user cancels the picker or the API is unavailable.
 */
export async function pickLibraryFolder(): Promise<FileSystemDirectoryHandle> {
  if (typeof (globalThis as any).showDirectoryPicker !== 'function') {
    throw new Error(
      'File System Access API unavailable. Use Chrome/Edge 117+ (desktop) over the side panel.',
    );
  }
  const handle: FileSystemDirectoryHandle = await (globalThis as any).showDirectoryPicker({
    id: 'kicad-library-root',
    mode: 'readwrite',
    startIn: 'documents',
  });
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

/**
 * Re-load the previously granted folder handle and (re-)request read-write
 * permission. Chrome forgets the *active* grant between sessions, so this must
 * run from a user gesture; it returns null if no handle was ever stored or the
 * user declines permission.
 */
export async function getSavedFolder(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
  if (!handle) return null;

  const opts = { mode: 'readwrite' as const };
  // queryPermission first to avoid an unnecessary prompt if already granted.
  const query = await (handle as any).queryPermission(opts);
  if (query === 'granted') return handle;

  const request = await (handle as any).requestPermission(opts);
  return request === 'granted' ? handle : null;
}

/** Forget the stored folder handle (used by a "change folder" affordance). */
export async function clearSavedFolder(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

/** Get (creating if missing) a subdirectory handle by path segment. */
async function getDir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

/** Read a file's text, or '' if it doesn't exist. */
async function readFileText(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<string> {
  try {
    const fileHandle = await dir.getFileHandle(name, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return '';
    }
    throw err;
  }
}

/** Write text to a file (creating it), overwriting any existing content. */
async function writeFileText(
  dir: FileSystemDirectoryHandle,
  name: string,
  contents: string | BufferSource,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents as FileSystemWriteChunkType);
  await writable.close();
}

/** Convert result fields needed to install a part. */
export interface InstallPartInput {
  bucket: string;
  symbol: string;
  footprint: string;
  model3dUrl: string | null;
  meta: { lcsc: string; mpn: string; manufacturer: string; datasheet: string; package: string; description: string };
}

/** What `installPart` wrote (or skipped). */
export interface InstallPartResult {
  ok: boolean;
  /** Repo-relative paths of files written/updated. */
  written: string[];
  /** Symbol added (true) or skipped as a duplicate (false). */
  symbolAdded: boolean;
  symbolName: string | null;
  footprintName: string;
  /** '' = no model attempted, 'ok' = written, otherwise a short skip reason. */
  modelStatus: string;
  errors: string[];
}

/**
 * Install a converted part into the granted KiCad library folder.
 *
 * Writes/updates:
 *   symbols/DavidLib_<bucket>.kicad_sym       (append + dedupe)
 *   footprints/DavidLib_<bucket>.pretty/<fp>.kicad_mod
 *   3dmodels/<uuid>.step                      (best-effort)
 *
 * The 3D model is best-effort: if the fetch fails the footprint is still written
 * (without a model line) and `modelStatus` explains the skip.
 */
export async function installPart(
  root: FileSystemDirectoryHandle,
  input: InstallPartInput,
): Promise<InstallPartResult> {
  const result: InstallPartResult = {
    ok: false,
    written: [],
    symbolAdded: false,
    symbolName: null,
    footprintName: 'Footprint',
    modelStatus: '',
    errors: [],
  };

  const bucket = input.bucket;
  const symLibName = `DavidLib_${bucket}.kicad_sym`;
  const prettyName = `DavidLib_${bucket}.pretty`;

  let footprintText = input.footprint;
  result.footprintName = extractFootprintName(footprintText);

  // --- 3D model (best-effort, before the footprint is written) ---------------
  if (input.model3dUrl) {
    const dl = resolveModelDownload(input.model3dUrl);
    if (!dl) {
      result.modelStatus = 'skipped (no model uuid)';
    } else {
      try {
        // Referer for modules.easyeda.com is injected by declarativeNetRequest;
        // fetch() cannot set that forbidden header from extension pages.
        const resp = await fetch(dl.stepUrl);
        if (!resp.ok) {
          result.modelStatus = `skipped (HTTP ${resp.status})`;
        } else {
          const bytes = new Uint8Array(await resp.arrayBuffer());
          // Guard against an HTML error page masquerading as a model.
          const head = new TextDecoder().decode(bytes.slice(0, 64)).toLowerCase();
          if (bytes.byteLength < 32 || head.includes('<html') || head.includes('<!doctype')) {
            result.modelStatus = 'skipped (not a STEP file)';
          } else {
            const modelsDir = await getDir(root, '3dmodels');
            await writeFileText(modelsDir, dl.fileName, bytes);
            footprintText = setFootprintModel(footprintText, dl.fileName);
            result.written.push(`3dmodels/${dl.fileName}`);
            result.modelStatus = 'ok';
          }
        }
      } catch (err) {
        result.modelStatus = `skipped (${err instanceof Error ? err.message : 'fetch failed'})`;
      }
    }
  }

  // --- Symbol: read → merge (append/dedupe) → write --------------------------
  try {
    const symbolsDir = await getDir(root, 'symbols');
    const existing = await readFileText(symbolsDir, symLibName);
    const merged = mergeSymbolLibrary(existing, input.symbol);
    result.symbolName = merged.name;
    result.symbolAdded = merged.added;
    if (merged.added) {
      await writeFileText(symbolsDir, symLibName, merged.text);
    }
    // Always report the symbol library path so the user knows where it landed.
    result.written.push(`symbols/${symLibName}${merged.added ? '' : ' (deduped)'}`);
  } catch (err) {
    result.errors.push(`symbol: ${err instanceof Error ? err.message : 'write failed'}`);
  }

  // --- Footprint: write into the .pretty dir ---------------------------------
  try {
    const footprintsDir = await getDir(root, 'footprints');
    const prettyDir = await getDir(footprintsDir, prettyName);
    const modName = `${result.footprintName}.kicad_mod`;
    await writeFileText(prettyDir, modName, footprintText);
    result.written.push(`footprints/${prettyName}/${modName}`);
  } catch (err) {
    result.errors.push(`footprint: ${err instanceof Error ? err.message : 'write failed'}`);
  }

  result.ok = result.errors.length === 0;
  return result;
}
