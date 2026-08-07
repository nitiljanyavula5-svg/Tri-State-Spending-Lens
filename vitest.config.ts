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
    /**
     * Run test files one at a time, in worker threads.
     *
     * Most files here stand up a full jsdom document, and several add an
     * IndexedDB shim and a real Dexie database on top. Running several at once
     * needs more memory than a loaded machine reliably has, and the failure
     * mode is nasty: Vitest reports `[vitest-pool]: Failed to start worker` as
     * an *unhandled error* rather than a test failure, so the run goes red
     * while every test that actually executed passed.
     *
     * That was reproduced here at 4 threads and again at 2 — concurrency level
     * only changed how often it happened, not whether it did. Sequential
     * execution is the only setting observed to pass repeatably, so it is the
     * one committed: a verification suite that is intermittently red for
     * environmental reasons is worse than a slow one.
     *
     * Cost, measured on this machine: about 50s parallel versus about 290s
     * sequential. Raise `fileParallelism` on a runner with real memory headroom.
     */
    pool: 'threads',
    fileParallelism: false,
  },
});
