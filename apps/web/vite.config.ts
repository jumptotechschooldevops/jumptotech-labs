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
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 3000),
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
