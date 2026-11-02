import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app bundle. The service worker is a second, separate build so it can be
// emitted as a classic worker script at a stable URL: see vite.sw.config.ts.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    manifest: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // In dev the Python API runs on 8000 and serves the runtime config too.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/runtime-config.js': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
});
