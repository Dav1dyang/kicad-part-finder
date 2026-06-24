/**
 * In-page overlay — a draggable, resizable, minimizable finder panel injected
 * directly onto the current web page (the v1-style "float mode"). Injected by the
 * service worker via chrome.scripting.executeScript when `openMode` is 'overlay'.
 *
 * Style isolation: the whole panel lives inside a Shadow DOM host attached to the
 * page, so the host page's CSS can't bleed in and ours can't bleed out. The host
 * is positioned `fixed` with a very high z-index.
 *
 * The finder UI itself is an <iframe> pointing at the extension's side-panel page
 * with `?overlay=1`. The iframe is an EXTENSION-ORIGIN document, so chrome.runtime
 * / chrome.storage and all relay fetches work inside it unchanged — only File
 * System Access is blocked there (cross-origin iframe), which the side-panel UI
 * detects via `overlay=1` and delegates to a real window through the SW.
 *
 * Re-invoking toggles show/hide + focus rather than stacking duplicates (the
 * `window.__kicadOverlayActive` guard, same pattern as the selection listener).
 * Position/size/minimized persist to chrome.storage.local `overlayBounds`,
 * clamped to the viewport on load and on window resize.
 *
 * Wrapped in an IIFE so re-injection can't redeclare top-level bindings.
 */

import {
  clampOverlayBounds,
  defaultOverlayBounds,
  OVERLAY_MIN_WIDTH,
  OVERLAY_MIN_HEIGHT,
  type OverlayBounds,
} from './overlay-bounds.js';

// ---------------------------------------------------------------------------
// Markup + styles (declared before the IIFE so it can reference them — these are
// static template strings with no interpolated page/user data, so `innerHTML`
// below carries no injection surface).
// ---------------------------------------------------------------------------

const PANEL_HTML = `
  <div class="ov-header">
    <span class="ov-grip" aria-hidden="true">⋮⋮</span>
    <span class="ov-title">KiCad Part Finder</span>
    <span class="ov-spacer"></span>
    <button class="ov-btn ov-min" type="button" title="Minimize" aria-label="Minimize">—</button>
    <button class="ov-btn ov-close" type="button" title="Close" aria-label="Close">×</button>
  </div>
  <div class="ov-body"></div>
  <div class="ov-resize" title="Resize" aria-hidden="true"></div>
`;

const OVERLAY_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }

  .panel {
    position: fixed;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    min-width: ${OVERLAY_MIN_WIDTH}px;
    min-height: 0;
    background: #15181d;
    color: #e7eaee;
    border: 1px solid #2a2f37;
    border-radius: 12px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 2px 10px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
  }
  .panel.is-dragging, .panel.is-resizing { user-select: none; }
  .panel.is-dragging .ov-frame, .panel.is-resizing .ov-frame { pointer-events: none; }

  .ov-header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 8px 0 10px;
    background: linear-gradient(180deg, #1c2128, #181b21);
    border-bottom: 1px solid #2a2f37;
    cursor: grab;
    flex: 0 0 auto;
    touch-action: none;
  }
  .panel.is-dragging .ov-header { cursor: grabbing; }

  .ov-grip { color: #5d6470; font-size: 12px; letter-spacing: -2px; cursor: grab; }
  .ov-title {
    font-weight: 600;
    font-size: 12.5px;
    color: #cfd4db;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0.1px;
  }
  .ov-spacer { flex: 1 1 auto; }

  .ov-btn {
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    color: #9aa2ad;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .ov-btn:hover { background: #262c35; color: #e7eaee; }
  .ov-close:hover { background: #3a2226; color: #ff8088; }

  .ov-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .ov-frame {
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #15181d;
  }

  .ov-resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    touch-action: none;
    background:
      linear-gradient(135deg, transparent 50%, #3a414b 50%, #3a414b 60%, transparent 60%,
        transparent 70%, #3a414b 70%, #3a414b 80%, transparent 80%);
  }

  /* CSP-blocked-frame fallback: a centered message + "open in a window" button. */
  .ov-fallback {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px;
    text-align: center;
  }
  .ov-fallback p { margin: 0; color: #aab2bd; line-height: 1.5; font-size: 13px; }
  .ov-fallback-btn {
    all: unset;
    padding: 8px 16px;
    border-radius: 8px;
    background: #2a6f53;
    color: #eafff4;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
  }
  .ov-fallback-btn:hover { background: #318063; }

  /* Minimized: hide the body + resize handle, keep just the header bar. */
  .panel.is-minimized .ov-body,
  .panel.is-minimized .ov-resize { display: none; }
  .panel.is-minimized { height: auto !important; min-height: 0; }
`;

(() => {
  const FLAG = '__kicadOverlayActive';
  const w = window as unknown as Record<string, unknown>;

  // Re-invocation: if the overlay already exists, toggle its visibility + focus
  // instead of injecting a second one. A small controller is stashed on `window`.
  const existing = w[FLAG] as { toggle: () => void } | undefined;
  if (existing && typeof existing.toggle === 'function') {
    existing.toggle();
    return;
  }

  const STORAGE_KEY = 'overlayBounds';
  const HOST_ID = 'kicad-part-finder-overlay-host';
  const IFRAME_URL = `${chrome.runtime.getURL('src/sidepanel/index.html')}?overlay=1`;

  // --- Host + Shadow root ----------------------------------------------------
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Reset the host against the page's CSS and pin it as a zero-size fixed anchor
  // at the top-left. The panel inside the shadow root is itself `position: fixed`,
  // so it's viewport-relative; pinning the host (with !important to beat hostile
  // page rules) keeps things sane even under unusual page stylesheets.
  host.style.cssText =
    'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important;' +
    'width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important;' +
    'border: 0 !important; z-index: 2147483647 !important;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'KiCad Part Finder');
  panel.innerHTML = PANEL_HTML;
  shadow.appendChild(panel);

  (document.body || document.documentElement).appendChild(host);

  // --- Element refs ----------------------------------------------------------
  const headerEl = panel.querySelector('.ov-header') as HTMLElement;
  const minBtn = panel.querySelector('.ov-min') as HTMLButtonElement;
  const closeBtn = panel.querySelector('.ov-close') as HTMLButtonElement;
  const bodyEl = panel.querySelector('.ov-body') as HTMLElement;
  const resizeEl = panel.querySelector('.ov-resize') as HTMLElement;

  // The finder iframe (extension-origin page; FS-Access delegated to a window).
  const frame = document.createElement('iframe');
  frame.className = 'ov-frame';
  frame.src = IFRAME_URL;
  frame.title = 'KiCad Part Finder';
  // `allow` is belt-and-braces; FS-Access is blocked in cross-origin iframes
  // regardless, which is exactly why install is delegated to a real window.
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  bodyEl.appendChild(frame);

  // A few pages ship a strict CSP `frame-src` that can refuse even an
  // extension-origin frame. The `load` event fires when the extension page
  // mounts; if it hasn't fired shortly after, assume the frame was blocked and
  // offer to open the finder in a normal window instead (so the panel never just
  // shows blank). Cleared the moment the frame loads.
  let frameLoaded = false;
  frame.addEventListener('load', () => {
    frameLoaded = true;
  });
  const frameWatchdog = setTimeout(() => {
    if (!frameLoaded) showFrameFallback();
  }, 2500);

  /** Replace the (blocked) iframe with a "open in a window" fallback. */
  function showFrameFallback() {
    bodyEl.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'ov-fallback';
    const msg = document.createElement('p');
    msg.textContent = "This page blocks embedded panels. Open the finder in a window instead.";
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ov-fallback-btn';
    btn.textContent = 'Open in a window';
    btn.addEventListener('click', () => {
      try {
        void chrome.runtime.sendMessage({ type: 'OVERLAY_FALLBACK_WINDOW' });
      } catch {
        /* SW unreachable — nothing more we can do from here */
      }
      teardown();
    });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    bodyEl.appendChild(wrap);
  }

  // --- State -----------------------------------------------------------------
  let bounds: OverlayBounds = defaultOverlayBounds(viewport());
  let hidden = false;

  function viewport() {
    return {
      width: window.innerWidth || document.documentElement.clientWidth || 1024,
      height: window.innerHeight || document.documentElement.clientHeight || 768,
    };
  }

  /** Write the current bounds onto the panel element. */
  function applyBounds() {
    panel.style.left = `${bounds.left}px`;
    panel.style.top = `${bounds.top}px`;
    panel.style.width = `${bounds.width}px`;
    // When minimized, collapse to just the header height (CSS handles the body).
    panel.style.height = bounds.minimized ? 'auto' : `${bounds.height}px`;
    panel.classList.toggle('is-minimized', bounds.minimized);
    minBtn.setAttribute('aria-expanded', String(!bounds.minimized));
    minBtn.title = bounds.minimized ? 'Expand' : 'Minimize';
    minBtn.textContent = bounds.minimized ? '▢' : '—';
  }

  /** Persist the current bounds (best-effort; never throws). */
  function saveBounds() {
    try {
      void chrome.storage.local.set({ [STORAGE_KEY]: bounds }).catch(() => {});
    } catch {
      /* storage unavailable — keep the in-memory bounds for this session */
    }
  }

  /** Re-clamp to the (possibly new) viewport and re-apply. */
  function reclamp() {
    bounds = clampOverlayBounds(bounds, viewport());
    applyBounds();
  }

  // --- Dragging (header) -----------------------------------------------------
  let dragStart: { x: number; y: number; left: number; top: number } | null = null;

  function onHeaderPointerDown(e: PointerEvent) {
    // Ignore drags that start on the header buttons.
    if ((e.target as HTMLElement)?.closest('.ov-btn')) return;
    if (e.button !== 0) return;
    dragStart = { x: e.clientX, y: e.clientY, left: bounds.left, top: bounds.top };
    headerEl.setPointerCapture(e.pointerId);
    panel.classList.add('is-dragging');
    e.preventDefault();
  }

  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    bounds = clampOverlayBounds(
      { ...bounds, left: dragStart.left + dx, top: dragStart.top + dy },
      viewport(),
    );
    applyBounds();
  }

  function onHeaderPointerUp(e: PointerEvent) {
    if (!dragStart) return;
    dragStart = null;
    panel.classList.remove('is-dragging');
    try {
      headerEl.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may have already been released */
    }
    saveBounds();
  }

  // --- Resizing (corner handle) ---------------------------------------------
  let resizeStart: { x: number; y: number; width: number; height: number } | null = null;

  function onResizePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    resizeStart = { x: e.clientX, y: e.clientY, width: bounds.width, height: bounds.height };
    resizeEl.setPointerCapture(e.pointerId);
    panel.classList.add('is-resizing');
    e.preventDefault();
    e.stopPropagation();
  }

  function onResizePointerMove(e: PointerEvent) {
    if (!resizeStart) return;
    const dw = e.clientX - resizeStart.x;
    const dh = e.clientY - resizeStart.y;
    bounds = clampOverlayBounds(
      {
        ...bounds,
        width: Math.max(OVERLAY_MIN_WIDTH, resizeStart.width + dw),
        height: Math.max(OVERLAY_MIN_HEIGHT, resizeStart.height + dh),
        minimized: false,
      },
      viewport(),
    );
    applyBounds();
  }

  function onResizePointerUp(e: PointerEvent) {
    if (!resizeStart) return;
    resizeStart = null;
    panel.classList.remove('is-resizing');
    try {
      resizeEl.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    saveBounds();
  }

  // --- Minimize / close ------------------------------------------------------
  function toggleMinimize() {
    bounds = { ...bounds, minimized: !bounds.minimized };
    applyBounds();
    saveBounds();
  }

  /** Toggle the whole overlay's visibility (re-invoke from the toolbar icon). */
  function toggleVisibility() {
    hidden = !hidden;
    // setProperty with priority beats the `all: initial !important` host reset.
    host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
    if (!hidden) {
      reclamp();
      focusFrame();
    }
  }

  /** Focus the iframe so keyboard input lands in the finder, best-effort. */
  function focusFrame() {
    try {
      frame.focus();
    } catch {
      /* cross-origin focus may be restricted — non-fatal */
    }
  }

  /** Tear everything down cleanly and release the re-injection guard. */
  function teardown() {
    window.removeEventListener('resize', reclamp);
    clearTimeout(frameWatchdog);
    try {
      host.remove();
    } catch {
      /* already detached */
    }
    delete w[FLAG];
  }

  // Note: the SW broadcasts (OVERLAY_INSTALLED / OVERLAY_FOLDER_READY / …) when a
  // delegated helper window finishes, but those go via chrome.runtime.sendMessage,
  // which does NOT reach content scripts — only extension pages. The overlay's
  // iframe IS an extension page and handles them itself (refresh readiness /
  // success / failure), so the content script needs no message listener here. (A
  // previous header "pulse" listener was dead code — it could never fire.)

  // --- Wire up listeners -----------------------------------------------------
  headerEl.addEventListener('pointerdown', onHeaderPointerDown);
  headerEl.addEventListener('pointermove', onHeaderPointerMove);
  headerEl.addEventListener('pointerup', onHeaderPointerUp);
  headerEl.addEventListener('pointercancel', onHeaderPointerUp);
  // Double-click the header to toggle minimize (a familiar window affordance).
  headerEl.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement)?.closest('.ov-btn')) return;
    toggleMinimize();
  });

  resizeEl.addEventListener('pointerdown', onResizePointerDown);
  resizeEl.addEventListener('pointermove', onResizePointerMove);
  resizeEl.addEventListener('pointerup', onResizePointerUp);
  resizeEl.addEventListener('pointercancel', onResizePointerUp);

  minBtn.addEventListener('click', toggleMinimize);
  closeBtn.addEventListener('click', teardown);

  window.addEventListener('resize', reclamp);

  // Expose the toggle so a re-injection toggles visibility instead of stacking.
  w[FLAG] = { toggle: toggleVisibility };

  // --- Boot: restore saved bounds, then show ---------------------------------
  (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      bounds = clampOverlayBounds(stored?.[STORAGE_KEY] as Partial<OverlayBounds>, viewport());
    } catch {
      bounds = defaultOverlayBounds(viewport());
    }
    applyBounds();
    focusFrame();
  })();
})();

