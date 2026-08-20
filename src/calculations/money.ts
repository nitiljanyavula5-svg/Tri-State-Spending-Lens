import type { Cents } from './types';

/**
 * Integer-cent arithmetic.
 *
 * calculation-contract.md §1 rule 4 requires every monetary computation to run
 * in integer cents, and §14.6 removes the residual escape hatch that would let
 * a mismatch be reported instead of fixed. Both rules are only as good as their
 * enforcement, so the aggregation helpers here *check* their inputs rather than
 * trusting that no float ever reached them.
 *
 * The failure this prevents is specific. A single float in a sum does not throw;
 * it produces a total that is wrong in the last cent, survives every equality
 * test written with `toBeCloseTo`, and reconciles against itself because the
 * same wrong number flows to the card and the chart. Failing loudly at the
 * point of entry is the only way that stays impossible.
 */

/** True for a safe, whole-number cent value. Rejects NaN, Infinity, and floats. */
export function isIntegerCents(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * Guard for a value entering an aggregate.
 *
 * Throws rather than coercing. A silently rounded input is exactly the bug this
 * module exists to prevent, and a thrown error in a pure function is a test
 * failure rather than a wrong number on a dashboard.
 */
export function assertIntegerCents(value: number, label: string): Cents {
  if (!isIntegerCents(value)) {
    throw new TypeError(`${label} must be an integer number of cents.`);
  }
  return value;
}

/** Sum, checked at every element. Empty sums to 0, which is a real zero. */
export function sumCents(values: Iterable<number>, label = 'amountCents'): Cents {
  let total = 0;
  for (const value of values) {
    total += assertIntegerCents(value, label);
  }
  return assertIntegerCents(total, `${label} total`);
}

/** Sum of a projected field, checked per element. */
export function sumBy<T>(
  items: Iterable<T>,
  select: (item: T) => number,
  label = 'amountCents',
): Cents {
  let total = 0;
  for (const item of items) {
    total += assertIntegerCents(select(item), label);
  }
  return assertIntegerCents(total, `${label} total`);
}

/**
 * Difference in cents.
 *
 * Named rather than inlined so that the one place net spending is derived reads
 * as the contract formula (§4) instead of as bare subtraction.
 */
export function subtractCents(minuend: number, subtrahend: number): Cents {
  return assertIntegerCents(
    assertIntegerCents(minuend, 'minuend') - assertIntegerCents(subtrahend, 'subtrahend'),
    'difference',
  );
}

/**
 * An exact ratio, or `null` when the denominator is zero.
 *
 * Returns the raw quotient. Rounding happens only at display (§9), so nothing
 * here rounds, clamps, or bounds the result: a savings rate may legitimately be
 * negative and may legitimately exceed 1.
 */
export function ratioOf(numerator: Cents, denominator: Cents): number | null {
  assertIntegerCents(numerator, 'numerator');
  assertIntegerCents(denominator, 'denominator');
  if (denominator === 0) return null;
  return numerator / denominator;
}
