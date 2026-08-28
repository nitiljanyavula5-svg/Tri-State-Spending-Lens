// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { selectDashboard } from '../../../src/calculations/selectors';
import * as calculations from '../../../src/calculations';
import {
  ACCOUNTS,
  COVERAGE_PARTIAL_MAY,
  COVERAGE_TWO_MONTHS,
  income,
  MAY,
  purchase,
  refund,
  resetIds,
  transfer,
  unknownDebit,
} from './fixtures';

/**
 * The composed entry point, against calculation-contract.md §1 rule 1.
 *
 * One population, one partition, every figure derived from those. The test that
 * matters most is the last group: the same input must produce the same output,
 * because a selector that quietly depended on anything outside `DashboardInput`
 * would break reproducibility without failing any single-figure assertion.
 */

const BASE = {
  filters: { range: MAY },
  incomeCompleteness: 'confirmed-complete' as const,
  coverage: COVERAGE_TWO_MONTHS,
  accounts: ACCOUNTS,
  granularity: 'month' as const,
};

describe('a complete dashboard selection', () => {
  it('produces every figure from one population', () => {
    resetIds();
    const selection = selectDashboard({
      ...BASE,
      transactions: [
        purchase(12_345, { postedDate: '2026-05-02', categoryId: 'groceries' }),
        purchase(4_999, { postedDate: '2026-05-19', categoryId: 'dining' }),
        refund(2_500, { postedDate: '2026-05-28', categoryId: 'groceries' }),
        income(500_000, { postedDate: '2026-05-01' }),
        transfer(90_000, { postedDate: '2026-05-11' }),
        unknownDebit(700, { postedDate: '2026-05-12' }),
      ],
    });

    expect(selection.netSpending.netSpendingCents).toBe(12_345 + 4_999 - 2_500);
    expect(selection.cashFlow.moneyInCents).toEqual({ available: true, value: 500_000 });
    expect(selection.partition.excludedByKind).toHaveLength(2);
    expect(selection.partition.needsReview).toHaveLength(1);
    expect(selection.dataQuality.unreviewedDebits).toBe(1);
    expect(selection.reconciliation.holds).toBe(true);
  });

  it('handles an empty workspace without inventing zeros for undefined figures', () => {
    const selection = selectDashboard({ ...BASE, transactions: [] });
    // Net spending of zero is a real measured result.
    expect(selection.netSpending.netSpendingCents).toBe(0);
    expect(selection.netSpending.includedTransactionCount).toBe(0);
    // Money in is not: there is no income data to measure.
    expect(selection.cashFlow.moneyInCents.available).toBe(false);
    expect(selection.byCategory).toEqual([]);
    expect(selection.reconciliation.holds).toBe(true);
  });

  it('keeps a genuine zero distinguishable from an unavailable measurement', () => {
    resetIds();
    const selection = selectDashboard({
      ...BASE,
      transactions: [purchase(1_000), income(0)],
    });
    expect(selection.netSpending.netSpendingCents).toBe(1_000);
    // Income rows exist and total zero, so money in is a measured zero...
    expect(selection.cashFlow.moneyInCents).toEqual({ available: true, value: 0 });
    // ...but a savings rate over zero income has no value to state.
    expect(selection.cashFlow.savingsRate.available).toBe(false);
  });

  it('normalizes filters before selecting', () => {
    resetIds();
    const selection = selectDashboard({
      ...BASE,
      filters: { range: MAY, accountIds: [], categoryIds: [] },
      transactions: [purchase(1_000), purchase(2_000)],
    });
    expect(selection.population).toHaveLength(2);
  });

  it('reports a partial month through data quality', () => {
    resetIds();
    const selection = selectDashboard({
      ...BASE,
      coverage: COVERAGE_PARTIAL_MAY,
      transactions: [purchase(1_000, { postedDate: '2026-05-20' })],
    });
    expect(selection.dataQuality.partialMonth).toBe(true);
    expect(selection.comparison.available).toBe(false);
  });

  it('offers a comparison when both months are complete', () => {
    resetIds();
    const selection = selectDashboard({
      ...BASE,
      transactions: [
        purchase(10_000, { postedDate: '2026-04-10' }),
        purchase(15_000, { postedDate: '2026-05-10' }),
      ],
    });
    expect(selection.comparison.available).toBe(true);
  });

  it('counts accounts across the whole workspace, not just the filtered period', () => {
    resetIds();
    const selection = selectDashboard({
      ...BASE,
      transactions: [
        purchase(1_000, { postedDate: '2026-05-02', accountId: 'acct-checking' }),
        purchase(2_000, { postedDate: '2026-04-02', accountId: 'acct-card' }),
      ],
    });
    // Two accounts exist, so the single-account warning must not fire merely
    // because May happens to contain rows from one of them.
    expect(selection.dataQuality.singleAccountWithPayments).toBe(false);
  });
});

describe('purity', () => {
  it('returns identical output for identical input', () => {
    resetIds();
    const transactions = [purchase(1_234), refund(56), income(78_900)];
    const first = selectDashboard({ ...BASE, transactions });
    const second = selectDashboard({ ...BASE, transactions });
    expect(second).toEqual(first);
  });

  it('does not mutate its input', () => {
    resetIds();
    const transactions = [purchase(1_000), refund(250)];
    const snapshot = JSON.parse(JSON.stringify(transactions)) as unknown;
    selectDashboard({ ...BASE, transactions });
    expect(JSON.parse(JSON.stringify(transactions))).toEqual(snapshot);
  });

  it('reads nothing outside its input', () => {
    resetIds();
    // No clock, no database, no DOM: the same call in any environment at any
    // time yields the same figures (§1 rule 2).
    const transactions = [purchase(4_200, { postedDate: '2026-05-15' })];
    const selection = selectDashboard({ ...BASE, transactions });
    expect(selection.netSpending.netSpendingCents).toBe(4_200);
    expect(selection.timeSeries).toHaveLength(1);
  });
});

describe('the public barrel', () => {
  it('exports the composed entry point', () => {
    expect(typeof calculations.selectDashboard).toBe('function');
  });

  it('exports the pieces a consumer needs without reaching into modules', () => {
    for (const name of [
      'selectPopulation',
      'partitionByTreatment',
      'selectNetSpending',
      'selectCashFlow',
      'selectCategoryBreakdown',
      'selectAccountBreakdown',
      'selectTimeSeries',
      'selectComparison',
      'selectDataQuality',
      'reconcile',
      'completeMonthsForScope',
      'buildAccountCoverage',
      'accountsInScope',
      'incomeCompletenessFrom',
      'incomeCompletenessWarning',
    ] as const) {
      expect(typeof calculations[name], name).toBe('function');
    }
  });

  /**
   * Superseded by Phase 6A, narrowed rather than deleted.
   *
   * Phase 5 asserted the barrel exported neither a budget nor a recurring
   * selector. Budgeting shipped in Phase 6A, so the budget half of that claim
   * is now false and asserting it would be asserting the feature is missing.
   * The recurring half still holds and is kept, alongside a counterpart that
   * pins the budget selector as present.
   */
  it('exposes the Phase 6A budget selector', () => {
    expect(typeof calculations.selectBudgetProgress).toBe('function');
  });

  it('still exposes no recurring selector, because detection is Phase 6B', () => {
    const names = Object.keys(calculations);
    expect(names.some((name) => /recurring/i.test(name))).toBe(false);
    expect(names.some((name) => /insight/i.test(name))).toBe(false);
  });
});
