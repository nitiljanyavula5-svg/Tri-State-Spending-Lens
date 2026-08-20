// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildBreakdownRows,
  buildTrendRows,
  COLLAPSED_KEY,
  MAX_BREAKDOWN_ROWS,
  totalBreakdownCents,
  totalTrendCents,
} from '../../../src/components/dashboard/chartData';
import { selectDashboard } from '../../../src/calculations';
import type { AccountScope, BreakdownSlice, TimeBucket } from '../../../src/calculations';
import { getCategory } from '../../../src/domain/categories';
import {
  ACCOUNTS,
  COVERAGE_TWO_MONTHS,
  MAY,
  purchase,
  refund,
  resetIds,
} from '../calculations/fixtures';

/**
 * The shared chart adapters.
 *
 * Charts and fallback tables read these rows, so the property that matters is
 * that collapsing never moves a cent: the visible rows must still total exactly
 * what the selector computed (calculation-contract.md §9, §14.6).
 */

const slice = (key: string, netCents: number): BreakdownSlice => ({
  key,
  grossOutflowCents: netCents > 0 ? netCents : 0,
  refundsCents: netCents < 0 ? -netCents : 0,
  netCents,
  transactionCount: 1,
});

const identity = (key: string) => key;

describe('breakdown rows', () => {
  it('keeps every entry when six or fewer exist, with no Other row', () => {
    const slices = Array.from({ length: MAX_BREAKDOWN_ROWS }, (_, i) => slice(`c${i}`, 100 - i));
    const rows = buildBreakdownRows(slices, identity);
    expect(rows).toHaveLength(MAX_BREAKDOWN_ROWS);
    expect(rows.some((row) => row.isCollapsed)).toBe(false);
  });

  it('collapses the tail into one explicit Other row', () => {
    const slices = Array.from({ length: 10 }, (_, i) => slice(`c${i}`, 100 - i));
    const rows = buildBreakdownRows(slices, identity);
    expect(rows).toHaveLength(MAX_BREAKDOWN_ROWS + 1);

    const other = rows[rows.length - 1];
    expect(other?.isCollapsed).toBe(true);
    expect(other?.entryCount).toBe(4);
    expect(other?.label).toBe('Other (4 more)');
    // 94 + 93 + 92 + 91
    expect(other?.netCents).toBe(370);
  });

  it('sums Other in exact integer cents', () => {
    const slices = [
      ...Array.from({ length: MAX_BREAKDOWN_ROWS }, (_, i) => slice(`c${i}`, 1_000)),
      slice('x', 1),
      slice('y', 2),
      slice('z', 3),
    ];
    const rows = buildBreakdownRows(slices, identity);
    expect(rows[rows.length - 1]?.netCents).toBe(6);
  });

  it('preserves selector order for the visible rows', () => {
    const slices = [slice('a', 900), slice('b', 500), slice('c', 100)];
    expect(buildBreakdownRows(slices, identity).map((row) => row.key)).toEqual(['a', 'b', 'c']);
  });

  it('handles negative and zero entries', () => {
    const rows = buildBreakdownRows([slice('a', -400), slice('b', 0)], identity);
    expect(rows[0]?.netCents).toBe(-400);
    expect(rows[0]?.amount).toBe('-$4.00');
    expect(rows[1]?.amount).toBe('$0.00');
  });

  it('collapses a negative tail correctly', () => {
    const slices = [
      ...Array.from({ length: MAX_BREAKDOWN_ROWS }, (_, i) => slice(`c${i}`, 1_000)),
      slice('x', -500),
      slice('y', -300),
    ];
    expect(buildBreakdownRows(slices, identity)[MAX_BREAKDOWN_ROWS]?.netCents).toBe(-800);
  });

  it('is empty for no slices', () => {
    expect(buildBreakdownRows([], identity)).toEqual([]);
    expect(totalBreakdownCents([])).toBe(0);
  });

  it('applies the label function without changing amounts', () => {
    const rows = buildBreakdownRows([slice('groceries', 500)], (key) => getCategory(key)!.label);
    expect(rows[0]?.label).toBe('Groceries');
    expect(rows[0]?.netCents).toBe(500);
  });
});

describe('the collapsed row cannot be confused with a real entry', () => {
  it('uses a key no category or account id can produce', () => {
    expect(COLLAPSED_KEY).toBe('__collapsed_other__');
    // `other` is a real category id in this product.
    expect(COLLAPSED_KEY).not.toBe('other');
    expect(getCategory(COLLAPSED_KEY)).toBeUndefined();
  });

  it('stays distinct when a real "Other" category is also visible', () => {
    const slices = [
      slice('other', 5_000),
      ...Array.from({ length: MAX_BREAKDOWN_ROWS }, (_, i) => slice(`c${i}`, 100 - i)),
    ];
    const rows = buildBreakdownRows(slices, (key) => getCategory(key)?.label ?? key);

    const real = rows.find((row) => row.key === 'other');
    const collapsed = rows.find((row) => row.isCollapsed);
    expect(real?.isCollapsed).toBe(false);
    expect(real?.label).toBe('Other');
    expect(collapsed?.key).toBe(COLLAPSED_KEY);
    expect(collapsed?.label).not.toBe('Other');
    expect(real?.key).not.toBe(collapsed?.key);
  });
});

describe('collapsing never moves a cent', () => {
  it('keeps the visible total equal to the full breakdown and to net spending', () => {
    resetIds();
    const transactions = [
      ...Array.from({ length: 9 }, (_, i) =>
        purchase(1_000 + i, { postedDate: '2026-05-02', categoryId: `cat-${i}` }),
      ),
      refund(250, { postedDate: '2026-05-20', categoryId: 'cat-0' }),
    ];
    const selection = selectDashboard({
      transactions,
      filters: { range: MAY },
      incomeCompleteness: 'confirmed-complete',
      coverage: COVERAGE_TWO_MONTHS,
      accounts: ACCOUNTS as readonly AccountScope[],
      granularity: 'month',
    });

    const rows = buildBreakdownRows(selection.byCategory, identity);
    const fullTotal = selection.byCategory.reduce((sum, s) => sum + s.netCents, 0);

    expect(rows.some((row) => row.isCollapsed)).toBe(true);
    expect(totalBreakdownCents(rows)).toBe(fullTotal);
    expect(totalBreakdownCents(rows)).toBe(selection.netSpending.netSpendingCents);
  });

  it('holds for the account breakdown too', () => {
    resetIds();
    const selection = selectDashboard({
      transactions: [
        purchase(1_000, { postedDate: '2026-05-02', accountId: 'acct-checking' }),
        purchase(2_000, { postedDate: '2026-05-03', accountId: 'acct-card' }),
      ],
      filters: { range: MAY },
      incomeCompleteness: 'confirmed-complete',
      coverage: COVERAGE_TWO_MONTHS,
      accounts: ACCOUNTS as readonly AccountScope[],
      granularity: 'month',
    });
    const rows = buildBreakdownRows(selection.byAccount, identity);
    expect(totalBreakdownCents(rows)).toBe(selection.netSpending.netSpendingCents);
  });
});

describe('trend rows', () => {
  const bucket = (key: string, netCents: number, isComplete: boolean): TimeBucket => ({
    key,
    start: `${key}-01`,
    end: `${key}-28`,
    grossOutflowCents: netCents > 0 ? netCents : 0,
    refundsCents: netCents < 0 ? -netCents : 0,
    netCents,
    transactionCount: 1,
    isComplete,
  });

  it('preserves every dense bucket, including empty ones', () => {
    const buckets = [bucket('2026-04', 1_000, true), bucket('2026-05', 0, true)];
    const rows = buildTrendRows(buckets);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.amount).toBe('$0.00');
  });

  it('never truncates', () => {
    const buckets = Array.from({ length: 24 }, (_, i) =>
      bucket(`2026-${String((i % 12) + 1).padStart(2, '0')}`, 100, true),
    );
    expect(buildTrendRows(buckets)).toHaveLength(24);
  });

  it('carries completeness as words, not only a flag', () => {
    const rows = buildTrendRows([bucket('2026-04', 1_000, true), bucket('2026-05', 500, false)]);
    expect(rows[0]?.completeness).toBe('complete');
    expect(rows[0]?.completenessLabel).toBe('Fully covered by statements');
    expect(rows[1]?.completeness).toBe('partial');
    expect(rows[1]?.completenessLabel).toBe('Not fully covered by statements');
  });

  it('formats negative amounts honestly', () => {
    expect(buildTrendRows([bucket('2026-05', -13_000, true)])[0]?.amount).toBe('-$130.00');
  });

  it('totals to net spending', () => {
    resetIds();
    const selection = selectDashboard({
      transactions: [
        purchase(12_345, { postedDate: '2026-05-02' }),
        refund(2_500, { postedDate: '2026-05-20' }),
      ],
      filters: { range: MAY },
      incomeCompleteness: 'confirmed-complete',
      coverage: COVERAGE_TWO_MONTHS,
      accounts: ACCOUNTS as readonly AccountScope[],
      granularity: 'day',
    });
    expect(totalTrendCents(buildTrendRows(selection.timeSeries))).toBe(
      selection.netSpending.netSpendingCents,
    );
  });

  it('is empty for no buckets', () => {
    expect(buildTrendRows([])).toEqual([]);
    expect(totalTrendCents([])).toBe(0);
  });
});
