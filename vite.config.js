import { defineConfig } from 'vite'

export default defineConfig({
  base: '/rhythmanalysis/',

  build: {
    outDir: 'dist'
  },
  server: {
    host: true,
    port: 5173,
  },
})
