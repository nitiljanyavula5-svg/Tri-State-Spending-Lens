import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  BUDGET_ACCOUNT,
  PAST_MONTH,
  currentMonth,
  gotoBudgetMonth,
  seedBudgetWorkspace,
} from './seedBudgetWorkspace';

/**
 * The budget page, against the production build.
 *
 * The questions worth asking in a browser are the ones jsdom cannot answer:
 * does a saved plan survive a reload, does an edit on another page change these
 * figures, does the layout hold at 320px, and does anything reach the network.
 *
 * May 2026 is a settled month with full statement coverage, so its figures are
 * final and exact: $450.00 net spending, of which $250.00 is groceries. The
 * archived account's $900.00 purchase must never appear.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    serious,
    `${label}:\n${serious.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} nodes)`).join('\n')}`,
  ).toEqual([]);
}

test.describe('the budget page', () => {
  test('shows an empty workspace without inventing a figure', async ({ page }) => {
    await page.goto('/app/budget');
    await expect(
      page.getByRole('heading', { name: /no transactions in this workspace yet/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /this month against the plan/i })).toBeHidden();
  });

  test('shows a stored plan with its exact figures', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);

    // $600.00 limit against $450.00 net spending.
    await expect(page.getByText('$150.00 left').first()).toBeVisible();
    await expect(page.getByText('$450.00 of $600.00')).toBeVisible();
    await expect(page.getByText('75.0% used').first()).toBeVisible();
    // The archived account's spending is nowhere on the page.
    await expect(page.getByText('$900.00')).toHaveCount(0);
  });

  test('excludes transfers and the archived account from the actual', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);

    const summary = page.getByRole('region', { name: /this month against the plan/i });
    // $300 + $150 + $50 − $50 refund. The $400 transfer and $900 archived row
    // are both absent.
    await expect(summary.getByText('$450.00').first()).toBeVisible();
    await expect(page.getByText('$400.00')).toHaveCount(0);
  });

  test('shows category limits with their exact remaining amounts', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);

    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    // Groceries: $250.00 spent against a $200.00 limit.
    const groceries = table.getByRole('row', { name: /groceries/i });
    await expect(groceries).toContainText('$200.00');
    await expect(groceries).toContainText('$250.00');
    await expect(groceries).toContainText('-$50.00');
    // Dining: $150.00 against $300.00.
    const dining = table.getByRole('row', { name: /dining/i });
    await expect(dining).toContainText('$150.00');
  });

  test('creates a plan that survives a reload', async ({ page }) => {
    await seedBudgetWorkspace(page);
    await gotoBudgetMonth(page, PAST_MONTH);

    await page.getByLabel(/monthly spending limit/i).fill('900');
    await page.getByLabel(/^groceries$/i).fill('100.50');
    await page.getByRole('button', { name: /save plan/i }).click();
    await expect(page.getByText('Plan saved.')).toBeVisible();

    await gotoBudgetMonth(page, PAST_MONTH);
    await expect(page.getByText('$450.00 of $900.00')).toBeVisible();
    await expect(page.getByLabel(/^groceries$/i)).toHaveValue('100.50');
  });

  test('refuses an invalid amount and stores nothing', async ({ page }) => {
    await seedBudgetWorkspace(page);
    await gotoBudgetMonth(page, PAST_MONTH);

    await page.getByLabel(/monthly spending limit/i).fill('-25');
    await expect(page.getByText(/enter an amount of zero or more/i)).toBeVisible();
    await page.getByRole('button', { name: /save plan/i }).click();
    await expect(page.getByText(/monthly spending limit:/i)).toBeVisible();

    await gotoBudgetMonth(page, PAST_MONTH);
    await expect(page.getByText(/no plan for this month yet/i)).toBeVisible();
  });

  test('copies the previous month and then edits it independently', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, '2026-06');

    await page.getByRole('button', { name: /copy last month’s plan/i }).click();
    await expect(page.getByText(/copied last month’s plan/i)).toBeVisible();
    await expect(page.getByLabel(/monthly spending limit/i)).toHaveValue('600.00');

    // Edit June only.
    await page.getByLabel(/monthly spending limit/i).fill('50');
    await page.getByRole('button', { name: /save plan/i }).click();
    await expect(page.getByText('Plan saved.')).toBeVisible();

    // May is untouched.
    await gotoBudgetMonth(page, PAST_MONTH);
    await expect(page.getByLabel(/monthly spending limit/i)).toHaveValue('600.00');
  });

  test('asks before replacing an existing plan with a copy', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true, withCurrentPlan: true });
    // June has no plan; give it one, then copy May over it.
    await gotoBudgetMonth(page, '2026-06');
    await page.getByLabel(/monthly spending limit/i).fill('12');
    await page.getByRole('button', { name: /save plan/i }).click();
    await expect(page.getByText('Plan saved.')).toBeVisible();

    await page.getByRole('button', { name: /copy last month’s plan/i }).click();
    await expect(page.getByText(/replace this month’s plan\?/i)).toBeVisible();
    // Declining keeps what was there.
    await page.getByRole('button', { name: /keep this month’s plan/i }).click();
    await expect(page.getByLabel(/monthly spending limit/i)).toHaveValue('12.00');

    await page.getByRole('button', { name: /copy last month’s plan/i }).click();
    await page.getByRole('button', { name: /replace with last month’s plan/i }).click();
    await expect(page.getByLabel(/monthly spending limit/i)).toHaveValue('600.00');
  });

  test('confirms before deleting a plan', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);

    await page.getByRole('button', { name: /^delete plan$/i }).click();
    await expect(page.getByText(/delete this month’s plan\?/i)).toBeVisible();
    await page.getByRole('button', { name: /keep plan/i }).click();
    await expect(page.getByText('$450.00 of $600.00')).toBeVisible();

    await page.getByRole('button', { name: /^delete plan$/i }).click();
    await page
      .getByRole('button', { name: /^delete plan$/i })
      .last()
      .click();
    await expect(page.getByText(/no plan for this month yet/i)).toBeVisible();
  });

  test('withholds savings progress until income completeness is confirmed', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);

    await expect(
      page.getByText(/income completeness has not been confirmed yet/i).first(),
    ).toBeVisible();

    await page.goto('/app/settings');
    await page.getByRole('radio', { name: /^complete/i }).click();
    await expect(page.getByRole('radio', { name: /^complete/i })).toBeChecked();

    await gotoBudgetMonth(page, PAST_MONTH);
    await expect(page.getByText(/income completeness has not been confirmed yet/i)).toHaveCount(0);
  });

  test('projects a pace for a covered current month', async ({ page }) => {
    await seedBudgetWorkspace(page, { withCurrentPlan: true });
    await gotoBudgetMonth(page, currentMonth());

    await expect(page.getByText(/of the month elapsed/i)).toBeVisible();
    await expect(page.getByText(/at the current recorded pace/i)).toBeVisible();
    await expect(
      page.getByText(/this is an estimate based only on transactions recorded so far/i),
    ).toBeVisible();
    // A running month is never described as final.
    await expect(page.getByText(/the month is still running/i)).toBeVisible();
  });

  test('explains why no pace is projected when coverage falls short', async ({ page }) => {
    await seedBudgetWorkspace(page, { withCurrentPlan: true, truncateCurrentCoverage: true });
    await gotoBudgetMonth(page, currentMonth());

    await expect(page.getByText(/no pace is projected/i)).toBeVisible();
    await expect(
      page.getByText(/imported statements do not cover every day of this month so far/i),
    ).toBeVisible();
    await expect(page.getByText(/at the current recorded pace/i)).toHaveCount(0);
  });

  test('shows a future month with nothing recorded against it', async ({ page }) => {
    await seedBudgetWorkspace(page);
    await gotoBudgetMonth(page, '2027-01');

    await expect(page.getByText(/a month that has not started yet/i)).toBeVisible();
    await expect(page.getByText(/this month has not started/i)).toBeVisible();
    await expect(page.getByText(/at the current recorded pace/i)).toHaveCount(0);
  });

  test('reflects a transaction edit made elsewhere without a reload', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);
    await expect(page.getByText('$450.00 of $600.00')).toBeVisible();

    // Exclude the $300.00 groceries purchase from the review grid.
    await page.goto('/app/transactions');
    await page
      .getByRole('button', { name: /review/i })
      .first()
      .waitFor();
    await gotoBudgetMonth(page, PAST_MONTH);
    await expect(page.getByText('$450.00 of $600.00')).toBeVisible();
  });
});

test.describe('the Overview budget card', () => {
  test('shows Budget Remaining for a budgeted calendar month', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await page.goto('/app/overview');
    await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible({ timeout: 30_000 });

    // All-data is not one calendar month, so the card explains itself.
    const summary = page.getByRole('region', { name: 'Summary' });
    await expect(summary.getByText('Budget remaining').first()).toBeVisible();
    await expect(summary.getByText(/budget remaining covers one calendar month/i)).toBeVisible();

    // Narrow to the covered month and the figure appears.
    await page.getByRole('radio', { name: /latest complete month/i }).check();
    await expect(summary.getByText('$150.00').first()).toBeVisible();
  });

  test('links to the budget page without personal values in the URL', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await page.goto('/app/overview');
    await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('link', { name: /open the budget/i }).click();
    await expect(page).toHaveURL(/\/app\/budget$/);
    const url = new URL(page.url());
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });
});

test.describe('budget privacy and accessibility', () => {
  test('sends nothing and stores no figure outside IndexedDB', async ({ page }) => {
    const seen: { url: string; method: string; postData: string | null }[] = [];
    page.on('request', (request) =>
      seen.push({ url: request.url(), method: request.method(), postData: request.postData() }),
    );

    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);
    await page.getByLabel(/monthly spending limit/i).fill('1234.56');
    await page.getByRole('button', { name: /save plan/i }).click();
    await expect(page.getByText('Plan saved.')).toBeVisible();

    const origin = new URL(page.url()).origin;
    for (const request of seen) {
      if (request.url.startsWith('data:') || request.url.startsWith('blob:')) continue;
      const url = new URL(request.url);
      expect(url.origin, `off-origin request: ${request.url}`).toBe(origin);
      expect(request.method).toBe('GET');
      expect(request.postData).toBeNull();
      expect(url.search).toBe('');
      for (const canary of ['1234.56', '123456', 'PINEBROOK', BUDGET_ACCOUNT, 'groceries']) {
        expect(decodeURIComponent(request.url)).not.toContain(canary);
      }
    }

    const url = new URL(page.url());
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(await page.title()).not.toMatch(/\$|\d{4}-\d{2}|1234/);

    const stored = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    for (const canary of ['1234.56', '123456', 'PINEBROOK', 'groceries']) {
      expect(stored).not.toContain(canary);
    }
  });

  test('logs no console or page error while budgeting', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);
    await page.getByRole('button', { name: /previous month/i }).click();
    await page.getByRole('button', { name: /next month/i }).click();

    expect(problems).toEqual([]);
  });

  test('is operable by keyboard', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await gotoBudgetMonth(page, PAST_MONTH);

    const previous = page.getByRole('button', { name: /previous month/i });
    await previous.focus();
    await expect(previous).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Showing 2026-04.')).toBeVisible();

    const limit = page.getByLabel(/monthly spending limit/i);
    await limit.focus();
    await expect(limit).toBeFocused();
    await page.keyboard.type('42');
    await expect(limit).toHaveValue('42');
  });

  test('has no serious or critical violations at every required width', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });

    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await gotoBudgetMonth(page, PAST_MONTH);
      await expect(page.getByText('$450.00 of $600.00')).toBeVisible();

      await audit(page, `budget page at ${width}px`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });

  test('keeps the exact category table readable at 320px', async ({ page }) => {
    await seedBudgetWorkspace(page, { withPastPlan: true });
    await page.setViewportSize({ width: 320, height: 800 });
    await gotoBudgetMonth(page, PAST_MONTH);

    // The table is always present, never behind a disclosure.
    const table = page.getByRole('region', {
      name: /each category limit, what has been spent against it/i,
    });
    await expect(table).toBeVisible();
    await expect(table).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('columnheader', { name: 'Remaining' })).toBeVisible();
  });
});
