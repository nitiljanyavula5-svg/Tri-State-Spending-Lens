import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// The IndexedDB shim is imported per test file rather than globally: jsdom does
// not implement IndexedDB, but only the data-layer tests need the polyfill, and
// loading it into every component file made the suite noticeably slower.

// Vitest globals are disabled, so Testing Library's automatic cleanup does not
// register itself. Unmount explicitly between tests instead.
afterEach(() => {
  cleanup();
});
