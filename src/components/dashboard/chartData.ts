import type { BreakdownSlice, Cents, TimeBucket } from '../../calculations';
import { sumBy } from '../../calculations';
import { formatCurrency } from './format';

/**
 * The one preparation step between a selector result and anything drawn.
 *
 * Charts and their fallback tables read the *same* rows from here. That is the
 * whole point: calculation-contract.md §1 rule 1 forbids two implementations of
 * a shared figure, and a chart that transformed the selector output itself
 * while its table transformed it again is exactly how the picture and the
 * numbers beneath it come to disagree.
 *
 * These adapters may relabel, format, and collapse. They may not recalculate,
 * refilter, reclassify, or move a cent between rows.
 */

/** Visible rows before collapsing. The seventh and beyond become `Other`. */
export const MAX_BREAKDOWN_ROWS = 6;

/**
 * The synthetic collapsed row's key.
 *
 * Deliberately not `other`: that is a real category id in this product, and a
 * collapsed bucket that shared its key would be indistinguishable from the
 * user's actual uncategorized spending. The double underscores cannot occur in
 * a category or account id.
 */
export const COLLAPSED_KEY = '__collapsed_other__';

export interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly netCents: Cents;
  /** Formatted at the presentation boundary; never re-parsed. */
  readonly amount: string;
  /** True only for the synthetic collapsed row. */
  readonly isCollapsed: boolean;
  /** How many selector rows this row represents. 1 for a real entry. */
  readonly entryCount: number;
}

/**
 * The rows a breakdown chart and its table both show.
 *
 * Selector order is preserved — it already sorts by net descending with a
 * documented tie-break — and the tail is summed in integer cents into one
 * explicit row. Nothing is dropped, so the visible rows still total net
 * spending exactly (§14.6, §9).
 */
export function buildBreakdownRows(
  slices: readonly BreakdownSlice[],
  labelFor: (key: string) => string,
): BreakdownRow[] {
  const visible = slices.slice(0, MAX_BREAKDOWN_ROWS).map((slice) => ({
    key: slice.key,
    label: labelFor(slice.key),
    netCents: slice.netCents,
    amount: formatCurrency(slice.netCents),
    isCollapsed: false,
    entryCount: 1,
  }));

  const tail = slices.slice(MAX_BREAKDOWN_ROWS);
  if (tail.length === 0) return visible;

  const netCents = sumBy(tail, (slice) => slice.netCents, 'collapsed netCents');
  return [
    ...visible,
    {
      key: COLLAPSED_KEY,
      label: `Other (${tail.length} more)`,
      netCents,
      amount: formatCurrency(netCents),
      isCollapsed: true,
      entryCount: tail.length,
    },
  ];
}

/** Total across prepared rows. Used to prove the visible set still reconciles. */
export function totalBreakdownCents(rows: readonly BreakdownRow[]): Cents {
  return sumBy(rows, (row) => row.netCents, 'breakdown row netCents');
}

export type Completeness = 'complete' | 'partial';

export interface TrendRow {
  readonly key: string;
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly netCents: Cents;
  readonly amount: string;
  readonly isComplete: boolean;
  /** Text, not a colour or a shape — the meaning must survive without either. */
  readonly completeness: Completeness;
  readonly completenessLabel: string;
}

/**
 * The rows a trend chart and its table both show.
 *
 * Never truncated and never filtered: the selector already emits a dense
 * series, and dropping an empty bucket would let a line interpolate across a
 * month with no data — the claim data-methodology.md §6 forbids.
 */
export function buildTrendRows(buckets: readonly TimeBucket[]): TrendRow[] {
  return buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.key,
    start: bucket.start,
    end: bucket.end,
    netCents: bucket.netCents,
    amount: formatCurrency(bucket.netCents),
    isComplete: bucket.isComplete,
    completeness: bucket.isComplete ? 'complete' : 'partial',
    completenessLabel: bucket.isComplete
      ? 'Fully covered by statements'
      : 'Not fully covered by statements',
  }));
}

/** Total across prepared trend rows, for the same reconciliation proof. */
export function totalTrendCents(rows: readonly TrendRow[]): Cents {
  return sumBy(rows, (row) => row.netCents, 'trend row netCents');
}
