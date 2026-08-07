import type { RejectionCode } from './errors';

/**
 * Calendar-date normalization.
 *
 * data-methodology.md §3.3: dates are stored as `YYYY-MM-DD` with no time and
 * no timezone; the format is *confirmed by the user*, never silently inferred;
 * ambiguous values resolve by the confirmed file-level format, never per row;
 * and a date that does not exist is rejected rather than coerced.
 *
 * Nothing here constructs a `Date`. `new Date(2026, 1, 30)` silently becomes
 * March 2nd — exactly the rollover that would turn an invalid row into a
 * plausible wrong one. Validation is done with an explicit calendar instead.
 */

export type DateFormat = 'iso' | 'us' | 'eu';

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  iso: 'Year first (2026-03-04)',
  us: 'Month first (3/4/2026)',
  eu: 'Day first (4/3/2026)',
};

export type DateParseResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: RejectionCode };

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/** True only for a day that exists on the proleptic Gregorian calendar. */
export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1000 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Three integer components, or null when the shape is not a date at all. */
interface DateParts {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  /** True when the first component is a 4-digit year. */
  readonly yearFirst: boolean;
}

function splitDate(raw: string): DateParts | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const match = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/.exec(text);
  if (!match) return null;

  const first = match[1]!;
  const third = match[3]!;

  // A two-digit year would require guessing a century. data-methodology.md
  // rejects rather than coerces, so `03/04/26` is refused with an explanation
  // instead of silently becoming 2026.
  const yearFirst = first.length === 4;
  if (!yearFirst && third.length !== 4) return null;
  if (yearFirst && third.length > 2) return null;

  return {
    a: Number(first),
    b: Number(match[2]!),
    c: Number(third),
    yearFirst,
  };
}

/**
 * Normalizes one cell under an already-confirmed format.
 *
 * `date-format-conflict` is distinct from `date-not-a-real-day`: it means the
 * row is impossible *under this format* but would be valid under another, which
 * is the signal the wizard surfaces as "the day and month may be swapped".
 */
export function normalizeDate(raw: string, format: DateFormat): DateParseResult {
  if (raw.trim().length === 0) return { ok: false, code: 'date-missing' };

  const parts = splitDate(raw);
  if (!parts) return { ok: false, code: 'date-unparseable' };

  let year: number;
  let month: number;
  let day: number;

  if (format === 'iso') {
    if (!parts.yearFirst) return { ok: false, code: 'date-unparseable' };
    year = parts.a;
    month = parts.b;
    day = parts.c;
  } else {
    if (parts.yearFirst) return { ok: false, code: 'date-unparseable' };
    year = parts.c;
    if (format === 'us') {
      month = parts.a;
      day = parts.b;
    } else {
      day = parts.a;
      month = parts.b;
    }
  }

  if (isRealCalendarDate(year, month, day)) {
    return { ok: true, value: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` };
  }

  // Would swapping day and month have produced a real date? If so this is a
  // format conflict, not a broken row.
  if (format !== 'iso' && isRealCalendarDate(year, day, month)) {
    return { ok: false, code: 'date-format-conflict' };
  }

  return { ok: false, code: 'date-not-a-real-day' };
}

/* ------------------------------------------------------------- detection - */

export interface DateFormatDetection {
  /** Formats under which every sampled value is a real date. */
  readonly candidates: readonly DateFormat[];
  /** The format to pre-select. Null when nothing fits. */
  readonly recommended: DateFormat | null;
  /**
   * True when more than one format fits every sample, so the file cannot
   * distinguish them on its own and the user must decide.
   */
  readonly ambiguous: boolean;
  /**
   * A sampled value that rules out the alternatives, when one exists — e.g. a
   * `13` in the month position proves day-first. Safe to show: it is a date,
   * not a personal value.
   */
  readonly discriminator: string | null;
  readonly sampleCount: number;
}

/**
 * Proposes a date format from sampled cells.
 *
 * Detection only ever *proposes*. data-methodology.md §3.3 requires the user to
 * confirm, which is why `ambiguous` is reported rather than resolved: with only
 * values like `01/02/2026` in the file, month-first and day-first are equally
 * consistent and guessing would silently misdate every row.
 */
export function detectDateFormat(samples: readonly string[]): DateFormatDetection {
  const usable = samples.map((s) => s.trim()).filter((s) => s.length > 0);

  if (usable.length === 0) {
    return {
      candidates: [],
      recommended: null,
      ambiguous: false,
      discriminator: null,
      sampleCount: 0,
    };
  }

  const order: readonly DateFormat[] = ['iso', 'us', 'eu'];
  const candidates = order.filter((format) =>
    usable.every((sample) => normalizeDate(sample, format).ok),
  );

  // Find a value that separates month-first from day-first.
  let discriminator: string | null = null;
  if (candidates.includes('us') !== candidates.includes('eu')) {
    const winner: DateFormat = candidates.includes('us') ? 'us' : 'eu';
    const loser: DateFormat = winner === 'us' ? 'eu' : 'us';
    discriminator =
      usable.find(
        (sample) => normalizeDate(sample, winner).ok && !normalizeDate(sample, loser).ok,
      ) ?? null;
  }

  return {
    candidates,
    recommended: candidates[0] ?? null,
    ambiguous: candidates.length > 1,
    discriminator,
    sampleCount: usable.length,
  };
}

/* ------------------------------------------------------- statement range - */

/** Validates an optional statement range: real dates, correctly ordered. */
export function validateStatementRange(
  start: string | undefined,
  end: string | undefined,
): { ok: true } | { ok: false; message: string } {
  const check = (value: string): boolean => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    return isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
  };

  if (start !== undefined && start.length > 0 && !check(start)) {
    return { ok: false, message: 'The statement start date is not a real calendar date.' };
  }
  if (end !== undefined && end.length > 0 && !check(end)) {
    return { ok: false, message: 'The statement end date is not a real calendar date.' };
  }
  if (start && end && start > end) {
    return { ok: false, message: 'The statement start date is after the statement end date.' };
  }
  return { ok: true };
}
