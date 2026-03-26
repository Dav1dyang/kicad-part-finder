/**
 * Floating panel fallback — injected when chrome.sidePanel is unavailable (e.g., Arc browser).
 * Creates a draggable, resizable, minimizable panel that loads the side panel UI in an iframe.
 *
 * Uses Shadow DOM to isolate the panel chrome (drag handle, buttons) from the page.
 * The actual UI loads in an iframe pointing to the extension's sidepanel HTML.
 */

const PANEL_ID = 'kicad-part-finder-panel';
const STORAGE_KEY = 'kicad-panel-position';

interface PanelPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
}

const DEFAULT_POSITION: PanelPosition = {
  x: -1, // -1 means "right edge"
  y: 80,
  width: 360,
  height: 580,
  minimized: false,
};

function createPanel() {
  // Don't create duplicates
  if (document.getElementById(PANEL_ID)) return;

  // Host element — fixed position, highest z-index
  const host = document.createElement('div');
  host.id = PANEL_ID;
  host.style.cssText = `
    all: initial;
    position: fixed;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  `;
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  // Inject styles into shadow DOM
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
    }

    .panel {
      position: fixed;
      display: flex;
      flex-direction: column;
      background: #18181b;
      border: 1px solid #3f3f46;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
      overflow: hidden;
      transition: box-shadow 0.15s;
    }

    .panel:hover {
      box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.3);
    }

    .panel.minimized {
      width: auto !important;
      height: auto !important;
      border-radius: 10px;
    }

    .panel.minimized .panel-content {
      display: none;
    }

    .panel.minimized .panel-resize {
      display: none;
    }

    .panel.dragging {
      opacity: 0.9;
      transition: none;
    }

    .titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: #27272a;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      border-bottom: 1px solid #3f3f46;
      min-height: 32px;
      flex-shrink: 0;
    }

    .titlebar:active {
      cursor: grabbing;
    }

    .titlebar-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .titlebar-icon {
      width: 14px;
      height: 14px;
      background: #2563eb;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .titlebar-title {
      font-size: 11px;
      font-weight: 600;
      color: #e4e4e7;
      white-space: nowrap;
    }

    .titlebar-buttons {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .titlebar-btn {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #71717a;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      line-height: 1;
      padding: 0;
      transition: background 0.1s, color 0.1s;
    }

    .titlebar-btn:hover {
      background: #3f3f46;
      color: #e4e4e7;
    }

    .titlebar-btn.close:hover {
      background: #ef4444;
      color: #fff;
    }

    .panel-content {
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    .panel-content iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #18181b;
    }

    .panel-resize {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      z-index: 10;
    }

    .panel-resize::after {
      content: '';
      position: absolute;
      bottom: 4px;
      right: 4px;
      width: 8px;
      height: 8px;
      border-right: 2px solid #52525b;
      border-bottom: 2px solid #52525b;
    }

    /* Snap indicator */
    .panel.snap-right {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }
  `;
  shadow.appendChild(style);

  // Panel container
  const panel = document.createElement('div');
  panel.className = 'panel';
  shadow.appendChild(panel);

  // Title bar
  const titlebar = document.createElement('div');
  titlebar.className = 'titlebar';

  const titleLeft = document.createElement('div');
  titleLeft.className = 'titlebar-left';

  const icon = document.createElement('div');
  icon.className = 'titlebar-icon';

  const title = document.createElement('span');
  title.className = 'titlebar-title';
  title.textContent = 'KiCad Part Finder';

  titleLeft.appendChild(icon);
  titleLeft.appendChild(title);

  const buttons = document.createElement('div');
  buttons.className = 'titlebar-buttons';

  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'titlebar-btn';
  minimizeBtn.textContent = '\u2013'; // –
  minimizeBtn.title = 'Minimize';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'titlebar-btn close';
  closeBtn.textContent = '\u2715'; // ✕
  closeBtn.title = 'Close';

  buttons.appendChild(minimizeBtn);
  buttons.appendChild(closeBtn);

  titlebar.appendChild(titleLeft);
  titlebar.appendChild(buttons);
  panel.appendChild(titlebar);

  // Content (iframe)
  const content = document.createElement('div');
  content.className = 'panel-content';

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('src/sidepanel/index.html');
  content.appendChild(iframe);
  panel.appendChild(content);

  // Resize handle
  const resize = document.createElement('div');
  resize.className = 'panel-resize';
  panel.appendChild(resize);

  // --- Behavior ---

  let pos: PanelPosition = { ...DEFAULT_POSITION };

  // Load saved position
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    if (data[STORAGE_KEY]) {
      pos = { ...DEFAULT_POSITION, ...data[STORAGE_KEY] };
    }
    applyPosition();
  });

  function applyPosition() {
    // Clamp to viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (pos.x === -1) {
      pos.x = vw - pos.width - 8;
    }
    pos.x = Math.max(0, Math.min(pos.x, vw - 60));
    pos.y = Math.max(0, Math.min(pos.y, vh - 40));
    pos.width = Math.max(280, Math.min(pos.width, vw - 20));
    pos.height = Math.max(200, Math.min(pos.height, vh - 20));

    panel.style.left = pos.x + 'px';
    panel.style.top = pos.y + 'px';
    panel.style.width = pos.width + 'px';
    panel.style.height = pos.height + 'px';

    if (pos.minimized) {
      panel.classList.add('minimized');
    } else {
      panel.classList.remove('minimized');
    }

    // Snap to right edge visual indicator
    if (pos.x + pos.width >= vw - 12) {
      panel.classList.add('snap-right');
    } else {
      panel.classList.remove('snap-right');
    }
  }

  function savePosition() {
    chrome.storage.local.set({ [STORAGE_KEY]: pos });
  }

  // --- Dragging ---
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  titlebar.addEventListener('pointerdown', (e) => {
    // Don't drag when clicking buttons
    if ((e.target as HTMLElement).closest('.titlebar-btn')) return;

    isDragging = true;
    dragOffsetX = e.clientX - pos.x;
    dragOffsetY = e.clientY - pos.y;
    panel.classList.add('dragging');
    titlebar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  titlebar.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    pos.x = e.clientX - dragOffsetX;
    pos.y = e.clientY - dragOffsetY;
    applyPosition();
  });

  titlebar.addEventListener('pointerup', () => {
    if (isDragging) {
      isDragging = false;
      panel.classList.remove('dragging');
      savePosition();
    }
  });

  // --- Resizing ---
  let isResizing = false;

  resize.addEventListener('pointerdown', (e) => {
    isResizing = true;
    resize.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  resize.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    pos.width = Math.max(280, e.clientX - pos.x);
    pos.height = Math.max(200, e.clientY - pos.y);
    applyPosition();
  });

  resize.addEventListener('pointerup', () => {
    if (isResizing) {
      isResizing = false;
      savePosition();
    }
  });

  // --- Minimize ---
  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pos.minimized = !pos.minimized;
    applyPosition();
    savePosition();
    minimizeBtn.textContent = pos.minimized ? '+' : '\u2013';
    minimizeBtn.title = pos.minimized ? 'Expand' : 'Minimize';
  });

  // --- Close ---
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    host.remove();
  });

  // --- Double-click title to toggle minimize ---
  titlebar.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.titlebar-btn')) return;
    pos.minimized = !pos.minimized;
    applyPosition();
    savePosition();
    minimizeBtn.textContent = pos.minimized ? '+' : '\u2013';
    minimizeBtn.title = pos.minimized ? 'Expand' : 'Minimize';
  });

  // --- Prevent page interaction when clicking panel ---
  panel.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // --- Reposition on window resize ---
  window.addEventListener('resize', () => {
    applyPosition();
  });
}

function destroyPanel() {
  const host = document.getElementById(PANEL_ID);
  if (host) host.remove();
}

// Guard against double-injection of message listener
if (!(window as unknown as Record<string, boolean>).__kicadFloatingPanelActive) {
(window as unknown as Record<string, boolean>).__kicadFloatingPanelActive = true;
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TOGGLE_FLOATING_PANEL') {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      destroyPanel();
    } else {
      createPanel();
    }
  }
  if (message.type === 'SHOW_FLOATING_PANEL') {
    if (!document.getElementById(PANEL_ID)) {
      createPanel();
    }
  }
  if (message.type === 'HIDE_FLOATING_PANEL') {
    destroyPanel();
  }
});
}

export { createPanel, destroyPanel };
