import type {
  BreakdownSlice,
  NetSpendingBreakdown,
  ReconciliationCheck,
  ReconciliationReport,
  SelectableTransaction,
  TimeBucket,
  TreatmentPartition,
} from './types';
import { isIntegerCents } from './money';
import { totalNetCents } from './breakdowns';
import { totalBucketNetCents } from './timeSeries';

/**
 * The Phase 5 exit condition, expressed as executable invariants.
 *
 * The master plan's condition is that "cards, charts, and tables reconcile
 * exactly under every test fixture". A report that merely *described* a
 * mismatch would satisfy the letter and miss the point, so
 * calculation-contract.md §14.6 removed the residual field that would have made
 * disagreement expressible. Every equality here is exact integer-cent equality;
 * a failure is a defect, not a rounding note.
 *
 * These run over the real selector outputs rather than over a recomputation, so
 * a bug that corrupted a breakdown would be caught here rather than reproduced
 * identically on both sides of the comparison.
 */

function check(name: string, expected: number, actual: number): ReconciliationCheck {
  return { name, expected, actual, holds: expected === actual };
}

export interface ReconciliationInput {
  readonly population: readonly SelectableTransaction[];
  readonly partition: TreatmentPartition;
  readonly netSpending: NetSpendingBreakdown;
  readonly byCategory: readonly BreakdownSlice[];
  readonly byAccount: readonly BreakdownSlice[];
  readonly timeSeries: readonly TimeBucket[];
}

/** Distinct ids across the two included buckets; catches double-counting. */
function includedIdCount(partition: TreatmentPartition): { total: number; distinct: number } {
  const ids = new Set<string>();
  let total = 0;
  for (const row of partition.includedOutflow) {
    ids.add(row.id);
    total += 1;
  }
  for (const row of partition.includedRefund) {
    ids.add(row.id);
    total += 1;
  }
  return { total, distinct: ids.size };
}

/** Every id appearing in more than one treatment bucket. Must be empty. */
function overlappingTreatmentIds(partition: TreatmentPartition): number {
  const seen = new Set<string>();
  let overlaps = 0;
  const buckets = [
    partition.includedOutflow,
    partition.includedRefund,
    partition.excludedByKind,
    partition.excludedByUser,
    partition.needsReview,
  ];
  for (const bucket of buckets) {
    for (const row of bucket) {
      if (seen.has(row.id)) overlaps += 1;
      else seen.add(row.id);
    }
  }
  return overlaps;
}

function nonIntegerAmountCount(input: ReconciliationInput): number {
  let count = 0;
  const amounts: number[] = [
    input.netSpending.grossOutflowCents,
    input.netSpending.refundsCents,
    input.netSpending.netSpendingCents,
  ];
  for (const slice of input.byCategory) {
    amounts.push(slice.grossOutflowCents, slice.refundsCents, slice.netCents);
  }
  for (const slice of input.byAccount) {
    amounts.push(slice.grossOutflowCents, slice.refundsCents, slice.netCents);
  }
  for (const bucket of input.timeSeries) {
    amounts.push(bucket.grossOutflowCents, bucket.refundsCents, bucket.netCents);
  }
  for (const amount of amounts) {
    if (!isIntegerCents(amount)) count += 1;
  }
  return count;
}

/**
 * Counts included rows that land in a time bucket.
 *
 * Proves invariant 8 from the reconciliation contract: an included row appears
 * in exactly one bucket. A row outside every bucket would silently vanish from
 * the trend while still counting toward the headline total.
 */
function bucketedIncludedCount(input: ReconciliationInput): number {
  return input.timeSeries.reduce((sum, bucket) => sum + bucket.transactionCount, 0);
}

export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const { partition, netSpending } = input;
  const included = includedIdCount(partition);

  const partitionTotal =
    partition.includedOutflow.length +
    partition.includedRefund.length +
    partition.excludedByKind.length +
    partition.excludedByUser.length +
    partition.needsReview.length;

  const checks: ReconciliationCheck[] = [
    check('treatment partition covers the population', partition.populationCount, partitionTotal),
    check('population size matches the filtered rows', input.population.length, partitionTotal),
    check('treatment partitions are mutually exclusive', 0, overlappingTreatmentIds(partition)),
    check(
      'gross outflow minus refunds equals net spending',
      netSpending.netSpendingCents,
      netSpending.grossOutflowCents - netSpending.refundsCents,
    ),
    check(
      'category totals equal net spending',
      netSpending.netSpendingCents,
      totalNetCents(input.byCategory),
    ),
    check(
      'account totals equal net spending',
      netSpending.netSpendingCents,
      totalNetCents(input.byAccount),
    ),
    check(
      'time-bucket totals equal net spending',
      netSpending.netSpendingCents,
      totalBucketNetCents(input.timeSeries),
    ),
    check('no included transaction is counted twice', included.distinct, included.total),
    check(
      'included transaction count matches the breakdown',
      netSpending.includedTransactionCount,
      included.total,
    ),
    check(
      'every included transaction lands in exactly one time bucket',
      netSpending.includedTransactionCount,
      bucketedIncludedCount(input),
    ),
    check(
      'category slice counts cover every included transaction',
      netSpending.includedTransactionCount,
      input.byCategory.reduce((sum, slice) => sum + slice.transactionCount, 0),
    ),
    check(
      'account slice counts cover every included transaction',
      netSpending.includedTransactionCount,
      input.byAccount.reduce((sum, slice) => sum + slice.transactionCount, 0),
    ),
    check('every amount is an integer number of cents', 0, nonIntegerAmountCount(input)),
  ];

  const failures = checks.filter((entry) => !entry.holds);
  return { holds: failures.length === 0, checks, failures };
}
