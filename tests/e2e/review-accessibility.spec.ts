import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedWorkspace } from './seedWorkspace';

/**
 * Automated accessibility checks for every Phase 4 review surface.
 *
 * `accessibility.spec.ts` walks the route table with an empty workspace. This
 * file covers the states a route only reaches once it has data and someone has
 * started working — an open dialog, a live bulk-action bar, a no-results grid.
 * Those are exactly the states a route-level sweep never sees.
 *
 * product-spec.md §10.5: no serious or critical violations. Lower-impact
 * findings are reported alongside a real one but do not fail on their own,
 * because treating every advisory as a blocker trains people to ignore the
 * suite. Nothing is excluded or suppressed.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function blocking(violations: Array<{ id: string; impact?: string | null; nodes: unknown[] }>) {
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const serious = blocking(results.violations);
  expect(
    serious,
    `${label}:\n${serious.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} nodes)`).join('\n')}`,
  ).toEqual([]);
}

async function gotoTransactions(page: Page) {
  await page.goto('/app/transactions');
  await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();
}

test.describe('the transaction review page', () => {
  test('is accessible with an empty workspace', async ({ page }) => {
    await gotoTransactions(page);
    await expect(page.getByRole('heading', { name: /nothing to review yet/i })).toBeVisible();
    await audit(page, 'empty workspace');
  });

  test('is accessible with rows, filters, and pagination on screen', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();
    await audit(page, 'populated grid');
  });

  test('is accessible in the no-results state', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await page.getByLabel('Search').fill('ZZZ-NOTHING-MATCHES');
    await expect(
      page.getByRole('heading', { name: /no transactions match these filters/i }),
    ).toBeVisible();
    await audit(page, 'no results');
  });

  test('is accessible with the bulk-action bar open', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByRole('checkbox', { name: /select every transaction on this page/i }).check();
    await expect(page.getByText('14 selected on this page')).toBeVisible();
    await audit(page, 'bulk actions');
  });

  test('is accessible with the transaction editor open', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await page.getByLabel('Search').fill('PINEBROOK MARKET');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    await page
      .getByRole('button', { name: /^Review/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // With the future-rule section expanded, so its radio group is audited too.
    await dialog.getByLabel(/also create a rule/i).check();
    await audit(page, 'transaction editor');
  });

  test('is accessible with the export confirmation open', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByRole('button', { name: /export csv/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, 'export confirmation');
  });
});

test.describe('the rule manager', () => {
  test('is accessible with rules listed', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/settings');
    const manager = page.getByRole('region', { name: /^merchant rules$/i });
    await expect(manager).toBeVisible();

    // One real rule, so the list, its badges, and its controls are all audited.
    await manager.getByRole('button', { name: /create a rule/i }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel(/pattern to match/i).fill('PINEBROOK MARKET');
    await dialog.getByLabel(/set the category to/i).selectOption('groceries');
    await dialog.getByRole('button', { name: /^create rule$/i }).click();

    // Creating a rule now asks whether to apply it retroactively, so that
    // confirmation is audited here rather than skipped past.
    const offer = page.getByRole('dialog');
    await expect(offer).toContainText(/matches 1 transaction already stored/i);
    await audit(page, 'retroactive-apply confirmation');
    await offer.getByRole('button', { name: /not now/i }).click();
    await expect(offer).toBeHidden();

    await expect(manager.getByText(/1 rule, listed in the order they apply/i)).toBeVisible();
    await audit(page, 'rule manager with rules');

    // --- the edit dialog, including a live validation error ----------------
    await manager.getByRole('button', { name: /edit the rule for PINEBROOK MARKET/i }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^priority$/i).fill('1.5');
    await expect(dialog.getByText(/whole number in the allowed range/i)).toBeVisible();
    await audit(page, 'rule editor with a field error');
  });

  test('is accessible with its empty state', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/settings');
    await expect(page.getByText(/you have not created any rules yet/i)).toBeVisible();
    await audit(page, 'rule manager empty');
  });
});

test.describe('the relationship review page', () => {
  test('is accessible with transfer and refund suggestions listed', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');
    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();

    await expect(page.getByText('2 possible pairs')).toBeVisible();
    await expect(page.getByText(/2 refunds with a matching purchase/i)).toBeVisible();
    await audit(page, 'transfer and refund suggestions');
  });

  test('is accessible with a link confirmation open', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const transfers = page.getByRole('region', { name: /possible transfers and card payments/i });
    await transfers
      .getByRole('button', { name: /link these two/i })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, 'link confirmation');
  });

  test('is accessible once a relationship is confirmed', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const transfers = page.getByRole('region', { name: /possible transfers and card payments/i });
    await transfers
      .getByRole('button', { name: /link these two/i })
      .first()
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^link them$/i })
      .click();

    // The confirmed list and the undo bar are both on screen now.
    await expect(page.getByRole('region', { name: /links you have confirmed/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /undo last change/i })).toBeVisible();
    await audit(page, 'confirmed relationships and undo');
  });

  test('is accessible with an empty workspace', async ({ page }) => {
    await page.goto('/app/transactions/relationships');
    await expect(page.getByRole('heading', { name: /nothing to link yet/i })).toBeVisible();
    await audit(page, 'relationships empty');
  });
});
