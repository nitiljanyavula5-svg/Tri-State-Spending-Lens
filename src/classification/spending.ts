import type { Direction, TransactionKind } from '../types/domain';

/**
 * How a transaction is treated by net spending.
 *
 * calculation-contract.md §3 owns the arithmetic; this module owns the
 * *classification* of a single row into one of five honest states, so the
 * review interface can explain a figure rather than merely show a checkbox.
 *
 * The distinction that matters most is between "excluded because of what this
 * is" and "excluded because you said so". Collapsing them into one greyed-out
 * row is how a user comes to believe they can include a transfer in spending —
 * they cannot, and the interface must say why instead of offering a control
 * that appears to work.
 */

export type SpendingTreatment =
  /** A debit that counts toward net spending. */
  | 'included-outflow'
  /** A credit that reduces net spending. */
  | 'included-refund'
  /** Excluded by kind — the user cannot override this without changing kind. */
  | 'excluded-by-kind'
  /** Excluded because the user said so. Reversible by the user. */
  | 'excluded-by-user'
  /** Not yet determined; excluded until reviewed. */
  | 'needs-review';

/** Kinds whose money never counts as spending (calculation-contract.md §3.3). */
const NEVER_SPENDING: ReadonlySet<TransactionKind> = new Set<TransactionKind>([
  'income',
  'transfer',
  'payment',
]);

/** Kinds that count as outflow when included. */
const OUTFLOW_KINDS: ReadonlySet<TransactionKind> = new Set<TransactionKind>([
  'purchase',
  'fee',
  'cash_withdrawal',
]);

export interface SpendingInput {
  readonly kind: TransactionKind;
  readonly direction: Direction;
  readonly excludedFromSpending: boolean;
}

/**
 * The one place a row's spending treatment is decided.
 *
 * Order is deliberate. Kind-based exclusion is checked *before* the user flag,
 * so a transfer the user also ticked "exclude" on still reports the honest
 * reason: it was never going to count.
 */
export function spendingTreatment(input: SpendingInput): SpendingTreatment {
  if (NEVER_SPENDING.has(input.kind)) return 'excluded-by-kind';

  // `unknown` is the review queue: a credit could be income or a refund, and a
  // debit could be anything. Either way it is excluded until someone decides.
  if (input.kind === 'unknown') return 'needs-review';

  if (input.excludedFromSpending) return 'excluded-by-user';

  if (input.kind === 'refund') return 'included-refund';
  return OUTFLOW_KINDS.has(input.kind) ? 'included-outflow' : 'needs-review';
}

/** True when this row contributes to net spending in either direction. */
export function countsTowardSpending(input: SpendingInput): boolean {
  const treatment = spendingTreatment(input);
  return treatment === 'included-outflow' || treatment === 'included-refund';
}

/**
 * Whether the user's include/exclude control does anything for this kind.
 *
 * §18 forbids showing an "Include" control that appears to override a kind the
 * contract always excludes. The interface asks this and explains instead.
 */
export function userExclusionApplies(kind: TransactionKind): boolean {
  return !NEVER_SPENDING.has(kind) && kind !== 'unknown';
}

export const TREATMENT_LABELS: Readonly<Record<SpendingTreatment, string>> = {
  'included-outflow': 'Counts as spending',
  'included-refund': 'Reduces spending',
  'excluded-by-kind': 'Not spending',
  'excluded-by-user': 'You excluded this',
  'needs-review': 'Needs review',
};

export const TREATMENT_EXPLANATIONS: Readonly<Record<SpendingTreatment, string>> = {
  'included-outflow': 'This is money out and is included in your spending totals.',
  'included-refund': 'This is money back, and it reduces spending in the period it posted.',
  'excluded-by-kind':
    'Money of this sort moves between your own accounts or comes in from outside, so it is never counted as spending. To count it, change the kind.',
  'excluded-by-user': 'You excluded this from spending totals. You can include it again.',
  'needs-review':
    'This has not been identified yet, so it is left out of spending totals until you decide what it is.',
};

/**
 * Fixed exclusion reasons.
 *
 * A constant table rather than free text, because `exclusionReason` is stored
 * and rendered, and a reason built by interpolating a description would put a
 * personal value into a field that is displayed everywhere (threat-model.md §8).
 */
export const EXCLUSION_REASONS = {
  userExcluded: 'You excluded this transaction from spending totals.',
  kindChanged: 'The kind changed to one that is never counted as spending.',
} as const;

export interface ExclusionUpdate {
  readonly excludedFromSpending: boolean;
  readonly exclusionReason?: string;
}

/**
 * Reconciles the exclusion fields after a kind change.
 *
 * Deterministic and total: every kind maps to exactly one outcome, so a kind
 * change can never leave a row flagged excluded for a reason that no longer
 * applies. Moving *to* an always-excluded kind clears the user flag, because
 * the kind now does the work and a stale flag would misreport why.
 */
export function reconcileExclusionForKind(
  kind: TransactionKind,
  previous: { excludedFromSpending: boolean; exclusionReason?: string | undefined },
): ExclusionUpdate {
  if (!userExclusionApplies(kind)) {
    return { excludedFromSpending: false };
  }

  if (!previous.excludedFromSpending) return { excludedFromSpending: false };

  return {
    excludedFromSpending: true,
    exclusionReason: previous.exclusionReason ?? EXCLUSION_REASONS.userExcluded,
  };
}

/**
 * Direction/kind pairings worth warning about.
 *
 * A warning only. §18 forbids inventing amounts or flipping signs — the user
 * may genuinely have a credit-side fee reversal, and the product does not know
 * better than the statement.
 */
export function unusualDirectionForKind(
  kind: TransactionKind,
  direction: Direction,
): string | null {
  if (kind === 'refund' && direction === 'debit') {
    return 'Refunds are usually money coming back in. This one is money going out.';
  }
  if (kind === 'income' && direction === 'debit') {
    return 'Income is usually money coming in. This one is money going out.';
  }
  if (kind === 'purchase' && direction === 'credit') {
    return 'Purchases are usually money going out. This one is money coming in — it may be a refund.';
  }
  if (kind === 'cash_withdrawal' && direction === 'credit') {
    return 'Cash withdrawals are usually money going out. This one is money coming in.';
  }
  return null;
}
