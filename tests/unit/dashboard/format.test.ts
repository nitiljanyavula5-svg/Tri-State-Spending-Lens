// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatCurrency,
  formatRatio,
  UNAVAILABLE_COPY,
  unavailableCopy,
} from '../../../src/components/dashboard/format';
import type { UnavailableReason } from '../../../src/calculations';

/**
 * The presentation boundary, against calculation-contract.md §9.
 *
 * Rounding happens here and nowhere earlier, and every export returns a string —
 * so a formatted value cannot be fed back into a calculation even by accident.
 */

describe('currency', () => {
  it('formats integer cents as dollars', () => {
    expect(formatCurrency(123_456)).toBe('$1,234.56');
    expect(formatCurrency(5)).toBe('$0.05');
  });

  it('formats a genuine zero as a real figure', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('formats a negative total honestly, with a sign rather than a colour', () => {
    expect(formatCurrency(-13_000)).toBe('-$130.00');
  });

  it('always shows both cent digits', () => {
    expect(formatCurrency(100)).toBe('$1.00');
    expect(formatCurrency(110)).toBe('$1.10');
  });
});

describe('ratios', () => {
  it('rounds to one decimal place at display only', () => {
    expect(formatRatio(0.75)).toBe('75.0%');
    expect(formatRatio(0.666_666_6)).toBe('66.7%');
  });

  it('does not clamp a negative or above-100% rate', () => {
    expect(formatRatio(-1.5)).toBe('-150.0%');
    expect(formatRatio(1.05)).toBe('105.0%');
  });
});

describe('counts', () => {
  it('groups thousands', () => {
    expect(formatCount(1_234)).toBe('1,234');
    expect(formatCount(0)).toBe('0');
  });
});

describe('unavailable copy', () => {
  const REASONS: readonly UnavailableReason[] = [
    'no-income-data',
    'income-data-incomplete',
    'income-completeness-unconfirmed',
    'no-budget-limit-set',
    'partial-month',
    'insufficient-history',
    'no-included-transactions',
    'period-not-complete-month',
    'prior-month-incomplete',
    'not-applicable',
  ];

  it('explains every reason the contract defines', () => {
    for (const reason of REASONS) {
      expect(unavailableCopy(reason), reason).toBeTruthy();
    }
    expect(Object.keys(UNAVAILABLE_COPY)).toHaveLength(REASONS.length);
  });

  it('distinguishes confirmed-incomplete income from unconfirmed income', () => {
    expect(unavailableCopy('income-data-incomplete')).not.toBe(
      unavailableCopy('income-completeness-unconfirmed'),
    );
  });

  it('never substitutes a zero, a percentage, or a bare dash for an explanation', () => {
    for (const reason of REASONS) {
      const copy = unavailableCopy(reason);
      expect(copy).not.toBe('0');
      expect(copy).not.toBe('0%');
      expect(copy).not.toBe('—');
      expect(copy.length).toBeGreaterThan(10);
    }
  });
});
