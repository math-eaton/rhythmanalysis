import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web', 
  server: {
    host: true, // Allow network access
    // port: 5173,
  },
});
