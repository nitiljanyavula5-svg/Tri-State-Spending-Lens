import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The IndexedDB shim is imported per test file rather than globally: jsdom does
// not implement IndexedDB, but only the data-layer tests need the polyfill, and
// loading it into every component file made the suite noticeably slower.

/**
 * Testing Library's `waitFor` defaults to a 1-second budget, which is tuned for
 * assertions about a render that has already happened.
 *
 * Several suites here wait on something genuinely slower: a real Dexie database
 * opening through the IndexedDB shim, then a live query resolving. One second is
 * comfortable when that file runs alone and marginal when Vitest is running many
 * files in parallel — which is exactly the shape of a flake that passes locally
 * and fails in CI.
 *
 * Raising the budget changes *how long we are willing to wait*, never what is
 * asserted. It stays well under the 20-second `testTimeout`, so a genuinely
 * broken expectation still fails the test rather than hanging it.
 */
configure({ asyncUtilTimeout: 10_000 });

// Vitest globals are disabled, so Testing Library's automatic cleanup does not
// register itself. Unmount explicitly between tests instead.
afterEach(() => {
  cleanup();
});
