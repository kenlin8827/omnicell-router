import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { DEFAULT_DEV_PORT } from './src/lib/defaults';

// Single source of truth for the app version: the repository root package.json.
// Injected at build time as the global __APP_VERSION__ (declared in src/vite-env.d.ts).
const appVersion =
  (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string })
    .version ?? '0.0.0';

// Console pages live under /admin/ everywhere (dev + build) so dev URLs match
// production exactly; the dev server auto-redirects / → /admin/. The router
// basename in main.tsx follows import.meta.env.BASE_URL. Backend serves the
// dist under /admin/ — see backend/src/routes/console.ts.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    proxy: {
      // Dev API target = the gateway the dev stack started. scripts/dev.ts
      // resolves ONE port for both children and injects it as PORT here, so
      // this fallback only matters when the frontend runs alone — it mirrors
      // backend DEFAULT_DEV_PORT (never the installed 4000 gateway, never the
      // crowded 3000 dev range).
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? DEFAULT_DEV_PORT}`,
        changeOrigin: true,
      },
      '/v1': {
        target: `http://127.0.0.1:${process.env.PORT ?? DEFAULT_DEV_PORT}`,
        changeOrigin: true,
      },
      // Proxy auto-config (ADR-0022) lives at the gateway root, not under /api.
      '/proxy.pac': {
        target: `http://127.0.0.1:${process.env.PORT ?? DEFAULT_DEV_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
