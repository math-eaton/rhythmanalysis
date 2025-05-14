import { defineConfig } from 'vite';

export default defineConfig({
  // root: 'web', 
  // base: '/rhythmanalysis/',
  build: {
    outDir: 'dist'
  },
  server: {
    host: true, // Allow network access
    port: 5173,
  },
});
