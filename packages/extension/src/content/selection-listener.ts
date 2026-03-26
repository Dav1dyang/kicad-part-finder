/**
 * Selection listener — detects text highlighted by the user on any webpage.
 * When the floating panel or side panel is active, sends the selected text
 * to the extension as a detected part for searching.
 *
 * Wrapped in IIFE to prevent redeclaration errors on re-injection.
 */

(() => {
  // Guard against double-injection
  if ((window as unknown as Record<string, boolean>).__kicadSelectionListenerActive) return;
  (window as unknown as Record<string, boolean>).__kicadSelectionListenerActive = true;

  let lastSelection = '';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function looksLikePartNumber(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 3 || trimmed.length > 60) return false;
    if (trimmed.includes('\n')) return false;
    const partNumberPattern = /^[A-Za-z0-9][A-Za-z0-9\-_./+ ]{1,58}[A-Za-z0-9]$/;
    return partNumberPattern.test(trimmed);
  }

  function onSelectionChange() {
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const text = selection.toString().trim();
      if (!text || text === lastSelection) return;
      if (!looksLikePartNumber(text)) return;

      lastSelection = text;

      chrome.runtime.sendMessage({
        type: 'PART_DETECTED',
        part: {
          mpn: text,
          source: 'selection',
          pageUrl: window.location.href,
        },
      });
    }, 400);
  }

  document.addEventListener('mouseup', onSelectionChange);
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey) onSelectionChange();
  });
})();
