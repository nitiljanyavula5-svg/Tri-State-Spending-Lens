import type { BreakdownSlice, SelectableTransaction, TreatmentPartition } from './types';
import { subtractCents, sumBy } from './money';

/**
 * Net spending split by category and by account.
 *
 * Both breakdowns are built from the same two included buckets that produced
 * net spending, so `Σ slices === net spending` holds by construction
 * (calculation-contract.md §14.6). Deriving them independently — say, by
 * re-filtering the population per category — is what allows two views of one
 * period to disagree, and §14.6 removed the residual field that would have let
 * such a disagreement be reported instead of fixed.
 *
 * Excluded and needs-review rows create no slice. A category whose only rows
 * were transfers contributes nothing to net spending, and emitting a zero slice
 * for it would put a row on a chart that represents no spending at all.
 */

function groupSlices(
  outflows: readonly SelectableTransaction[],
  refunds: readonly SelectableTransaction[],
  keyOf: (row: SelectableTransaction) => string,
): BreakdownSlice[] {
  const outflowsByKey = new Map<string, SelectableTransaction[]>();
  const refundsByKey = new Map<string, SelectableTransaction[]>();

  for (const row of outflows) {
    const key = keyOf(row);
    const bucket = outflowsByKey.get(key);
    if (bucket) bucket.push(row);
    else outflowsByKey.set(key, [row]);
  }
  for (const row of refunds) {
    const key = keyOf(row);
    const bucket = refundsByKey.get(key);
    if (bucket) bucket.push(row);
    else refundsByKey.set(key, [row]);
  }

  const keys = new Set<string>([...outflowsByKey.keys(), ...refundsByKey.keys()]);
  const slices: BreakdownSlice[] = [];

  for (const key of keys) {
    const keyOutflows = outflowsByKey.get(key) ?? [];
    const keyRefunds = refundsByKey.get(key) ?? [];
    const grossOutflowCents = sumBy(keyOutflows, (row) => row.amountCents);
    const refundsCents = sumBy(keyRefunds, (row) => row.amountCents);
    slices.push({
      key,
      grossOutflowCents,
      refundsCents,
      netCents: subtractCents(grossOutflowCents, refundsCents),
      transactionCount: keyOutflows.length + keyRefunds.length,
    });
  }

  return sortSlices(slices);
}

/**
 * Largest net first, ties broken by key.
 *
 * The tie-break is what makes the order total. Without it, two categories with
 * equal net spending could swap between renders according to `Map` insertion
 * order, which changes with input order — and "shuffled input produces identical
 * output" is one of the reconciliation invariants.
 */
export function sortSlices(slices: readonly BreakdownSlice[]): BreakdownSlice[] {
  return [...slices].sort((a, b) => {
    if (a.netCents !== b.netCents) return b.netCents - a.netCents;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function selectCategoryBreakdown(partition: TreatmentPartition): BreakdownSlice[] {
  return groupSlices(partition.includedOutflow, partition.includedRefund, (row) => row.categoryId);
}

export function selectAccountBreakdown(partition: TreatmentPartition): BreakdownSlice[] {
  return groupSlices(partition.includedOutflow, partition.includedRefund, (row) => row.accountId);
}

/** Total net across slices. Used by reconciliation to prove the sums agree. */
export function totalNetCents(slices: readonly BreakdownSlice[]): number {
  return sumBy(slices, (slice) => slice.netCents, 'slice netCents');
}
