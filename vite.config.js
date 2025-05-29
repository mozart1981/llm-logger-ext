import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'esnext',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        'scripts/background': resolve(__dirname, 'scripts/background.js'),
        'scripts/content': resolve(__dirname, 'scripts/content.js'),
        'scripts/offscreen_controller': resolve(__dirname, 'scripts/offscreen_controller.js'),
        'scripts/vlm_worker': resolve(__dirname, 'scripts/vlm_worker.js'),
        'scripts/summarizer_worker': resolve(__dirname, 'scripts/summarizer_worker.js'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    emptyOutDir: true,
  },
  publicDir: './public',
});
