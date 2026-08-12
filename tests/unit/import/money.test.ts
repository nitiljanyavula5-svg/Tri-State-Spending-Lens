import { describe, expect, it } from 'vitest';
import { formatCents, parseAmountToCents } from '../../../src/import/money';
import { MAX_AMOUNT_CENTS } from '../../../src/import/limits';

function cents(raw: string): number {
  const result = parseAmountToCents(raw);
  if (!result.ok) throw new Error(`expected "${raw}" to parse, got ${result.code}`);
  return result.value.negative ? -result.value.cents : result.value.cents;
}

function rejection(raw: string): string {
  const result = parseAmountToCents(raw);
  if (result.ok) throw new Error(`expected "${raw}" to be rejected`);
  return result.code;
}

describe('exact cents parsing', () => {
  it.each([
    ['0', 0],
    ['0.00', 0],
    ['1', 100],
    ['12.34', 1234],
    ['0.07', 7],
    ['0.1', 10],
    ['19.99', 1999],
    ['8.61', 861],
    ['1234.56', 123456],
    ['.50', 50],
    ['100.', 10000],
  ])('parses %s as %i cents', (raw, expected) => {
    expect(cents(raw)).toBe(expected);
  });

  it('never loses a cent across the whole two-decimal space', () => {
    // The naive `parseFloat(x) * 100` is wrong for many of these — 8.61 becomes
    // 860.9999999999999. Walking every value from 0.00 to 99.99 proves this
    // parser is exact rather than merely usually right.
    for (let whole = 0; whole < 100; whole += 1) {
      for (let fraction = 0; fraction < 100; fraction += 1) {
        const text = `${whole}.${String(fraction).padStart(2, '0')}`;
        expect(cents(text)).toBe(whole * 100 + fraction);
      }
    }
  });

  it('is exact for the values where the floating-point route drifts', () => {
    // Rather than hard-coding a magic value whose float behaviour varies by
    // engine, find every two-decimal value under 100 where `parseFloat * 100`
    // is not already an integer, and prove this parser is exact for all of them.
    const drifting: string[] = [];
    for (let whole = 0; whole < 100; whole += 1) {
      for (let fraction = 0; fraction < 100; fraction += 1) {
        const text = `${whole}.${String(fraction).padStart(2, '0')}`;
        if (!Number.isInteger(Number.parseFloat(text) * 100)) drifting.push(text);
      }
    }

    // If this ever hits zero the test has stopped proving anything.
    expect(drifting.length).toBeGreaterThan(0);

    for (const text of drifting) {
      const [whole, fraction] = text.split('.') as [string, string];
      expect(cents(text)).toBe(Number(whole) * 100 + Number(fraction));
    }
  });
});

describe('accepted bank formatting', () => {
  it.each([
    ['$12.34', 1234],
    ['$1,234.56', 123456],
    ['1,234,567.89', 123456789],
    ['  42.00  ', 4200],
    ['-12.34', -1234],
    ['+12.34', 1234],
    ['12.34-', -1234],
    ['(12.34)', -1234],
    ['($12.34)', -1234],
    ['-$12.34', -1234],
    ['$-12.34', -1234],
  ])('parses %s as %i cents', (raw, expected) => {
    expect(cents(raw)).toBe(expected);
  });

  it('treats negative zero as zero, not as a negative amount', () => {
    const result = parseAmountToCents('-0.00');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cents).toBe(0);
      expect(result.value.negative).toBe(false);
    }
  });
});

describe('refusals', () => {
  it.each([
    ['', 'amount-missing'],
    ['   ', 'amount-missing'],
    ['N/A', 'amount-not-numeric'],
    ['--', 'amount-not-numeric'],
    ['abc', 'amount-not-numeric'],
    ['1e3', 'amount-exponent-notation'],
    ['1E3', 'amount-exponent-notation'],
    ['Infinity', 'amount-not-numeric'],
    ['NaN', 'amount-not-numeric'],
    ['12.345', 'amount-too-precise'],
    ['-88.615', 'amount-too-precise'],
    ['1,23,456.00', 'amount-malformed-grouping'],
    ['12,34', 'amount-malformed-grouping'],
    ['1234,56', 'amount-malformed-grouping'],
    ['12.34.56', 'amount-not-numeric'],
    ['--5.00', 'amount-not-numeric'],
    ['1-2', 'amount-not-numeric'],
    ['(12.34', 'amount-not-numeric'],
    ['12.34)', 'amount-not-numeric'],
    ['€45.00', 'amount-non-usd-symbol'],
    ['£45.00', 'amount-non-usd-symbol'],
  ])('rejects %s as %s', (raw, code) => {
    expect(rejection(raw)).toBe(code);
  });

  it('rejects an amount beyond the storable range', () => {
    const overLimit = String(MAX_AMOUNT_CENTS / 100 + 1);
    expect(rejection(overLimit)).toBe('amount-out-of-range');
  });

  it('accepts an amount exactly at the range limit', () => {
    expect(cents(String(MAX_AMOUNT_CENTS / 100))).toBe(MAX_AMOUNT_CENTS);
  });

  it('rejects absurdly long digit strings before they become imprecise', () => {
    expect(rejection('9'.repeat(40))).toBe('amount-out-of-range');
  });
});

describe('formatCents', () => {
  it.each([
    [0, '0.00'],
    [7, '0.07'],
    [1234, '12.34'],
    [123456, '1,234.56'],
    [-1234, '-12.34'],
  ])('formats %i as %s', (value, expected) => {
    expect(formatCents(value)).toBe(expected);
  });
});
