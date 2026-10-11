import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

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
      // Dev API target = the live gateway from config.yaml (port: 3000).
      // The old :4000 daemon is gone since gateway port unification.
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
