/**
 * Background service worker — routes messages between content scripts and side panel.
 * Detects sidePanel API support and falls back to floating panel on unsupported browsers.
 * Injects a text selection listener when the panel is active so highlighting text
 * on any page triggers a component search.
 */

import type { DetectedPart } from '@kicad-part-finder/shared';

// Store the most recently detected part per tab
const detectedParts = new Map<number, DetectedPart>();
// Track which tabs have the selection listener injected
const selectionListenerInjected = new Set<number>();

/** Check if chrome.sidePanel actually works (Arc exposes namespace but doesn't implement it) */
let sidePanelSupported: boolean | null = null;
async function isSidePanelSupported(): Promise<boolean> {
  if (sidePanelSupported !== null) return sidePanelSupported;

  if (!chrome?.sidePanel?.getOptions) {
    sidePanelSupported = false;
    return false;
  }

  try {
    await chrome.sidePanel.getOptions({});
    sidePanelSupported = true;
  } catch {
    sidePanelSupported = false;
  }
  return sidePanelSupported;
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PART_DETECTED' && sender.tab?.id) {
    detectedParts.set(sender.tab.id, message.part);
    // Update badge to indicate a part was found
    chrome.action.setBadgeText({ text: '1', tabId: sender.tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab.id });
  }

  if (message.type === 'NO_PART_FOUND' && sender.tab?.id) {
    detectedParts.delete(sender.tab.id);
    chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
  }

  // Side panel or floating panel requesting current part info
  if (message.type === 'GET_DETECTED_PART') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id && detectedParts.has(tab.id)) {
        sendResponse({ part: detectedParts.get(tab.id) });
      } else {
        sendResponse({ part: null });
      }
    });
    return true; // Keep channel open for async response
  }

  return false;
});

// Handle extension icon click (or Cmd+Shift+2)
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  const supported = await isSidePanelSupported();

  if (supported) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      await injectFloatingPanel(tab.id);
    }
  } else {
    await injectFloatingPanel(tab.id);
  }

  // Inject selection listener on the active tab
  await injectSelectionListener(tab.id);
});

/** Inject the floating panel content script and toggle it */
async function injectFloatingPanel(tabId: number) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_FLOATING_PANEL' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/floating-panel.js'],
      });
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'SHOW_FLOATING_PANEL' });
        } catch { /* ignore */ }
      }, 100);
    } catch (err) {
      console.error('Failed to inject floating panel:', err);
    }
  }
}

/** Inject the text selection listener so highlighting text triggers a search */
async function injectSelectionListener(tabId: number) {
  if (selectionListenerInjected.has(tabId)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selection-listener.js'],
    });
    selectionListenerInjected.add(tabId);
  } catch {
    // Ignore — page may not allow script injection (e.g., chrome:// pages)
  }
}

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedParts.delete(tabId);
  selectionListenerInjected.delete(tabId);
});

// When tab navigates to a new page, re-inject selection listener if it was active
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && selectionListenerInjected.has(tabId)) {
    selectionListenerInjected.delete(tabId);
    injectSelectionListener(tabId);
  }
});
