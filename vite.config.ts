import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      /**
       * The import-worker harness is an end-to-end test fixture, not a product
       * surface: it exists so Playwright can drive the *real* module worker,
       * which jsdom cannot run.
       *
       * It is added as a build input only under `--mode e2e`. A plain
       * `npm run build` therefore emits `index.html` alone, and no production
       * route or link points at the harness.
       */
      input:
        mode === 'e2e'
          ? {
              main: resolve('./index.html'),
              importWorkerHarness: resolve('./tests/harness/import-worker.html'),
            }
          : undefined,
    },
  },
}));
