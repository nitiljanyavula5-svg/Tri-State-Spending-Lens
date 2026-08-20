// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  excludedIncomeRows,
  includedIncomeRows,
  incomeCompletenessFrom,
  incomeUnavailableReason,
  selectCashFlow,
} from '../../../src/calculations/cashFlow';
import { partitionByTreatment, selectNetSpending } from '../../../src/calculations/netSpending';
import type { IncomeCompleteness, SelectableTransaction } from '../../../src/calculations/types';
import { income, purchase, refund, resetIds, transfer, unknownCredit } from './fixtures';

/**
 * Cash flow, against calculation-contract.md §4.1–§4.3, §14.1, and §14.10.
 *
 * Two independent gates are under test. Completeness is tri-state: a missing
 * setting is not a confirmed `true`, because publishing a savings rate nobody
 * vouched for is the misleading precision §6 forbids. User exclusion is the
 * second gate, and §14.10 keeps it visible rather than silent.
 */

function cashFlowFor(
  population: readonly SelectableTransaction[],
  completeness: IncomeCompleteness = 'confirmed-complete',
) {
  const netSpending = selectNetSpending(partitionByTreatment(population));
  return selectCashFlow(population, netSpending, completeness);
}

describe('reading the stored setting', () => {
  it('maps true, false, and absent to three distinct states', () => {
    expect(incomeCompletenessFrom(true)).toBe('confirmed-complete');
    expect(incomeCompletenessFrom(false)).toBe('confirmed-incomplete');
    expect(incomeCompletenessFrom(undefined)).toBe('unconfirmed');
  });
});

describe('what counts as money in', () => {
  it('counts income credits', () => {
    resetIds();
    expect(includedIncomeRows([income(500_000), purchase(1_000)])).toHaveLength(1);
  });

  it('does not count refunds as income', () => {
    resetIds();
    // A refund already reduces net spending; counting it as income too would
    // double-count it (§4.1).
    expect(includedIncomeRows([refund(2_500)])).toHaveLength(0);
  });

  it('does not count transfers in as income', () => {
    resetIds();
    expect(includedIncomeRows([transfer(250_000, { direction: 'credit' })])).toHaveLength(0);
  });

  it('does not count unknown credits until reviewed', () => {
    resetIds();
    expect(includedIncomeRows([unknownCredit(90_000)])).toHaveLength(0);
  });

  it('omits an income row carrying the user-exclusion flag', () => {
    resetIds();
    const rows = [income(400_000, { excludedFromSpending: true }), income(50_000)];
    expect(includedIncomeRows(rows)).toHaveLength(1);
    expect(excludedIncomeRows(rows)).toHaveLength(1);
  });
});

describe('the completeness gate', () => {
  it('publishes figures only when completeness is confirmed', () => {
    resetIds();
    const result = cashFlowFor([income(500_000), purchase(200_000)], 'confirmed-complete');
    expect(result.moneyInCents).toEqual({ available: true, value: 500_000 });
    expect(result.netCashFlowCents).toEqual({ available: true, value: 300_000 });
  });

  it('withholds every income figure when the user confirmed incomplete', () => {
    resetIds();
    const result = cashFlowFor([income(500_000), purchase(200_000)], 'confirmed-incomplete');
    expect(result.moneyInCents).toEqual({ available: false, reason: 'income-data-incomplete' });
    expect(result.netCashFlowCents.available).toBe(false);
    expect(result.savingsRate.available).toBe(false);
  });

  it('withholds every income figure when completeness was never confirmed', () => {
    resetIds();
    const result = cashFlowFor([income(500_000), purchase(200_000)], 'unconfirmed');
    expect(result.moneyInCents).toEqual({
      available: false,
      reason: 'income-completeness-unconfirmed',
    });
  });

  it('distinguishes an unconfirmed workspace from a confirmed-incomplete one', () => {
    resetIds();
    const rows = [income(500_000)];
    const unconfirmed = cashFlowFor(rows, 'unconfirmed').moneyInCents;
    const incomplete = cashFlowFor(rows, 'confirmed-incomplete').moneyInCents;
    expect(unconfirmed.available).toBe(false);
    expect(incomplete.available).toBe(false);
    expect(unconfirmed).not.toEqual(incomplete);
  });

  it('reports no income data when confirmed complete but no income exists', () => {
    resetIds();
    const result = cashFlowFor([purchase(4_200)], 'confirmed-complete');
    expect(result.moneyInCents).toEqual({ available: false, reason: 'no-income-data' });
  });

  it('leaves net spending available in every completeness state', () => {
    resetIds();
    for (const state of ['confirmed-complete', 'confirmed-incomplete', 'unconfirmed'] as const) {
      const result = cashFlowFor([purchase(4_200), income(1_000)], state);
      expect(result.netSpending.netSpendingCents).toBe(4_200);
    }
  });

  it('names the reason before looking at the rows', () => {
    resetIds();
    expect(incomeUnavailableReason([income(1)], 'unconfirmed')).toBe(
      'income-completeness-unconfirmed',
    );
    expect(incomeUnavailableReason([income(1)], 'confirmed-complete')).toBeNull();
    expect(incomeUnavailableReason([], 'confirmed-complete')).toBe('no-income-data');
  });
});

describe('savings rate', () => {
  it('is the net cash flow over money in', () => {
    resetIds();
    const result = cashFlowFor([income(100_000), purchase(25_000)]);
    expect(result.savingsRate).toEqual({ available: true, value: 0.75 });
  });

  it('is negative when spending exceeds income, and is not clamped', () => {
    resetIds();
    const result = cashFlowFor([income(100_000), purchase(250_000)]);
    expect(result.netCashFlowCents).toEqual({ available: true, value: -150_000 });
    expect(result.savingsRate).toEqual({ available: true, value: -1.5 });
  });

  it('is undefined rather than zero when income is zero', () => {
    resetIds();
    const result = cashFlowFor([income(0), purchase(1_000)]);
    expect(result.savingsRate.available).toBe(false);
  });

  it('is not rounded inside the selector', () => {
    resetIds();
    const result = cashFlowFor([income(3), purchase(1)]);
    // 2/3 must arrive raw; §9 rounds only at display.
    expect(result.savingsRate.available && result.savingsRate.value).toBeCloseTo(0.666_666_6, 6);
  });

  it('may exceed one when spending is negative', () => {
    resetIds();
    const result = cashFlowFor([income(100_000), purchase(1_000), refund(6_000)]);
    // Net spending is -5_000, so cash flow exceeds income.
    expect(result.netCashFlowCents).toEqual({ available: true, value: 105_000 });
    expect(result.savingsRate).toEqual({ available: true, value: 1.05 });
  });
});

describe('excluded income is counted, never silently dropped', () => {
  it('omits the flagged row from money in but keeps it visible', () => {
    resetIds();
    const rows = [
      income(400_000, { excludedFromSpending: true }),
      income(50_000),
      purchase(10_000),
    ];
    const result = cashFlowFor(rows);
    expect(result.moneyInCents).toEqual({ available: true, value: 50_000 });
    expect(excludedIncomeRows(rows)).toHaveLength(1);
  });
});
