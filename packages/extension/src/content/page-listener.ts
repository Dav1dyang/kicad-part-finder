/**
 * Page listener — the small piece of Part Finder that lives on ordinary web
 * pages. It does two things:
 *
 *  1. Turns text the user highlights into a search (`PART_DETECTED` with
 *     source 'selection'). The service worker drops these while the
 *     "search when I highlight" setting is off.
 *  2. Listens for the PAGE shortcuts (open or close the finder, search the
 *     highlighted text, install the current part) and forwards them as
 *     `PAGE_COMMAND`. Browser-level `chrome.commands` do the same job in Chrome,
 *     but Arc and Dia never deliver them, so the page has to.
 *
 * It runs wherever the extension may run: DigiKey and LCSC product pages (from
 * the manifest), the page the finder was opened on (`activeTab`), and every
 * site once the user allows all sites (registered content script). It is
 * injected repeatedly and must stay a self-contained classic script: the only
 * import is `page-combo.ts`, which nothing else imports, so rollup inlines it.
 *
 * Guarded with a window flag so re-injection is a no-op, and detaches itself
 * when the extension is reloaded underneath it ("Extension context invalidated").
 */

import { matchPageAction, resolvePageTable, type PageCombo } from './page-combo.js';

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__kicadPageListenerActive) return;
  w.__kicadPageListenerActive = true;

  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || '');
  let table: Record<string, PageCombo | null> = resolvePageTable(undefined);
  let lastSelection = '';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function alive(): boolean {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function detach() {
    document.removeEventListener('selectionchange', onSelectionChange);
    window.removeEventListener('keydown', onKeyDown, true);
    if (debounceTimer) clearTimeout(debounceTimer);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      /* already gone */
    }
    delete w.__kicadPageListenerActive;
  }

  /** Send to the extension; a rejection means it was reloaded, so stop cleanly. */
  function send(message: Record<string, unknown>) {
    if (!alive()) {
      detach();
      return;
    }
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        (p as Promise<unknown>).catch(() => detach());
      }
    } catch {
      detach();
    }
  }

  // --- Highlight to search ---------------------------------------------------

  function looksLikePartNumber(text: string): boolean {
    if (text.length < 3 || text.length > 60) return false;
    if (/[\r\n]/.test(text)) return false;
    // Letters/digits with the separators part numbers use; must contain a digit.
    if (!/\d/.test(text)) return false;
    return /^[A-Za-z0-9][A-Za-z0-9\-_./+ ]{1,58}[A-Za-z0-9]$/.test(text);
  }

  function currentSelectionText(): string {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return '';
    return selection.toString().trim();
  }

  function onSelectionChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      // Ignore selections inside editable fields (the user is typing, not picking a part).
      const anchor = selection.anchorNode?.parentElement;
      if (anchor?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = selection.toString().trim();
      if (!text || text === lastSelection || !looksLikePartNumber(text)) return;
      lastSelection = text;
      send({ type: 'PART_DETECTED', part: { mpn: text, source: 'selection', pageUrl: window.location.href } });
    }, 450);
  }

  // --- Page shortcuts --------------------------------------------------------

  function loadTable() {
    if (!alive()) return;
    try {
      chrome.storage.sync
        .get('pageShortcuts')
        .then((stored) => {
          table = resolvePageTable(stored?.pageShortcuts);
        })
        .catch(() => {
          /* keep the defaults */
        });
    } catch {
      /* storage unavailable here */
    }
  }

  function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area === 'sync' && changes.pageShortcuts) table = resolvePageTable(changes.pageShortcuts.newValue);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return;
    const action = matchPageAction(table, e, isMac);
    if (!action) return;
    if (!alive()) {
      detach();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // The selection is read here, where it lives, so the worker needs no
    // extra script injection (which may be refused on this page).
    const text = action === 'search-selection' ? currentSelectionText() : '';
    send({ type: 'PAGE_COMMAND', name: action, text });
  }

  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('keydown', onKeyDown, true);
  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch {
    /* storage unavailable here */
  }
  loadTable();
})();
