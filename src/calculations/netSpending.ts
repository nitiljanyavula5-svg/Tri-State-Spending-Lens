import { spendingTreatment, type SpendingTreatment } from '../classification/spending';
import type { NetSpendingBreakdown, SelectableTransaction, TreatmentPartition } from './types';
import { subtractCents, sumBy } from './money';

/**
 * Net spending, and the partition that explains it.
 *
 * `spendingTreatment` is called exactly once per row and its answer is the only
 * thing consulted afterwards. The alternative — re-listing the outflow kinds
 * here — is how two modules come to disagree about whether a `fee` counts, and
 * calculation-contract.md §1 rule 1 exists to make that impossible rather than
 * merely unlikely.
 *
 * The partition is retained rather than discarded because an excluded row is
 * part of the explanation. A user asking "why is this month lower than I
 * expected" is usually looking at rows that were excluded by kind or are still
 * awaiting review, and a selector that returned only the total could not answer.
 */

const EMPTY: readonly SelectableTransaction[] = [];

/**
 * Splits the population into the five mutually exclusive treatments.
 *
 * Exhaustive by construction: `spendingTreatment` is total over its input, and
 * every branch pushes to exactly one bucket, so the five lengths sum to the
 * population size. `reconciliation.ts` proves that rather than assuming it.
 */
export function partitionByTreatment(
  population: readonly SelectableTransaction[],
): TreatmentPartition {
  const includedOutflow: SelectableTransaction[] = [];
  const includedRefund: SelectableTransaction[] = [];
  const excludedByKind: SelectableTransaction[] = [];
  const excludedByUser: SelectableTransaction[] = [];
  const needsReview: SelectableTransaction[] = [];

  for (const row of population) {
    const treatment: SpendingTreatment = spendingTreatment({
      kind: row.kind,
      direction: row.direction,
      excludedFromSpending: row.excludedFromSpending,
    });

    switch (treatment) {
      case 'included-outflow':
        includedOutflow.push(row);
        break;
      case 'included-refund':
        includedRefund.push(row);
        break;
      case 'excluded-by-kind':
        excludedByKind.push(row);
        break;
      case 'excluded-by-user':
        excludedByUser.push(row);
        break;
      default:
        needsReview.push(row);
        break;
    }
  }

  return {
    includedOutflow,
    includedRefund,
    excludedByKind,
    excludedByUser,
    needsReview,
    populationCount: population.length,
  };
}

export function emptyPartition(): TreatmentPartition {
  return {
    includedOutflow: EMPTY,
    includedRefund: EMPTY,
    excludedByKind: EMPTY,
    excludedByUser: EMPTY,
    needsReview: EMPTY,
    populationCount: 0,
  };
}

/**
 * Net spending for a partition.
 *
 * `net = gross outflow − refunds` (§4). The result may be negative: a refund
 * posts in its own period (§5.3), so a January purchase refunded in February
 * leaves February genuinely below zero. That is displayed honestly rather than
 * clamped, and `includedTransactionCount` counts both sides so a card can say
 * how many rows produced the figure.
 */
export function selectNetSpending(partition: TreatmentPartition): NetSpendingBreakdown {
  const grossOutflowCents = sumBy(partition.includedOutflow, (row) => row.amountCents);
  const refundsCents = sumBy(partition.includedRefund, (row) => row.amountCents);
  return {
    grossOutflowCents,
    refundsCents,
    netSpendingCents: subtractCents(grossOutflowCents, refundsCents),
    includedTransactionCount: partition.includedOutflow.length + partition.includedRefund.length,
  };
}

/** Rows that contribute to net spending, in population order. */
export function includedRows(partition: TreatmentPartition): readonly SelectableTransaction[] {
  return [...partition.includedOutflow, ...partition.includedRefund];
}

/**
 * A row's signed contribution to net spending.
 *
 * Outflows add, refunds subtract, everything else contributes nothing. Every
 * breakdown sums this same function, which is what makes the category, account,
 * and time-bucket totals agree with net spending by construction rather than by
 * three parallel derivations that happen to match.
 */
export function signedContribution(
  row: SelectableTransaction,
  treatment: SpendingTreatment,
): number {
  if (treatment === 'included-outflow') return row.amountCents;
  if (treatment === 'included-refund') return -row.amountCents;
  return 0;
}
