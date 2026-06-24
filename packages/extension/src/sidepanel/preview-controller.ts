/**
 * Preview controller — owns the Symbol · Footprint · 3D segmented block in the
 * result card.
 *
 * Responsibilities:
 *   • Wire the three tab buttons to their panes (visibility + ARIA state).
 *   • Render each preview LAZILY on first activation — the symbol/footprint SVGs
 *     aren't parsed until their tab is shown, and three.js isn't imported until
 *     the 3D tab is opened (see {@link mount3dPreview}).
 *   • Keep every render wrapped so a parse/render failure shows "preview
 *     unavailable" instead of breaking the card.
 *   • Tear down the 3D scene (animation loop + WebGL context) when the part
 *     changes or the card resets, so nothing leaks across installs.
 *
 * The DOM wiring lives here; the actual parsing/drawing is in the pure
 * preview-* modules. Call {@link setResult} each time a new part is shown and
 * {@link reset} when the card is cleared.
 */

import type { ConvertResult } from '../lib/converter/easyeda.js';
import { footprintToSvg } from './preview-footprint.js';
import { symbolToSvg } from './preview-symbol.js';
import { mount3dPreview, type Preview3dHandle } from './preview-3d.js';

/** Which preview a tab/pane represents. */
export type PreviewKind = 'symbol' | 'footprint' | '3d';

const KINDS: PreviewKind[] = ['symbol', 'footprint', '3d'];

/** The tab button + its pane for one preview kind. */
interface PreviewTab {
  tab: HTMLButtonElement;
  pane: HTMLElement;
}

/**
 * Construct the controller over an already-rendered preview block. Returns a
 * small API the side panel drives; throws nothing — if the expected elements
 * are missing it simply no-ops.
 *
 * @param root the element containing the `.preview-tab` / `.preview-pane` nodes
 *   (the result card, or `document`). Defaults to `document`.
 */
export function createPreviewController(root: ParentNode = document) {
  const tabs = new Map<PreviewKind, PreviewTab>();
  for (const kind of KINDS) {
    const tab = root.querySelector<HTMLButtonElement>(`.preview-tab[data-preview="${kind}"]`);
    const pane = tab?.getAttribute('aria-controls')
      ? root.querySelector<HTMLElement>(`#${tab.getAttribute('aria-controls')}`)
      : null;
    if (tab && pane) tabs.set(kind, { tab, pane });
  }

  // Per-part state.
  let result: ConvertResult | null = null;
  let relayUrl = '';
  let active: PreviewKind = 'symbol';
  const rendered = new Set<PreviewKind>();
  let handle3d: Preview3dHandle | null = null;

  /** Replace a pane's contents with a quiet "preview unavailable" note. */
  function setUnavailable(pane: HTMLElement, message = 'Preview unavailable.'): void {
    pane.textContent = '';
    const note = document.createElement('div');
    note.className = 'preview-unavailable';
    const glyph = document.createElement('span');
    glyph.className = 'preview-3d-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '⌀';
    const text = document.createElement('span');
    text.textContent = message;
    note.appendChild(glyph);
    note.appendChild(text);
    pane.appendChild(note);
  }

  /** Render the symbol/footprint SVG into a pane, or the unavailable note. */
  function renderSvgPane(pane: HTMLElement, text: string, kind: 'symbol' | 'footprint'): void {
    pane.textContent = '';
    let svg: SVGElement | null = null;
    try {
      svg = kind === 'symbol' ? symbolToSvg(text) : footprintToSvg(text);
    } catch {
      svg = null;
    }
    if (svg) {
      pane.appendChild(svg);
    } else {
      setUnavailable(pane, `No ${kind} preview available.`);
    }
  }

  /** Lazily render one preview kind the first time it's shown. */
  function ensureRendered(kind: PreviewKind): void {
    if (rendered.has(kind) || !result) return;
    const entry = tabs.get(kind);
    if (!entry) return;
    rendered.add(kind);

    if (kind === 'symbol') {
      renderSvgPane(entry.pane, result.symbol, 'symbol');
    } else if (kind === 'footprint') {
      renderSvgPane(entry.pane, result.footprint, 'footprint');
    } else {
      // 3D: dispose any prior scene, then mount a new one (it imports three.js
      // lazily and handles its own loading/empty/error states).
      handle3d?.dispose();
      try {
        handle3d = mount3dPreview(entry.pane, result.model3dUrl, relayUrl);
      } catch {
        handle3d = null;
        setUnavailable(entry.pane, 'No 3D preview available.');
      }
    }
  }

  /** Show a preview kind: toggle tab/pane state and lazily render it. */
  function activate(kind: PreviewKind): void {
    if (!tabs.has(kind)) return;
    active = kind;
    for (const [k, { tab, pane }] of tabs) {
      const on = k === kind;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      pane.classList.toggle('is-active', on);
      if (on) pane.removeAttribute('hidden');
      else pane.setAttribute('hidden', '');
    }
    ensureRendered(kind);
  }

  // Wire tab clicks once.
  for (const [kind, { tab }] of tabs) {
    tab.addEventListener('click', () => activate(kind));
  }

  return {
    /**
     * Point the previews at a new part. Clears prior renders, tears down any
     * 3D scene, resets to the Symbol tab, and renders it lazily.
     */
    setResult(next: ConvertResult, relay: string): void {
      result = next;
      relayUrl = relay;
      rendered.clear();
      handle3d?.dispose();
      handle3d = null;
      // Clear every pane so stale content never flashes when switching parts.
      for (const { pane } of tabs.values()) pane.textContent = '';
      activate('symbol');
    },

    /** Programmatically switch tabs (also used by the click handlers). */
    activate,

    /** The currently-active preview kind. */
    get active(): PreviewKind {
      return active;
    },

    /**
     * Clear all previews and free resources (called when the card is hidden /
     * "Install another"). Leaves the Symbol tab selected for next time.
     */
    reset(): void {
      result = null;
      relayUrl = '';
      rendered.clear();
      handle3d?.dispose();
      handle3d = null;
      for (const { pane } of tabs.values()) pane.textContent = '';
      // Reset tab visuals to the default without rendering anything.
      for (const [k, { tab, pane }] of tabs) {
        const on = k === 'symbol';
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', String(on));
        pane.classList.toggle('is-active', on);
        if (on) pane.removeAttribute('hidden');
        else pane.setAttribute('hidden', '');
      }
      active = 'symbol';
    },
  };
}

/** The controller instance type (for typing the side panel's reference). */
export type PreviewController = ReturnType<typeof createPreviewController>;
