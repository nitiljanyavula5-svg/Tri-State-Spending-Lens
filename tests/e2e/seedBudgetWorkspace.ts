import { expect, type Page } from '@playwright/test';
import type { SeedAccount, SeedTransaction } from './seedWorkspace';

/**
 * A workspace shaped for budgeting.
 *
 * Two things the Phase 5 seeds cannot provide: budget plan rows, and statement
 * coverage that reaches *today* so a current-month pace can be projected. The
 * second is necessarily wall-clock dependent — a projection is only offered
 * when the elapsed part of the current month is covered — so the current-month
 * range is computed at seed time from local calendar parts rather than pinned
 * to a date that would go stale.
 *
 * Everything is invented. No real bank, merchant, person, or account appears,
 * and nothing here leaves the browser.
 */

const STAMP = '2026-08-01T12:00:00.000Z';

export const BUDGET_ACCOUNT = 'budget-checking';
export const ARCHIVED_ACCOUNT = 'budget-archived';

/** A settled past month, so plan editing is tested against final figures. */
export const PAST_MONTH = '2026-05';

export const BUDGET_ACCOUNTS: SeedAccount[] = [
  {
    id: BUDGET_ACCOUNT,
    label: 'Budget Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  {
    id: ARCHIVED_ACCOUNT,
    label: 'Closed Card',
    type: 'credit_card',
    currency: 'USD',
    archived: true,
  },
];

/** Local calendar parts, never a parsed date-only string. */
function todayParts(): { year: number; month: number; day: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

const pad = (value: number) => String(value).padStart(2, '0');

export function currentMonth(): string {
  const { year, month } = todayParts();
  return `${year}-${pad(month)}`;
}

export function currentMonthStart(): string {
  return `${currentMonth()}-01`;
}

export function todayIso(): string {
  const { year, month, day } = todayParts();
  return `${year}-${pad(month)}-${pad(day)}`;
}

function row(
  id: string,
  postedDate: string,
  categoryId: string,
  amountCents: number,
  overrides: Partial<SeedTransaction> = {},
): SeedTransaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: 'budget-session',
    originalRow: 1,
    accountId: BUDGET_ACCOUNT,
    postedDate,
    descriptionRaw: 'PINEBROOK MARKET #114',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents,
    direction: 'debit',
    kind: 'purchase',
    categoryId,
    categorySource: 'user',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

/**
 * May 2026 rows: $300 groceries, $150 dining, $50 transportation, less a $50
 * groceries refund — net $450.00, of which $250.00 is groceries.
 *
 * The archived account also holds a large purchase, which must never appear in
 * any budget figure.
 */
export function budgetFixture(): SeedTransaction[] {
  const { day } = todayParts();
  // One row early in the current month, so a covered pace has something to
  // project from on any day of any month.
  const currentRow = row('b-current', `${currentMonthStart()}`, 'groceries', 12_000);

  return [
    row('b-1', '2026-05-04', 'groceries', 30_000),
    row('b-2', '2026-05-11', 'dining', 15_000),
    row('b-3', '2026-05-18', 'transportation', 5_000),
    row('b-4', '2026-05-24', 'groceries', 5_000, { direction: 'credit', kind: 'refund' }),
    row('b-5', '2026-05-27', 'other', 40_000, { kind: 'transfer' }),
    row('b-archived', '2026-05-15', 'travel', 90_000, { accountId: ARCHIVED_ACCOUNT }),
    ...(day >= 1 ? [currentRow] : []),
  ];
}

interface Snapshot {
  accounts: SeedAccount[];
  importSessions: unknown[];
  transactions: SeedTransaction[];
  merchantRules: unknown[];
  budgetPlans: unknown[];
  budgetCategoryTargets: unknown[];
  recurringSeries: unknown[];
  userEdits: unknown[];
  appSettings: unknown[];
  mappingPresets: unknown[];
  transactionLinks: unknown[];
}

export interface BudgetSeedOptions {
  /** Adds a stored plan for May 2026. */
  readonly withPastPlan?: boolean;
  /** Adds a stored plan for the current month, so pace has a limit to compare. */
  readonly withCurrentPlan?: boolean;
  /**
   * Covers the current month only up to its first day.
   *
   * Enough to make the month incomplete from the second day onward, which is
   * the state that must refuse a projection rather than scale a partial figure.
   */
  readonly truncateCurrentCoverage?: boolean;
}

function snapshotOf(options: BudgetSeedOptions): Snapshot {
  const transactions = budgetFixture();

  const budgetPlans: unknown[] = [];
  const budgetCategoryTargets: unknown[] = [];

  if (options.withPastPlan) {
    budgetPlans.push({
      id: 'plan-past',
      month: PAST_MONTH,
      overallLimitCents: 60_000,
      incomeTargetCents: 400_000,
      savingsTargetCents: 20_000,
      rolloverEnabled: false,
    });
    budgetCategoryTargets.push(
      {
        id: 'target-groceries',
        budgetPlanId: 'plan-past',
        categoryId: 'groceries',
        limitCents: 20_000,
      },
      { id: 'target-dining', budgetPlanId: 'plan-past', categoryId: 'dining', limitCents: 30_000 },
    );
  }

  if (options.withCurrentPlan) {
    budgetPlans.push({
      id: 'plan-current',
      month: currentMonth(),
      overallLimitCents: 80_000,
      rolloverEnabled: false,
    });
  }

  return {
    accounts: BUDGET_ACCOUNTS,
    importSessions: [
      {
        id: 'budget-session',
        importedAt: STAMP,
        sourceFileNames: ['statement.csv'],
        // Exactly one account, so coverage is unambiguous (§14.11).
        accountIds: [BUDGET_ACCOUNT],
        mappingVersion: 1,
        rowCount: transactions.length,
        acceptedCount: transactions.length,
        rejectedCount: 0,
        duplicateCandidateCount: 0,
        warnings: [],
        statementRangeStart: '2026-05-01',
        statementRangeEnd: '2026-05-31',
      },
      {
        id: 'budget-session-current',
        importedAt: STAMP,
        sourceFileNames: ['statement.csv'],
        accountIds: [BUDGET_ACCOUNT],
        mappingVersion: 1,
        rowCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        duplicateCandidateCount: 0,
        warnings: [],
        statementRangeStart: currentMonthStart(),
        statementRangeEnd: options.truncateCurrentCoverage ? currentMonthStart() : todayIso(),
      },
    ],
    transactions,
    merchantRules: [],
    budgetPlans,
    budgetCategoryTargets,
    recurringSeries: [],
    userEdits: [],
    appSettings: [{ key: 'workspaceMode', value: 'personal', updatedAt: STAMP }],
    mappingPresets: [],
    transactionLinks: [],
  };
}

export function budgetBackup(options: BudgetSeedOptions = {}): string {
  const data = snapshotOf(options);
  const counts = Object.fromEntries(
    Object.entries(data).map(([table, rows]) => [table, (rows as unknown[]).length]),
  );
  return JSON.stringify({
    format: 'tri-state-spending-lens-workspace',
    formatVersion: 1,
    schemaVersion: 3,
    exportedAt: STAMP,
    counts,
    data,
  });
}

/** Restores the budget workspace through the product's own restore path. */
export async function seedBudgetWorkspace(
  page: Page,
  options: BudgetSeedOptions = {},
): Promise<void> {
  await page.goto('/app/settings');
  await expect(page.getByRole('heading', { level: 1, name: /^settings$/i })).toBeVisible();

  const input = page.getByLabel(/restore a workspace backup/i);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.setInputFiles({
    name: 'budget-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(budgetBackup(options), 'utf8'),
  });

  await expect(page.getByRole('status')).toContainText(/workspace restored/i, { timeout: 30_000 });
}

/** Opens the budget page and moves it to the given month. */
export async function gotoBudgetMonth(page: Page, month: string): Promise<void> {
  await page.goto('/app/budget');
  await expect(page.getByRole('heading', { level: 1, name: /^budget$/i })).toBeVisible();
  const monthInput = page.getByLabel(/budget month/i);
  await expect(monthInput).toBeVisible({ timeout: 30_000 });
  await monthInput.fill(month);
  await expect(page.getByText(`Showing ${month}.`)).toBeVisible();
}
