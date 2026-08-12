import { describe, expect, it } from 'vitest';
import {
  countsTowardSpending,
  EXCLUSION_REASONS,
  reconcileExclusionForKind,
  spendingTreatment,
  unusualDirectionForKind,
  userExclusionApplies,
} from '../../../src/classification/spending';
import type { TransactionKind } from '../../../src/types/domain';

/**
 * Spending inclusion, against calculation-contract.md §3.
 *
 * The distinction under test is between "excluded because of what this is" and
 * "excluded because you said so". Collapsing them is how a user comes to
 * believe they can include a transfer in spending — they cannot.
 */

const treat = (
  kind: TransactionKind,
  direction: 'debit' | 'credit' = 'debit',
  excludedFromSpending = false,
) => spendingTreatment({ kind, direction, excludedFromSpending });

describe('what counts as spending', () => {
  it('includes purchases, fees, and cash withdrawals', () => {
    expect(treat('purchase')).toBe('included-outflow');
    expect(treat('fee')).toBe('included-outflow');
    expect(treat('cash_withdrawal')).toBe('included-outflow');
  });

  it('treats a refund as money back rather than money out', () => {
    expect(treat('refund', 'credit')).toBe('included-refund');
    expect(
      countsTowardSpending({ kind: 'refund', direction: 'credit', excludedFromSpending: false }),
    ).toBe(true);
  });

  it('excludes income, transfers, and card payments by kind', () => {
    expect(treat('income', 'credit')).toBe('excluded-by-kind');
    expect(treat('transfer')).toBe('excluded-by-kind');
    expect(treat('payment')).toBe('excluded-by-kind');
  });

  it('leaves unknown out until it is reviewed', () => {
    expect(treat('unknown', 'credit')).toBe('needs-review');
    // An unknown *debit* is excluded too, and surfaced for review.
    expect(treat('unknown', 'debit')).toBe('needs-review');
    expect(
      countsTowardSpending({ kind: 'unknown', direction: 'debit', excludedFromSpending: false }),
    ).toBe(false);
  });

  it('honours an explicit user exclusion', () => {
    expect(treat('purchase', 'debit', true)).toBe('excluded-by-user');
    expect(
      countsTowardSpending({ kind: 'purchase', direction: 'debit', excludedFromSpending: true }),
    ).toBe(false);
  });

  it('reports the kind reason ahead of the user flag', () => {
    // A transfer the user also ticked "exclude" was never going to count. The
    // honest reason is the kind, not the tick.
    expect(treat('transfer', 'debit', true)).toBe('excluded-by-kind');
  });
});

describe('the include control', () => {
  it('is meaningful only for kinds the contract can include', () => {
    expect(userExclusionApplies('purchase')).toBe(true);
    expect(userExclusionApplies('fee')).toBe(true);
    expect(userExclusionApplies('refund')).toBe(true);

    // §18 forbids offering an Include control that appears to override these.
    expect(userExclusionApplies('transfer')).toBe(false);
    expect(userExclusionApplies('payment')).toBe(false);
    expect(userExclusionApplies('income')).toBe(false);
    expect(userExclusionApplies('unknown')).toBe(false);
  });
});

describe('reconciling exclusion after a kind change', () => {
  it('clears a stale user exclusion when the kind now excludes it anyway', () => {
    const result = reconcileExclusionForKind('transfer', {
      excludedFromSpending: true,
      exclusionReason: EXCLUSION_REASONS.userExcluded,
    });

    expect(result.excludedFromSpending).toBe(false);
    // A stale flag would misreport *why* the row is out of the totals.
    expect(result.exclusionReason).toBeUndefined();
  });

  it('keeps a user exclusion on a kind where it still means something', () => {
    const result = reconcileExclusionForKind('purchase', {
      excludedFromSpending: true,
      exclusionReason: EXCLUSION_REASONS.userExcluded,
    });

    expect(result.excludedFromSpending).toBe(true);
    expect(result.exclusionReason).toBe(EXCLUSION_REASONS.userExcluded);
  });

  it('supplies a fixed reason rather than inventing one', () => {
    const result = reconcileExclusionForKind('purchase', { excludedFromSpending: true });
    // A reason built from a description would put a personal value into a
    // stored, displayed field.
    expect(result.exclusionReason).toBe(EXCLUSION_REASONS.userExcluded);
    expect(result.exclusionReason).not.toMatch(/PINEBROOK|\$|\d/);
  });

  it('is total — every kind resolves', () => {
    const kinds: TransactionKind[] = [
      'purchase',
      'refund',
      'income',
      'transfer',
      'payment',
      'fee',
      'cash_withdrawal',
      'unknown',
    ];
    for (const kind of kinds) {
      expect(() => reconcileExclusionForKind(kind, { excludedFromSpending: true })).not.toThrow();
    }
  });
});

describe('unusual direction warnings', () => {
  it('warns without changing anything', () => {
    expect(unusualDirectionForKind('refund', 'debit')).toMatch(/usually money coming back/i);
    expect(unusualDirectionForKind('income', 'debit')).toMatch(/usually money coming in/i);
    expect(unusualDirectionForKind('purchase', 'credit')).toMatch(/may be a refund/i);
  });

  it('stays quiet on ordinary pairings', () => {
    expect(unusualDirectionForKind('purchase', 'debit')).toBeNull();
    expect(unusualDirectionForKind('refund', 'credit')).toBeNull();
    expect(unusualDirectionForKind('transfer', 'debit')).toBeNull();
  });
});
