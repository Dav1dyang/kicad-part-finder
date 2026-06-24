/**
 * Document Picture-in-Picture "float on top" support.
 *
 * Moves the panel's single root node (`#app`) into a Document PiP window so the
 * UI floats above every other window, then moves it back when that window
 * closes. The PiP window is same-origin with the extension page, so the File
 * System Access install (`showDirectoryPicker`) and all relay fetches keep
 * working inside it unchanged.
 *
 * Everything here is feature-detected and defensive: if `documentPictureInPicture`
 * is unavailable, {@link isPipSupported} returns false and the caller hides the
 * Float button. `requestWindow` can also reject when called from a context that
 * isn't a top-level tab (a side panel or an extension popup window) — the caller
 * handles that rejection and degrades gracefully.
 *
 * The DOM-free string/predicate helpers are exported for unit testing; the parts
 * that touch `window`/`document` are not.
 */

/** The Document PiP window size we request (matches the popup-window fallback). */
export const PIP_WINDOW_SIZE = { width: 460, height: 760 } as const;

/**
 * Whether Document Picture-in-Picture is available in this context. Pure feature
 * detection — does not attempt to open anything. `win` defaults to the ambient
 * `window` but is injectable for tests.
 */
export function isPipSupported(win: unknown = globalThis): boolean {
  const w = win as { documentPictureInPicture?: { requestWindow?: unknown } };
  return (
    !!w &&
    typeof w.documentPictureInPicture === 'object' &&
    w.documentPictureInPicture !== null &&
    typeof w.documentPictureInPicture.requestWindow === 'function'
  );
}

/**
 * Copy the source document's style into a freshly-opened PiP document so the
 * moved UI renders identically. Clones every `<style>` and `<link rel=stylesheet>`
 * from the source `<head>`, and adopts any constructed stylesheets the source
 * document is using.
 *
 * Resilient to partial failures (a malformed sheet, a cross-origin adopted sheet)
 * so styling is best-effort and never throws.
 */
export function copyStyles(sourceDoc: Document, pipDoc: Document): void {
  // 1. Clone <style> and <link rel="stylesheet"> nodes verbatim.
  const nodes = sourceDoc.querySelectorAll('style, link[rel="stylesheet"]');
  for (const node of Array.from(nodes)) {
    try {
      pipDoc.head.appendChild(node.cloneNode(true));
    } catch {
      /* skip a single un-cloneable node */
    }
  }

  // 2. Adopt constructed stylesheets (CSSStyleSheet objects attached via
  //    adoptedStyleSheets), if both documents support it.
  try {
    const adopted = (sourceDoc as unknown as { adoptedStyleSheets?: CSSStyleSheet[] })
      .adoptedStyleSheets;
    if (adopted && adopted.length && 'adoptedStyleSheets' in pipDoc) {
      (pipDoc as unknown as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = [
        ...(pipDoc as unknown as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets,
        ...adopted,
      ];
    }
  } catch {
    /* constructed-sheet adoption unsupported / cross-origin — ignore */
  }
}

/** Minimal shape of the Document PiP API we rely on. */
interface DocumentPip {
  requestWindow(opts: { width: number; height: number }): Promise<Window>;
}

/** Options/callbacks for {@link floatOnTop}. */
export interface FloatOptions {
  /** The node to move into (and back out of) the PiP window — usually `#app`. */
  root: HTMLElement;
  /** Called once the UI is in the floating window (e.g. to show the note). */
  onEnter?: (pipWindow: Window) => void;
  /** Called after the UI has been moved back (e.g. to hide the note). */
  onLeave?: () => void;
}

/** Handle returned by {@link floatOnTop} for programmatically closing the float. */
export interface FloatHandle {
  /** The open PiP window. */
  pipWindow: Window;
  /** Close the float and restore the UI to the original document. */
  close(): void;
}

/**
 * Best-effort keep-awake for Arc. Arc backgrounds/suspends the opener tab the
 * moment you switch tabs, which drops the Document PiP window with it (Chrome and
 * Dia keep it — that is the spec). Holding the opener "audible" with an inaudible
 * Web Audio tone makes Arc less likely to suspend it while floating. Feature-
 * detected and fully reversible; a harmless no-op everywhere else.
 */
function keepOpenerAwake(win: Window): () => void {
  try {
    const Ctx =
      (win as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (win as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return () => {};
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001; // inaudible, but marks the tab as producing audio
    osc.frequency.value = 1;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    return () => {
      try { osc.stop(); } catch { /* already stopped */ }
      try { void ctx.close(); } catch { /* already closed */ }
    };
  } catch {
    return () => {};
  }
}

/**
 * Move `root` into a new Document PiP window (always-on-top), copying styles so
 * it looks identical. The node is returned to its original parent when the PiP
 * window closes (via `pagehide`) or {@link FloatHandle.close} is called.
 *
 * Must be invoked from a user gesture. Rejects if the API is unavailable or the
 * current context can't open a PiP window (e.g. a side panel / extension popup).
 *
 * @param win injectable ambient window (defaults to the real `window`).
 */
export async function floatOnTop(
  opts: FloatOptions,
  win: Window = window,
): Promise<FloatHandle> {
  if (!isPipSupported(win)) {
    throw new Error('Document Picture-in-Picture is not supported here.');
  }

  const { root, onEnter, onLeave } = opts;
  const sourceDoc = root.ownerDocument;
  // Remember exactly where the node was so we can put it back in place.
  const originalParent = root.parentNode;
  const originalNextSibling = root.nextSibling;

  const pip = (win as unknown as { documentPictureInPicture: DocumentPip })
    .documentPictureInPicture;
  const pipWindow = await pip.requestWindow({ ...PIP_WINDOW_SIZE });

  // Arc suspends the backgrounded opener tab + drops the float; try to hold it awake.
  const stopKeepAwake = keepOpenerAwake(win);

  // Mirror lang + a base background so there's no white flash before styles load.
  try {
    pipWindow.document.documentElement.lang = sourceDoc.documentElement.lang || 'en';
    pipWindow.document.documentElement.style.colorScheme = 'dark';
    pipWindow.document.body.style.margin = '0';
  } catch {
    /* non-fatal */
  }

  copyStyles(sourceDoc, pipWindow.document);

  // Move the live node (preserves form state + listeners) into the PiP window.
  pipWindow.document.body.appendChild(root);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stopKeepAwake();
    // Put the node back exactly where it came from.
    try {
      if (originalParent) {
        if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
          originalParent.insertBefore(root, originalNextSibling);
        } else {
          originalParent.appendChild(root);
        }
      } else {
        sourceDoc.body.appendChild(root);
      }
    } catch {
      try {
        sourceDoc.body.appendChild(root);
      } catch {
        /* give up silently — the page can be reopened */
      }
    }
    onLeave?.();
  };

  // The PiP window fires pagehide when the user closes it (or it's closed
  // programmatically). Restore the UI then.
  pipWindow.addEventListener('pagehide', restore, { once: true });

  onEnter?.(pipWindow);

  return {
    pipWindow,
    close() {
      try {
        pipWindow.close();
      } catch {
        /* if close() is blocked, still restore the DOM */
        restore();
      }
    },
  };
}
