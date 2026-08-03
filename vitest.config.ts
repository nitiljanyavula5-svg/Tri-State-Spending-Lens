import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // Tailwind is not needed to assert behaviour, and skipping CSS keeps the
    // component suite fast.
    css: false,
    restoreMocks: true,
    // The data-layer tests drive a real Dexie database through an IndexedDB
    // shim, which is slower than a plain render. The default 5s is enough on a
    // fast machine and marginal on a loaded CI runner.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
