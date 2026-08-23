import type { IsoDate, IsoMonth } from '../types/domain';
import type { DateRange, SelectableTransaction } from '../calculations';
import {
  firstDayOfMonth,
  isIsoDate,
  lastDayOfMonth,
  monthOf,
  previousMonth,
} from '../calculations';

/**
 * The dashboard's period presets.
 *
 * Pure and separated from the hook so every preset can be tested against a
 * frozen date without mounting React. calculation-contract.md §14.9 forbids
 * treating a stored `YYYY-MM-DD` as an instant, so nothing here parses a date
 * string into a `Date` — month arithmetic goes through the calculation layer's
 * calendar helpers, and "today" is read from local calendar *parts* rather than
 * from a string.
 */

export type PeriodPreset =
  'all-data' | 'this-month' | 'previous-month' | 'latest-complete-month' | 'custom';

/** Reads the current local calendar date. Injected so tests can freeze it. */
export type TodayProvider = () => IsoDate;

/**
 * Local calendar day, assembled from parts.
 *
 * `new Date()` is a real instant, which is the correct source for "what day is
 * it here"; the hazard §14.9 names is *parsing* a date-only string. Reading
 * `getFullYear`/`getMonth`/`getDate` never crosses a zone boundary the way
 * `new Date('2026-05-01')` does.
 */
export const systemToday: TodayProvider = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

/**
 * Widest bracket over stored dates, used only when a workspace holds nothing.
 *
 * Not a claim about what was imported: an empty workspace has no date domain,
 * and the UI says "All data" without dates rather than showing these. They exist
 * so the selector still receives a well-formed inclusive range that hides no row.
 */
const OPEN_START = '0000-01-01';
const OPEN_END = '9999-12-31';

/**
 * The span actually covered by stored transactions.
 *
 * `null` when the workspace holds no usable date — the honest answer, and what
 * lets the caller avoid manufacturing bounds it cannot support.
 */
export function transactionDateDomain(
  transactions: readonly SelectableTransaction[],
): DateRange | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const row of transactions) {
    if (!isIsoDate(row.postedDate)) continue;
    if (start === null || row.postedDate < start) start = row.postedDate;
    if (end === null || row.postedDate > end) end = row.postedDate;
  }
  return start !== null && end !== null ? { start, end } : null;
}

/** The whole-month range for a `YYYY-MM`. */
export function monthRange(month: IsoMonth): DateRange {
  return { start: firstDayOfMonth(month), end: lastDayOfMonth(month) };
}

/** Latest complete month in a scope-wide set, or `null` when there is none. */
export function latestCompleteMonth(completeMonths: ReadonlySet<IsoMonth>): IsoMonth | null {
  let latest: IsoMonth | null = null;
  for (const month of completeMonths) {
    if (latest === null || month > latest) latest = month;
  }
  return latest;
}

export interface PresetContext {
  readonly today: IsoDate;
  readonly domain: DateRange | null;
  readonly completeMonths: ReadonlySet<IsoMonth>;
}

/**
 * The range a preset resolves to, or `null` when the preset cannot be offered.
 *
 * `latest-complete-month` returns `null` when no month is complete for the
 * current account scope — the control is then disabled rather than silently
 * falling back to a different period, which would label one month's figures with
 * another month's name.
 */
export function resolvePreset(preset: PeriodPreset, context: PresetContext): DateRange | null {
  switch (preset) {
    case 'all-data':
      return context.domain ?? { start: OPEN_START, end: OPEN_END };
    case 'this-month':
      return monthRange(monthOf(context.today));
    case 'previous-month':
      return monthRange(previousMonth(monthOf(context.today)));
    case 'latest-complete-month': {
      const month = latestCompleteMonth(context.completeMonths);
      return month === null ? null : monthRange(month);
    }
    default:
      return null;
  }
}

export const PERIOD_PRESETS: readonly { value: PeriodPreset; label: string }[] = [
  { value: 'all-data', label: 'All data' },
  { value: 'this-month', label: 'This month' },
  { value: 'previous-month', label: 'Previous month' },
  { value: 'latest-complete-month', label: 'Latest complete month' },
  { value: 'custom', label: 'Custom' },
];

export type CustomRangeError = 'start-invalid' | 'end-invalid' | 'reversed' | null;

/**
 * Validates a custom range without correcting it.
 *
 * A reversed range is reported, never swapped: silently reordering the user's
 * dates would answer a question they did not ask, and they would have no way to
 * tell it happened.
 */
export function validateCustomRange(start: string, end: string): CustomRangeError {
  if (!isIsoDate(start)) return 'start-invalid';
  if (!isIsoDate(end)) return 'end-invalid';
  if (start > end) return 'reversed';
  return null;
}

export const CUSTOM_RANGE_MESSAGES: Readonly<Record<NonNullable<CustomRangeError>, string>> = {
  'start-invalid': 'Enter a start date as a real calendar date.',
  'end-invalid': 'Enter an end date as a real calendar date.',
  reversed: 'The start date is after the end date. Adjust one of them to continue.',
};

/** Human label for the active period, with no fabricated dates for an empty workspace. */
export function describePeriod(
  preset: PeriodPreset,
  range: DateRange,
  domain: DateRange | null,
): string {
  if (preset === 'all-data') {
    return domain === null ? 'All data' : `All data (${domain.start} to ${domain.end})`;
  }
  return `${range.start} to ${range.end}`;
}
