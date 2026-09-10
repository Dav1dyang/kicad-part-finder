/**
 * Selection listener — turns text the user highlights on a page into a search.
 * Injected by the service worker when the finder opens (and only while the
 * "search when I highlight text" setting is on).
 *
 * Uses `selectionchange` (debounced) so keyboard selections count too, sends
 * nothing for clicks that don't select anything, and detaches itself when the
 * extension is reloaded underneath it ("Extension context invalidated").
 *
 * Wrapped in an IIFE and guarded so re-injection is a no-op.
 */

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__kicadSelectionListenerActive) return;
  w.__kicadSelectionListenerActive = true;

  let lastSelection = '';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function looksLikePartNumber(text: string): boolean {
    if (text.length < 3 || text.length > 60) return false;
    if (/[\r\n]/.test(text)) return false;
    // Letters/digits with the separators part numbers use; must contain a digit.
    if (!/\d/.test(text)) return false;
    return /^[A-Za-z0-9][A-Za-z0-9\-_./+ ]{1,58}[A-Za-z0-9]$/.test(text);
  }

  function detach() {
    document.removeEventListener('selectionchange', onSelectionChange);
    if (debounceTimer) clearTimeout(debounceTimer);
    delete w.__kicadSelectionListenerActive;
  }

  function send(text: string) {
    try {
      const p = chrome.runtime.sendMessage({
        type: 'PART_DETECTED',
        part: { mpn: text, source: 'selection', pageUrl: window.location.href },
      });
      // A rejected promise here means the extension was reloaded: stop listening.
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        (p as Promise<unknown>).catch(() => detach());
      }
    } catch {
      detach();
    }
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
      send(text);
    }, 450);
  }

  document.addEventListener('selectionchange', onSelectionChange);
})();
