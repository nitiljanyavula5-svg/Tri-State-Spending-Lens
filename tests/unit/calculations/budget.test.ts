import { describe, expect, it } from 'vitest';
import {
  selectBudgetProgress,
  selectDashboard,
  type AccountScope,
  type BudgetCategoryTargetInput,
  type BudgetInput,
  type BudgetPlanInput,
  type IncomeCompleteness,
  type SelectableTransaction,
  type StatementRange,
} from '../../../src/calculations';
import {
  ACCOUNTS,
  CARD,
  CHECKING,
  cardPayment,
  cashOut,
  fee,
  income,
  purchase,
  range,
  rangesForAll,
  refund,
  resetIds,
  transfer,
  tx,
  unknownCredit,
} from './fixtures';

/**
 * The Phase 6A budget selector.
 *
 * Budgeting adds a limit beside figures Phase 5 already computes; it does not
 * add a second way to compute them. Most of what is asserted here is therefore
 * about *composition*: that a transfer is still excluded, that a refund still
 * reduces the total, that an archived account still contributes nothing — and
 * that a limit placed next to those figures behaves exactly as the contract
 * says, including at the awkward values (zero, negative, exactly equal).
 */

const MAY = '2026-05';
const MID_MAY = '2026-05-15';

/** Statement coverage for all three fixture accounts across April and May. */
const COVERED = rangesForAll('2026-04-01', '2026-05-31');

function build(overrides: Partial<BudgetInput> = {}): BudgetInput {
  return {
    month: MAY,
    plan: null,
    categoryTargets: [],
    transactions: [],
    accounts: ACCOUNTS,
    coverage: COVERED,
    incomeCompleteness: 'confirmed-complete',
    // A day inside May, so the default scenario is a current month.
    today: MID_MAY,
    ...overrides,
  };
}

function plan(overrides: Partial<BudgetPlanInput> = {}): BudgetPlanInput {
  return { month: MAY, ...overrides };
}

const inMay = (overrides = {}) => ({ postedDate: '2026-05-10', ...overrides });

describe('no plan', () => {
  it('reports every plan-dependent figure as unavailable, and none as zero', () => {
    resetIds();
    const result = selectBudgetProgress(build({ transactions: [purchase(5_000, inMay())] }));

    expect(result.hasPlan).toBe(false);
    expect(result.limitCents).toEqual({ available: false, reason: 'no-budget-plan' });
    expect(result.remainingCents).toEqual({ available: false, reason: 'no-budget-plan' });
    expect(result.usedRatio).toEqual({ available: false, reason: 'no-budget-plan' });
    expect(result.status).toBe('no-limit');
    // Spending is still a fact, plan or no plan.
    expect(result.actualCents).toBe(5_000);
  });
});

describe('the overall limit', () => {
  const withLimit = (limitCents: number, transactions: SelectableTransaction[]) =>
    selectBudgetProgress(build({ plan: plan({ overallLimitCents: limitCents }), transactions }));

  it('reports the full limit remaining when nothing was spent', () => {
    resetIds();
    const result = withLimit(50_000, []);
    expect(result.actualCents).toBe(0);
    expect(result.remainingCents).toEqual({ available: true, value: 50_000 });
    expect(result.usedRatio).toEqual({ available: true, value: 0 });
    expect(result.status).toBe('under');
  });

  it('is under when spending is below the limit', () => {
    resetIds();
    const result = withLimit(50_000, [purchase(20_000, inMay())]);
    expect(result.remainingCents).toEqual({ available: true, value: 30_000 });
    expect(result.usedRatio).toEqual({ available: true, value: 0.4 });
    expect(result.status).toBe('under');
  });

  it('is at plan when spending exactly equals the limit', () => {
    resetIds();
    const result = withLimit(20_000, [purchase(20_000, inMay())]);
    expect(result.remainingCents).toEqual({ available: true, value: 0 });
    expect(result.usedRatio).toEqual({ available: true, value: 1 });
    expect(result.status).toBe('at');
  });

  it('goes negative rather than clamping when spending exceeds the limit', () => {
    resetIds();
    const result = withLimit(20_000, [purchase(32_500, inMay())]);
    expect(result.remainingCents).toEqual({ available: true, value: -12_500 });
    expect(result.usedRatio).toEqual({ available: true, value: 1.625 });
    expect(result.status).toBe('over');
  });

  it('lets refunds reduce the actual, and remaining exceed the limit', () => {
    resetIds();
    const result = withLimit(20_000, [
      purchase(10_000, inMay()),
      refund(4_000, inMay({ categoryId: 'groceries' })),
    ]);
    expect(result.grossOutflowCents).toBe(10_000);
    expect(result.refundsCents).toBe(4_000);
    expect(result.actualCents).toBe(6_000);
    expect(result.remainingCents).toEqual({ available: true, value: 14_000 });
  });

  it('allows a net-negative month, with remaining above the limit', () => {
    resetIds();
    const result = withLimit(20_000, [
      purchase(3_000, inMay()),
      refund(11_000, inMay({ categoryId: 'groceries' })),
    ]);
    expect(result.actualCents).toBe(-8_000);
    expect(result.remainingCents).toEqual({ available: true, value: 28_000 });
    expect(result.usedRatio).toEqual({ available: true, value: -0.4 });
    expect(result.status).toBe('under');
  });

  it('computes remaining for a zero-dollar limit but withholds the ratio', () => {
    resetIds();
    const result = withLimit(0, [purchase(2_500, inMay())]);
    expect(result.remainingCents).toEqual({ available: true, value: -2_500 });
    // Never NaN, never Infinity, never 0%.
    expect(result.usedRatio).toEqual({ available: false, reason: 'not-applicable' });
    expect(result.status).toBe('over');
  });
});

describe('which rows count', () => {
  const actualOf = (transactions: SelectableTransaction[], accounts = ACCOUNTS) =>
    selectBudgetProgress(build({ transactions, accounts })).actualCents;

  it('excludes transfers', () => {
    resetIds();
    expect(actualOf([purchase(1_000, inMay()), transfer(90_000, inMay())])).toBe(1_000);
  });

  it('excludes card payments', () => {
    resetIds();
    expect(actualOf([purchase(1_000, inMay()), cardPayment(90_000, inMay())])).toBe(1_000);
  });

  it('excludes rows the user excluded', () => {
    resetIds();
    expect(
      actualOf([purchase(1_000, inMay()), purchase(90_000, inMay({ excludedFromSpending: true }))]),
    ).toBe(1_000);
  });

  it('excludes rows awaiting review', () => {
    resetIds();
    expect(actualOf([purchase(1_000, inMay()), unknownCredit(90_000, inMay())])).toBe(1_000);
  });

  it('excludes an archived account entirely', () => {
    resetIds();
    const accounts: AccountScope[] = [
      { id: CHECKING, archived: false },
      { id: CARD, archived: true },
    ];
    const result = selectBudgetProgress(
      build({
        accounts,
        transactions: [
          purchase(1_000, inMay({ accountId: CHECKING })),
          purchase(90_000, inMay({ accountId: CARD })),
        ],
      }),
    );
    expect(result.actualCents).toBe(1_000);
    expect(result.scope).toEqual([CHECKING]);
  });

  it('combines every active account', () => {
    resetIds();
    expect(
      actualOf([
        purchase(1_000, inMay({ accountId: CHECKING })),
        purchase(2_000, inMay({ accountId: CARD })),
        fee(500, inMay({ accountId: CHECKING })),
        cashOut(1_500, inMay({ accountId: CARD })),
      ]),
    ).toBe(5_000);
  });

  it('counts only the named month', () => {
    resetIds();
    expect(
      actualOf([
        purchase(1_000, inMay()),
        purchase(70_000, { postedDate: '2026-04-30' }),
        purchase(80_000, { postedDate: '2026-06-01' }),
      ]),
    ).toBe(1_000);
  });
});

describe('category targets', () => {
  const targets: BudgetCategoryTargetInput[] = [
    { categoryId: 'groceries', limitCents: 30_000 },
    { categoryId: 'dining', limitCents: 10_000 },
    { categoryId: 'transportation', limitCents: 5_000 },
  ];

  it('reports under, at, and over per category', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        plan: plan({ overallLimitCents: 100_000 }),
        categoryTargets: targets,
        transactions: [
          purchase(12_000, inMay({ categoryId: 'groceries' })),
          purchase(10_000, inMay({ categoryId: 'dining' })),
          purchase(8_000, inMay({ categoryId: 'transportation' })),
        ],
      }),
    );

    expect(result.categories.map((entry) => [entry.categoryId, entry.status])).toEqual([
      ['groceries', 'under'],
      ['dining', 'at'],
      ['transportation', 'over'],
    ]);
    expect(result.categories[0]?.remainingCents).toBe(18_000);
    expect(result.categories[2]?.remainingCents).toBe(-3_000);
  });

  it('sorts by the permanent domain order, not by insertion or locale', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        categoryTargets: [
          { categoryId: 'travel', limitCents: 100 },
          { categoryId: 'groceries', limitCents: 100 },
          { categoryId: 'housing', limitCents: 100 },
          { categoryId: 'dining', limitCents: 100 },
        ],
      }),
    );
    // Domain order is housing, utilities, groceries, dining, … travel.
    expect(result.categories.map((entry) => entry.categoryId)).toEqual([
      'housing',
      'groceries',
      'dining',
      'travel',
    ]);
  });

  it('keeps untargeted spending inside the overall actual and names it', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        plan: plan({ overallLimitCents: 100_000 }),
        categoryTargets: [{ categoryId: 'groceries', limitCents: 30_000 }],
        transactions: [
          purchase(12_000, inMay({ categoryId: 'groceries' })),
          purchase(7_000, inMay({ categoryId: 'travel' })),
        ],
      }),
    );
    expect(result.actualCents).toBe(19_000);
    expect(result.untargetedSpendCents).toBe(7_000);
    // The untargeted category never becomes a phantom target.
    expect(result.categories).toHaveLength(1);
  });

  it('keeps a targeted category visible at zero spent', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({ categoryTargets: [{ categoryId: 'health', limitCents: 4_000 }] }),
    );
    expect(result.categories[0]).toMatchObject({
      categoryId: 'health',
      spentCents: 0,
      remainingCents: 4_000,
      status: 'under',
    });
  });

  it('warns, without rewriting either value, when targets exceed the overall limit', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({ plan: plan({ overallLimitCents: 20_000 }), categoryTargets: targets }),
    );
    expect(result.categoryTargetTotalCents).toBe(45_000);
    expect(result.warnings).toContain('category-targets-exceed-overall-limit');
    expect(result.limitCents).toEqual({ available: true, value: 20_000 });
  });
});

describe('planned margin and savings target', () => {
  it('is income target minus spending limit', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({ plan: plan({ overallLimitCents: 300_000, incomeTargetCents: 450_000 }) }),
    );
    expect(result.plannedMarginCents).toEqual({ available: true, value: 150_000 });
  });

  it('may be negative', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({ plan: plan({ overallLimitCents: 500_000, incomeTargetCents: 450_000 }) }),
    );
    expect(result.plannedMarginCents).toEqual({ available: true, value: -50_000 });
  });

  it('is unavailable without both inputs', () => {
    resetIds();
    expect(
      selectBudgetProgress(build({ plan: plan({ incomeTargetCents: 450_000 }) }))
        .plannedMarginCents,
    ).toEqual({ available: false, reason: 'not-applicable' });
  });

  it('warns only when the savings target is above the planned margin', () => {
    resetIds();
    const base = { overallLimitCents: 300_000, incomeTargetCents: 450_000 };

    const below = selectBudgetProgress(
      build({ plan: plan({ ...base, savingsTargetCents: 100_000 }) }),
    );
    const at = selectBudgetProgress(
      build({ plan: plan({ ...base, savingsTargetCents: 150_000 }) }),
    );
    const above = selectBudgetProgress(
      build({ plan: plan({ ...base, savingsTargetCents: 200_000 }) }),
    );

    expect(below.warnings).not.toContain('savings-target-exceeds-planned-margin');
    expect(at.warnings).not.toContain('savings-target-exceeds-planned-margin');
    expect(above.warnings).toContain('savings-target-exceeds-planned-margin');
    // A warning, not a validation failure: the values are untouched.
    expect(above.savingsTargetCents).toEqual({ available: true, value: 200_000 });
  });
});

describe('the income-completeness gate', () => {
  const withIncome = (completeness: IncomeCompleteness) =>
    selectBudgetProgress(
      build({
        incomeCompleteness: completeness,
        plan: plan({ overallLimitCents: 50_000, savingsTargetCents: 10_000 }),
        transactions: [purchase(20_000, inMay()), income(100_000, inMay())],
      }),
    );

  it('withholds observed income and savings progress when unconfirmed', () => {
    resetIds();
    const result = withIncome('unconfirmed');
    expect(result.observedIncomeCents).toEqual({
      available: false,
      reason: 'income-completeness-unconfirmed',
    });
    expect(result.savingsTargetProgress).toEqual({
      available: false,
      reason: 'income-completeness-unconfirmed',
    });
    // Net spending is never gated by income completeness.
    expect(result.actualCents).toBe(20_000);
  });

  it('withholds them when income is confirmed incomplete', () => {
    resetIds();
    const result = withIncome('confirmed-incomplete');
    expect(result.observedIncomeCents).toEqual({
      available: false,
      reason: 'income-data-incomplete',
    });
    expect(result.savingsTargetProgress).toEqual({
      available: false,
      reason: 'income-data-incomplete',
    });
  });

  it('publishes them when income is confirmed complete', () => {
    resetIds();
    const result = withIncome('confirmed-complete');
    expect(result.observedIncomeCents).toEqual({ available: true, value: 100_000 });
    expect(result.savingsTargetProgress).toEqual({
      available: true,
      value: {
        targetCents: 10_000,
        actualCents: 80_000,
        differenceCents: 70_000,
        meetsTarget: true,
      },
    });
  });
});

describe('period completeness and pace', () => {
  it('labels a current month as to date and projects from covered days', () => {
    resetIds();
    // Fifteen of May's thirty-one days have elapsed, with $310.00 recorded.
    const result = selectBudgetProgress(
      build({
        today: MID_MAY,
        plan: plan({ overallLimitCents: 100_000 }),
        transactions: [purchase(31_000, { postedDate: '2026-05-02' })],
      }),
    );

    expect(result.monthPosition).toBe('current');
    expect(result.pace.available).toBe(true);
    if (!result.pace.available) throw new Error('expected a pace');
    expect(result.pace.value.elapsedDays).toBe(15);
    expect(result.pace.value.totalDays).toBe(31);
    expect(result.pace.value.monthToDateCents).toBe(31_000);
    // round(31000 * 31 / 15) = round(64066.66…) = 64067
    expect(result.pace.value.projectedSpendCents).toBe(64_067);
    expect(result.pace.value.projectedOverUnderCents).toEqual({ available: true, value: 35_933 });
  });

  it('counts the first of the month as one elapsed day', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({ today: '2026-05-01', transactions: [purchase(1_000, { postedDate: '2026-05-01' })] }),
    );
    if (!result.pace.available) throw new Error('expected a pace');
    expect(result.pace.value.elapsedDays).toBe(1);
    expect(result.pace.value.projectedSpendCents).toBe(31_000);
  });

  it('refuses to project when coverage stops before today', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        today: MID_MAY,
        coverage: rangesForAll('2026-05-01', '2026-05-07'),
        transactions: [purchase(31_000, { postedDate: '2026-05-02' })],
      }),
    );
    expect(result.pace).toEqual({ available: false, reason: 'budget-coverage-incomplete' });
  });

  it('refuses to project when an in-scope account has an ambiguous range', () => {
    resetIds();
    const ambiguous: StatementRange[] = [
      { start: '2026-05-01', end: '2026-05-31', accountIds: [CHECKING, CARD] },
    ];
    const result = selectBudgetProgress(
      build({ today: MID_MAY, coverage: ambiguous, transactions: [purchase(31_000, inMay())] }),
    );
    expect(result.pace).toEqual({ available: false, reason: 'budget-coverage-incomplete' });
    expect(result.monthComplete).toBe(false);
  });

  it('reports a finished, fully covered month as final with no projection', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        today: '2026-06-10',
        plan: plan({ overallLimitCents: 100_000 }),
        transactions: [purchase(31_000, inMay())],
      }),
    );
    expect(result.monthPosition).toBe('past');
    expect(result.monthComplete).toBe(true);
    expect(result.pace).toEqual({ available: false, reason: 'not-applicable' });
  });

  it('names the accounts a past month is missing coverage for', () => {
    resetIds();
    const partial: StatementRange[] = [
      range('2026-05-01', '2026-05-31', [CHECKING]),
      range('2026-05-01', '2026-05-10', [CARD]),
    ];
    const result = selectBudgetProgress(
      build({
        today: '2026-06-10',
        coverage: partial,
        accounts: [
          { id: CHECKING, archived: false },
          { id: CARD, archived: false },
        ],
      }),
    );
    expect(result.monthComplete).toBe(false);
    expect(result.accountsMissingCoverage).toEqual([CARD]);
  });

  it('never projects a future month', () => {
    resetIds();
    const result = selectBudgetProgress(build({ today: '2026-04-20' }));
    expect(result.monthPosition).toBe('future');
    expect(result.pace).toEqual({ available: false, reason: 'not-applicable' });
    expect(result.actualCents).toBe(0);
  });
});

describe('calendar arithmetic', () => {
  it('handles leap-year February', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        month: '2028-02',
        today: '2028-02-10',
        coverage: rangesForAll('2028-02-01', '2028-02-29'),
        transactions: [purchase(10_000, { postedDate: '2028-02-05' })],
      }),
    );
    if (!result.pace.available) throw new Error('expected a pace');
    expect(result.pace.value.totalDays).toBe(29);
    expect(result.pace.value.elapsedDays).toBe(10);
    expect(result.pace.value.projectedSpendCents).toBe(29_000);
  });

  it('handles a thirty-day month', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        month: '2026-04',
        today: '2026-04-15',
        coverage: rangesForAll('2026-04-01', '2026-04-30'),
        transactions: [purchase(15_000, { postedDate: '2026-04-03' })],
      }),
    );
    if (!result.pace.available) throw new Error('expected a pace');
    expect(result.pace.value.totalDays).toBe(30);
    expect(result.pace.value.projectedSpendCents).toBe(30_000);
  });

  it('handles a thirty-one-day month', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({ today: '2026-05-31', transactions: [purchase(31_000, inMay())] }),
    );
    if (!result.pace.available) throw new Error('expected a pace');
    expect(result.pace.value.totalDays).toBe(31);
    expect(result.pace.value.elapsedDays).toBe(31);
    expect(result.pace.value.projectedSpendCents).toBe(31_000);
  });
});

describe('determinism and purity', () => {
  const scenario = () => {
    resetIds();
    return [
      purchase(12_000, inMay({ categoryId: 'groceries', accountId: CHECKING })),
      refund(2_000, inMay({ categoryId: 'groceries', accountId: CHECKING })),
      purchase(7_500, inMay({ categoryId: 'dining', accountId: CARD })),
      transfer(50_000, inMay({ accountId: CHECKING })),
      income(200_000, inMay({ accountId: CHECKING })),
      fee(300, inMay({ accountId: CARD })),
    ];
  };

  const input = (transactions: SelectableTransaction[], accounts: AccountScope[]): BudgetInput =>
    build({
      transactions,
      accounts,
      plan: plan({
        overallLimitCents: 40_000,
        incomeTargetCents: 200_000,
        savingsTargetCents: 1_000,
      }),
      categoryTargets: [
        { categoryId: 'dining', limitCents: 5_000 },
        { categoryId: 'groceries', limitCents: 15_000 },
      ],
    });

  it('deep-equals across three input orderings', () => {
    const rows = scenario();
    const a = selectBudgetProgress(input(rows, ACCOUNTS));
    const b = selectBudgetProgress(input([...rows].reverse(), [...ACCOUNTS].reverse()));
    const shuffled = [
      rows[3],
      rows[0],
      rows[5],
      rows[2],
      rows[4],
      rows[1],
    ] as SelectableTransaction[];
    const c = selectBudgetProgress(
      input(shuffled, [ACCOUNTS[1], ACCOUNTS[2], ACCOUNTS[0]] as AccountScope[]),
    );

    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('mutates neither the transactions, the accounts, nor the targets', () => {
    const rows = scenario();
    const targets: BudgetCategoryTargetInput[] = [
      { categoryId: 'dining', limitCents: 5_000 },
      { categoryId: 'groceries', limitCents: 15_000 },
    ];
    const rowsBefore = JSON.stringify(rows);
    const accountsBefore = JSON.stringify(ACCOUNTS);
    const targetsBefore = JSON.stringify(targets);
    const coverageBefore = JSON.stringify(COVERED);

    selectBudgetProgress(build({ transactions: rows, categoryTargets: targets }));

    expect(JSON.stringify(rows)).toBe(rowsBefore);
    expect(JSON.stringify(ACCOUNTS)).toBe(accountsBefore);
    expect(JSON.stringify(targets)).toBe(targetsBefore);
    expect(JSON.stringify(COVERED)).toBe(coverageBefore);
  });

  it('produces integer cents for every monetary field', () => {
    const rows = scenario();
    const result = selectBudgetProgress(input(rows, ACCOUNTS));

    const cents: number[] = [
      result.actualCents,
      result.grossOutflowCents,
      result.refundsCents,
      result.untargetedSpendCents,
      result.categoryTargetTotalCents,
      ...result.categories.flatMap((entry) => [
        entry.limitCents,
        entry.spentCents,
        entry.remainingCents,
      ]),
    ];
    if (result.remainingCents.available) cents.push(result.remainingCents.value);
    if (result.plannedMarginCents.available) cents.push(result.plannedMarginCents.value);
    if (result.pace.available) {
      cents.push(result.pace.value.monthToDateCents, result.pace.value.projectedSpendCents);
      if (result.pace.value.projectedOverUnderCents.available) {
        cents.push(result.pace.value.projectedOverUnderCents.value);
      }
    }

    for (const value of cents) expect(Number.isInteger(value)).toBe(true);
  });
});

describe('reconciliation with the dashboard selector', () => {
  it('reports the same monthly net spending as selectDashboard for the same scope', () => {
    resetIds();
    const transactions = [
      purchase(12_000, inMay({ accountId: CHECKING })),
      refund(2_000, inMay({ accountId: CHECKING, categoryId: 'groceries' })),
      purchase(7_500, inMay({ accountId: CARD, categoryId: 'dining' })),
      transfer(50_000, inMay({ accountId: CHECKING })),
      unknownCredit(1_000, inMay({ accountId: CARD })),
      tx({ ...inMay({ accountId: CHECKING }), excludedFromSpending: true, amountCents: 9_000 }),
    ];
    const accounts: AccountScope[] = [
      { id: CHECKING, archived: false },
      { id: CARD, archived: false },
    ];

    const budget = selectBudgetProgress(build({ transactions, accounts, today: '2026-06-10' }));
    const dashboard = selectDashboard({
      transactions,
      filters: { range: { start: '2026-05-01', end: '2026-05-31' }, accountIds: [CHECKING, CARD] },
      incomeCompleteness: 'confirmed-complete',
      coverage: COVERED,
      accounts,
      granularity: 'month',
    });

    expect(budget.actualCents).toBe(dashboard.netSpending.netSpendingCents);
    expect(budget.grossOutflowCents).toBe(dashboard.netSpending.grossOutflowCents);
    expect(budget.refundsCents).toBe(dashboard.netSpending.refundsCents);
    expect(budget.populationCount).toBe(dashboard.partition.populationCount);
    // And the breakdown the categories were read from is the same one.
    expect(budget.untargetedSpendCents).toBe(
      dashboard.byCategory.reduce((total, slice) => total + slice.netCents, 0),
    );
  });
});

describe('the settled Phase 0 contract shape', () => {
  it('fills BudgetProgress from the same values the page renders', () => {
    resetIds();
    const result = selectBudgetProgress(
      build({
        plan: plan({ overallLimitCents: 100_000 }),
        transactions: [purchase(31_000, { postedDate: '2026-05-02' })],
      }),
    );

    expect(result.progress.month).toBe(MAY);
    expect(result.progress.spentCents).toBe(result.actualCents);
    expect(result.progress.limitCents).toEqual(result.limitCents);
    expect(result.progress.remainingCents).toEqual(result.remainingCents);
    expect(result.progress.spentFraction).toEqual(result.usedRatio);
    expect(result.progress.elapsedFraction).toEqual({
      available: true,
      value: 15 / 31,
    });
    expect(result.progress.projectedSpendCents).toEqual({ available: true, value: 64_067 });
  });
});
