// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  assertIntegerCents,
  isIntegerCents,
  ratioOf,
  subtractCents,
  sumBy,
  sumCents,
} from '../../../src/calculations/money';

/**
 * Integer-cent arithmetic, against calculation-contract.md §1 rule 4 and §9.
 *
 * The rule these tests defend is that a float must never enter an aggregate.
 * A float does not throw on its own — it produces a total wrong in the last
 * cent that reconciles against itself everywhere, so the guard has to be the
 * thing that fails.
 */

describe('integer-cent guards', () => {
  it('accepts whole cent values including zero and negatives', () => {
    expect(isIntegerCents(0)).toBe(true);
    expect(isIntegerCents(1)).toBe(true);
    expect(isIntegerCents(-4_250)).toBe(true);
  });

  it('rejects floats, NaN, and infinities', () => {
    expect(isIntegerCents(10.5)).toBe(false);
    expect(isIntegerCents(0.1 + 0.2)).toBe(false);
    expect(isIntegerCents(Number.NaN)).toBe(false);
    expect(isIntegerCents(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('rejects values beyond safe integer precision', () => {
    expect(isIntegerCents(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('throws rather than coercing a float into an aggregate', () => {
    expect(() => assertIntegerCents(10.5, 'amountCents')).toThrow(TypeError);
    expect(() => sumCents([100, 200.5])).toThrow(TypeError);
  });

  it('names the offending field so a failure is diagnosable', () => {
    expect(() => assertIntegerCents(1.5, 'refundsCents')).toThrow(/refundsCents/);
  });
});

describe('summation', () => {
  it('sums an empty collection to a real zero', () => {
    expect(sumCents([])).toBe(0);
  });

  it('sums exactly at cent granularity', () => {
    expect(sumCents([1, 2, 3])).toBe(6);
    expect(sumCents([99, 1])).toBe(100);
  });

  it('sums a projected field', () => {
    expect(sumBy([{ cents: 250 }, { cents: 750 }], (row) => row.cents)).toBe(1_000);
  });

  it('does not accumulate representation error the way float dollars would', () => {
    // 0.1 + 0.2 !== 0.3 in floats; the same money in cents is exact.
    expect(sumCents([10, 20])).toBe(30);
  });
});

describe('differences and ratios', () => {
  it('subtracts exactly and allows a negative result', () => {
    expect(subtractCents(500, 1_800)).toBe(-1_300);
  });

  it('returns null rather than dividing by zero', () => {
    expect(ratioOf(1_000, 0)).toBeNull();
  });

  it('returns the raw quotient without rounding or clamping', () => {
    expect(ratioOf(1, 3)).toBeCloseTo(0.333_333_333, 9);
    expect(ratioOf(-5_000, 1_000)).toBe(-5);
    expect(ratioOf(3_000, 1_000)).toBe(3);
  });
});
