import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  build: {
    // Aladin Lite ships its WebAssembly engine inline; it is loaded lazily in its own chunk.
    chunkSizeWarningLimit: 3000,
  },
  server: {
    proxy: { '/api': 'http://localhost:8000', '/analysis': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
