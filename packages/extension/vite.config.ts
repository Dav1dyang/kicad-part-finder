import { defineConfig } from 'vite';
import { resolve } from 'path';
import { cpSync } from 'fs';

export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'content/digikey': resolve(__dirname, 'src/content/digikey.ts'),
        'content/lcsc': resolve(__dirname, 'src/content/lcsc.ts'),
        'content/selection-listener': resolve(__dirname, 'src/content/selection-listener.ts'),
        // In-page overlay content script (injected via executeScript). Must be a
        // SELF-CONTAINED classic script: its only helper (overlay-bounds.ts) is
        // imported by NO other entry, so rollup inlines it here instead of
        // splitting a chunk the classic content script couldn't import. (The
        // side-panel's overlay params live in the separate overlay-params.ts.)
        'content/overlay': resolve(__dirname, 'src/content/overlay.ts'),
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'sidepanel/sidepanel': resolve(__dirname, 'src/sidepanel/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'sidepanel/[name][extname]',
      },
    },
    target: 'es2022',
    minify: false,
    // Source maps triple the shipped size (three.js alone is 3 MB of map);
    // keep them for `pnpm dev:extension` only.
    sourcemap: mode === 'development',
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared/src'),
    },
  },
  plugins: [
    {
      name: 'iife-wrap-overlay-content',
      // content/overlay.js is re-injected via executeScript; rollup emits its
      // inlined helper consts (OVERLAY_MIN_WIDTH, etc.) and the static markup/CSS
      // at top level, which redeclare on the 2nd injection ("Identifier already
      // declared"). Wrap the whole chunk in an IIFE so every binding is function-
      // scoped; re-running just re-enters the __kicadOverlayActive guard (toggle).
      renderChunk(code, chunk) {
        if (chunk.fileName === 'content/overlay.js') {
          // Prepend the IIFE opener on the SAME first line (no leading newline)
          // and append the closer AFTER the existing code so every original line
          // keeps its line number — the generated sourcemap then still aligns.
          // (A leading `\n` shifted the whole overlay map down by one line.)
          return { code: '(() => {' + code + '\n})();\n', map: null };
        }
        return null;
      },
    },
    {
      name: 'copy-extension-assets',
      closeBundle() {
        // Copy the extension manifest and icons to dist. (The relay replaces the
        // old declarativeNetRequest Referer hack, so rules.json is gone.)
        cpSync(resolve(__dirname, 'manifest.json'), resolve(__dirname, 'dist/manifest.json'));
        cpSync(resolve(__dirname, 'public/icons'), resolve(__dirname, 'dist/icons'), { recursive: true });
      },
    },
  ],
}));
