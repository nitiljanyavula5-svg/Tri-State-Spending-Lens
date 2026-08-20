import type {
  BucketGranularity,
  DateRange,
  SelectableTransaction,
  TimeBucket,
  TreatmentPartition,
} from './types';
import { subtractCents, sumBy } from './money';
import {
  addDays,
  firstDayOfMonth,
  isIsoDate,
  lastDayOfMonth,
  monthOf,
  monthsInRange,
  startOfWeek,
  type WeekStart,
} from './period';
import { isRangeCoveredForScope, type AccountCoverage } from './completeness';

/**
 * Net spending over time.
 *
 * Buckets are **dense**: every bucket in the range is emitted, including empty
 * ones. A sparse series drawn as a line silently interpolates across a month
 * with no data, which is precisely the claim data-methodology.md §6 forbids —
 * the chart must break across a gap rather than draw through it. An empty bucket
 * carries a real zero; `isComplete` says whether statement coverage backs it.
 *
 * Every bucket's net is the same `outflow − refund` difference used everywhere
 * else, so `Σ buckets === net spending` holds by construction (§14.6). Buckets
 * partition the range exactly: each date falls in one, so no row is counted
 * twice and none is dropped.
 */

/**
 * Bucket boundaries covering the range, in order.
 *
 * Month buckets are clipped to the requested range so a partial first or last
 * month does not silently widen the period the totals describe.
 */
export function bucketBoundaries(
  range: DateRange,
  granularity: BucketGranularity,
  weekStart: WeekStart = 'sunday',
): { start: string; end: string }[] {
  if (!isIsoDate(range.start) || !isIsoDate(range.end) || range.start > range.end) return [];

  if (granularity === 'month') {
    return monthsInRange(range).map((month) => {
      const first = firstDayOfMonth(month);
      const last = lastDayOfMonth(month);
      return {
        start: first < range.start ? range.start : first,
        end: last > range.end ? range.end : last,
      };
    });
  }

  const buckets: { start: string; end: string }[] = [];
  const step = granularity === 'week' ? 7 : 1;
  let cursor = granularity === 'week' ? startOfWeek(range.start, weekStart) : range.start;

  while (cursor <= range.end) {
    const rawEnd = granularity === 'week' ? addDays(cursor, step - 1) : cursor;
    buckets.push({
      start: cursor < range.start ? range.start : cursor,
      end: rawEnd > range.end ? range.end : rawEnd,
    });
    cursor = addDays(cursor, step);
  }

  return buckets;
}

/** Which bucket a date belongs to. One bucket per date, by construction. */
function bucketKeyFor(date: string, granularity: BucketGranularity, weekStart: WeekStart): string {
  if (granularity === 'month') return monthOf(date);
  if (granularity === 'week') return startOfWeek(date, weekStart);
  return date;
}

function bucketKeyOfBoundary(
  boundary: { start: string; end: string },
  granularity: BucketGranularity,
  weekStart: WeekStart,
): string {
  return bucketKeyFor(boundary.start, granularity, weekStart);
}

export function selectTimeSeries(
  partition: TreatmentPartition,
  range: DateRange,
  granularity: BucketGranularity,
  coverage: AccountCoverage,
  scope: readonly string[],
  weekStart: WeekStart = 'sunday',
): TimeBucket[] {
  const boundaries = bucketBoundaries(range, granularity, weekStart);

  const outflowsByKey = new Map<string, SelectableTransaction[]>();
  const refundsByKey = new Map<string, SelectableTransaction[]>();

  const index = (
    rows: readonly SelectableTransaction[],
    target: Map<string, SelectableTransaction[]>,
  ) => {
    for (const row of rows) {
      const key = bucketKeyFor(row.postedDate, granularity, weekStart);
      const bucket = target.get(key);
      if (bucket) bucket.push(row);
      else target.set(key, [row]);
    }
  };

  index(partition.includedOutflow, outflowsByKey);
  index(partition.includedRefund, refundsByKey);

  return boundaries.map((boundary) => {
    const key = bucketKeyOfBoundary(boundary, granularity, weekStart);
    const outflows = outflowsByKey.get(key) ?? [];
    const refunds = refundsByKey.get(key) ?? [];
    const grossOutflowCents = sumBy(outflows, (row) => row.amountCents);
    const refundsCents = sumBy(refunds, (row) => row.amountCents);
    return {
      key,
      start: boundary.start,
      end: boundary.end,
      grossOutflowCents,
      refundsCents,
      netCents: subtractCents(grossOutflowCents, refundsCents),
      transactionCount: outflows.length + refunds.length,
      // Coverage of the bucket's own span, not of the whole period: one missing
      // statement week must not mark every other bucket incomplete. Scoped per
      // account (§14.11), so a bucket is complete only when every account in
      // scope covers it independently.
      isComplete: isRangeCoveredForScope(
        { start: boundary.start, end: boundary.end },
        coverage,
        scope,
      ),
    };
  });
}

/** Total net across buckets. Used by reconciliation to prove the sums agree. */
export function totalBucketNetCents(buckets: readonly TimeBucket[]): number {
  return sumBy(buckets, (bucket) => bucket.netCents, 'bucket netCents');
}
