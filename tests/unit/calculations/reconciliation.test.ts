// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { reconcile } from '../../../src/calculations/reconciliation';
import { selectDashboard } from '../../../src/calculations/selectors';
import { partitionByTreatment, selectNetSpending } from '../../../src/calculations/netSpending';
import {
  selectAccountBreakdown,
  selectCategoryBreakdown,
} from '../../../src/calculations/breakdowns';
import { selectTimeSeries } from '../../../src/calculations/timeSeries';
import { buildAccountCoverage } from '../../../src/calculations/completeness';
import type { BucketGranularity } from '../../../src/calculations/types';
import {
  ACCOUNTS,
  COVERAGE_TWO_MONTHS,
  filterVariants,
  MAY,
  purchase,
  refund,
  resetIds,
  scenarios,
  shuffle,
} from './fixtures';

/**
 * The Phase 5 exit condition, executed.
 *
 * The master plan requires that "cards, charts, and tables reconcile exactly
 * under every test fixture". This file is that sentence as a test: every
 * scenario is run under every filter variant at every granularity, and the
 * equalities are exact integer-cent equalities.
 *
 * calculation-contract.md §14.6 removed the residual field that would have let
 * a near-miss be reported rather than fixed, so there is no tolerance here to
 * relax. A mismatch fails.
 */

const GRANULARITIES: BucketGranularity[] = ['day', 'week', 'month'];

describe('the reconciliation sweep', () => {
  for (const scenario of scenarios()) {
    for (const filters of filterVariants(scenario.filters)) {
      for (const granularity of GRANULARITIES) {
        const label = [
          scenario.name,
          filters.accountIds ? `accounts=${filters.accountIds.join('+')}` : 'all accounts',
          filters.categoryIds ? `categories=${filters.categoryIds.join('+')}` : 'all categories',
          granularity,
        ].join(' | ');

        it(`reconciles: ${label}`, () => {
          const selection = selectDashboard({
            transactions: scenario.transactions,
            filters,
            incomeCompleteness: scenario.incomeCompleteness,
            coverage: scenario.coverage,
            accounts: scenario.accounts,
            granularity,
          });

          expect(selection.reconciliation.failures).toEqual([]);
          expect(selection.reconciliation.holds).toBe(true);
        });
      }
    }
  }
});

describe('the unfiltered scenarios produce their hand-computed totals', () => {
  for (const scenario of scenarios()) {
    it(`nets correctly: ${scenario.name}`, () => {
      const selection = selectDashboard({
        transactions: scenario.transactions,
        filters: scenario.filters,
        incomeCompleteness: scenario.incomeCompleteness,
        coverage: scenario.coverage,
        accounts: scenario.accounts,
        granularity: 'month',
      });
      expect(selection.netSpending.netSpendingCents).toBe(scenario.expectedNetCents);
    });
  }
});

describe('individual invariants', () => {
  const build = (granularity: BucketGranularity = 'month') => {
    resetIds();
    const rows = [
      purchase(12_345, { postedDate: '2026-05-02', categoryId: 'groceries' }),
      purchase(4_999, { postedDate: '2026-05-19', categoryId: 'dining' }),
      refund(2_500, { postedDate: '2026-05-28', categoryId: 'groceries' }),
    ];
    const partition = partitionByTreatment(rows);
    const netSpending = selectNetSpending(partition);
    return {
      population: rows,
      partition,
      netSpending,
      byCategory: selectCategoryBreakdown(partition),
      byAccount: selectAccountBreakdown(partition),
      timeSeries: selectTimeSeries(
        partition,
        MAY,
        granularity,
        buildAccountCoverage(COVERAGE_TWO_MONTHS),
        ACCOUNTS.map((account) => account.id),
      ),
    };
  };

  it('holds for a well-formed selection', () => {
    const report = reconcile(build());
    expect(report.holds).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('names every invariant it checks', () => {
    const report = reconcile(build());
    expect(report.checks.length).toBeGreaterThanOrEqual(10);
    for (const check of report.checks) {
      expect(check.name).toBeTruthy();
    }
  });

  it('detects a category breakdown that does not sum to net spending', () => {
    const input = build();
    const corrupted = {
      ...input,
      byCategory: input.byCategory.map((slice) => ({ ...slice, netCents: slice.netCents + 1 })),
    };
    const report = reconcile(corrupted);
    expect(report.holds).toBe(false);
    expect(report.failures.some((entry) => entry.name.includes('category totals'))).toBe(true);
  });

  it('detects an account breakdown that does not sum to net spending', () => {
    const input = build();
    const corrupted = {
      ...input,
      byAccount: input.byAccount.map((slice) => ({ ...slice, netCents: slice.netCents - 5 })),
    };
    expect(reconcile(corrupted).holds).toBe(false);
  });

  it('detects a time series that does not sum to net spending', () => {
    const input = build();
    const corrupted = {
      ...input,
      timeSeries: input.timeSeries.map((bucket) => ({ ...bucket, netCents: bucket.netCents + 7 })),
    };
    expect(reconcile(corrupted).holds).toBe(false);
  });

  it('detects a row counted in two treatment buckets', () => {
    const input = build();
    const duplicated = {
      ...input,
      partition: {
        ...input.partition,
        excludedByUser: [...input.partition.includedOutflow.slice(0, 1)],
      },
    };
    const report = reconcile(duplicated);
    expect(report.holds).toBe(false);
    expect(report.failures.some((entry) => entry.name.includes('mutually exclusive'))).toBe(true);
  });

  it('detects a partition that does not cover the population', () => {
    const input = build();
    const short = {
      ...input,
      partition: { ...input.partition, includedOutflow: input.partition.includedOutflow.slice(1) },
    };
    expect(reconcile(short).holds).toBe(false);
  });

  it('detects a non-integer amount', () => {
    const input = build();
    const fractional = {
      ...input,
      netSpending: {
        ...input.netSpending,
        netSpendingCents: input.netSpending.netSpendingCents + 0.5,
      },
    };
    const report = reconcile(fractional);
    expect(report.holds).toBe(false);
    expect(report.failures.some((entry) => entry.name.includes('integer'))).toBe(true);
  });

  it('holds at every granularity', () => {
    for (const granularity of GRANULARITIES) {
      expect(reconcile(build(granularity)).holds).toBe(true);
    }
  });
});

/**
 * Determinism, over the whole composed output.
 *
 * Comparing only totals would miss the failures that actually bite: a breakdown
 * whose slices reorder between renders, a warning list whose account ids come
 * out in Map-insertion order, a comparison computed from a differently-ordered
 * prior month. Every ordering below is deep-compared against the original, so
 * slice order, bucket order, warning output, comparison output, and
 * reconciliation metadata are all covered — not just the numbers.
 *
 * Transactions, sessions, and accounts are each reordered, because all three
 * arrive from Dexie in an order the selector must not depend on.
 */
describe('order independence', () => {
  for (const scenario of scenarios()) {
    const base = {
      filters: scenario.filters,
      incomeCompleteness: scenario.incomeCompleteness,
      granularity: 'month' as const,
    };

    const orderings = {
      reversed: {
        transactions: [...scenario.transactions].reverse(),
        coverage: [...scenario.coverage].reverse(),
        accounts: [...scenario.accounts].reverse(),
      },
      shuffled: {
        transactions: shuffle(scenario.transactions),
        coverage: shuffle(scenario.coverage, 11),
        accounts: shuffle(scenario.accounts, 3),
      },
    };

    for (const [label, reordered] of Object.entries(orderings)) {
      it(`produces deeply equal output under ${label} input: ${scenario.name}`, () => {
        const forward = selectDashboard({
          ...base,
          transactions: scenario.transactions,
          coverage: scenario.coverage,
          accounts: scenario.accounts,
        });
        const other = selectDashboard({ ...base, ...reordered });

        // The whole selection, not a field at a time.
        expect(other).toEqual(forward);

        // Named explicitly so a regression reports which surface drifted.
        expect(other.byCategory).toEqual(forward.byCategory);
        expect(other.byAccount).toEqual(forward.byAccount);
        expect(other.timeSeries).toEqual(forward.timeSeries);
        expect(other.dataQuality).toEqual(forward.dataQuality);
        expect(other.comparison).toEqual(forward.comparison);
        expect(other.reconciliation).toEqual(forward.reconciliation);
        expect(other.population.map((row) => row.id)).toEqual(
          forward.population.map((row) => row.id),
        );
      });
    }
  }
});
