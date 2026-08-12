import { expect, type Page } from '@playwright/test';

/**
 * Deterministic workspace seeding for browser tests.
 *
 * Seeded through the product's own **restore** path rather than by writing to
 * IndexedDB directly. That matters for two reasons: the rows go through the
 * same validation a real backup does, so a fixture that would be refused in
 * production is refused here too; and the test never has to know the Dexie
 * schema, so a migration cannot leave these files quietly writing the wrong
 * shape.
 *
 * Everything below is invented. No real bank, merchant, person, or account
 * appears, and nothing here leaves the browser.
 */

export interface SeedAccount {
  id: string;
  label: string;
  type: 'checking' | 'savings' | 'credit_card' | 'cash' | 'other';
  currency: 'USD';
  archived: boolean;
}

export interface SeedTransaction {
  id: string;
  fingerprint: string;
  importSessionId: string;
  originalRow: number;
  accountId: string;
  postedDate: string;
  descriptionRaw: string;
  merchantNormalized: string;
  amountCents: number;
  direction: 'debit' | 'credit';
  kind: string;
  categoryId: string;
  categorySource: string;
  classificationConfidence: string;
  tags: string[];
  excludedFromSpending: boolean;
  createdAt: string;
  updatedAt: string;
}

const STAMP = '2026-08-01T12:00:00.000Z';
export const SESSION_ID = 'e2e-session';

export const ACCOUNTS: SeedAccount[] = [
  {
    id: 'acct-checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  {
    id: 'acct-savings',
    label: 'Rainy Day Savings',
    type: 'savings',
    currency: 'USD',
    archived: false,
  },
  { id: 'acct-card', label: 'Rewards Card', type: 'credit_card', currency: 'USD', archived: false },
];

export function txn(
  id: string,
  overrides: Partial<SeedTransaction> & Pick<SeedTransaction, 'accountId'>,
): SeedTransaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: SESSION_ID,
    originalRow: 1,
    postedDate: '2026-04-08',
    descriptionRaw: 'PINEBROOK MARKET #114',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1_234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'other',
    categorySource: 'uncategorized',
    classificationConfidence: 'none',
    tags: [],
    excludedFromSpending: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

/**
 * The standard review fixture.
 *
 * Deliberately contains one of everything the review surfaces have to handle:
 * a transfer pair across two accounts, a card-payment pair, a refund with
 * exactly one matching purchase, an ambiguous refund with two, a credit nothing
 * matches, a hostile description that would be a formula in a spreadsheet, and
 * an extremely long merchant name.
 */
export function reviewFixture(): SeedTransaction[] {
  return [
    // A transfer: same amount, opposite directions, different accounts.
    txn('t-out', {
      accountId: 'acct-checking',
      direction: 'debit',
      amountCents: 20_000,
      postedDate: '2026-04-03',
      descriptionRaw: 'TRANSFER TO SAVINGS',
      merchantNormalized: 'TRANSFER TO SAVINGS',
    }),
    txn('t-in', {
      accountId: 'acct-savings',
      direction: 'credit',
      amountCents: 20_000,
      postedDate: '2026-04-04',
      descriptionRaw: 'TRANSFER FROM CHECKING',
      merchantNormalized: 'TRANSFER FROM CHECKING',
      kind: 'unknown',
    }),

    // A card payment: a credit card is one of the two accounts.
    txn('p-out', {
      accountId: 'acct-checking',
      direction: 'debit',
      amountCents: 31_500,
      postedDate: '2026-04-20',
      descriptionRaw: 'PAYMENT TO REWARDS CARD',
      merchantNormalized: 'REWARDS CARD PAYMENT',
    }),
    txn('p-in', {
      accountId: 'acct-card',
      direction: 'credit',
      amountCents: 31_500,
      postedDate: '2026-04-20',
      descriptionRaw: 'PAYMENT RECEIVED - THANK YOU',
      merchantNormalized: 'REWARDS CARD PAYMENT',
      kind: 'unknown',
    }),

    // A refund with exactly one matching earlier purchase.
    txn('r-purchase', {
      accountId: 'acct-card',
      direction: 'debit',
      amountCents: 2_400,
      postedDate: '2026-04-05',
      descriptionRaw: 'QUILL AND PAGE BOOKS',
      merchantNormalized: 'QUILL AND PAGE BOOKS',
      categoryId: 'shopping',
      categorySource: 'user',
      classificationConfidence: 'high',
    }),
    txn('r-refund', {
      accountId: 'acct-card',
      direction: 'credit',
      amountCents: 2_400,
      postedDate: '2026-04-22',
      descriptionRaw: 'QUILL AND PAGE BOOKS',
      merchantNormalized: 'QUILL AND PAGE BOOKS',
      kind: 'refund',
    }),

    // Two identical earlier purchases: genuinely ambiguous, and shown as such.
    txn('amb-purchase-1', {
      accountId: 'acct-card',
      direction: 'debit',
      amountCents: 5_600,
      postedDate: '2026-04-02',
      descriptionRaw: 'GREENLEAF GROCERS',
      merchantNormalized: 'GREENLEAF GROCERS',
      categoryId: 'groceries',
    }),
    txn('amb-purchase-2', {
      accountId: 'acct-card',
      direction: 'debit',
      amountCents: 5_600,
      postedDate: '2026-04-11',
      descriptionRaw: 'GREENLEAF GROCERS',
      merchantNormalized: 'GREENLEAF GROCERS',
      categoryId: 'groceries',
    }),
    txn('amb-refund', {
      accountId: 'acct-card',
      direction: 'credit',
      amountCents: 5_600,
      postedDate: '2026-04-25',
      descriptionRaw: 'GREENLEAF GROCERS',
      merchantNormalized: 'GREENLEAF GROCERS',
      kind: 'refund',
    }),

    // A credit nothing matches: the honest "decide this by hand" case.
    txn('orphan-credit', {
      accountId: 'acct-checking',
      direction: 'credit',
      amountCents: 3_250,
      postedDate: '2026-04-28',
      descriptionRaw: 'ADJUSTMENT CREDIT',
      merchantNormalized: 'ADJUSTMENT CREDIT',
      kind: 'unknown',
    }),

    // Ordinary purchases, for search, filtering, and editing.
    txn('buy-pinebrook', {
      accountId: 'acct-checking',
      postedDate: '2026-04-08',
      descriptionRaw: 'PINEBROOK MARKET #114',
      merchantNormalized: 'PINEBROOK MARKET',
      amountCents: 1_234,
    }),
    txn('buy-harbor', {
      accountId: 'acct-checking',
      postedDate: '2026-04-09',
      descriptionRaw: 'SQ *HARBOR BEAN 0413',
      merchantNormalized: 'HARBOR BEAN COFFEE',
      amountCents: 4_500,
      categoryId: 'dining',
      categorySource: 'user',
      classificationConfidence: 'high',
    }),

    // A description that is data here and an executable formula in a
    // spreadsheet, so the export can be asserted against a real hazard.
    txn('buy-formula', {
      accountId: 'acct-checking',
      postedDate: '2026-04-12',
      descriptionRaw: '=cmd|/c calc',
      merchantNormalized: 'LEDGER TEST MERCHANT',
      amountCents: 777,
    }),

    // A merchant long enough to break a layout that does not truncate.
    txn('buy-long', {
      accountId: 'acct-checking',
      postedDate: '2026-04-13',
      descriptionRaw: `NORTHFIELD ${'VERYLONGMERCHANTNAME '.repeat(12)}END`,
      merchantNormalized: `NORTHFIELD ${'VERYLONGMERCHANTNAME '.repeat(12)}END`,
      amountCents: 8_900,
    }),
  ];
}

/** Extra filler rows, so pagination and large-workspace behaviour are reachable. */
export function fillerRows(count: number, from = 0): SeedTransaction[] {
  const rows: SeedTransaction[] = [];
  for (let index = from; index < from + count; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    rows.push(
      txn(`filler-${String(index).padStart(4, '0')}`, {
        accountId: 'acct-checking',
        postedDate: `2026-05-${day}`,
        descriptionRaw: `FILLER MERCHANT ${index}`,
        merchantNormalized: `FILLER MERCHANT ${index}`,
        amountCents: 100 + index,
        originalRow: index + 1,
      }),
    );
  }
  return rows;
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

function snapshotOf(transactions: SeedTransaction[]): Snapshot {
  return {
    accounts: ACCOUNTS,
    importSessions: [
      {
        id: SESSION_ID,
        importedAt: STAMP,
        sourceFileNames: ['statement.csv'],
        accountIds: ACCOUNTS.map((account) => account.id),
        mappingVersion: 1,
        rowCount: transactions.length,
        acceptedCount: transactions.length,
        rejectedCount: 0,
        duplicateCandidateCount: 0,
        warnings: [],
      },
    ],
    transactions,
    merchantRules: [],
    budgetPlans: [],
    budgetCategoryTargets: [],
    recurringSeries: [],
    userEdits: [],
    // A personal workspace, so no demo badge appears and the fixture is not
    // mistaken for the demo dataset.
    appSettings: [{ key: 'workspaceMode', value: 'personal', updatedAt: STAMP }],
    mappingPresets: [],
    transactionLinks: [],
  };
}

/** A valid backup document wrapping the given rows. */
export function backupFor(transactions: SeedTransaction[]): string {
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
 * Puts a deterministic workspace into this browser profile.
 *
 * Restore replaces the whole workspace atomically, so the state afterwards is
 * exactly the fixture — no leftovers from an earlier navigation.
 */
export async function seedWorkspace(
  page: Page,
  transactions: SeedTransaction[] = reviewFixture(),
): Promise<void> {
  await page.goto('/app/settings');
  await expect(page.getByRole('heading', { level: 1, name: /^settings$/i })).toBeVisible();

  // The restore control is disabled until IndexedDB has finished opening.
  // `setInputFiles` does not wait for that on its own, so a file dropped in
  // too early is read while the provider still has no database and comes back
  // as "that file could not be read".
  const input = page.getByLabel(/restore a workspace backup/i);
  await expect(input).toBeEnabled({ timeout: 30_000 });

  await input.setInputFiles({
    name: 'fixture-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupFor(transactions), 'utf8'),
  });

  await expect(page.getByRole('status')).toContainText(/workspace restored/i, { timeout: 30_000 });
}
