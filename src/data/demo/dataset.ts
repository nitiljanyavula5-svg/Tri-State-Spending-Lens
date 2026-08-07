import type {
  Account,
  BudgetCategoryTarget,
  BudgetPlan,
  ImportSession,
  IsoDate,
  IsoMonth,
  MerchantRule,
  RecurringSeries,
  Transaction,
  TransactionKind,
  UserEdit,
} from '../../types/domain';
import type { WorkspaceSnapshot } from '../../db/workspace';
import { getCategory } from '../../domain/categories';
import { SETTING_KEYS } from '../../db/repositories/settings';

/**
 * The fictional demo workspace.
 *
 * product-spec.md §8.1: demo mode uses obviously fictional, realistic
 * transactions spanning at least four complete months, supports every core
 * feature, and can be restored by "Reset demo".
 *
 * EVERYTHING HERE IS INVENTED. No real bank, merchant, employer, person, or
 * account appears. The merchant vocabulary is shared with the Phase 0 fixtures
 * on purpose, so demo data and fixture data describe one fictional world.
 *
 * DETERMINISM: the same seed produces byte-identical output on every machine,
 * every time. There is no `Math.random()` and no `Date.now()` — "Reset demo"
 * must restore *the original* dataset, which is only meaningful if the dataset
 * is reproducible.
 */

export const DEMO_SEED_VERSION = 1;
export const DEMO_SEED = 20260801;

/**
 * Demo rows are written under one well-known import session so that removing
 * them reuses the rule already specified for rollback — "removes only that
 * session's transactions" (data-methodology.md §2.2) — instead of inventing a
 * second deletion path that could drift from it.
 */
export const DEMO_IMPORT_SESSION_ID = 'demo-seed-session';

/** Four complete calendar months. */
export const DEMO_RANGE: { start: IsoDate; end: IsoDate } = {
  start: '2026-04-01',
  end: '2026-07-31',
};

export const DEMO_MONTHS: readonly IsoMonth[] = ['2026-04', '2026-05', '2026-06', '2026-07'];

/** Fixed so record bookkeeping stays deterministic. */
const DEMO_TIMESTAMP = '2026-08-01T00:00:00.000Z';

export const DEMO_ACCOUNTS: readonly Account[] = [
  {
    id: 'demo-account-checking',
    label: 'Everyday Checking (demo)',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  {
    id: 'demo-account-card',
    label: 'Rewards Card (demo)',
    type: 'credit_card',
    currency: 'USD',
    archived: false,
  },
] as const;

const CHECKING = DEMO_ACCOUNTS[0]!.id;
const CARD = DEMO_ACCOUNTS[1]!.id;

/* ----------------------------------------------------------- determinism - */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(year: number, month: number, day: number): IsoDate {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/* -------------------------------------------------------------- merchants - */

interface DemoMerchant {
  readonly name: string;
  readonly categoryId: string;
  readonly account: string;
  readonly minCents: number;
  readonly maxCents: number;
  /** Roughly how many times a month this merchant appears. */
  readonly perMonth: number;
}

const EVERYDAY_MERCHANTS: readonly DemoMerchant[] = [
  {
    name: 'PINEBROOK MARKET',
    categoryId: 'groceries',
    account: CHECKING,
    minCents: 2400,
    maxCents: 9200,
    perMonth: 4,
  },
  {
    name: 'GREENLEAF GROCERS',
    categoryId: 'groceries',
    account: CARD,
    minCents: 1800,
    maxCents: 7400,
    perMonth: 2,
  },
  {
    name: 'HARBOR BEAN COFFEE #114',
    categoryId: 'dining',
    account: CARD,
    minCents: 375,
    maxCents: 875,
    perMonth: 6,
  },
  {
    name: 'BAYSIDE DELI',
    categoryId: 'dining',
    account: CARD,
    minCents: 900,
    maxCents: 2400,
    perMonth: 3,
  },
  {
    name: 'NOODLE POINT KITCHEN',
    categoryId: 'dining',
    account: CARD,
    minCents: 1400,
    maxCents: 3600,
    perMonth: 2,
  },
  {
    name: 'RIVERLINE TRANSIT FARE',
    categoryId: 'transportation',
    account: CARD,
    minCents: 290,
    maxCents: 290,
    perMonth: 8,
  },
  {
    name: 'EASTGATE FUEL STOP',
    categoryId: 'transportation',
    account: CARD,
    minCents: 2600,
    maxCents: 5800,
    perMonth: 1,
  },
  {
    name: 'QUILL AND PAGE BOOKS',
    categoryId: 'shopping',
    account: CARD,
    minCents: 1200,
    maxCents: 4800,
    perMonth: 1,
  },
  {
    name: 'CEDAR GROVE PHARMACY',
    categoryId: 'health',
    account: CARD,
    minCents: 800,
    maxCents: 4200,
    perMonth: 1,
  },
  {
    name: 'ORPHEUM CINEMA HOUSE',
    categoryId: 'entertainment',
    account: CARD,
    minCents: 1400,
    maxCents: 3200,
    perMonth: 1,
  },
  {
    name: 'LUMEN SKIN STUDIO',
    categoryId: 'personal_care',
    account: CARD,
    minCents: 1900,
    maxCents: 5200,
    perMonth: 1,
  },
] as const;

/* ------------------------------------------------------------ transactions - */

interface Draft {
  date: IsoDate;
  accountId: string;
  description: string;
  merchant: string;
  amountCents: number;
  direction: 'debit' | 'credit';
  kind: TransactionKind;
  categoryId: string;
  /** Left unset for rows the demo deliberately leaves unreviewed. */
  classify: boolean;
}

function amountBetween(rand: () => number, min: number, max: number): number {
  return min === max ? min : min + Math.floor(rand() * (max - min + 1));
}

function buildDrafts(): Draft[] {
  const rand = mulberry32(DEMO_SEED);
  const drafts: Draft[] = [];

  const push = (draft: Draft) => drafts.push(draft);

  for (const month of DEMO_MONTHS) {
    const [year, monthNumber] = month.split('-').map(Number) as [number, number];
    const lastDay = daysInMonth(year, monthNumber);
    const on = (day: number) => isoDate(year, monthNumber, Math.min(day, lastDay));

    // Housing — a single fixed obligation.
    push({
      date: on(1),
      accountId: CHECKING,
      description: 'OAKMONT RENTALS RENT',
      merchant: 'OAKMONT RENTALS',
      amountCents: 95_000,
      direction: 'debit',
      kind: 'purchase',
      categoryId: 'housing',
      classify: true,
    });

    // Income — semimonthly payroll, already reviewed in this workspace.
    for (const day of [1, 15]) {
      push({
        date: on(day),
        accountId: CHECKING,
        description: 'PAYROLL DEPOSIT NORTHGATE LABS',
        merchant: 'NORTHGATE LABS',
        amountCents: 145_000,
        direction: 'credit',
        kind: 'income',
        categoryId: 'other',
        classify: false,
      });
    }

    // Subscriptions. STREAMLY rises in July, so the Phase 6 price-change flag
    // has something real to find.
    push({
      date: on(12),
      accountId: CARD,
      description: 'STREAMLY MEDIA MONTHLY',
      merchant: 'STREAMLY MEDIA',
      amountCents: month === '2026-07' ? 1_399 : 1_199,
      direction: 'debit',
      kind: 'purchase',
      categoryId: 'subscriptions_memberships',
      classify: true,
    });
    push({
      date: on(5),
      accountId: CARD,
      description: 'ATLAS FITNESS CLUB',
      merchant: 'ATLAS FITNESS CLUB',
      amountCents: 2_999,
      direction: 'debit',
      kind: 'purchase',
      categoryId: 'subscriptions_memberships',
      classify: true,
    });

    // Utilities — a genuinely variable recurring amount.
    push({
      date: on(9),
      accountId: CHECKING,
      description: 'NORTHFIELD UTILITIES',
      merchant: 'NORTHFIELD UTILITIES',
      amountCents: amountBetween(rand, 6_500, 12_500),
      direction: 'debit',
      kind: 'purchase',
      categoryId: 'utilities_bills',
      classify: true,
    });
    push({
      date: on(18),
      accountId: CHECKING,
      description: 'LINKWAVE INTERNET',
      merchant: 'LINKWAVE INTERNET',
      amountCents: 7_999,
      direction: 'debit',
      kind: 'purchase',
      categoryId: 'utilities_bills',
      classify: true,
    });

    // Money movement — must never reach net spending.
    push({
      date: on(3),
      accountId: CHECKING,
      description: 'TRANSFER TO SAVINGS',
      merchant: 'TRANSFER TO SAVINGS',
      amountCents: 20_000,
      direction: 'debit',
      kind: 'transfer',
      categoryId: 'other',
      classify: false,
    });

    const paymentCents = amountBetween(rand, 22_000, 41_000);
    push({
      date: on(20),
      accountId: CHECKING,
      description: 'PAYMENT TO REWARDS CARD',
      merchant: 'REWARDS CARD PAYMENT',
      amountCents: paymentCents,
      direction: 'debit',
      kind: 'payment',
      categoryId: 'other',
      classify: false,
    });
    push({
      date: on(20),
      accountId: CARD,
      description: 'PAYMENT RECEIVED - THANK YOU',
      merchant: 'REWARDS CARD PAYMENT',
      amountCents: paymentCents,
      direction: 'credit',
      kind: 'payment',
      categoryId: 'other',
      classify: false,
    });

    // Fee and cash withdrawal — both count toward net spending.
    push({
      date: on(26),
      accountId: CHECKING,
      description: 'MONTHLY SERVICE FEE',
      merchant: 'MONTHLY SERVICE FEE',
      amountCents: 500,
      direction: 'debit',
      kind: 'fee',
      categoryId: 'fees_interest',
      classify: true,
    });
    push({
      date: on(24),
      accountId: CHECKING,
      description: 'ATM WITHDRAWAL MAIN ST',
      merchant: 'ATM WITHDRAWAL',
      amountCents: 6_000,
      direction: 'debit',
      kind: 'cash_withdrawal',
      categoryId: 'cash_atm',
      classify: true,
    });

    // Everyday spending, spread deterministically across the month.
    for (const merchant of EVERYDAY_MERCHANTS) {
      for (let occurrence = 0; occurrence < merchant.perMonth; occurrence += 1) {
        const day = 2 + Math.floor(rand() * (lastDay - 2));
        push({
          date: on(day),
          accountId: merchant.account,
          description: merchant.name,
          merchant: merchant.name,
          amountCents: amountBetween(rand, merchant.minCents, merchant.maxCents),
          direction: 'debit',
          kind: 'purchase',
          categoryId: merchant.categoryId,
          classify: true,
        });
      }
    }
  }

  // Two refunds, one of them crossing a month boundary so the Phase 5
  // cross-period rule (calculation-contract.md §5.3) has a real case.
  push({
    date: '2026-05-14',
    accountId: CARD,
    description: 'QUILL AND PAGE BOOKS',
    merchant: 'QUILL AND PAGE BOOKS',
    amountCents: 2_400,
    direction: 'credit',
    kind: 'refund',
    categoryId: 'shopping',
    classify: true,
  });
  push({
    date: '2026-07-02',
    accountId: CARD,
    description: 'GREENLEAF GROCERS',
    merchant: 'GREENLEAF GROCERS',
    amountCents: 1_850,
    direction: 'credit',
    kind: 'refund',
    categoryId: 'groceries',
    classify: true,
  });

  // One credit deliberately left unreviewed, so the unreviewed-credits
  // data-quality state (data-methodology.md §6) is reachable in the demo.
  push({
    date: '2026-06-11',
    accountId: CHECKING,
    description: 'ADJUSTMENT CREDIT',
    merchant: 'ADJUSTMENT CREDIT',
    amountCents: 3_250,
    direction: 'credit',
    kind: 'unknown',
    categoryId: 'other',
    classify: false,
  });

  return drafts.sort(
    (a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description),
  );
}

/**
 * A deterministic stand-in for the real content fingerprint.
 *
 * data-methodology.md §4.2 specifies `SHA-256(fingerprintVersion ‖ accountId ‖
 * postedDate ‖ direction ‖ amountCents ‖ descriptionCanonical)`. That hash is
 * asynchronous and belongs with duplicate detection, which is Phase 3 work, so
 * demo rows carry a clearly-marked deterministic placeholder built from exactly
 * the same components and in the same order. Phase 3 replaces this with the
 * real digest.
 */
function demoFingerprint(draft: Draft): string {
  const canonical = draft.description.trim().replace(/\s+/g, ' ').toUpperCase();
  return [
    'demo-fp-v1',
    draft.accountId,
    draft.date,
    draft.direction,
    String(draft.amountCents),
    canonical,
  ].join('|');
}

function toTransaction(draft: Draft, index: number): Transaction {
  const category = draft.classify ? getCategory(draft.categoryId) : undefined;

  return {
    id: `demo-txn-${String(index + 1).padStart(4, '0')}`,
    fingerprint: demoFingerprint(draft),
    importSessionId: DEMO_IMPORT_SESSION_ID,
    originalRow: index + 2, // +2: row 1 is the header in the source this imitates.
    accountId: draft.accountId,
    postedDate: draft.date,
    descriptionRaw: draft.description,
    merchantNormalized: draft.merchant,
    amountCents: draft.amountCents,
    direction: draft.direction,
    kind: draft.kind,
    categoryId: draft.categoryId,
    categorySource: draft.classify ? 'merchant_rule' : 'uncategorized',
    classificationConfidence: draft.classify ? 'high' : 'none',
    ...(category
      ? { essentiality: category.defaultEssentiality, variability: category.defaultVariability }
      : {}),
    tags: [],
    excludedFromSpending: false,
    createdAt: DEMO_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  };
}

/* ------------------------------------------------------------- budgets - */

const CATEGORY_LIMITS: readonly (readonly [string, number])[] = [
  ['housing', 95_000],
  ['groceries', 42_000],
  ['dining', 18_000],
  ['transportation', 12_000],
  ['utilities_bills', 20_000],
  ['subscriptions_memberships', 5_000],
  ['shopping', 10_000],
] as const;

function buildBudgets(): { plans: BudgetPlan[]; targets: BudgetCategoryTarget[] } {
  const plans: BudgetPlan[] = [];
  const targets: BudgetCategoryTarget[] = [];

  DEMO_MONTHS.forEach((month, index) => {
    const planId = `demo-budget-${month}`;
    plans.push({
      id: planId,
      month,
      overallLimitCents: 210_000,
      incomeTargetCents: 290_000,
      savingsTargetCents: 40_000,
      // Provenance only — copied plans are independent records
      // (product-spec.md §10.3).
      ...(index > 0 ? { copiedFromMonth: DEMO_MONTHS[index - 1]! } : {}),
      rolloverEnabled: false,
    });

    for (const [categoryId, limitCents] of CATEGORY_LIMITS) {
      targets.push({
        id: `demo-target-${month}-${categoryId}`,
        budgetPlanId: planId,
        categoryId,
        limitCents,
      });
    }
  });

  return { plans, targets };
}

/* ----------------------------------------------------------- recurring - */

function buildRecurringSeries(transactions: Transaction[]): RecurringSeries[] {
  const idsFor = (merchant: string) =>
    transactions.filter((t) => t.merchantNormalized === merchant).map((t) => t.id);

  const lastDateFor = (merchant: string): IsoDate => {
    const dates = transactions
      .filter((t) => t.merchantNormalized === merchant)
      .map((t) => t.postedDate)
      .sort();
    return dates[dates.length - 1] ?? DEMO_RANGE.end;
  };

  const series: RecurringSeries[] = [
    {
      id: 'demo-recurring-rent',
      merchantNormalized: 'OAKMONT RENTALS',
      categoryId: 'housing',
      cadence: 'monthly',
      typicalAmountCents: 95_000,
      amountMinCents: 95_000,
      amountMaxCents: 95_000,
      lastChargeDate: lastDateFor('OAKMONT RENTALS'),
      expectedNextDate: '2026-08-01',
      occurrenceCount: 4,
      confidence: 'high',
      confidenceReasons: [
        'Four charges at the same merchant',
        'Consistent monthly interval',
        'Identical amount every time',
      ],
      userStatus: 'confirmed',
      excludedFromRecurringTotals: false,
      transactionIds: idsFor('OAKMONT RENTALS'),
      detectedAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
    },
    {
      id: 'demo-recurring-streamly',
      merchantNormalized: 'STREAMLY MEDIA',
      categoryId: 'subscriptions_memberships',
      cadence: 'monthly',
      typicalAmountCents: 1_199,
      amountMinCents: 1_199,
      amountMaxCents: 1_399,
      lastChargeDate: lastDateFor('STREAMLY MEDIA'),
      expectedNextDate: '2026-08-12',
      occurrenceCount: 4,
      confidence: 'high',
      confidenceReasons: [
        'Four charges at the same merchant',
        'Consistent monthly interval',
        'Most recent charge is higher than the previous three',
      ],
      priceChange: {
        previousAmountCents: 1_199,
        previousDate: '2026-06-12',
        currentAmountCents: 1_399,
        currentDate: '2026-07-12',
      },
      userStatus: 'unreviewed',
      excludedFromRecurringTotals: false,
      transactionIds: idsFor('STREAMLY MEDIA'),
      detectedAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
    },
    {
      id: 'demo-recurring-fitness',
      merchantNormalized: 'ATLAS FITNESS CLUB',
      categoryId: 'subscriptions_memberships',
      cadence: 'monthly',
      typicalAmountCents: 2_999,
      amountMinCents: 2_999,
      amountMaxCents: 2_999,
      lastChargeDate: lastDateFor('ATLAS FITNESS CLUB'),
      expectedNextDate: '2026-08-05',
      occurrenceCount: 4,
      confidence: 'high',
      confidenceReasons: ['Four charges at the same merchant', 'Identical amount every time'],
      userStatus: 'confirmed',
      excludedFromRecurringTotals: false,
      transactionIds: idsFor('ATLAS FITNESS CLUB'),
      detectedAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
    },
    {
      id: 'demo-recurring-utilities',
      merchantNormalized: 'NORTHFIELD UTILITIES',
      categoryId: 'utilities_bills',
      cadence: 'monthly',
      typicalAmountCents: 9_500,
      amountMinCents: 6_500,
      amountMaxCents: 12_500,
      lastChargeDate: lastDateFor('NORTHFIELD UTILITIES'),
      expectedNextDate: '2026-08-09',
      occurrenceCount: 4,
      // A genuinely variable bill: recurring, but not to the same amount.
      confidence: 'medium',
      confidenceReasons: [
        'Four charges at the same merchant',
        'Consistent monthly interval',
        'Amount varies beyond the usual tolerance',
      ],
      userStatus: 'unreviewed',
      excludedFromRecurringTotals: false,
      transactionIds: idsFor('NORTHFIELD UTILITIES'),
      detectedAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
    },
    {
      id: 'demo-recurring-internet',
      merchantNormalized: 'LINKWAVE INTERNET',
      categoryId: 'utilities_bills',
      cadence: 'monthly',
      typicalAmountCents: 7_999,
      amountMinCents: 7_999,
      amountMaxCents: 7_999,
      lastChargeDate: lastDateFor('LINKWAVE INTERNET'),
      expectedNextDate: '2026-08-18',
      occurrenceCount: 4,
      confidence: 'high',
      confidenceReasons: ['Four charges at the same merchant', 'Identical amount every time'],
      userStatus: 'confirmed',
      excludedFromRecurringTotals: false,
      transactionIds: idsFor('LINKWAVE INTERNET'),
      detectedAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
    },
  ];

  return series;
}

/* ---------------------------------------------------------------- build - */

const DEMO_MERCHANT_RULES: readonly MerchantRule[] = [
  {
    id: 'demo-rule-transit',
    matchType: 'starts_with',
    pattern: 'RIVERLINE TRANSIT',
    normalizedMerchant: 'RIVERLINE TRANSIT FARE',
    categoryId: 'transportation',
    priority: 10,
    createdByUser: true,
  },
] as const;

const DEMO_USER_EDITS: readonly UserEdit[] = [
  {
    id: 'demo-edit-0001',
    entityType: 'recurring_series',
    entityId: 'demo-recurring-rent',
    field: 'userStatus',
    previousValue: 'unreviewed',
    nextValue: 'confirmed',
    editedAt: DEMO_TIMESTAMP,
  },
] as const;

/**
 * Builds the complete demo workspace. Pure: no database access, no clock, no
 * randomness beyond the fixed seed.
 */
export function buildDemoWorkspace(): WorkspaceSnapshot {
  const drafts = buildDrafts();
  const transactions = drafts.map(toTransaction);
  const { plans, targets } = buildBudgets();

  const session: ImportSession = {
    id: DEMO_IMPORT_SESSION_ID,
    importedAt: DEMO_TIMESTAMP,
    sourceFileNames: ['demo-workspace (fictional)'],
    accountIds: DEMO_ACCOUNTS.map((account) => account.id),
    mappingVersion: 1,
    rowCount: transactions.length,
    acceptedCount: transactions.length,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
    // Month completeness comes from the statement range, not from the observed
    // transaction dates (data-methodology.md §6).
    statementRangeStart: DEMO_RANGE.start,
    statementRangeEnd: DEMO_RANGE.end,
  };

  return {
    accounts: [...DEMO_ACCOUNTS],
    importSessions: [session],
    transactions,
    merchantRules: [...DEMO_MERCHANT_RULES],
    budgetPlans: plans,
    budgetCategoryTargets: targets,
    recurringSeries: buildRecurringSeries(transactions),
    userEdits: [...DEMO_USER_EDITS],
    appSettings: [
      { key: SETTING_KEYS.workspaceMode, value: 'demo', updatedAt: DEMO_TIMESTAMP },
      { key: SETTING_KEYS.demoSeedVersion, value: DEMO_SEED_VERSION, updatedAt: DEMO_TIMESTAMP },
      { key: SETTING_KEYS.homeState, value: 'NJ', updatedAt: DEMO_TIMESTAMP },
      { key: SETTING_KEYS.weekStart, value: 'sunday', updatedAt: DEMO_TIMESTAMP },
      { key: SETTING_KEYS.incomeDataComplete, value: true, updatedAt: DEMO_TIMESTAMP },
    ],
    // The demo ships no saved column mappings. A preset describes how to read a
    // real bank's export, and inventing one would suggest the demo data came
    // from a file the user could recognize — it did not.
    mappingPresets: [],
  };
}
