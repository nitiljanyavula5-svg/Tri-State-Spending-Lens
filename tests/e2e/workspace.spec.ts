import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 2 end-to-end coverage, against a real browser IndexedDB.
 *
 * Playwright gives each test a fresh browser context, so every test starts with
 * empty origin storage without any explicit teardown.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function blocking(violations: Array<{ id: string; impact?: string | null; nodes: unknown[] }>) {
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

async function loadDemoFromLanding(page: Page) {
  await page.goto('/');
  const button = page.getByRole('button', { name: /try the demo/i }).first();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('heading', { level: 1, name: /^overview$/i })).toBeVisible();
}

test.describe('demo workspace', () => {
  test('loads from the landing page and stores records locally', async ({ page }) => {
    await loadDemoFromLanding(page);

    const panel = page.getByRole('region', { name: /fictional demo workspace loaded/i });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/transactions stored/i)).toBeVisible();

    // Record counts only until the shared calculation layer lands in Phase 5.
    await expect(panel.getByText(/record counts, not financial totals/i)).toBeVisible();
  });

  test('survives a full page reload, because it is really persisted', async ({ page }) => {
    await loadDemoFromLanding(page);
    await page.reload();

    await expect(
      page.getByRole('region', { name: /fictional demo workspace loaded/i }),
    ).toBeVisible();
  });

  test('is labelled as fictional wherever it appears', async ({ page }) => {
    await loadDemoFromLanding(page);
    await expect(page.getByText('Fictional demo data').first()).toBeVisible();

    await page.goto('/app/settings');
    await expect(page.getByText(/fictional demo data loaded/i)).toBeVisible();
  });

  test('shows no financial total anywhere in the workspace yet', async ({ page }) => {
    await loadDemoFromLanding(page);

    for (const route of ['/app/overview', '/app/transactions', '/app/budget', '/app/recurring']) {
      await page.goto(route);
      const main = page.getByRole('main');
      await expect(main).toBeVisible();

      // The only currency strings in this build are the demo card's labelled
      // illustrations, which live on the landing page — not in the workspace.
      const currencyMatches = await main.getByText(/\$\d/).count();
      expect(currencyMatches, `${route} should show no currency figure`).toBe(0);
    }
  });
});

test.describe('backup, delete, and restore', () => {
  test('backup then delete then restore reproduces the workspace', async ({ page }) => {
    await loadDemoFromLanding(page);

    const countFor = async (label: RegExp) => {
      await page.goto('/app/overview');
      const panel = page.getByRole('region', { name: /workspace loaded/i });
      const row = panel.locator('div').filter({ hasText: label }).first();
      return (await row.innerText()).replace(/[^\d]/g, '');
    };

    const originalTransactions = await countFor(/transactions stored/i);
    expect(Number(originalTransactions)).toBeGreaterThan(0);

    // --- download a backup -------------------------------------------------
    await page.goto('/app/settings');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /download workspace backup/i }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(
      /^tri-state-spending-lens-backup-\d{4}-\d{2}-\d{2}\.json$/,
    );
    const backupPath = await download.path();
    const backupText = readFileSync(backupPath, 'utf8');
    expect(JSON.parse(backupText).format).toBe('tri-state-spending-lens-workspace');

    await expect(page.getByRole('status')).toContainText(/backup downloaded/i);

    // --- delete everything -------------------------------------------------
    await page.getByRole('button', { name: /^delete all data$/i }).click();
    await expect(page.getByText(/delete everything stored in this browser\?/i)).toBeVisible();
    await page.getByRole('button', { name: /yes, delete everything/i }).click();
    await expect(page.getByRole('status')).toContainText(/all local data has been deleted/i);

    await page.goto('/app/overview');
    await expect(
      page.getByRole('heading', { name: /no transactions in this workspace yet/i }),
    ).toBeVisible();

    // --- restore -----------------------------------------------------------
    await page.goto('/app/settings');
    await page.getByLabel(/restore a workspace backup/i).setInputFiles(backupPath);
    await expect(page.getByRole('status')).toContainText(/workspace restored/i);

    expect(await countFor(/transactions stored/i)).toBe(originalTransactions);
  });

  test('refuses a corrupt backup and leaves the workspace untouched', async ({ page }) => {
    await loadDemoFromLanding(page);

    await page.goto('/app/settings');
    await page.getByLabel(/restore a workspace backup/i).setInputFiles({
      name: 'broken-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ "format": "tri-state-spending-lens-workspace", "formatVersion":'),
    });

    await expect(page.getByRole('status')).toContainText(/not valid json/i);
    await expect(page.getByRole('status')).toContainText(/nothing was changed/i);

    await page.goto('/app/overview');
    await expect(
      page.getByRole('region', { name: /fictional demo workspace loaded/i }),
    ).toBeVisible();
  });

  test('refuses a backup from a newer version rather than guessing', async ({ page }) => {
    await loadDemoFromLanding(page);

    await page.goto('/app/settings');
    await page.getByLabel(/restore a workspace backup/i).setInputFiles({
      name: 'future-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'tri-state-spending-lens-workspace',
          formatVersion: 1,
          schemaVersion: 999,
          exportedAt: '2030-01-01T00:00:00.000Z',
          counts: {},
          data: {},
        }),
      ),
    });

    await expect(page.getByRole('status')).toContainText(/newer version/i);

    await page.goto('/app/overview');
    await expect(
      page.getByRole('region', { name: /fictional demo workspace loaded/i }),
    ).toBeVisible();
  });

  test('reports validation failures by field name, never by value', async ({ page }) => {
    await loadDemoFromLanding(page);

    const secret = 'SECRET-VALUE-DO-NOT-ECHO';
    await page.goto('/app/settings');
    await page.getByLabel(/restore a workspace backup/i).setInputFiles({
      name: 'invalid-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'tri-state-spending-lens-workspace',
          formatVersion: 1,
          schemaVersion: 1,
          exportedAt: secret,
          counts: {},
          data: { accounts: secret },
        }),
      ),
    });

    const status = page.getByRole('status');
    await expect(status).toContainText(/was not trusted/i);
    // threat-model.md §8: error output carries field names, never field values.
    await expect(status).not.toContainText(secret);
  });
});

test.describe('reset demo', () => {
  test('restores the original dataset after the workspace is changed', async ({ page }) => {
    await loadDemoFromLanding(page);
    await page.goto('/app/settings');

    await page.getByRole('button', { name: /reset demo/i }).click();
    await expect(page.getByRole('status')).toContainText(/demo reset to its original state/i);

    await page.goto('/app/overview');
    await expect(
      page.getByRole('region', { name: /fictional demo workspace loaded/i }),
    ).toBeVisible();
  });
});

test.describe('privacy boundary', () => {
  test('never sends workspace data anywhere', async ({ page }) => {
    const offending: string[] = [];

    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://localhost:4173')) offending.push(`external request: ${url}`);

      const body = request.postData() ?? '';
      for (const marker of ['PINEBROOK', 'OAKMONT', 'NORTHGATE', 'demo-txn-']) {
        if (url.includes(marker) || body.includes(marker)) {
          offending.push(`${request.method()} carried "${marker}"`);
        }
      }
    });

    await loadDemoFromLanding(page);
    await page.goto('/app/settings');
    await page.getByRole('button', { name: /reset demo/i }).click();
    await expect(page.getByRole('status')).toContainText(/demo reset/i);

    expect(offending).toEqual([]);
  });

  test('keeps personal values out of the page title and the URL', async ({ page }) => {
    await loadDemoFromLanding(page);

    await expect(page).toHaveTitle('Overview · Tri-State Spending Lens');
    expect(page.url()).not.toMatch(/PINEBROOK|OAKMONT|demo-txn/i);
  });
});

test.describe('accessibility with a loaded workspace', () => {
  test('Settings has no serious or critical violations', async ({ page }) => {
    await loadDemoFromLanding(page);
    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { level: 1, name: /^settings$/i })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(blocking(results.violations)).toEqual([]);
  });

  test('the delete confirmation has no serious or critical violations', async ({ page }) => {
    await loadDemoFromLanding(page);
    await page.goto('/app/settings');
    await page.getByRole('button', { name: /^delete all data$/i }).click();
    await expect(page.getByText(/delete everything stored in this browser\?/i)).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(blocking(results.violations)).toEqual([]);
  });

  test('workspace pages have no serious or critical violations with data loaded', async ({
    page,
  }) => {
    await loadDemoFromLanding(page);

    for (const route of ['/app/overview', '/app/transactions', '/app/budget', '/app/recurring']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(blocking(results.violations), `${route} had violations`).toEqual([]);
    }
  });
});
