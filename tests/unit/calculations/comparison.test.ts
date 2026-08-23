// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { selectComparison } from '../../../src/calculations/comparison';
import { buildAccountCoverage } from '../../../src/calculations/completeness';
import type {
  ComparisonResult,
  DashboardFilters,
  Measured,
  SelectableTransaction,
} from '../../../src/calculations/types';
import type { AccountCoverage } from '../../../src/calculations/completeness';
import {
  ACCOUNTS,
  APRIL,
  COVERAGE_PARTIAL_MAY,
  COVERAGE_PRIOR_INCOMPLETE,
  COVERAGE_TWO_MONTHS,
  MAY,
  purchase,
  rangesForAll,
  refund,
  resetIds,
} from './fixtures';

/**
 * The scope every fixture range is attributed to.
 *
 * Held in one place so a comparison test cannot accidentally assert against a
 * different set of accounts than the coverage it was given.
 */
const SCOPE = ACCOUNTS.map((account) => account.id).sort();

const compare = (
  transactions: readonly SelectableTransaction[],
  filters: DashboardFilters,
  coverage: AccountCoverage,
  scope: readonly string[] = SCOPE,
): Measured<ComparisonResult> => selectComparison(transactions, filters, coverage, scope);

/**
 * Month-over-month comparison, against calculation-contract.md §14.8.
 *
 * The rule worth defending is the one about *not skipping*. If April is
 * incomplete, comparing May against March is not a slightly worse comparison —
 * it is a different claim presented where a user reads "versus last month". The
 * tests below assert that this returns unavailable rather than reaching back.
 */

const TWO_COMPLETE = buildAccountCoverage(COVERAGE_TWO_MONTHS);

describe('availability gates', () => {
  it('is unavailable when the range is not a whole calendar month', () => {
    resetIds();
    const result = compare([], { range: { start: '2026-05-02', end: '2026-05-31' } }, TWO_COMPLETE);
    expect(result).toEqual({ available: false, reason: 'period-not-complete-month' });
  });

  it('is unavailable for a multi-month range', () => {
    resetIds();
    const result = compare([], { range: { start: '2026-04-01', end: '2026-05-31' } }, TWO_COMPLETE);
    expect(result).toEqual({ available: false, reason: 'period-not-complete-month' });
  });

  it('is unavailable when the selected month is itself incomplete', () => {
    resetIds();
    const result = compare([], { range: MAY }, buildAccountCoverage(COVERAGE_PARTIAL_MAY));
    expect(result).toEqual({ available: false, reason: 'partial-month' });
  });

  it('is unavailable when the immediately preceding month is incomplete', () => {
    resetIds();
    const result = compare([], { range: MAY }, buildAccountCoverage(COVERAGE_PRIOR_INCOMPLETE));
    expect(result).toEqual({ available: false, reason: 'prior-month-incomplete' });
  });

  it('never reaches past an incomplete prior month to an older complete one', () => {
    resetIds();
    // March complete, April incomplete, May complete. A comparison of May
    // against March would be a different claim in the same place.
    const coverage = buildAccountCoverage([
      ...rangesForAll('2026-03-01', '2026-03-31'),
      ...rangesForAll('2026-04-08', '2026-04-30'),
      ...rangesForAll('2026-05-01', '2026-05-31'),
    ]);
    const result = compare([], { range: MAY }, coverage);
    expect(result).toEqual({ available: false, reason: 'prior-month-incomplete' });
  });

  it('is unavailable when the prior month has no coverage at all', () => {
    resetIds();
    const result = compare(
      [],
      { range: MAY },
      buildAccountCoverage(rangesForAll('2026-05-01', '2026-05-31')),
    );
    expect(result).toEqual({ available: false, reason: 'prior-month-incomplete' });
  });
});

describe('a valid comparison', () => {
  const rows = () => {
    resetIds();
    return [
      purchase(10_000, { postedDate: '2026-04-10' }),
      purchase(15_000, { postedDate: '2026-05-10' }),
      refund(5_000, { postedDate: '2026-05-20' }),
    ];
  };

  it('compares the selected month against the one immediately before it', () => {
    const result = compare(rows(), { range: MAY }, TWO_COMPLETE);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.currentMonth).toBe('2026-05');
    expect(result.value.priorMonth).toBe('2026-04');
    expect(result.value.currentNetCents).toBe(10_000);
    expect(result.value.priorNetCents).toBe(10_000);
    expect(result.value.deltaCents).toBe(0);
  });

  it('reports a delta and its ratio', () => {
    resetIds();
    const transactions = [
      purchase(10_000, { postedDate: '2026-04-10' }),
      purchase(15_000, { postedDate: '2026-05-10' }),
    ];
    const result = compare(transactions, { range: MAY }, TWO_COMPLETE);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.deltaCents).toBe(5_000);
    expect(result.value.deltaRatio).toEqual({ available: true, value: 0.5 });
  });

  it('withholds the ratio when the prior month is exactly zero', () => {
    resetIds();
    const transactions = [purchase(15_000, { postedDate: '2026-05-10' })];
    const result = compare(transactions, { range: MAY }, TWO_COMPLETE);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.priorNetCents).toBe(0);
    // Every change from zero is an infinite percentage; §1 rule 5 hides it.
    expect(result.value.deltaRatio.available).toBe(false);
  });

  it('carries account and category filters into the prior month', () => {
    resetIds();
    const transactions = [
      purchase(10_000, { postedDate: '2026-04-10', categoryId: 'dining' }),
      purchase(90_000, { postedDate: '2026-04-11', categoryId: 'groceries' }),
      purchase(15_000, { postedDate: '2026-05-10', categoryId: 'dining' }),
    ];
    const result = compare(transactions, { range: MAY, categoryIds: ['dining'] }, TWO_COMPLETE);
    expect(result.available).toBe(true);
    if (!result.available) return;
    // Comparing filtered May against unfiltered April would be a category error.
    expect(result.value.priorNetCents).toBe(10_000);
    expect(result.value.currentNetCents).toBe(15_000);
  });

  it('works when the selected month is the earlier of the two', () => {
    resetIds();
    const transactions = [purchase(8_000, { postedDate: '2026-04-10' })];
    const coverage = buildAccountCoverage(rangesForAll('2026-03-01', '2026-05-31'));
    const result = compare(transactions, { range: APRIL }, coverage);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.priorMonth).toBe('2026-03');
  });

  it('crosses a year boundary', () => {
    resetIds();
    const transactions = [
      purchase(4_000, { postedDate: '2026-12-15' }),
      purchase(6_000, { postedDate: '2027-01-15' }),
    ];
    const coverage = buildAccountCoverage(rangesForAll('2026-12-01', '2027-01-31'));
    const result = compare(
      transactions,
      { range: { start: '2027-01-01', end: '2027-01-31' } },
      coverage,
    );
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.priorMonth).toBe('2026-12');
    expect(result.value.deltaCents).toBe(2_000);
  });

  it('handles a leap February as the compared month', () => {
    resetIds();
    const transactions = [purchase(2_900, { postedDate: '2028-02-29' })];
    const coverage = buildAccountCoverage(rangesForAll('2028-01-01', '2028-02-29'));
    const result = compare(
      transactions,
      { range: { start: '2028-02-01', end: '2028-02-29' } },
      coverage,
    );
    expect(result.available).toBe(true);
    if (!result.available) return;
    // The 29th must be inside the compared month, not dropped.
    expect(result.value.currentNetCents).toBe(2_900);
  });
});
