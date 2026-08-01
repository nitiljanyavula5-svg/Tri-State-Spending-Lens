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
  },
});
