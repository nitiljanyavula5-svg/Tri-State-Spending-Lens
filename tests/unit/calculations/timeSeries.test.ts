// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  bucketBoundaries,
  selectTimeSeries,
  totalBucketNetCents,
} from '../../../src/calculations/timeSeries';
import { partitionByTreatment, selectNetSpending } from '../../../src/calculations/netSpending';
import { buildAccountCoverage } from '../../../src/calculations/completeness';
import {
  ACCOUNTS,
  COVERAGE_PARTIAL_MAY,
  COVERAGE_TWO_MONTHS,
  MAY,
  purchase,
  rangesForAll,
  refund,
  resetIds,
  shuffle,
  transfer,
} from './fixtures';

/**
 * The trend series, against data-methodology.md §6 and calculation-contract.md §14.6.
 *
 * Buckets are dense on purpose. A sparse series drawn as a line interpolates
 * across a month with no data, which is exactly the claim §6 forbids — the chart
 * must break across a gap rather than draw through it. An empty bucket therefore
 * carries a real zero, and `isComplete` says whether coverage backs it.
 */

const COVERAGE = buildAccountCoverage(COVERAGE_TWO_MONTHS);

/** Every account the fixture ranges are attributed to (§14.11). */
const SCOPE = ACCOUNTS.map((account) => account.id).sort();

describe('bucket boundaries', () => {
  it('emits one bucket per month, clipped to the range', () => {
    expect(bucketBoundaries({ start: '2026-04-15', end: '2026-06-10' }, 'month')).toEqual([
      { start: '2026-04-15', end: '2026-04-30' },
      { start: '2026-05-01', end: '2026-05-31' },
      { start: '2026-06-01', end: '2026-06-10' },
    ]);
  });

  it('emits one bucket per day', () => {
    const buckets = bucketBoundaries({ start: '2026-05-01', end: '2026-05-03' }, 'day');
    expect(buckets).toEqual([
      { start: '2026-05-01', end: '2026-05-01' },
      { start: '2026-05-02', end: '2026-05-02' },
      { start: '2026-05-03', end: '2026-05-03' },
    ]);
  });

  it('clips week buckets to the range at both ends', () => {
    const buckets = bucketBoundaries(MAY, 'week');
    expect(buckets[0]).toEqual({ start: '2026-05-01', end: '2026-05-02' });
    expect(buckets[buckets.length - 1]?.end).toBe('2026-05-31');
  });

  it('covers a leap February day by day', () => {
    const buckets = bucketBoundaries({ start: '2028-02-01', end: '2028-02-29' }, 'day');
    expect(buckets).toHaveLength(29);
    expect(buckets[28]).toEqual({ start: '2028-02-29', end: '2028-02-29' });
  });

  it('spans a year boundary by month', () => {
    expect(bucketBoundaries({ start: '2026-12-01', end: '2027-01-31' }, 'month')).toHaveLength(2);
  });

  it('returns nothing for an inverted range', () => {
    expect(bucketBoundaries({ start: '2026-05-31', end: '2026-05-01' }, 'month')).toEqual([]);
  });
});

describe('bucketed net spending', () => {
  it('places each row in the bucket its posted date falls in', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(1_000, { postedDate: '2026-04-10' }),
      purchase(2_000, { postedDate: '2026-05-10' }),
    ]);
    const buckets = selectTimeSeries(
      partition,
      { start: '2026-04-01', end: '2026-05-31' },
      'month',
      COVERAGE,
      SCOPE,
    );
    expect(buckets.map((bucket) => [bucket.key, bucket.netCents])).toEqual([
      ['2026-04', 1_000],
      ['2026-05', 2_000],
    ]);
  });

  it('emits empty buckets rather than skipping them', () => {
    resetIds();
    const partition = partitionByTreatment([purchase(1_000, { postedDate: '2026-05-02' })]);
    const buckets = selectTimeSeries(
      partition,
      { start: '2026-05-01', end: '2026-05-04' },
      'day',
      COVERAGE,
      SCOPE,
    );
    expect(buckets).toHaveLength(4);
    expect(buckets.map((bucket) => bucket.netCents)).toEqual([0, 1_000, 0, 0]);
  });

  it('nets a refund inside the period it posted', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(10_000, { postedDate: '2026-04-20' }),
      refund(4_000, { postedDate: '2026-05-05' }),
    ]);
    const buckets = selectTimeSeries(
      partition,
      { start: '2026-04-01', end: '2026-05-31' },
      'month',
      COVERAGE,
      SCOPE,
    );
    // §5.3: the refund lands in May, leaving May negative rather than restating April.
    expect(buckets.map((bucket) => bucket.netCents)).toEqual([10_000, -4_000]);
  });

  it('omits excluded rows from every bucket', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(1_000, { postedDate: '2026-05-02' }),
      transfer(90_000, { postedDate: '2026-05-03' }),
    ]);
    const buckets = selectTimeSeries(partition, MAY, 'month', COVERAGE, SCOPE);
    expect(buckets[0]?.netCents).toBe(1_000);
    expect(buckets[0]?.transactionCount).toBe(1);
  });

  it('marks a bucket complete only when coverage spans it', () => {
    resetIds();
    const partition = partitionByTreatment([purchase(1_000, { postedDate: '2026-05-20' })]);
    const partial = selectTimeSeries(
      partition,
      MAY,
      'month',
      buildAccountCoverage(COVERAGE_PARTIAL_MAY),
      SCOPE,
    );
    const complete = selectTimeSeries(partition, MAY, 'month', COVERAGE, SCOPE);
    expect(partial[0]?.isComplete).toBe(false);
    expect(complete[0]?.isComplete).toBe(true);
  });

  it('marks only the uncovered bucket incomplete, not every bucket', () => {
    resetIds();
    const partition = partitionByTreatment([]);
    const coverage = buildAccountCoverage(rangesForAll('2026-05-01', '2026-05-02'));
    const buckets = selectTimeSeries(
      partition,
      { start: '2026-05-01', end: '2026-05-03' },
      'day',
      coverage,
      SCOPE,
    );
    expect(buckets.map((bucket) => bucket.isComplete)).toEqual([true, true, false]);
  });

  it('sums exactly to net spending across every granularity', () => {
    resetIds();
    const rows = [
      purchase(12_345, { postedDate: '2026-05-02' }),
      purchase(4_999, { postedDate: '2026-05-19' }),
      refund(2_500, { postedDate: '2026-05-28' }),
      transfer(50_000, { postedDate: '2026-05-11' }),
    ];
    const partition = partitionByTreatment(rows);
    const expected = selectNetSpending(partition).netSpendingCents;
    for (const granularity of ['day', 'week', 'month'] as const) {
      expect(
        totalBucketNetCents(selectTimeSeries(partition, MAY, granularity, COVERAGE, SCOPE)),
      ).toBe(expected);
    }
  });

  it('does not depend on input order', () => {
    resetIds();
    const rows = [
      purchase(500, { postedDate: '2026-05-02' }),
      purchase(900, { postedDate: '2026-05-20' }),
      refund(100, { postedDate: '2026-05-09' }),
    ];
    const forward = selectTimeSeries(partitionByTreatment(rows), MAY, 'week', COVERAGE, SCOPE);
    const shuffled = selectTimeSeries(
      partitionByTreatment(shuffle(rows)),
      MAY,
      'week',
      COVERAGE,
      SCOPE,
    );
    expect(shuffled).toEqual(forward);
  });

  it('counts every included transaction exactly once across buckets', () => {
    resetIds();
    const rows = [
      purchase(100, { postedDate: '2026-05-01' }),
      purchase(200, { postedDate: '2026-05-15' }),
      refund(50, { postedDate: '2026-05-31' }),
    ];
    const partition = partitionByTreatment(rows);
    const buckets = selectTimeSeries(partition, MAY, 'day', COVERAGE, SCOPE);
    const counted = buckets.reduce((sum, bucket) => sum + bucket.transactionCount, 0);
    expect(counted).toBe(selectNetSpending(partition).includedTransactionCount);
  });
});
