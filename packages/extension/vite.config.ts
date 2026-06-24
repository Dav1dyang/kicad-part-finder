import { defineConfig } from 'vite';
import { resolve } from 'path';
import { cpSync } from 'fs';

export default defineConfig({
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
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared/src'),
    },
  },
  plugins: [
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
});
