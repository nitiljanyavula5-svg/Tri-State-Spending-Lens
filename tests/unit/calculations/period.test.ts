// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  daysInIsoMonth,
  daysInMonth,
  firstDayOfMonth,
  isIsoDate,
  isIsoMonth,
  isLeapYear,
  isWholeCalendarMonth,
  isWithinRange,
  lastDayOfMonth,
  monthOf,
  monthsInRange,
  nextMonth,
  parseIsoDate,
  previousMonth,
  startOfWeek,
} from '../../../src/calculations/period';

/**
 * Calendar arithmetic, against calculation-contract.md §14.9.
 *
 * The failure mode being excluded is subtle and only appears off-UTC: parsing
 * `2026-03-01` as an instant yields February 28 in any negative-offset zone, so
 * a "March" total silently borrows a day from February. Nothing in `period.ts`
 * constructs a Date from a string, and these tests pin the boundaries where that
 * bug would surface.
 */

describe('parsing and validation', () => {
  it('accepts a real calendar date', () => {
    expect(parseIsoDate('2026-05-15')).toEqual({ year: 2026, month: 5, day: 15 });
  });

  it('rejects a date that matches the shape but does not exist', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2027-02-29')).toBeNull();
    expect(isIsoDate('2026-02-30')).toBe(false);
  });

  it('rejects malformed shapes outright', () => {
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate('2026-5-15')).toBeNull();
    expect(parseIsoDate('05/15/2026')).toBeNull();
  });

  it('validates YYYY-MM months', () => {
    expect(isIsoMonth('2026-05')).toBe(true);
    expect(isIsoMonth('2026-13')).toBe(false);
    expect(isIsoMonth('2026-05-01')).toBe(false);
  });
});

describe('leap years', () => {
  it('applies the full Gregorian rule', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2027)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it('gives February 29 days in 2028', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInIsoMonth('2028-02')).toBe(29);
  });

  it('accepts February 29 2028 as a real date', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });
});

describe('day stepping', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
    expect(addDays('2026-06-01', -1)).toBe('2026-05-31');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('steps through February 29 in a leap year', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('skips February 29 in a non-leap year', () => {
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('is unaffected by DST transitions', () => {
    // US DST starts 2026-03-08 and ends 2026-11-01. A local-time implementation
    // drops or repeats an hour here and can land on the wrong calendar day.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('measures whole days across a leap month', () => {
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29);
    expect(daysBetween('2027-02-01', '2027-03-01')).toBe(28);
  });

  it('returns a malformed input unchanged rather than inventing a date', () => {
    expect(addDays('2026-02-30', 1)).toBe('2026-02-30');
  });
});

describe('month helpers', () => {
  it('derives the month by slicing, not by arithmetic', () => {
    expect(monthOf('2026-05-15')).toBe('2026-05');
    expect(monthOf('2026-01-01')).toBe('2026-01');
    expect(monthOf('2026-12-31')).toBe('2026-12');
  });

  it('bounds a month inclusively', () => {
    expect(firstDayOfMonth('2026-05')).toBe('2026-05-01');
    expect(lastDayOfMonth('2026-05')).toBe('2026-05-31');
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
  });

  it('steps months across a year boundary', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(previousMonth('2026-05')).toBe('2026-04');
  });

  it('lists every month a range touches', () => {
    expect(monthsInRange({ start: '2026-04-15', end: '2026-06-02' })).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  it('lists months across a year boundary', () => {
    expect(monthsInRange({ start: '2026-12-01', end: '2027-01-31' })).toEqual([
      '2026-12',
      '2027-01',
    ]);
  });

  it('returns nothing for an inverted range', () => {
    expect(monthsInRange({ start: '2026-06-01', end: '2026-05-01' })).toEqual([]);
  });
});

describe('whole calendar months', () => {
  it('recognises an exact month', () => {
    expect(isWholeCalendarMonth({ start: '2026-05-01', end: '2026-05-31' })).toBe(true);
    expect(isWholeCalendarMonth({ start: '2028-02-01', end: '2028-02-29' })).toBe(true);
  });

  it('rejects a range trimmed at either end', () => {
    expect(isWholeCalendarMonth({ start: '2026-05-02', end: '2026-05-31' })).toBe(false);
    expect(isWholeCalendarMonth({ start: '2026-05-01', end: '2026-05-30' })).toBe(false);
  });

  it('rejects a range spanning two months', () => {
    expect(isWholeCalendarMonth({ start: '2026-05-01', end: '2026-06-30' })).toBe(false);
  });

  it('rejects February 28 in a leap year as a whole month', () => {
    expect(isWholeCalendarMonth({ start: '2028-02-01', end: '2028-02-28' })).toBe(false);
  });
});

describe('range membership', () => {
  it('includes both endpoints', () => {
    const range = { start: '2026-05-01', end: '2026-05-31' };
    expect(isWithinRange('2026-05-01', range)).toBe(true);
    expect(isWithinRange('2026-05-31', range)).toBe(true);
    expect(isWithinRange('2026-04-30', range)).toBe(false);
    expect(isWithinRange('2026-06-01', range)).toBe(false);
  });
});

describe('week starts', () => {
  it('anchors to Sunday by default', () => {
    // 2026-05-15 is a Friday.
    expect(startOfWeek('2026-05-15')).toBe('2026-05-10');
  });

  it('anchors to Monday when asked', () => {
    expect(startOfWeek('2026-05-15', 'monday')).toBe('2026-05-11');
  });

  it('is stable on the anchor day itself', () => {
    expect(startOfWeek('2026-05-10')).toBe('2026-05-10');
  });
});
