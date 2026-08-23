import type {
  AccountScope,
  DashboardFilters,
  IncomeCompleteness,
  SelectableTransaction,
  StatementRange,
} from '../../../src/calculations/types';

/**
 * Fixtures for the calculation layer.
 *
 * Built as plain data rather than through the demo dataset or a database: these
 * selectors are pure functions of their input (calculation-contract.md §1 rule
 * 2), and a fixture that needed Dexie to exist would undermine the property the
 * suite is meant to prove.
 *
 * Each scenario is a named financial situation rather than a bag of rows, so a
 * failure names the condition that broke — "refunds exceeding outflows" reads as
 * a specification, "case 7" does not.
 */

let sequence = 0;

export function resetIds(): void {
  sequence = 0;
}

export interface TxOverrides {
  readonly id?: string;
  readonly accountId?: string;
  readonly postedDate?: string;
  readonly amountCents?: number;
  readonly direction?: 'debit' | 'credit';
  readonly kind?: SelectableTransaction['kind'];
  readonly categoryId?: string;
  readonly merchantNormalized?: string;
  readonly excludedFromSpending?: boolean;
}

/** A transaction with ordinary defaults: an included grocery purchase. */
export function tx(overrides: TxOverrides = {}): SelectableTransaction {
  sequence += 1;
  return {
    id: overrides.id ?? `t-${String(sequence).padStart(4, '0')}`,
    accountId: overrides.accountId ?? 'acct-checking',
    postedDate: overrides.postedDate ?? '2026-05-15',
    amountCents: overrides.amountCents ?? 1_000,
    direction: overrides.direction ?? 'debit',
    kind: overrides.kind ?? 'purchase',
    categoryId: overrides.categoryId ?? 'groceries',
    merchantNormalized: overrides.merchantNormalized ?? 'ACME MARKET',
    excludedFromSpending: overrides.excludedFromSpending ?? false,
  };
}

export const purchase = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'purchase', direction: 'debit' });

export const refund = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'refund', direction: 'credit' });

export const income = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'income', direction: 'credit', categoryId: 'other' });

export const transfer = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'transfer', categoryId: 'other' });

export const cardPayment = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'payment', categoryId: 'other' });

export const fee = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'fee', direction: 'debit', categoryId: 'fees_interest' });

export const cashOut = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({
    ...overrides,
    amountCents,
    kind: 'cash_withdrawal',
    direction: 'debit',
    categoryId: 'cash_atm',
  });

export const unknownCredit = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'unknown', direction: 'credit', categoryId: 'other' });

export const unknownDebit = (amountCents: number, overrides: TxOverrides = {}) =>
  tx({ ...overrides, amountCents, kind: 'unknown', direction: 'debit', categoryId: 'other' });

/* -------------------------------------------------------- accounts + ranges - */

export const CHECKING = 'acct-checking';
export const CARD = 'acct-card';
export const SAVINGS = 'acct-savings';

/** The three accounts the scenarios transact on. All active. */
export const ACCOUNTS: AccountScope[] = [
  { id: CHECKING, archived: false },
  { id: CARD, archived: false },
  { id: SAVINGS, archived: false },
];

export const MAY = { start: '2026-05-01', end: '2026-05-31' } as const;
export const APRIL = { start: '2026-04-01', end: '2026-04-30' } as const;

/**
 * A statement range attributed to accounts.
 *
 * `accountIds` mirrors `ImportSession.accountIds`. Defaults to a **single**
 * account, because only a single-account range is usable per-account coverage
 * evidence (§14.11) — a range naming several accounts is ambiguous and
 * establishes coverage for none of them.
 */
export function range(
  start: string | undefined,
  end: string | undefined,
  accountIds: readonly string[] = [CHECKING],
): StatementRange {
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    accountIds,
  };
}

/**
 * The same period, stated once per account.
 *
 * This is what a workspace that imported each account's statement separately
 * actually holds, and it is the only shape that can complete a month for a
 * multi-account scope. A single range naming all three accounts would be
 * ambiguous and complete nothing.
 */
export function rangesForAll(
  start: string,
  end: string,
  accountIds: readonly string[] = [CHECKING, CARD, SAVINGS],
): StatementRange[] {
  return accountIds.map((accountId) => range(start, end, [accountId]));
}

/** April and May fully covered for every account — two adjacent complete months. */
export const COVERAGE_TWO_MONTHS: StatementRange[] = [
  ...rangesForAll('2026-04-01', '2026-04-30'),
  ...rangesForAll('2026-05-01', '2026-05-31'),
];

/** One span covering both months, stated per account. */
export const COVERAGE_SPANNING: StatementRange[] = rangesForAll('2026-04-01', '2026-05-31');

/** May starts on the 12th: not a complete month. */
export const COVERAGE_PARTIAL_MAY: StatementRange[] = rangesForAll('2026-05-12', '2026-05-31');

/** May complete, April missing its first week — prior month incomplete. */
export const COVERAGE_PRIOR_INCOMPLETE: StatementRange[] = [
  ...rangesForAll('2026-04-08', '2026-04-30'),
  ...rangesForAll('2026-05-01', '2026-05-31'),
];

/** Both endpoints absent — a session that never confirmed a range. */
export const COVERAGE_MISSING: StatementRange[] = [
  range(undefined, undefined),
  range('2026-05-01', undefined),
];

/** Reversed and non-calendar ranges; neither may establish coverage. */
export const COVERAGE_MALFORMED: StatementRange[] = [
  range('2026-05-31', '2026-05-01'),
  range('2026-02-30', '2026-03-05'),
];

/** Overlapping statements that must not double-count their intersection. */
export const COVERAGE_OVERLAPPING: StatementRange[] = [
  ...rangesForAll('2026-05-01', '2026-05-20'),
  ...rangesForAll('2026-05-10', '2026-05-31'),
];

/** Touching but not overlapping — must merge into continuous coverage. */
export const COVERAGE_ADJACENT: StatementRange[] = [
  ...rangesForAll('2026-05-01', '2026-05-15'),
  ...rangesForAll('2026-05-16', '2026-05-31'),
];

/** December into January — a complete pair across a year boundary. */
export const COVERAGE_CROSS_YEAR: StatementRange[] = [
  ...rangesForAll('2026-12-01', '2026-12-31'),
  ...rangesForAll('2027-01-01', '2027-01-31'),
];

/** February 2028 in full — 29 days, so the 29th must be covered. */
export const COVERAGE_LEAP: StatementRange[] = rangesForAll('2028-02-01', '2028-02-29');

/** February 2028 stopping on the 28th — one day short of complete. */
export const COVERAGE_LEAP_SHORT: StatementRange[] = rangesForAll('2028-02-01', '2028-02-28');

/* ----------------------------------------------- ambiguous multi-account - */

/**
 * One full-month range naming two accounts.
 *
 * The session proves both accounts were imported; it cannot say what period
 * either statement covered. Completes neither (§14.11).
 */
export const COVERAGE_AMBIGUOUS_PAIR: StatementRange[] = [
  range('2026-05-01', '2026-05-31', [CHECKING, CARD]),
];

/**
 * A partial single-account range plus an ambiguous range naming that account.
 *
 * The ambiguous range must not fill the gap the partial one leaves.
 */
export const COVERAGE_AMBIGUOUS_CANNOT_FILL: StatementRange[] = [
  range('2026-05-12', '2026-05-31', [CHECKING]),
  range('2026-05-01', '2026-05-11', [CHECKING, CARD]),
];

/** The same account named twice — one unique account, still usable. */
export const COVERAGE_DUPLICATE_ID: StatementRange[] = [
  range('2026-05-01', '2026-05-31', [CHECKING, CHECKING]),
];

/** A validly dated range naming no account at all. */
export const COVERAGE_UNATTRIBUTED: StatementRange[] = [range('2026-05-01', '2026-05-31', [])];

/** Malformed dates *and* several accounts — malformed takes precedence (§14.11). */
export const COVERAGE_MALFORMED_MULTI: StatementRange[] = [
  range('2026-05-31', '2026-05-01', [CHECKING, CARD]),
];

/* ------------------------------------------------- account-scoped coverage - */

/**
 * The case §14.11 exists for.
 *
 * Checking covers May 1–15, card covers May 16–31. A global union spans the
 * whole month; neither account does, so May is not complete for either.
 */
export const COVERAGE_SPLIT_HALVES: StatementRange[] = [
  range('2026-05-01', '2026-05-15', [CHECKING]),
  range('2026-05-16', '2026-05-31', [CARD]),
];

/** Checking complete for May; card only from the 12th. */
export const COVERAGE_ONE_COMPLETE_ONE_PARTIAL: StatementRange[] = [
  range('2026-05-01', '2026-05-31', [CHECKING]),
  range('2026-05-12', '2026-05-31', [CARD]),
];

/** Both accounts independently complete, reached by separate sessions. */
export const COVERAGE_BOTH_COMPLETE_SEPARATELY: StatementRange[] = [
  range('2026-05-01', '2026-05-31', [CHECKING]),
  range('2026-05-01', '2026-05-31', [CARD]),
];

/** Each account reaches a complete May through overlapping and adjacent sessions. */
export const COVERAGE_BOTH_COMPLETE_PIECEWISE: StatementRange[] = [
  range('2026-05-01', '2026-05-20', [CHECKING]),
  range('2026-05-10', '2026-05-31', [CHECKING]),
  range('2026-05-01', '2026-05-15', [CARD]),
  range('2026-05-16', '2026-05-31', [CARD]),
];

/** Both complete in May; only checking is complete in April. */
export const COVERAGE_PRIOR_INCOMPLETE_ONE_ACCOUNT: StatementRange[] = [
  range('2026-04-01', '2026-04-30', [CHECKING]),
  range('2026-04-10', '2026-04-30', [CARD]),
  range('2026-05-01', '2026-05-31', [CHECKING]),
  range('2026-05-01', '2026-05-31', [CARD]),
];

/* --------------------------------------------------------------- scenarios - */

export interface Scenario {
  readonly name: string;
  readonly transactions: readonly SelectableTransaction[];
  readonly coverage: readonly StatementRange[];
  readonly incomeCompleteness: IncomeCompleteness;
  readonly filters: DashboardFilters;
  readonly accounts: readonly AccountScope[];
  /** Net spending in cents, computed by hand from the rows above. */
  readonly expectedNetCents: number;
}

function may(day: number): string {
  return `2026-05-${String(day).padStart(2, '0')}`;
}

/**
 * The scenario matrix.
 *
 * `expectedNetCents` is written out by hand rather than derived, so a bug in the
 * selector cannot quietly rewrite the expectation it is being checked against.
 */
export function scenarios(): Scenario[] {
  resetIds();

  // Every scenario transacts on the same three active accounts, so the account
  // scope is attached once here rather than repeated 24 times.
  const withAccounts = (list: Omit<Scenario, 'accounts'>[]): Scenario[] =>
    list.map((scenario) => ({ ...scenario, accounts: ACCOUNTS }));

  return withAccounts([
    {
      name: 'normal populated month',
      transactions: [
        purchase(12_345, { postedDate: may(2), categoryId: 'groceries' }),
        purchase(4_999, { postedDate: may(9), categoryId: 'dining' }),
        fee(350, { postedDate: may(11) }),
        cashOut(20_000, { postedDate: may(14) }),
        refund(2_500, { postedDate: may(20), categoryId: 'groceries' }),
        income(500_000, { postedDate: may(1) }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 12_345 + 4_999 + 350 + 20_000 - 2_500,
    },
    {
      name: 'empty population',
      transactions: [],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 0,
    },
    {
      name: 'transfers and card payments are excluded',
      transactions: [
        purchase(10_000, { postedDate: may(3) }),
        transfer(250_000, { postedDate: may(4), direction: 'debit' }),
        transfer(250_000, { postedDate: may(4), direction: 'credit', accountId: 'acct-savings' }),
        cardPayment(75_000, { postedDate: may(5), direction: 'debit' }),
        cardPayment(75_000, { postedDate: may(5), direction: 'credit', accountId: 'acct-card' }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 10_000,
    },
    {
      name: 'user-excluded rows contribute nothing',
      transactions: [
        purchase(10_000, { postedDate: may(3) }),
        purchase(9_999, { postedDate: may(6), excludedFromSpending: true }),
        refund(1_000, { postedDate: may(7), excludedFromSpending: true }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 10_000,
    },
    {
      name: 'refunds exceeding outflows produce negative net spending',
      transactions: [
        purchase(5_000, { postedDate: may(3), categoryId: 'shopping' }),
        refund(18_000, { postedDate: may(21), categoryId: 'shopping' }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 5_000 - 18_000,
    },
    {
      name: 'unknown credit and unknown debit are both excluded',
      transactions: [
        purchase(7_000, { postedDate: may(3) }),
        unknownCredit(30_000, { postedDate: may(8) }),
        unknownDebit(6_000, { postedDate: may(9) }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 7_000,
    },
    {
      name: 'zero income with spending',
      transactions: [purchase(4_200, { postedDate: may(10) })],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 4_200,
    },
    {
      name: 'negative cash flow',
      transactions: [
        income(100_000, { postedDate: may(1) }),
        purchase(250_000, { postedDate: may(12) }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 250_000,
    },
    {
      name: 'income confirmed incomplete',
      transactions: [
        income(300_000, { postedDate: may(1) }),
        purchase(10_000, { postedDate: may(12) }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-incomplete',
      filters: { range: MAY },
      expectedNetCents: 10_000,
    },
    {
      name: 'income completeness unconfirmed',
      transactions: [
        income(300_000, { postedDate: may(1) }),
        purchase(10_000, { postedDate: may(12) }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'unconfirmed',
      filters: { range: MAY },
      expectedNetCents: 10_000,
    },
    {
      name: 'income row carrying the user-exclusion flag',
      transactions: [
        income(400_000, { postedDate: may(1), excludedFromSpending: true }),
        income(50_000, { postedDate: may(2) }),
        purchase(10_000, { postedDate: may(12) }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 10_000,
    },
    {
      name: 'inclusive first and last dates',
      transactions: [
        purchase(1_111, { postedDate: '2026-05-01' }),
        purchase(2_222, { postedDate: '2026-05-31' }),
        purchase(9_999, { postedDate: '2026-04-30' }),
        purchase(8_888, { postedDate: '2026-06-01' }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 1_111 + 2_222,
    },
    {
      name: 'account filter',
      transactions: [
        purchase(3_000, { postedDate: may(4), accountId: 'acct-checking' }),
        purchase(5_000, { postedDate: may(5), accountId: 'acct-card' }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY, accountIds: ['acct-checking'] },
      expectedNetCents: 3_000,
    },
    {
      name: 'category filter',
      transactions: [
        purchase(3_000, { postedDate: may(4), categoryId: 'groceries' }),
        purchase(5_000, { postedDate: may(5), categoryId: 'dining' }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY, categoryIds: ['dining'] },
      expectedNetCents: 5_000,
    },
    {
      name: 'combined account and category filters',
      transactions: [
        purchase(3_000, { postedDate: may(4), accountId: 'acct-checking', categoryId: 'dining' }),
        purchase(5_000, { postedDate: may(5), accountId: 'acct-card', categoryId: 'dining' }),
        purchase(7_000, {
          postedDate: may(6),
          accountId: 'acct-checking',
          categoryId: 'groceries',
        }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY, accountIds: ['acct-checking'], categoryIds: ['dining'] },
      expectedNetCents: 3_000,
    },
    {
      name: 'zero-value transactions',
      transactions: [
        purchase(0, { postedDate: may(3) }),
        refund(0, { postedDate: may(4) }),
        purchase(1_500, { postedDate: may(5) }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 1_500,
    },
    {
      name: 'cent-level values that do not divide evenly',
      transactions: [
        purchase(1, { postedDate: may(2), categoryId: 'groceries' }),
        purchase(2, { postedDate: may(3), categoryId: 'dining' }),
        purchase(3, { postedDate: may(4), categoryId: 'travel' }),
        refund(1, { postedDate: may(5), categoryId: 'travel' }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 1 + 2 + 3 - 1,
    },
    {
      name: 'partial current month',
      transactions: [purchase(6_000, { postedDate: may(20) })],
      coverage: COVERAGE_PARTIAL_MAY,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 6_000,
    },
    {
      name: 'incomplete immediately preceding month',
      transactions: [
        purchase(6_000, { postedDate: may(20) }),
        purchase(4_000, { postedDate: '2026-04-15' }),
      ],
      coverage: COVERAGE_PRIOR_INCOMPLETE,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 6_000,
    },
    {
      name: 'missing statement range',
      transactions: [purchase(6_000, { postedDate: may(20) })],
      coverage: COVERAGE_MISSING,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 6_000,
    },
    {
      name: 'malformed statement range',
      transactions: [purchase(6_000, { postedDate: may(20) })],
      coverage: COVERAGE_MALFORMED,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 6_000,
    },
    {
      name: 'leap day spending',
      transactions: [
        purchase(2_900, { postedDate: '2028-02-29' }),
        purchase(100, { postedDate: '2028-02-01' }),
      ],
      coverage: COVERAGE_LEAP,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: { start: '2028-02-01', end: '2028-02-29' } },
      expectedNetCents: 3_000,
    },
    {
      name: 'cross-year range',
      transactions: [
        purchase(11_000, { postedDate: '2026-12-31' }),
        purchase(22_000, { postedDate: '2027-01-01' }),
      ],
      coverage: COVERAGE_CROSS_YEAR,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: { start: '2026-12-01', end: '2027-01-31' } },
      expectedNetCents: 33_000,
    },
    {
      name: 'multi-account multi-category month',
      transactions: [
        purchase(1_000, {
          postedDate: may(2),
          accountId: 'acct-checking',
          categoryId: 'groceries',
        }),
        purchase(2_000, { postedDate: may(9), accountId: 'acct-card', categoryId: 'dining' }),
        purchase(3_000, { postedDate: may(16), accountId: 'acct-card', categoryId: 'groceries' }),
        refund(500, { postedDate: may(23), accountId: 'acct-card', categoryId: 'dining' }),
        transfer(9_000, { postedDate: may(24), accountId: 'acct-savings' }),
        unknownDebit(700, { postedDate: may(25), accountId: 'acct-checking' }),
      ],
      coverage: COVERAGE_TWO_MONTHS,
      incomeCompleteness: 'confirmed-complete',
      filters: { range: MAY },
      expectedNetCents: 1_000 + 2_000 + 3_000 - 500,
    },
  ]);
}

/** Filter variants applied to every scenario in the reconciliation sweep. */
export function filterVariants(base: DashboardFilters): DashboardFilters[] {
  return [
    base,
    { ...base, accountIds: ['acct-checking'] },
    { ...base, accountIds: ['acct-card'] },
    { ...base, categoryIds: ['groceries'] },
    { ...base, categoryIds: ['dining', 'groceries'] },
    { ...base, accountIds: ['acct-checking'], categoryIds: ['groceries'] },
    // An account nobody transacted on: the empty-population path under a filter.
    { ...base, accountIds: ['acct-nonexistent'] },
  ];
}

/**
 * Deterministic shuffle.
 *
 * Seeded rather than random so a failure reproduces. Used to prove that selector
 * output does not depend on input ordering.
 */
export function shuffle<T>(items: readonly T[], seed = 7): T[] {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}
