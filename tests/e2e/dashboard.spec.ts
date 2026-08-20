import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seedWorkspace, txn } from './seedWorkspace';
import { CURRENT_MONTH, EXPECTED, PRIOR_MONTH, seedCoveredWorkspace } from './seedCoveredWorkspace';

/**
 * The Overview dashboard, against the production build.
 *
 * Every figure here comes from the selector layer, so the questions worth
 * asking in a browser are the ones jsdom cannot answer: does the chart library
 * actually run without console or CSP errors, does the page overflow at 320px,
 * does the chart give way to its table there, and does anything reach the
 * network.
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

const CHECKING = 'acct-checking';
const CARD = 'acct-card';

/**
 * A workspace with enough shape to exercise every region: two accounts, a
 * refund, a transfer, an unreviewed credit, and nine categories so the
 * breakdown has to collapse a tail into `Other`.
 *
 * Note what this fixture *cannot* show. `seedWorkspace` writes one import
 * session that confirms no statement range at all, so no month is complete
 * here (§14.2) and the comparison is correctly unavailable. That is the
 * conservative behaviour under test, not a gap in the fixture — and the page
 * says which condition applies rather than leaving the absence unexplained.
 */
function dashboardFixture() {
  return [
    txn('d1', {
      accountId: CHECKING,
      postedDate: '2026-04-06',
      amountCents: 22_000,
      categoryId: 'groceries',
    }),
    txn('d2', {
      accountId: CHECKING,
      postedDate: '2026-04-18',
      amountCents: 8_400,
      categoryId: 'dining',
    }),
    txn('d3', {
      accountId: CHECKING,
      postedDate: '2026-05-04',
      amountCents: 15_000,
      categoryId: 'groceries',
    }),
    txn('d4', {
      accountId: CARD,
      postedDate: '2026-05-07',
      amountCents: 6_200,
      categoryId: 'transportation',
    }),
    txn('d5', {
      accountId: CHECKING,
      postedDate: '2026-05-09',
      amountCents: 4_100,
      categoryId: 'utilities_bills',
    }),
    txn('d6', {
      accountId: CARD,
      postedDate: '2026-05-11',
      amountCents: 3_300,
      categoryId: 'health',
    }),
    txn('d7', {
      accountId: CHECKING,
      postedDate: '2026-05-13',
      amountCents: 2_700,
      categoryId: 'shopping',
    }),
    txn('d8', {
      accountId: CARD,
      postedDate: '2026-05-15',
      amountCents: 1_900,
      categoryId: 'travel',
    }),
    txn('d9', {
      accountId: CHECKING,
      postedDate: '2026-05-17',
      amountCents: 1_100,
      categoryId: 'fees_interest',
    }),
    txn('d10', {
      accountId: CARD,
      postedDate: '2026-05-19',
      amountCents: 900,
      categoryId: 'entertainment',
    }),
    txn('d11', {
      accountId: CHECKING,
      postedDate: '2026-05-21',
      amountCents: 5_000,
      direction: 'credit',
      kind: 'refund',
      categoryId: 'shopping',
    }),
    txn('d12', {
      accountId: CHECKING,
      postedDate: '2026-05-23',
      amountCents: 40_000,
      kind: 'transfer',
      categoryId: 'other',
    }),
    txn('d13', {
      accountId: CHECKING,
      postedDate: '2026-05-25',
      amountCents: 7_000,
      direction: 'credit',
      kind: 'unknown',
      categoryId: 'other',
    }),
  ];
}

async function gotoOverview(page: Page) {
  await page.goto('/app/overview');
  await expect(page.getByRole('heading', { level: 1, name: /^overview$/i })).toBeVisible();
}

async function readyOverview(page: Page) {
  await gotoOverview(page);
  await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible({ timeout: 30_000 });
}

test.describe('the overview dashboard', () => {
  test('loads from empty to populated without inventing a figure', async ({ page }) => {
    await gotoOverview(page);
    await expect(
      page.getByRole('heading', { name: /no transactions in this workspace yet/i }),
    ).toBeVisible({
      timeout: 30_000,
    });
    // Nothing numeric is shown for an empty workspace.
    await expect(page.getByRole('heading', { name: 'Summary' })).toBeHidden();

    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await expect(
      page.getByRole('region', { name: 'Summary' }).getByText('Net spending', { exact: true }),
    ).toBeVisible();
  });

  test('shows the trend, breakdown, comparison, and reconciliation regions', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    await expect(page.getByRole('heading', { name: /net spending over time/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /where the spending went/i })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /compared with the previous complete month/i }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: /how these totals reconcile/i })).toBeVisible();
  });

  test('opens the trend fallback table with the same figures', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    await page.locator('summary', { hasText: /net spending over time, as a table/i }).click();
    const table = page.getByRole('table').first();
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /statement coverage/i })).toBeVisible();
  });

  test('switches the breakdown between category and account', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    await page.locator('summary', { hasText: /spending by category, as a table/i }).click();
    await expect(page.getByRole('columnheader', { name: 'Category' })).toBeVisible();

    await page.getByRole('radio', { name: 'Account' }).check();
    await expect(page.getByRole('columnheader', { name: 'Account' })).toBeVisible();
  });

  test('collapses a long breakdown tail into an explained Other row', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    await page.locator('summary', { hasText: /spending by category, as a table/i }).click();
    // Present on the chart's axis and in the table — the same adapter row.
    await expect(page.getByText(/Other \(\d+ more\)/).first()).toBeVisible();
    await expect(page.getByText(/Combines \d+ smaller entries/i)).toBeVisible();
  });

  test('reconciles, and says so', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await expect(page.getByText(/^Totals reconcile/)).toBeVisible();
  });

  test('withholds the comparison and explains why, rather than showing zero', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    // The seeded session confirms no statement range, so no month is complete
    // (§14.2) and the comparison says so rather than showing a zero.
    const comparison = page.getByRole('region', {
      name: /compared with the previous complete month/i,
    });
    await expect(comparison.getByText(/not available/i)).toBeVisible();
  });

  test('warns that an import recorded no statement period', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    // The seeded session confirms no statement range at all, so it establishes
    // no coverage — and the page says which condition applies rather than
    // leaving the missing comparison unexplained.
    await expect(page.getByText(/no confirmed statement period/i)).toBeVisible();
    await expect(page.getByText(/never guessed from transaction dates/i)).toBeVisible();
  });

  test('offers Latest complete month as disabled when no month is complete', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await expect(page.getByRole('radio', { name: /latest complete month/i })).toBeDisabled();
  });

  test('distinguishes a measured zero from an unavailable figure', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    const summary = page.getByRole('region', { name: 'Summary' });
    // Transactions analyzed is a real count; money in is withheld with a reason.
    await expect(summary.getByText('Transactions analyzed')).toBeVisible();
    await expect(summary.getByText('Not available').first()).toBeVisible();
    await expect(
      summary.getByText(/income completeness has not been confirmed yet/i).first(),
    ).toBeVisible();
  });

  test('applies filters and resets them', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    await page.getByRole('radio', { name: /^this month/i }).check();
    await expect(page.getByRole('radio', { name: /^this month/i })).toBeChecked();

    await page.getByRole('radio', { name: /^all data/i }).check();
    await expect(page.getByRole('radio', { name: /^all data/i })).toBeChecked();

    await page.getByRole('checkbox', { name: /groceries/i }).check();
    await expect(page.getByRole('button', { name: /remove filter/i }).first()).toBeVisible();

    await page.getByRole('button', { name: /reset all/i }).click();
    await expect(page.getByRole('checkbox', { name: /groceries/i })).not.toBeChecked();
  });

  test('explains a filter combination that matches nothing', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    await page.getByRole('radio', { name: /^previous month/i }).check();
    await page.getByRole('checkbox', { name: /^travel$/i }).check();

    await expect(page.getByText(/no transactions match these filters/i)).toBeVisible();
  });

  test('reflects an income-completeness change made in Settings', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    // Unconfirmed by default, so the income figures are withheld.
    await expect(
      page.getByText(/income completeness has not been confirmed/i).first(),
    ).toBeVisible();

    await page.goto('/app/settings');
    // Click rather than check(): the control is backed by IndexedDB, so its
    // checked state follows the write rather than the click, and check() asserts
    // the new state before the round-trip has finished.
    const complete = page.getByRole('radio', { name: /^complete/i });
    await complete.click();
    await expect(complete).toBeChecked();

    await readyOverview(page);
    await expect(page.getByText(/income completeness has not been confirmed/i)).toBeHidden();
  });

  test('keeps financial values out of the URL and the title', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await page.getByRole('checkbox', { name: /groceries/i }).check();
    await expect(page.getByRole('button', { name: /remove filter/i }).first()).toBeVisible();

    // The query string and fragment are where filter state would leak; the
    // origin legitimately carries a port number, so the whole URL is not the
    // thing to assert on.
    const url = new URL(page.url());
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/app/overview');
    expect(await page.title()).not.toMatch(/\$|groceries|\d{4}-\d{2}/i);
  });

  test('makes no network request beyond the app itself', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://localhost:') && !url.startsWith('data:')) external.push(url);
    });

    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await page.locator('summary', { hasText: /net spending over time, as a table/i }).click();

    expect(external).toEqual([]);
  });

  test('logs no console or page errors while rendering the charts', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await page.getByRole('radio', { name: 'Account' }).check();
    await page.locator('summary', { hasText: /spending by account, as a table/i }).click();

    expect(problems).toEqual([]);
  });
});

test.describe('responsive behaviour', () => {
  test('swaps the chart for its table at 320px, with no page overflow', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await page.setViewportSize({ width: 320, height: 800 });
    await readyOverview(page);

    // The chart images are hidden below 360px; the tables carry the figures.
    await expect(page.getByRole('img', { name: /net spending over time/i })).toBeHidden();
    await expect(page.getByRole('img', { name: /net spending by category/i })).toBeHidden();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('shows the exact tables at 320px rather than only offering them', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await page.setViewportSize({ width: 320, height: 800 });
    await readyOverview(page);

    await expect(page.getByRole('img', { name: /net spending over time/i })).toBeHidden();
    await expect(page.getByRole('img', { name: /net spending by category/i })).toBeHidden();

    // The substitution is only real if the table is on screen. A collapsed
    // disclosure at a width where the chart is hidden leaves the figures with
    // no presentation at all.
    await expect(
      page.getByRole('region', { name: /net spending for each period in the selected range/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: /net spending by category, largest first/i }),
    ).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /statement coverage/i })).toBeVisible();
  });

  test('leaves the tables behind their disclosures once a chart can be drawn', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await page.setViewportSize({ width: 390, height: 844 });
    await readyOverview(page);

    await expect(page.getByRole('img', { name: /net spending over time/i })).toBeVisible();
    await expect(
      page.getByRole('region', { name: /net spending by category, largest first/i }),
    ).toBeHidden();
  });

  test('shows the charts at 390px and wider', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await page.setViewportSize({ width: 390, height: 844 });
    await readyOverview(page);
    await expect(page.getByRole('img', { name: /net spending over time/i })).toBeVisible();
  });

  test('has no page-level horizontal overflow at any required width', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await readyOverview(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
});

test.describe('accessibility', () => {
  test('the populated dashboard has no serious or critical violations', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await audit(page, 'populated overview');
  });

  test('the dashboard with warnings and open disclosures is accessible', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await page.locator('summary', { hasText: /net spending over time, as a table/i }).click();
    await page.locator('summary', { hasText: /spending by category, as a table/i }).click();
    await page.locator('summary', { hasText: /show all \d+ checks/i }).click();
    await audit(page, 'overview with disclosures open');
  });

  test('the no-results state is accessible', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await page.getByRole('radio', { name: /^previous month/i }).check();
    await page.getByRole('checkbox', { name: /^travel$/i }).check();
    await expect(page.getByText(/no transactions match these filters/i)).toBeVisible();
    await audit(page, 'overview with no results');
  });

  test('the settings income control is accessible', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await page.goto('/app/settings');
    await expect(
      page.getByRole('group', { name: /is the imported income data complete/i }),
    ).toBeVisible();
    await audit(page, 'settings income control');
  });

  test('the breakdown switch and disclosures are keyboard operable', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    const accountRadio = page.getByRole('radio', { name: 'Account' });
    await accountRadio.focus();
    await expect(accountRadio).toBeFocused();
    await page.keyboard.press('Space');
    await expect(accountRadio).toBeChecked();

    const disclosure = page.locator('summary', { hasText: /spending by account, as a table/i });
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('columnheader', { name: 'Account' })).toBeVisible();
  });
});

/**
 * The comparison when it *is* available.
 *
 * The fixture above cannot reach this state: its one import session names three
 * accounts and confirms no statement range, so §14.11 correctly refuses to
 * establish coverage from it. `seedCoveredWorkspace` writes one single-account
 * session per account instead, each with a valid range covering 2026-02 and
 * 2026-03 end to end — which is the only shape the contract accepts as
 * per-account evidence.
 *
 * Every expected figure is a constant from `EXPECTED`. Nothing here re-derives
 * `net = gross − refunds`; a test that recomputed the comparison would agree
 * with a broken selector as readily as with a correct one.
 */
test.describe('the available month comparison', () => {
  /** The three `dt`/`dd` groups: current month, prior month, difference. */
  function figures(page: Page) {
    return page
      .getByRole('region', { name: /compared with the previous complete month/i })
      .locator('dl > div');
  }

  async function selectLatestCompleteMonth(page: Page) {
    const latest = page.getByRole('radio', { name: /latest complete month/i });
    await expect(latest).toBeEnabled();
    await latest.check();
    await expect(latest).toBeChecked();
    return latest;
  }

  test('offers the latest complete month once two adjacent months are covered', async ({
    page,
  }) => {
    await seedCoveredWorkspace(page);
    await readyOverview(page);

    // Enabled because coverage — not transaction dates — made a month complete.
    await selectLatestCompleteMonth(page);

    // The selected period is the covered month itself, named in full.
    await expect(
      page.getByRole('region', { name: 'Summary' }).getByText(/Showing 2026-03-01 to 2026-03-31\./),
    ).toBeVisible();

    // None of the "this establishes no coverage" warnings apply here.
    await expect(page.getByText(/no confirmed statement period/i)).toBeHidden();
    await expect(page.getByText(/could not be read/i)).toBeHidden();
    await expect(page.getByText(/name no account/i)).toBeHidden();
    await expect(page.getByText(/covers several accounts/i)).toBeHidden();
    await expect(page.getByText(/not fully covered by statements/i)).toBeHidden();
  });

  test('names both months and shows the selector figures for each', async ({ page }) => {
    await seedCoveredWorkspace(page);
    await readyOverview(page);
    await selectLatestCompleteMonth(page);

    const comparison = page.getByRole('region', {
      name: /compared with the previous complete month/i,
    });

    // The sentence names the current month, the immediately preceding one, and
    // the direction — no verdict attached to either.
    await expect(
      comparison.getByText(`Net spending in ${CURRENT_MONTH} was higher than ${PRIOR_MONTH}.`),
    ).toBeVisible();

    const groups = figures(page);
    await expect(groups).toHaveCount(3);

    await expect(groups.nth(0)).toContainText(CURRENT_MONTH);
    await expect(groups.nth(0)).toContainText(EXPECTED.all.current);

    await expect(groups.nth(1)).toContainText(PRIOR_MONTH);
    await expect(groups.nth(1)).toContainText(EXPECTED.all.prior);

    // Difference and percentage both come from `selectComparison`; React does
    // not subtract or divide anything on this page.
    await expect(groups.nth(2)).toContainText('Difference');
    await expect(groups.nth(2)).toContainText(EXPECTED.all.delta);
    await expect(groups.nth(2)).toContainText(EXPECTED.all.ratio);
  });

  test('agrees with the summary card for the same period', async ({ page }) => {
    await seedCoveredWorkspace(page);
    await readyOverview(page);
    await selectLatestCompleteMonth(page);

    // One selector, one figure: the card and the comparison's current month are
    // the same number, not two derivations that happen to match.
    const summary = page.getByRole('region', { name: 'Summary' });
    await expect(summary.getByText(EXPECTED.all.current)).toBeVisible();
    await expect(figures(page).nth(0)).toContainText(EXPECTED.all.current);
  });

  test('shows no unavailable stand-in and no fabricated zero', async ({ page }) => {
    await seedCoveredWorkspace(page);
    await readyOverview(page);
    await selectLatestCompleteMonth(page);

    const comparison = page.getByRole('region', {
      name: /compared with the previous complete month/i,
    });
    await expect(comparison.getByText(/not available/i)).toHaveCount(0);
    await expect(comparison.getByText(/select a single whole calendar month/i)).toHaveCount(0);
    await expect(comparison.getByText(/is not fully covered/i)).toHaveCount(0);
    await expect(comparison.getByText(/the month before this one/i)).toHaveCount(0);
    await expect(comparison.getByText(/no percentage/i)).toHaveCount(0);
    // §1 rule 5: a withheld figure is never substituted with 0, 0%, or a dash.
    await expect(comparison.getByText('$0.00')).toHaveCount(0);
    await expect(comparison.getByText(/\b0\.0%/)).toHaveCount(0);
    await expect(comparison.getByText(/^\s*[—–-]\s*$/)).toHaveCount(0);
  });

  test('recomputes both months under a category filter, on the same account scope', async ({
    page,
  }) => {
    await seedCoveredWorkspace(page);
    await readyOverview(page);
    await selectLatestCompleteMonth(page);

    const groups = figures(page);
    await expect(groups.nth(0)).toContainText(EXPECTED.all.current);

    // A category filter narrows the figures. It must not narrow the account
    // scope coverage is judged against (§14.11), so the comparison stays
    // available and still names the same two months.
    await page.getByRole('checkbox', { name: /^groceries$/i }).check();

    await expect(groups.nth(0)).toContainText(EXPECTED.groceriesOnly.current);
    await expect(groups.nth(1)).toContainText(EXPECTED.groceriesOnly.prior);
    await expect(groups.nth(2)).toContainText(EXPECTED.groceriesOnly.delta);
    await expect(groups.nth(2)).toContainText(EXPECTED.groceriesOnly.ratio);

    await expect(groups.nth(0)).toContainText(CURRENT_MONTH);
    await expect(groups.nth(1)).toContainText(PRIOR_MONTH);
    await expect(page.getByRole('radio', { name: /latest complete month/i })).toBeChecked();

    const comparison = page.getByRole('region', {
      name: /compared with the previous complete month/i,
    });
    await expect(comparison.getByText(/not available/i)).toHaveCount(0);

    // Removing the filter restores the unfiltered figures, so the change was a
    // recomputation rather than a one-way narrowing.
    await page.getByRole('checkbox', { name: /^groceries$/i }).uncheck();
    await expect(groups.nth(0)).toContainText(EXPECTED.all.current);
    await expect(groups.nth(1)).toContainText(EXPECTED.all.prior);
  });

  test('keeps an account filter from completing a month for another account', async ({ page }) => {
    await seedCoveredWorkspace(page);
    await readyOverview(page);
    await selectLatestCompleteMonth(page);

    // Both accounts independently cover both months, so narrowing to one keeps
    // the comparison available — and the figures drop to that account's rows.
    await page.getByRole('checkbox', { name: /^statement card$/i }).check();

    const groups = figures(page);
    await expect(groups.nth(0)).toContainText('$100.00');
    await expect(groups.nth(1)).toContainText('$80.00');
    await expect(groups.nth(2)).toContainText('$20.00');
    await expect(groups.nth(2)).toContainText('25.0%');
  });

  test('stays keyboard operable and screen-reader legible', async ({ page }) => {
    await seedCoveredWorkspace(page);
    await readyOverview(page);

    const latest = page.getByRole('radio', { name: /latest complete month/i });
    await latest.focus();
    await expect(latest).toBeFocused();
    await page.keyboard.press('Space');
    await expect(latest).toBeChecked();

    const comparison = page.getByRole('region', {
      name: /compared with the previous complete month/i,
    });
    // A named region with a heading, so the section is reachable by landmark
    // and by heading rather than only by reading order.
    await expect(comparison).toBeVisible();
    await expect(
      comparison.getByRole('heading', {
        level: 3,
        name: /compared with the previous complete month/i,
      }),
    ).toBeVisible();

    // Each figure is a `dd` bound to the `dt` that names it, so a screen reader
    // announces "2026-03, $600.00" rather than three loose numbers.
    await expect(comparison.getByRole('term')).toHaveCount(3);
    await expect(comparison.getByRole('definition')).toHaveCount(4);
    await expect(comparison.getByRole('term').nth(0)).toHaveText(CURRENT_MONTH);
    await expect(comparison.getByRole('definition').nth(0)).toHaveText(EXPECTED.all.current);
  });

  test('has no serious or critical violations at every required width', async ({ page }) => {
    await seedCoveredWorkspace(page);

    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await readyOverview(page);
      await selectLatestCompleteMonth(page);
      await expect(figures(page).nth(0)).toContainText(EXPECTED.all.current);

      // The chart, the comparison, and the fallback tables are all in scope —
      // nothing is excluded from the audit to make it pass.
      await audit(page, `available comparison at ${width}px`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
});

/**
 * What the page is allowed to send, proved at runtime rather than by reading it.
 *
 * A source search finds no `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`,
 * or `EventSource` anywhere in `src/` — but that is an argument about the code
 * we wrote, not the code that runs. A dependency could open a socket, and a
 * *same-origin* request carrying a merchant in its query string would leave
 * "nothing left this origin" perfectly true and the privacy claim false.
 *
 * Both halves are therefore asserted. The probe wraps every browser transport
 * before the app's first line executes and records what was called; Playwright
 * records every request the browser actually issued, whatever produced it.
 * Static same-origin assets are expected — the lazily-loaded chart chunk among
 * them — and are checked for what they carry rather than assumed harmless.
 */

/** Tokens that exist only in a seeded workspace. None may appear in a request. */
const CANARIES = [
  'PINEBROOK',
  'acct-checking',
  'acct-card',
  'Everyday Checking',
  'Rewards Card',
  'groceries',
  'transportation',
  'utilities_bills',
  '220.00',
  '22000',
  '2026-05',
] as const;

interface ProbeRecord {
  readonly api: string;
  readonly url: string;
  readonly detail: string;
}

declare global {
  interface Window {
    __transportProbe: ProbeRecord[];
  }
}

/**
 * Wraps every transport the platform offers, before any application code runs.
 *
 * The originals are still called. Blocking them would prove only that a blocked
 * call does nothing; letting them through and recording proves nothing called
 * them.
 */
async function installTransportProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: ProbeRecord[] = [];
    window.__transportProbe = probe;
    const record = (api: string, url: unknown, detail: unknown = '') =>
      probe.push({ api, url: String(url), detail: detail === undefined ? '' : String(detail) });

    const realFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      record('fetch', input instanceof Request ? input.url : input, init?.body);
      return realFetch(input as RequestInfo, init);
    }) as typeof window.fetch;

    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, ...args: unknown[]) {
      record('xhr.open', args[1]);
      return (realOpen as unknown as (...a: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;

    const realSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, ...args: unknown[]) {
      record('xhr.send', '', args[0]);
      return (realSend as unknown as (...a: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.send;

    if (typeof navigator.sendBeacon === 'function') {
      const realBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = ((url: string | URL, data?: BodyInit | null) => {
        record('sendBeacon', url, data);
        return realBeacon(url, data);
      }) as typeof navigator.sendBeacon;
    }

    const RealSocket = window.WebSocket;
    window.WebSocket = class ProbedSocket extends RealSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        record('WebSocket', url, protocols);
        super(url, protocols);
      }
    } as unknown as typeof WebSocket;

    if (typeof window.EventSource === 'function') {
      const RealEventSource = window.EventSource;
      window.EventSource = class ProbedEventSource extends RealEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          record('EventSource', url);
          super(url, init);
        }
      } as unknown as typeof EventSource;
    }
  });
}

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly postData: string | null;
}

/** Records every request the browser issues, whatever code path produced it. */
function recordRequests(page: Page): SeenRequest[] {
  const seen: SeenRequest[] = [];
  page.on('request', (request) => {
    seen.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      postData: request.postData(),
    });
  });
  return seen;
}

/** Static same-origin assets a single-page app legitimately fetches to render. */
const STATIC_TYPES = new Set(['document', 'script', 'stylesheet', 'image', 'font', 'other']);

function assertCarriesNothingFinancial(request: SeenRequest, origin: string) {
  const haystack = `${decodeURIComponent(request.url)} ${request.url} ${request.postData ?? ''}`;
  for (const canary of CANARIES) {
    expect(haystack, `${canary} appeared in ${request.method} ${request.url}`).not.toContain(
      canary,
    );
  }

  if (request.url.startsWith('data:') || request.url.startsWith('blob:')) return;

  const url = new URL(request.url);
  expect(url.origin, `off-origin request: ${request.url}`).toBe(origin);
  // A GET with no body and no parameters cannot carry a figure out of the page.
  expect(request.method, `non-GET request: ${request.url}`).toBe('GET');
  expect(request.postData, `request body on ${request.url}`).toBeNull();
  expect(url.search, `query string on ${request.url}`).toBe('');
  expect(url.hash, `fragment on ${request.url}`).toBe('');
  expect(STATIC_TYPES.has(request.resourceType), `${request.resourceType} on ${request.url}`).toBe(
    true,
  );
}

test.describe('what the dashboard sends', () => {
  test('calls no browser transport at all while the dashboard is used', async ({ page }) => {
    await installTransportProbe(page);
    const seen = recordRequests(page);

    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);

    // Every interaction that could plausibly report something: filtering,
    // switching the breakdown dimension, opening both fallback tables, and
    // opening the reconciliation checks.
    await page.getByRole('checkbox', { name: /groceries/i }).check();
    await expect(page.getByRole('button', { name: /remove filter/i }).first()).toBeVisible();
    await page.getByRole('button', { name: /reset all/i }).click();
    await page.getByRole('radio', { name: 'Account' }).check();
    await page.locator('summary', { hasText: /net spending over time, as a table/i }).click();
    await page.locator('summary', { hasText: /spending by account, as a table/i }).click();
    await page.locator('summary', { hasText: /show all \d+ checks/i }).click();
    await expect(page.getByRole('columnheader', { name: 'Check' })).toBeVisible();

    // Not one fetch, XHR, beacon, socket, or event source — so no
    // transaction-bearing runtime API request can have occurred.
    expect(await page.evaluate(() => window.__transportProbe)).toEqual([]);

    // The chart is on this page, so its lazy chunk must have been requested.
    // Without this, the test would also pass on a page that drew no chart.
    const scripts = seen.filter(
      (request) => request.resourceType === 'script' && request.url.includes('/assets/'),
    );
    expect(scripts.length).toBeGreaterThan(0);

    const origin = new URL(page.url()).origin;
    for (const request of seen) assertCarriesNothingFinancial(request, origin);
  });

  test('leaves no figure in the URL, the title, or web storage', async ({ page }) => {
    await seedWorkspace(page, dashboardFixture());
    await readyOverview(page);
    await page.getByRole('checkbox', { name: /groceries/i }).check();
    await page.getByRole('radio', { name: /^previous month/i }).check();
    await expect(page.getByRole('button', { name: /remove filter/i }).first()).toBeVisible();

    const url = new URL(page.url());
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/app/overview');

    const title = await page.title();
    for (const canary of CANARIES) expect(title).not.toContain(canary);
    expect(title).not.toMatch(/\$|\d{4}-\d{2}/);

    // Filter state lives in component state, so it is in neither storage — the
    // only two places a reload could recover it from.
    const stored = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    for (const canary of CANARIES) expect(stored).not.toContain(canary);
  });

  test('sends nothing when a setting is changed', async ({ page }) => {
    await installTransportProbe(page);
    const seen = recordRequests(page);

    await seedWorkspace(page, dashboardFixture());
    await expect(
      page.getByRole('group', { name: /is the imported income data complete/i }),
    ).toBeVisible({ timeout: 30_000 });

    const before = seen.length;
    const complete = page.getByRole('radio', { name: /^complete/i });
    await complete.click();
    await expect(complete).toBeChecked();
    // Proving an absence needs a window in which the request could have been
    // made; the write has round-tripped through IndexedDB well before this.
    await page.waitForTimeout(750);

    expect(seen.slice(before)).toEqual([]);
    expect(await page.evaluate(() => window.__transportProbe)).toEqual([]);
  });

  /**
   * The failed-read path is deliberately not driven from a browser.
   *
   * There is no way to make a *realistic* Dexie read failure from outside the
   * page: patching `IDBIndex` either throws where a real index never throws, or
   * hands Dexie a request object its contract does not allow. Both produce
   * states Dexie itself never produces, so a test built on them would be
   * asserting against an artifact of the injection.
   *
   * The real path is covered where the seam is honest —
   * `tests/unit/dashboard/retryAndTrust.test.tsx` rejects at the repository
   * boundary `useDashboard` actually consumes, and pins the sanitized message,
   * the null selection, and recovery after retry. What that cannot show is
   * network behaviour, and it does not need to: `retry` only increments a state
   * token that re-runs the same Dexie reads, and the probe above proves no
   * transport is called anywhere in the app.
   */
  test('logs no page error and no financial value to the console', async ({ page }) => {
    const consoleText: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => consoleText.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await seedCoveredWorkspace(page);
    await readyOverview(page);
    await page.getByRole('radio', { name: /latest complete month/i }).check();
    await page.locator('summary', { hasText: /spending by category, as a table/i }).click();

    expect(pageErrors).toEqual([]);
    expect(consoleText.filter((line) => line.startsWith('error:'))).toEqual([]);
    const dumped = consoleText.join('\n');
    for (const canary of ['PINEBROOK', 'Statement Checking', '$600.00', '$450.00']) {
      expect(dumped).not.toContain(canary);
    }
  });
});
