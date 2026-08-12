import { expect, test } from '@playwright/test';

/**
 * Real-browser coverage for the import worker.
 *
 * jsdom cannot run a module worker, so the lifecycle tests use a controllable
 * fake. This spec is the counterpart: it drives the *actual* Vite module worker
 * through the test-only harness, which is built only under `--mode e2e`.
 */

const HARNESS = '/tests/harness/import-worker.html';

interface HarnessResult {
  status: string;
  rowCount?: number;
  acceptedRows?: number;
  rejectedRows?: number;
  truncated?: boolean;
  distinctFingerprints?: number;
  failureCode?: string;
  progress: number[];
  heartbeats: number;
  elapsedMs: number;
}

test.describe('real import worker', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.locator('#status')).toHaveText('ready');
  });

  test('processes 100,000 generated rows without blocking the main thread', async ({ page }) => {
    // Generating and hashing 100k rows takes real time on a loaded CI machine.
    test.setTimeout(180_000);

    const result = await page.evaluate<HarnessResult>(async () =>
      window.runImportHarness(100_000, 100_000),
    );

    expect(result.status).toBe('ok');
    expect(result.rowCount).toBe(100_000);
    expect(result.acceptedRows).toBe(100_000);
    expect(result.rejectedRows).toBe(0);
    expect(result.truncated).toBe(false);

    // Count invariant: every logical row is either accepted or rejected.
    expect((result.acceptedRows ?? 0) + (result.rejectedRows ?? 0)).toBe(result.rowCount);

    // Each generated row is unique, so fingerprints must not collide.
    expect(result.distinctFingerprints).toBe(100_000);

    // THE RESPONSIVENESS CLAIM.
    //
    // Asserted as "the main thread kept painting frames while the worker ran",
    // not as a wall-clock budget: a slow CI runner would make a time threshold
    // flaky without saying anything about where the work happened. If parsing
    // were on the main thread, the rAF loop would be starved and produce
    // essentially nothing.
    expect(result.heartbeats).toBeGreaterThan(10);

    // Progress is monotonic and bounded.
    expect(result.progress.length).toBeGreaterThan(0);
    expect(result.progress.length).toBeLessThanOrEqual(101);
    expect([...result.progress].sort((a, b) => a - b)).toEqual(result.progress);
    expect(Math.min(...result.progress)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...result.progress)).toBeLessThanOrEqual(100);
  });

  test('stops at the session row budget instead of overrunning it', async ({ page }) => {
    test.setTimeout(120_000);

    // 20,000 rows offered, 5,000 of budget left.
    const result = await page.evaluate<HarnessResult>(async () =>
      window.runImportHarness(20_000, 5_000),
    );

    expect(result.status).toBe('ok');
    expect(result.acceptedRows).toBe(5_000);
    expect(result.truncated).toBe(true);
  });

  test('cancellation terminates work in flight and cannot resolve successfully', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const result = await page.evaluate<HarnessResult>(async () => window.cancelImportHarness());

    expect(result.status).toBe('cancelled');
  });

  test('makes no network request and logs no cell value while importing', async ({ page }) => {
    test.setTimeout(180_000);

    // Every request the page makes, recorded by Playwright itself rather than
    // by the instrumentation under test.
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));

    const consoleText: string[] = [];
    page.on('console', (message) => consoleText.push(message.text()));

    const result = await page.evaluate<HarnessResult>(async () =>
      window.runImportHarness(5_000, 100_000),
    );
    expect(result.status).toBe('ok');

    // The generated descriptions all contain this token; it must never appear
    // in a request URL or in console output.
    const canary = 'PINEBROOK MARKET';

    for (const url of requests) {
      expect(url).not.toContain(encodeURIComponent(canary));
      expect(url).not.toContain('PINEBROOK');
      // Nothing may leave this origin at all.
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    }

    for (const line of consoleText) {
      expect(line).not.toContain('PINEBROOK');
    }

    const harnessCalls = await page.evaluate(() => window.harnessNetworkCalls);
    for (const call of harnessCalls) {
      expect(call).not.toContain('PINEBROOK');
    }

    const harnessConsole = await page.evaluate(() => window.harnessConsoleOutput);
    for (const line of harnessConsole) {
      expect(line).not.toContain('PINEBROOK');
    }

    // Nothing personal may be parked in the URL or the title either.
    expect(page.url()).not.toContain('PINEBROOK');
    expect(await page.title()).not.toContain('PINEBROOK');
  });
});
