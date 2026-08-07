import { describe, expect, it } from 'vitest';
import {
  daysInMonth,
  detectDateFormat,
  isLeapYear,
  isRealCalendarDate,
  normalizeDate,
  validateStatementRange,
  type DateFormat,
} from '../../../src/import/dates';

function ok(raw: string, format: DateFormat): string {
  const result = normalizeDate(raw, format);
  if (!result.ok) throw new Error(`expected "${raw}" (${format}) to parse, got ${result.code}`);
  return result.value;
}

function code(raw: string, format: DateFormat): string {
  const result = normalizeDate(raw, format);
  if (result.ok) throw new Error(`expected "${raw}" (${format}) to be rejected`);
  return result.code;
}

describe('calendar arithmetic', () => {
  it.each([
    [2024, true],
    [2025, false],
    [2026, false],
    [2028, true],
    [1900, false],
    [2000, true],
  ])('treats %i leap status as %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });

  it('knows February in both kinds of year', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it.each([
    [2026, 2, 30, false],
    [2026, 13, 1, false],
    [2026, 0, 10, false],
    [2025, 2, 29, false],
    [2028, 2, 29, true],
    [2026, 4, 31, false],
    [2026, 4, 30, true],
    [2026, 12, 31, true],
  ])('isRealCalendarDate(%i,%i,%i) === %s', (y, m, d, expected) => {
    expect(isRealCalendarDate(y, m, d)).toBe(expected);
  });
});

describe('normalization under a confirmed format', () => {
  it('normalizes ISO input', () => {
    expect(ok('2026-03-04', 'iso')).toBe('2026-03-04');
    expect(ok('2026-3-4', 'iso')).toBe('2026-03-04');
  });

  it('normalizes month-first input, padded or not', () => {
    expect(ok('3/4/2026', 'us')).toBe('2026-03-04');
    expect(ok('03/04/2026', 'us')).toBe('2026-03-04');
    expect(ok('12/31/2025', 'us')).toBe('2025-12-31');
  });

  it('normalizes day-first input', () => {
    expect(ok('4/3/2026', 'eu')).toBe('2026-03-04');
    expect(ok('31/12/2025', 'eu')).toBe('2025-12-31');
  });

  it('reads the same day differently under each format, which is why the user confirms', () => {
    expect(ok('01/02/2026', 'us')).toBe('2026-01-02');
    expect(ok('01/02/2026', 'eu')).toBe('2026-02-01');
  });

  it('accepts dot and dash separators', () => {
    expect(ok('3-4-2026', 'us')).toBe('2026-03-04');
    expect(ok('3.4.2026', 'us')).toBe('2026-03-04');
  });
});

describe('refusals', () => {
  it.each([
    ['', 'iso', 'date-missing'],
    ['   ', 'iso', 'date-missing'],
    ['not a date', 'iso', 'date-unparseable'],
    ['2026-02-30', 'iso', 'date-not-a-real-day'],
    ['2026-13-01', 'iso', 'date-not-a-real-day'],
    ['2025-02-29', 'iso', 'date-not-a-real-day'],
    // Date-shaped, but names a day that cannot exist under either ordering.
    ['13/45/2026', 'us', 'date-not-a-real-day'],
    ['2/30/2026', 'us', 'date-not-a-real-day'],
  ] as const)('rejects %s under %s as %s', (raw, format, expected) => {
    expect(code(raw, format)).toBe(expected);
  });

  it('never lets a JavaScript Date roll an impossible day into a real one', () => {
    // `new Date(2026, 1, 30)` silently becomes March 2nd. If this ever returns
    // a value, the implementation has started constructing Dates.
    expect(code('2026-02-30', 'iso')).toBe('date-not-a-real-day');
    expect(code('2026-04-31', 'iso')).toBe('date-not-a-real-day');
  });

  it('refuses two-digit years rather than guessing a century', () => {
    expect(code('03/04/26', 'us')).toBe('date-unparseable');
  });

  it('refuses a year-first value under a day-first format and vice versa', () => {
    expect(code('2026-03-04', 'us')).toBe('date-unparseable');
    expect(code('3/4/2026', 'iso')).toBe('date-unparseable');
  });

  it('reports a swapped day and month as a format conflict, not a broken row', () => {
    // 13 cannot be a month, so this file is not month-first.
    expect(code('3/13/2026', 'eu')).toBe('date-format-conflict');
    expect(code('13/3/2026', 'us')).toBe('date-format-conflict');
  });
});

describe('format detection proposes but never decides', () => {
  it('reports ambiguity when both orderings fit every sample', () => {
    const detection = detectDateFormat(['01/02/2026', '03/04/2026', '05/06/2026']);
    expect(detection.candidates).toEqual(['us', 'eu']);
    expect(detection.ambiguous).toBe(true);
    expect(detection.recommended).toBe('us');
    expect(detection.discriminator).toBeNull();
  });

  it('resolves the ordering when a value rules one out, and says which', () => {
    const detection = detectDateFormat(['01/02/2026', '3/13/2026']);
    expect(detection.candidates).toEqual(['us']);
    expect(detection.ambiguous).toBe(false);
    expect(detection.discriminator).toBe('3/13/2026');
  });

  it('detects ISO unambiguously', () => {
    const detection = detectDateFormat(['2026-01-02', '2026-03-04']);
    expect(detection.candidates).toEqual(['iso']);
    expect(detection.ambiguous).toBe(false);
  });

  it('returns no candidate when nothing fits', () => {
    const detection = detectDateFormat(['whenever', '2026-02-30']);
    expect(detection.candidates).toEqual([]);
    expect(detection.recommended).toBeNull();
  });

  it('ignores blank samples', () => {
    const detection = detectDateFormat(['', '   ', '2026-01-02']);
    expect(detection.sampleCount).toBe(1);
    expect(detection.candidates).toEqual(['iso']);
  });
});

describe('statement range', () => {
  it('accepts an ordered range of real dates', () => {
    expect(validateStatementRange('2026-04-01', '2026-07-31').ok).toBe(true);
  });

  it('accepts an absent range', () => {
    expect(validateStatementRange(undefined, undefined).ok).toBe(true);
    expect(validateStatementRange('', '').ok).toBe(true);
  });

  it('refuses an impossible date', () => {
    expect(validateStatementRange('2026-02-30', '2026-07-31').ok).toBe(false);
  });

  it('refuses a start after the end', () => {
    const result = validateStatementRange('2026-07-31', '2026-04-01');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/after the statement end/i);
  });

  it('accepts a single-day range', () => {
    expect(validateStatementRange('2026-04-01', '2026-04-01').ok).toBe(true);
  });
});
