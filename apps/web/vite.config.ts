/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 3000),
    strictPort: true,
    // Docker Desktop bind mounts do not always deliver inotify events.
    watch: { usePolling: true, interval: 300 },
    /*
     * Same-origin development: leave VITE_API_URL / VITE_TERMINAL_WS_URL unset
     * and the UI calls `/api/*`, `/auth/*` and `/terminal` on this dev server,
     * which forwards to the api and terminal processes on localhost.
     *
     * `/auth` must be same-origin like the rest: the session cookie is
     * host-only and `SameSite=Lax`, so it is only ever sent back to the origin
     * that set it.
     */
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      '/auth': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      '/terminal': {
        target: process.env.VITE_DEV_TERMINAL_PROXY ?? 'http://127.0.0.1:4001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 3000),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      '/auth': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      '/terminal': {
        target: process.env.VITE_DEV_TERMINAL_PROXY ?? 'http://127.0.0.1:4001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
    // PLATFORM-006: the host-execution guard. The UI suite has no business
    // starting a process, and this is what proves it rather than assuming it.
    setupFiles: ['../../test-support/vitest.setup.ts'],
  },
});
