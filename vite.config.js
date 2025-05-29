import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        // keep the sub‑folder in the output name
        'scripts/background': 'scripts/background.js',
        'scripts/content': 'scripts/content.js',
        'scripts/offscreen_controller': 'scripts/offscreen_controller.js',
        'scripts/vlm_worker': 'scripts/vlm_worker.js',
        'scripts/summarizer_worker': 'scripts/summarizer_worker.js',
      },
      output: {
        entryFileNames: '[name].js',    // no hash, keep path
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
      external: [], // important: force bundling everything, nothing external
    },
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  optimizeDeps: {
    include: [
      '@mlc-ai/web-llm',
    ],
  },
  publicDir: '.',
});
