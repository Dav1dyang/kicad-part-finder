/**
 * How installed parts are named and referenced inside KiCad. Pure.
 *
 * Each bucket becomes one library pair named `<prefix>_<Bucket>`:
 *   symbols/<prefix>_<Bucket>.kicad_sym
 *   footprints/<prefix>_<Bucket>.pretty/
 * and 3D models are referenced as `${<pathVar>}/3dmodels/<uuid>.step`, where
 * `pathVar` is a KiCad path variable pointing at the library folder.
 */

import { BUCKETS, LIBRARY_CHOICES } from './autosort.js';

export interface LibraryConfig {
  /** Library name prefix, e.g. `DavidLib` → `DavidLib_IC`. */
  prefix: string;
  /** KiCad path variable (without `${}`) that points at the library folder. */
  pathVar: string;
}

/** The original setup; existing libraries keep working unchanged. */
export const DEFAULT_LIBRARY_CONFIG: Readonly<LibraryConfig> = { prefix: 'DavidLib', pathVar: 'DAVID_KICAD_LIB' };

/** The one destination that is not prefixed. */
export const CATCH_ALL_LIBRARY = 'KiCadPartFinder';

const PREFIX_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PATH_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

export function validatePrefix(value: string): string | null {
  return PREFIX_RE.test(value.trim()) ? null : 'Use letters, digits, - or _, starting with a letter (32 at most).';
}

export function validatePathVar(value: string): string | null {
  const v = value.trim().replace(/^\$\{|\}$/g, '');
  return PATH_VAR_RE.test(v) ? null : 'Use letters, digits and _, not starting with a digit.';
}

/** Clean a stored or typed config; anything invalid falls back to the default. */
export function normalizeLibraryConfig(raw: unknown): LibraryConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof LibraryConfig, unknown>>;
  const prefix = typeof obj.prefix === 'string' ? obj.prefix.trim() : '';
  const pathVar = typeof obj.pathVar === 'string' ? obj.pathVar.trim().replace(/^\$\{|\}$/g, '') : '';
  return {
    prefix: PREFIX_RE.test(prefix) ? prefix : DEFAULT_LIBRARY_CONFIG.prefix,
    pathVar: PATH_VAR_RE.test(pathVar) ? pathVar : DEFAULT_LIBRARY_CONFIG.pathVar,
  };
}

/** The KiCad library nickname for a destination. */
export function libraryNickname(choice: string, config: LibraryConfig): string {
  return choice === CATCH_ALL_LIBRARY ? CATCH_ALL_LIBRARY : `${config.prefix}_${choice}`;
}

/** Where a STEP model is referenced from a footprint. */
export function modelPath(fileName: string, config: LibraryConfig): string {
  return `\${${config.pathVar}}/3dmodels/${fileName}`;
}

/**
 * Rows for KiCad's global `sym-lib-table` and `fp-lib-table`, one per library.
 * Paste them inside the `(sym_lib_table …)` / `(fp_lib_table …)` lists while
 * KiCad is closed.
 */
export function libraryTableRows(config: LibraryConfig, choices: readonly string[] = LIBRARY_CHOICES): { symbols: string; footprints: string } {
  const row = (name: string, uri: string) => `  (lib (name "${name}")(type "KiCad")(uri "${uri}")(options "")(descr ""))`;
  const root = `\${${config.pathVar}}`;
  const names = choices.map((c) => libraryNickname(c, config));
  return {
    symbols: names.map((n) => row(n, `${root}/symbols/${n}.kicad_sym`)).join('\n'),
    footprints: names.map((n) => row(n, `${root}/footprints/${n}.pretty`)).join('\n'),
  };
}

/**
 * Guess the prefix an existing library folder already uses from the names in
 * its `symbols/` folder (`Foo_IC.kicad_sym` → `Foo`). Returns the most common
 * one, or null when no file matches a bucket.
 */
export function detectPrefix(symbolFileNames: readonly string[]): string | null {
  const bucketAlt = BUCKETS.join('|');
  const re = new RegExp(`^(.+)_(?:${bucketAlt})\\.kicad_sym$`);
  const counts = new Map<string, number>();
  for (const name of symbolFileNames) {
    const m = name.match(re);
    if (m && PREFIX_RE.test(m[1])) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix;
      bestCount = count;
    }
  }
  return best;
}


/** What the setup hint needs to know about the chosen folder. */
export interface FolderSetupInfo {
  name: string;
  hasSetupScript: boolean;
  /** `tables/sym-lib-table.fragment` text, '' when absent. */
  symTableFragment: string;
}

/** `nickname -> uri` for every `(lib …)` row in a library table or fragment. */
export function parseTableRows(text: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const m of text.matchAll(/\(lib\s*\(name\s+"([^"]+)"\)[^\n]*?\(uri\s+"([^"]+)"\)/g)) rows.set(m[1], m[2]);
  return rows;
}

/**
 * Libraries these settings install into that a folder's own table fragment
 * does not register the same way (missing, or another URI). Empty when the
 * fragment matches, or when there is no fragment to compare.
 */
export function fragmentMismatches(fragment: string, config: LibraryConfig): string[] {
  const theirs = parseTableRows(fragment);
  if (theirs.size === 0) return [];
  const ours = parseTableRows(libraryTableRows(config).symbols);
  return [...ours].filter(([name, uri]) => theirs.get(name) !== uri).map(([name]) => name);
}

/**
 * The one-time KiCad setup, as one paragraph. A folder that ships its own
 * `tools/setup` (kicad-libraries does) is set up by running that script,
 * unless its tables register different names than these settings.
 */
export function setupHint(config: LibraryConfig, folder: FolderSetupInfo | null): string {
  const target = folder ? `“${folder.name}”` : 'your library folder';
  const manual =
    `In KiCad, open Preferences › Configure Paths and set ${config.pathVar} to ${target}. ` +
    'Then quit KiCad and paste these rows just before the last ) of sym-lib-table and fp-lib-table, in KiCad’s settings folder.';
  if (!folder?.hasSetupScript) return `One-time setup. ${manual}`;
  const off = fragmentMismatches(folder.symTableFragment, config);
  if (off.length) {
    const names = off.slice(0, 2).join(', ') + (off.length > 2 ? ', …' : '');
    return (
      `${target} has a setup script, but it registers different libraries than these settings (${names}). ` +
      `Match the prefix and path variable to the folder, or set up by hand. ${manual}`
    );
  }
  return (
    `${target} has a setup script. Quit KiCad, run ./tools/setup in that folder, then reopen KiCad. ` +
    `It sets ${config.pathVar} and adds every library. The rows below are only for setting up by hand.`
  );
}

/** What the commit reminder needs to know about the chosen folder. */
export interface FolderGitInfo {
  name: string;
  isGitRepo: boolean;
  hasCatalogScript: boolean;
}

/** After an install into a git repo, say what to do so the new files are saved. '' otherwise. */
export function commitReminder(folder: FolderGitInfo | null): string {
  if (!folder?.isGitRepo) return '';
  return folder.hasCatalogScript
    ? `Run ./tools/catalog, then commit the new files in “${folder.name}”.`
    : `Commit the new files in “${folder.name}” so they are saved in git.`;
}
