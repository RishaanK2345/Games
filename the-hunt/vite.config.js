import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  base: './',                       // works from any folder or host
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { port: 5173 },
});
