/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Workers are bundled as ES modules so they can `import` transformers.js.
  worker: { format: 'es' },
  optimizeDeps: {
    // Pre-bundling breaks onnxruntime-web's runtime lookup of its .wasm/.mjs files.
    exclude: ['@huggingface/transformers'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
