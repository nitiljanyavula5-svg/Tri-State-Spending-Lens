// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  describePeriod,
  latestCompleteMonth,
  monthRange,
  resolvePreset,
  transactionDateDomain,
  validateCustomRange,
  type PresetContext,
} from '../../../src/review/dashboardPeriod';
import type { SelectableTransaction } from '../../../src/calculations';

/**
 * Period presets, with the effective date frozen.
 *
 * Nothing here reads the system clock: "this month" is a claim about a specific
 * day, and a test that used the real date would pass in May and fail in June.
 */

const row = (postedDate: string): SelectableTransaction => ({
  id: postedDate,
  accountId: 'acct-checking',
  postedDate,
  amountCents: 100,
  direction: 'debit',
  kind: 'purchase',
  categoryId: 'groceries',
  merchantNormalized: 'ACME',
  excludedFromSpending: false,
});

const context = (overrides: Partial<PresetContext> = {}): PresetContext => ({
  today: '2026-05-14',
  domain: { start: '2026-03-02', end: '2026-05-28' },
  completeMonths: new Set(['2026-03', '2026-04']),
  ...overrides,
});

describe('the transaction date domain', () => {
  it('spans the earliest and latest stored dates', () => {
    expect(
      transactionDateDomain([row('2026-05-10'), row('2026-03-02'), row('2026-04-01')]),
    ).toEqual({ start: '2026-03-02', end: '2026-05-10' });
  });

  it('is null for an empty workspace rather than an invented range', () => {
    expect(transactionDateDomain([])).toBeNull();
  });

  it('ignores rows whose date is not a real calendar date', () => {
    expect(transactionDateDomain([row('2026-02-30'), row('2026-05-01')])).toEqual({
      start: '2026-05-01',
      end: '2026-05-01',
    });
  });
});

describe('presets', () => {
  it('defaults All data to the full transaction domain', () => {
    expect(resolvePreset('all-data', context())).toEqual({
      start: '2026-03-02',
      end: '2026-05-28',
    });
  });

  it('brackets everything when the workspace is empty, hiding no record', () => {
    const range = resolvePreset('all-data', context({ domain: null }));
    expect(range).toEqual({ start: '0000-01-01', end: '9999-12-31' });
  });

  it('resolves This month from the frozen date', () => {
    expect(resolvePreset('this-month', context())).toEqual({
      start: '2026-05-01',
      end: '2026-05-31',
    });
  });

  it('resolves Previous month, crossing a year boundary correctly', () => {
    expect(resolvePreset('previous-month', context())).toEqual({
      start: '2026-04-01',
      end: '2026-04-30',
    });
    expect(resolvePreset('previous-month', context({ today: '2027-01-09' }))).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    });
  });

  it('resolves Latest complete month from selector completeness, not transaction dates', () => {
    // The domain runs to May, but only March and April are statement-complete.
    expect(resolvePreset('latest-complete-month', context())).toEqual({
      start: '2026-04-01',
      end: '2026-04-30',
    });
  });

  it('offers no Latest complete month when none exists', () => {
    expect(
      resolvePreset('latest-complete-month', context({ completeMonths: new Set() })),
    ).toBeNull();
  });

  it('gives February 29 days in a leap year', () => {
    expect(resolvePreset('this-month', context({ today: '2028-02-13' }))).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
    });
  });

  it('returns null for custom, which the caller supplies', () => {
    expect(resolvePreset('custom', context())).toBeNull();
  });

  it('picks the latest month by calendar order', () => {
    expect(latestCompleteMonth(new Set(['2026-12', '2027-01', '2026-04']))).toBe('2027-01');
    expect(latestCompleteMonth(new Set())).toBeNull();
  });

  it('builds a whole-month range', () => {
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
});

describe('custom range validation', () => {
  it('accepts an inclusive well-formed range', () => {
    expect(validateCustomRange('2026-05-01', '2026-05-31')).toBeNull();
  });

  it('accepts a single-day range', () => {
    expect(validateCustomRange('2026-05-04', '2026-05-04')).toBeNull();
  });

  it('reports a reversed range without swapping the dates', () => {
    expect(validateCustomRange('2026-05-31', '2026-05-01')).toBe('reversed');
  });

  it('reports each malformed endpoint separately', () => {
    expect(validateCustomRange('nope', '2026-05-31')).toBe('start-invalid');
    expect(validateCustomRange('2026-05-01', '2026-02-30')).toBe('end-invalid');
    expect(validateCustomRange('', '')).toBe('start-invalid');
  });
});

describe('period description', () => {
  it('names All data without dates when the workspace is empty', () => {
    expect(describePeriod('all-data', { start: '0000-01-01', end: '9999-12-31' }, null)).toBe(
      'All data',
    );
  });

  it('shows the real domain when there is one', () => {
    expect(
      describePeriod(
        'all-data',
        { start: '2026-03-02', end: '2026-05-28' },
        {
          start: '2026-03-02',
          end: '2026-05-28',
        },
      ),
    ).toBe('All data (2026-03-02 to 2026-05-28)');
  });

  it('shows the selected bounds for any other preset', () => {
    expect(describePeriod('this-month', { start: '2026-05-01', end: '2026-05-31' }, null)).toBe(
      '2026-05-01 to 2026-05-31',
    );
  });
});
