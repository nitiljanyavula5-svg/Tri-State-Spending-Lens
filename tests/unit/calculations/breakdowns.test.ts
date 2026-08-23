// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  selectAccountBreakdown,
  selectCategoryBreakdown,
  sortSlices,
  totalNetCents,
} from '../../../src/calculations/breakdowns';
import { partitionByTreatment, selectNetSpending } from '../../../src/calculations/netSpending';
import { purchase, refund, resetIds, shuffle, transfer, unknownDebit } from './fixtures';

/**
 * Category and account breakdowns, against calculation-contract.md §14.6.
 *
 * The property that matters is that the slices sum to net spending exactly.
 * §14.6 removed the residual field that would have let a near-miss be reported
 * instead of fixed, so "close enough" is not a passing state here.
 */

describe('category breakdown', () => {
  it('groups net spending by category', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(10_000, { categoryId: 'groceries' }),
      purchase(4_000, { categoryId: 'dining' }),
      purchase(2_000, { categoryId: 'groceries' }),
    ]);
    const slices = selectCategoryBreakdown(partition);
    expect(slices.map((slice) => [slice.key, slice.netCents])).toEqual([
      ['groceries', 12_000],
      ['dining', 4_000],
    ]);
  });

  it('nets refunds against their own category', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(10_000, { categoryId: 'shopping' }),
      refund(2_500, { categoryId: 'shopping' }),
    ]);
    const [slice] = selectCategoryBreakdown(partition);
    expect(slice).toMatchObject({
      key: 'shopping',
      grossOutflowCents: 10_000,
      refundsCents: 2_500,
      netCents: 7_500,
      transactionCount: 2,
    });
  });

  it('allows a negative category total from a cross-period refund', () => {
    resetIds();
    const partition = partitionByTreatment([refund(3_000, { categoryId: 'travel' })]);
    const [slice] = selectCategoryBreakdown(partition);
    expect(slice?.netCents).toBe(-3_000);
  });

  it('creates no slice for excluded or needs-review rows', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(1_000, { categoryId: 'groceries' }),
      transfer(90_000, { categoryId: 'other' }),
      unknownDebit(500, { categoryId: 'other' }),
      purchase(700, { categoryId: 'dining', excludedFromSpending: true }),
    ]);
    const slices = selectCategoryBreakdown(partition);
    expect(slices.map((slice) => slice.key)).toEqual(['groceries']);
  });

  it('sums exactly to net spending', () => {
    resetIds();
    const rows = [
      purchase(12_345, { categoryId: 'groceries' }),
      purchase(4_999, { categoryId: 'dining' }),
      purchase(1, { categoryId: 'travel' }),
      refund(2_500, { categoryId: 'groceries' }),
    ];
    const partition = partitionByTreatment(rows);
    expect(totalNetCents(selectCategoryBreakdown(partition))).toBe(
      selectNetSpending(partition).netSpendingCents,
    );
  });

  it('is empty for an empty partition', () => {
    expect(selectCategoryBreakdown(partitionByTreatment([]))).toEqual([]);
    expect(totalNetCents([])).toBe(0);
  });
});

describe('account breakdown', () => {
  it('groups net spending by account', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(3_000, { accountId: 'acct-checking' }),
      purchase(5_000, { accountId: 'acct-card' }),
      refund(1_000, { accountId: 'acct-card' }),
    ]);
    const slices = selectAccountBreakdown(partition);
    expect(slices.map((slice) => [slice.key, slice.netCents])).toEqual([
      ['acct-card', 4_000],
      ['acct-checking', 3_000],
    ]);
  });

  it('sums exactly to net spending', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(1, { accountId: 'a' }),
      purchase(2, { accountId: 'b' }),
      refund(3, { accountId: 'c' }),
    ]);
    expect(totalNetCents(selectAccountBreakdown(partition))).toBe(
      selectNetSpending(partition).netSpendingCents,
    );
  });
});

describe('ordering', () => {
  it('puts the largest net first', () => {
    const slices = sortSlices([
      { key: 'b', grossOutflowCents: 100, refundsCents: 0, netCents: 100, transactionCount: 1 },
      { key: 'a', grossOutflowCents: 900, refundsCents: 0, netCents: 900, transactionCount: 1 },
    ]);
    expect(slices.map((slice) => slice.key)).toEqual(['a', 'b']);
  });

  it('breaks ties by key so the order is total', () => {
    const slices = sortSlices([
      { key: 'z', grossOutflowCents: 100, refundsCents: 0, netCents: 100, transactionCount: 1 },
      { key: 'a', grossOutflowCents: 100, refundsCents: 0, netCents: 100, transactionCount: 1 },
    ]);
    expect(slices.map((slice) => slice.key)).toEqual(['a', 'z']);
  });

  it('does not depend on input order', () => {
    resetIds();
    const rows = [
      purchase(500, { categoryId: 'dining' }),
      purchase(500, { categoryId: 'groceries' }),
      purchase(900, { categoryId: 'travel' }),
      refund(100, { categoryId: 'dining' }),
    ];
    const forward = selectCategoryBreakdown(partitionByTreatment(rows));
    const shuffled = selectCategoryBreakdown(partitionByTreatment(shuffle(rows)));
    expect(shuffled).toEqual(forward);
  });
});
