import { expect, type Page } from '@playwright/test';
import type { SeedAccount, SeedTransaction } from './seedWorkspace';

/**
 * A workspace whose statements genuinely cover two adjacent calendar months.
 *
 * The shared Phase 4 seed cannot express this. `seedWorkspace` writes one import
 * session that names three accounts and confirms no statement range at all, so
 * every month is incomplete there and the comparison is correctly unavailable —
 * which was the only comparison path a browser test could reach.
 *
 * calculation-contract.md §14.11 decides what "covered" means, and this fixture
 * satisfies it the only way the schema allows: one import session per account,
 * each naming **exactly one** account id, each carrying a valid statement range.
 * A single session naming both accounts would be ambiguous and would establish
 * coverage for neither.
 *
 * Nothing here depends on the wall clock. `latest-complete-month` resolves from
 * confirmed coverage rather than from today, so the expected figures below are
 * the same on every run, on any date, in any timezone.
 *
 * Everything is invented. No real bank, merchant, person, or account appears,
 * and nothing here leaves the browser.
 */

const STAMP = '2026-08-01T12:00:00.000Z';

/** The month `Latest complete month` selects, and the one it is compared against. */
export const CURRENT_MONTH = '2026-03';
export const PRIOR_MONTH = '2026-02';

/**
 * One statement span per account, covering both months end to end.
 *
 * Written as a single span rather than two adjacent ones on purpose: merged
 * coverage with no gap is the state under test, and two spans would drag
 * `hasCoverageGapForScope` into a fixture that is about completeness.
 */
const RANGE_START = '2026-02-01';
const RANGE_END = '2026-03-31';

export const CHECKING = 'covered-checking';
export const CARD = 'covered-card';

export const COVERED_ACCOUNTS: SeedAccount[] = [
  {
    id: CHECKING,
    label: 'Statement Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  { id: CARD, label: 'Statement Card', type: 'credit_card', currency: 'USD', archived: false },
];

/** One session per account. Each names exactly one account, so neither is ambiguous. */
const SESSION_OF: Readonly<Record<string, string>> = {
  [CHECKING]: 'covered-session-checking',
  [CARD]: 'covered-session-card',
};

function row(
  id: string,
  accountId: string,
  postedDate: string,
  categoryId: string,
  amountCents: number,
  refund = false,
): SeedTransaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: SESSION_OF[accountId] as string,
    originalRow: 1,
    accountId,
    postedDate,
    descriptionRaw: 'PINEBROOK MARKET #114',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents,
    direction: refund ? 'credit' : 'debit',
    kind: refund ? 'refund' : 'purchase',
    categoryId,
    categorySource: 'user',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

/**
 * Eight rows, four in each month, with one refund per month.
 *
 * A refund on both sides means the comparison exercises
 * `net = gross outflow − refunds` in each month rather than comparing two plain
 * sums, and putting both refunds in Groceries is what makes the
 * category-filtered figures differ from the unfiltered ones in all four places.
 */
export function coveredFixture(): SeedTransaction[] {
  return [
    // 2026-02 — gross 50_000, refunds 5_000, net 45_000.
    row('cov-p1', CHECKING, '2026-02-05', 'groceries', 30_000),
    row('cov-p2', CHECKING, '2026-02-12', 'dining', 12_000),
    row('cov-p3', CARD, '2026-02-18', 'transportation', 8_000),
    row('cov-p4', CHECKING, '2026-02-24', 'groceries', 5_000, true),

    // 2026-03 — gross 65_000, refunds 5_000, net 60_000.
    row('cov-c1', CHECKING, '2026-03-03', 'groceries', 40_000),
    row('cov-c2', CHECKING, '2026-03-09', 'dining', 15_000),
    row('cov-c3', CARD, '2026-03-16', 'transportation', 10_000),
    row('cov-c4', CHECKING, '2026-03-22', 'groceries', 5_000, true),
  ];
}

/**
 * The figures the selector must produce, written out rather than recomputed.
 *
 * Deliberately not derived from `coveredFixture()` in the test. A test that
 * re-implements `net = gross − refunds` proves only that two copies of the same
 * arithmetic agree; these constants were worked out by hand from the contract,
 * so a change in the selector fails here instead of being mirrored.
 *
 *   all data      2026-03 60_000 − 2026-02 45_000 = 15_000, 15_000/45_000
 *   groceries     2026-03 35_000 − 2026-02 25_000 = 10_000, 10_000/25_000
 */
export const EXPECTED = {
  all: { current: '$600.00', prior: '$450.00', delta: '$150.00', ratio: '33.3%' },
  groceriesOnly: { current: '$350.00', prior: '$250.00', delta: '$100.00', ratio: '40.0%' },
} as const;

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

function snapshotOf(transactions: SeedTransaction[]): Snapshot {
  const sessionFor = (accountId: string) => {
    const rows = transactions.filter((entry) => entry.accountId === accountId);
    return {
      id: SESSION_OF[accountId] as string,
      importedAt: STAMP,
      sourceFileNames: ['statement.csv'],
      // Exactly one account id (§14.11).
      accountIds: [accountId],
      mappingVersion: 1,
      rowCount: rows.length,
      acceptedCount: rows.length,
      rejectedCount: 0,
      duplicateCandidateCount: 0,
      warnings: [],
      statementRangeStart: RANGE_START,
      statementRangeEnd: RANGE_END,
    };
  };

  return {
    accounts: COVERED_ACCOUNTS,
    importSessions: COVERED_ACCOUNTS.map((account) => sessionFor(account.id)),
    transactions,
    merchantRules: [],
    budgetPlans: [],
    budgetCategoryTargets: [],
    recurringSeries: [],
    userEdits: [],
    appSettings: [{ key: 'workspaceMode', value: 'personal', updatedAt: STAMP }],
    mappingPresets: [],
    transactionLinks: [],
  };
}

/** A valid backup document wrapping the covered fixture. */
export function coveredBackup(transactions: SeedTransaction[] = coveredFixture()): string {
  const data = snapshotOf(transactions);
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

/**
 * Puts the covered workspace into this browser profile.
 *
 * Restored through the product's own restore path, exactly as `seedWorkspace`
 * does, so the statement ranges face the same validation a real backup would
 * rather than being written straight into Dexie.
 */
export async function seedCoveredWorkspace(
  page: Page,
  transactions: SeedTransaction[] = coveredFixture(),
): Promise<void> {
  await page.goto('/app/settings');
  await expect(page.getByRole('heading', { level: 1, name: /^settings$/i })).toBeVisible();

  const input = page.getByLabel(/restore a workspace backup/i);
  await expect(input).toBeEnabled({ timeout: 30_000 });

  await input.setInputFiles({
    name: 'covered-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(coveredBackup(transactions), 'utf8'),
  });

  await expect(page.getByRole('status')).toContainText(/workspace restored/i, { timeout: 30_000 });
}
