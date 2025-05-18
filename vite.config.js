import { defineConfig } from 'vite'
import fs from 'fs';

// Load dbconfig.json for local dev API endpoint
let localApiBaseUrl = undefined;
try {
  const dbconfig = JSON.parse(fs.readFileSync('./dbconfig.json', 'utf8'));
  // Assume local API server runs on 3000
  localApiBaseUrl = dbconfig.local_api_base_url || 'http://localhost:3000/api';
} catch (e) {
  // fallback: do nothing
}

export default defineConfig(({ mode }) => ({
  base: '/rhythmanalysis/',
  build: {
    outDir: 'dist'
  },
  server: {
    host: true,
    port: 5173,
    proxy: mode === 'development' && localApiBaseUrl ? {
      '/api': {
        target: localApiBaseUrl,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '/api'),
      },
    } : undefined,
  },
}));
