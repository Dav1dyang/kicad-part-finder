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

/** Deadline for the STEP download (models can be several MB). */
const MODEL_TIMEOUT_MS = 60_000;

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

  // Insert before the paren that closes the top-level `(kicad_symbol_lib …)`
  // form. A depth scan (not `lastIndexOf(')')`) so a trailing comment or
  // stray text containing `)` can't push the new symbol outside the library.
  const closeAt = findLibraryClose(existing);
  if (closeAt === -1) {
    // Malformed (no closing paren) — append defensively.
    const text = `${existing.replace(/\s*$/, '')}\n${indentBlock(block)}\n`;
    return { text, name, added: true };
  }

  const before = existing.slice(0, closeAt).replace(/\s*$/, '');
  const after = existing.slice(closeAt); // starts at the ')'
  const text = `${before}\n${indentBlock(block)}\n${after}`;
  return { text, name, added: true };
}

/**
 * Index of the `)` that closes the first top-level `(kicad_symbol_lib` form
 * (string-aware depth scan). Falls back to the last `)` in the text when the
 * wrapper is missing, or -1 when there is no paren at all.
 */
function findLibraryClose(text: string): number {
  const start = text.indexOf('(kicad_symbol_lib');
  if (start === -1) return text.lastIndexOf(')');
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.lastIndexOf(')');
}

/**
 * Characters that are illegal in file names on at least one OS. A footprint
 * name is used both as `<name>.kicad_mod` and inside the symbol's
 * `Lib:Name` reference, so it is sanitised ONCE and used for both.
 */
export function safeFootprintName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  return cleaned || 'Footprint';
}

/** Rewrite the `(footprint "NAME"` token so the file's own name matches the file name. */
export function setFootprintName(footprintText: string, name: string): string {
  return footprintText.replace(/\(footprint\s+"(?:[^"\\]|\\.)*"/, `(footprint "${escapeKi(name)}"`);
}

/** Escape a value for a KiCad quoted string. */
function escapeKi(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** KiCad symbol ids may only contain these characters (mirrors the converter). */
function sanitizeSymbolId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.+-]/g, '_');
}

/** Metadata the user may have edited in the card before installing. */
export interface SymbolMeta {
  mpn?: string;
  manufacturer?: string;
  datasheet?: string;
  package?: string;
  lcsc?: string;
  description?: string;
}

/**
 * Set (or add) one `(property "Name" "value" …)` on the top-level symbol.
 * Existing properties are rewritten in place (escape-aware). A missing one is
 * inserted as a hidden property right after the last existing property so the
 * ids stay sequential. Pure.
 */
export function setSymbolProperty(symbolText: string, name: string, value: string): string {
  const re = new RegExp(`(\\(property\\s+"${escapeRegExp(name)}"\\s+")((?:[^"\\\\]|\\\\.)*)(")`);
  if (re.test(symbolText)) {
    return symbolText.replace(re, (_m, p1, _old, p3) => `${p1}${escapeKi(value)}${p3}`);
  }
  if (!value) return symbolText;
  // Find the last top-level property block and insert after it.
  const propRe = /\(property\s+"(?:[^"\\]|\\.)*"\s+"(?:[^"\\]|\\.)*"\s+\(id\s+(\d+)\)/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  let maxId = -1;
  while ((m = propRe.exec(symbolText)) !== null) {
    last = m;
    maxId = Math.max(maxId, Number(m[1]));
  }
  if (!last) return symbolText;
  // Walk to the end of that property's block.
  let depth = 0;
  let i = last.index;
  let inString = false;
  for (; i < symbolText.length; i++) {
    const ch = symbolText[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
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
  const indent = symbolText.slice(0, last.index).match(/(^|\n)([ \t]*)$/)?.[2] ?? '    ';
  const block =
    `\n${indent}(property "${escapeKi(name)}" "${escapeKi(value)}" (id ${maxId + 1}) (at 0 0 0)` +
    `\n${indent}  (effects (font (size 1.27 1.27)) hide)` +
    `\n${indent})`;
  return symbolText.slice(0, i) + block + symbolText.slice(i);
}

/**
 * Apply the card's edited metadata to a converted symbol: `Value` and `MPN`
 * follow the MPN, `Datasheet`/`Manufacturer`/`Package`/`LCSC`/`Description`
 * are written when present. When the MPN changed the symbol (and its `_0_1`
 * style sub-symbols) is renamed to match, so the library entry carries the
 * corrected part number. Pure.
 */
export function applySymbolMeta(symbolText: string, meta: SymbolMeta): string {
  let text = symbolText;
  const mpn = (meta.mpn ?? '').trim();
  if (mpn) {
    const oldName = extractSymbolName(text);
    const newName = sanitizeSymbolId(mpn);
    if (oldName && oldName !== newName) text = renameSymbol(text, oldName, newName);
    text = setSymbolProperty(text, 'Value', mpn);
    text = setSymbolProperty(text, 'MPN', mpn);
  }
  const fields: Array<[string, string | undefined]> = [
    ['Datasheet', meta.datasheet],
    ['Manufacturer', meta.manufacturer],
    ['Package', meta.package],
    ['LCSC', meta.lcsc],
    ['Description', meta.description],
  ];
  for (const [name, value] of fields) {
    const v = (value ?? '').trim();
    // Datasheet always exists in converter output; only ADD the others when set.
    if (v || name === 'Datasheet') text = setSymbolProperty(text, name, v);
  }
  return text;
}

/** Rename `(symbol "old"` and its `(symbol "old_<unit>_<style>"` children. Pure. */
export function renameSymbol(symbolText: string, oldName: string, newName: string): string {
  const re = new RegExp(`\\(symbol\\s+"${escapeRegExp(oldName)}(_\\d+_\\d+)?"`, 'g');
  return symbolText.replace(re, (_m, suffix: string | undefined) => `(symbol "${escapeKi(newName)}${suffix ?? ''}"`);
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
 * Rewrite the symbol's `Footprint` property value to a fully-qualified
 * `LibNickname:FootprintName` reference so KiCad auto-links the symbol to the
 * installed footprint. A bare footprint name (no `Lib:` prefix) shows in KiCad as
 * "Invalid footprint specified" and forces a manual pick. Pure.
 *
 * Rewrites the value inside `(property "Footprint" "VALUE" …)`. If the symbol has
 * no Footprint property (the converter always emits one), the text is unchanged.
 */
export function setSymbolFootprintRef(symbolText: string, footprintRef: string): string {
  return symbolText.replace(
    // The value group is escape-aware (`(?:[^"\\]|\\.)*`) so a value containing an
    // escaped quote (e.g. `"3.5\" pitch"`) isn't truncated at the inner `\"` — a
    // plain `[^"]*` would stop there and corrupt the symbol.
    /(\(property\s+"Footprint"\s+")((?:[^"\\]|\\.)*)(")/,
    (_m, p1, _old, p3) => `${p1}${footprintRef}${p3}`,
  );
}

/**
 * Find the bounds [start, end) of the top-level `(symbol "<name>" … )` block with
 * the EXACT given name inside a `.kicad_sym` document, using a paren-depth scan so
 * nested `(symbol "<name>_0_1" …)` children don't confuse it. Returns null if no
 * such top-level symbol exists. Pure.
 */
function findSymbolBlockBounds(
  libraryText: string,
  symbolName: string,
): { start: number; end: number } | null {
  const re = new RegExp(`\\(symbol\\s+"${escapeRegExp(symbolName)}"`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(libraryText)) !== null) {
    const start = match.index;
    let depth = 0;
    let inString = false;
    for (let i = start; i < libraryText.length; i++) {
      const ch = libraryText[i];
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
        if (depth === 0) return { start, end: i + 1 };
      }
    }
  }
  return null;
}

/**
 * Rewrite the `Footprint` property of an EXISTING `(symbol "<name>" …)` block
 * inside a library document to `footprintRef`, touching only that one symbol's
 * block (other symbols are left alone). Used on the dedupe path so a part
 * installed before the auto-link change — which kept a bare `(property
 * "Footprint" "LQFP-48")` — gets upgraded to the qualified `Lib:Footprint` ref in
 * place. Pure.
 *
 * @returns `{ text, changed }` — `changed` is false when the symbol is absent,
 *   has no Footprint property, or already holds exactly `footprintRef`.
 */
export function updateExistingSymbolFootprintRef(
  libraryText: string,
  symbolName: string,
  footprintRef: string,
): { text: string; changed: boolean } {
  const bounds = findSymbolBlockBounds(libraryText, symbolName);
  if (!bounds) return { text: libraryText, changed: false };

  const block = libraryText.slice(bounds.start, bounds.end);
  const rewritten = setSymbolFootprintRef(block, footprintRef);
  if (rewritten === block) return { text: libraryText, changed: false };

  const text = libraryText.slice(0, bounds.start) + rewritten + libraryText.slice(bounds.end);
  return { text, changed: true };
}

/** Trim a trailing slash so `${relayBase}/path` never doubles up. */
function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Decide the on-disk 3D-model filename + a fetchable STEP URL from a converter
 * `model3dUrl` (shape: `https://easyeda.com/api/v2/components/<uuid>/3d`).
 *
 * The STEP itself is fetched through the user's deployed Worker relay
 * (`${relayBase}/easyeda/model?uuid=<uuid>`): the browser gets HTTP 403 from
 * EasyEDA's module store even with spoofed headers, but the Worker streams the
 * bytes back server-side with permissive CORS. KiCad accepts STEP, so we skip
 * OBJ->WRL. Returns null if the uuid can't be extracted.
 *
 * @param model3dUrl the converter's `model3dUrl` carrying the 32-hex uuid.
 * @param relayBase  deployed Worker origin (e.g. `https://x.workers.dev`).
 */
export function resolveModelDownload(
  model3dUrl: string,
  relayBase: string,
): { fileName: string; stepUrl: string; uuid: string } | null {
  // The uuid is a 32-hex token somewhere in the URL.
  const m = model3dUrl.match(/([0-9a-fA-F]{32})/);
  if (!m) return null;
  const uuid = m[1];
  return {
    uuid,
    fileName: `${uuid}.step`,
    // Relay endpoint; the Worker fetches the upstream STEP store
    // (modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/<uuid>) server-side.
    stepUrl: `${trimTrailingSlash(relayBase)}/easyeda/model?uuid=${encodeURIComponent(uuid)}`,
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

/** The saved folder handle and whether it can be used right now. */
export type FolderPermission = 'granted' | 'prompt' | 'none';

/**
 * Look at the saved folder WITHOUT prompting: `granted` means writes will work
 * now, `prompt` means a handle exists but Chrome wants a click to re-grant it
 * (typical after a browser restart), `none` means no folder was ever chosen.
 */
export async function peekSavedFolder(): Promise<{
  handle: FileSystemDirectoryHandle | null;
  permission: FolderPermission;
}> {
  let handle: FileSystemDirectoryHandle | undefined;
  try {
    handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
  } catch {
    return { handle: null, permission: 'none' };
  }
  if (!handle) return { handle: null, permission: 'none' };
  try {
    const state = await (handle as any).queryPermission({ mode: 'readwrite' });
    return { handle, permission: state === 'granted' ? 'granted' : 'prompt' };
  } catch {
    return { handle, permission: 'prompt' };
  }
}

/**
 * Ask Chrome to re-allow a handle we already hold. Must be called directly from
 * a click: the permission prompt needs the user gesture, and any await before
 * it (an IndexedDB read, for example) can spend that gesture. Returns true when
 * writes are allowed now.
 */
export async function requestFolderPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const state = await (handle as any).requestPermission({ mode: 'readwrite' });
    return state === 'granted';
  } catch {
    return false;
  }
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
  /** True when this install created the `.kicad_sym` file (KiCad must be restarted to see it). */
  libraryCreated: boolean;
  errors: string[];
}

/** Run `fn` under a Web Lock when available (same-origin documents share it). */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: { request: (n: string, cb: () => Promise<T>) => Promise<T> } } | undefined)?.locks;
  if (locks && typeof locks.request === 'function') return locks.request(name, fn);
  return fn();
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
 *
 * @param root      the granted KiCad library root directory handle.
 * @param input     the converted part (symbol/footprint/model3dUrl/meta).
 * @param relayBase deployed Worker origin used to fetch the STEP model (e.g.
 *   `https://x.workers.dev`).
 */
export async function installPart(
  root: FileSystemDirectoryHandle,
  input: InstallPartInput,
  relayBase: string,
): Promise<InstallPartResult> {
  const result: InstallPartResult = {
    ok: false,
    written: [],
    symbolAdded: false,
    symbolName: null,
    footprintName: 'Footprint',
    modelStatus: '',
    libraryCreated: false,
    errors: [],
  };

  const bucket = input.bucket;
  // KiCadPartFinder is a bare nickname; the seven buckets are DavidLib_<bucket>.
  const libNick = bucket === 'KiCadPartFinder' ? 'KiCadPartFinder' : `DavidLib_${bucket}`;
  const symLibName = `${libNick}.kicad_sym`;
  const prettyName = `${libNick}.pretty`;

  // One sanitised footprint name serves as the file name AND the reference.
  result.footprintName = safeFootprintName(extractFootprintName(input.footprint));
  let footprintText = setFootprintName(input.footprint, result.footprintName);

  // Apply the card's edits (MPN, manufacturer, package, datasheet), then
  // qualify the symbol's Footprint field as `DavidLib_<bucket>:<fpName>` so
  // KiCad links symbol -> footprint automatically.
  const footprintRef = `${libNick}:${result.footprintName}`;
  const symbolText = setSymbolFootprintRef(applySymbolMeta(input.symbol, input.meta), footprintRef);

  // --- 3D model (best-effort, before the footprint is written) ---------------
  if (input.model3dUrl) {
    const dl = resolveModelDownload(input.model3dUrl, relayBase);
    if (!dl) {
      result.modelStatus = 'skipped (no model uuid)';
    } else {
      try {
        // Fetch the STEP through the relay; the Worker streams the bytes back
        // from EasyEDA's module store server-side (the browser is WAF-blocked).
        const resp = await fetch(dl.stepUrl, { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
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
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        result.modelStatus = timedOut
          ? 'skipped (download timed out)'
          : `skipped (${err instanceof Error ? err.message : 'fetch failed'})`;
      }
    }
  }

  // --- Symbol: read → merge (append/dedupe) → write --------------------------
  // The read-modify-write is guarded by a Web Lock so two finder documents
  // (e.g. a side panel and an overlay helper window) can't lose a symbol by
  // writing the same library at once.
  try {
    await withLock(`kicad-part-finder:${symLibName}`, async () => {
    const symbolsDir = await getDir(root, 'symbols');
    const existing = await readFileText(symbolsDir, symLibName);
    result.libraryCreated = existing.trim() === '';
    const merged = mergeSymbolLibrary(existing, symbolText);
    result.symbolName = merged.name;
    result.symbolAdded = merged.added;
    if (merged.added) {
      await writeFileText(symbolsDir, symLibName, merged.text);
      result.written.push(`symbols/${symLibName}`);
    } else if (merged.name) {
      // Dedupe: the symbol already exists, so mergeSymbolLibrary left the file
      // untouched. But a part installed BEFORE the auto-link change kept a bare
      // `(property "Footprint" "LQFP-48")`; upgrade that existing block's
      // Footprint to the qualified `Lib:Footprint` ref in place so the link works
      // on reinstall. Only write when it actually changed.
      const upgraded = updateExistingSymbolFootprintRef(existing, merged.name, footprintRef);
      if (upgraded.changed) {
        await writeFileText(symbolsDir, symLibName, upgraded.text);
        result.written.push(`symbols/${symLibName} (footprint link updated)`);
      } else {
        result.written.push(`symbols/${symLibName} (deduped)`);
      }
    } else {
      // No usable symbol name (nothing to insert or upgrade) — report the path.
      result.written.push(`symbols/${symLibName} (deduped)`);
    }
    });
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
