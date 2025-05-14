import { defineConfig } from 'vite';

export default defineConfig({
  // root: 'web', 
  // base: '/rhythmanalysis/',
  server: {
    host: true, // Allow network access
    port: 5173,
  },
});
