import type { IsoDate, IsoMonth } from '../types/domain';
import type { DateRange } from './types';

/**
 * Calendar arithmetic on `YYYY-MM-DD` strings.
 *
 * calculation-contract.md §14.9: a stored date is a *calendar date*, not an
 * instant. `new Date('2026-03-01')` parses as UTC midnight and then reports
 * February 28 to anyone west of Greenwich, so a "monthly" total computed that
 * way is wrong for roughly half the planet and right on the machine that wrote
 * the test. Nothing in this file constructs a `Date` from a string.
 *
 * Day stepping goes through `Date.UTC` with `getUTC*` accessors only. That is
 * pure integer arithmetic on a fixed epoch — it cannot observe a local zone or
 * a DST transition — while still getting month lengths and leap years right
 * without a hand-rolled calendar table.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_PATTERN = /^\d{4}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Days in a 1-based month. February answers 29 in a leap year. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] ?? 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Parses a stored date, or `null` when it is not a real calendar date.
 *
 * Shape and existence are checked separately on purpose: `2026-02-30` matches
 * the pattern and is not a date. data-methodology.md §3.3 rejects such values at
 * import, so one reaching here means a restored backup or a hand-edited record,
 * and the honest answer is `null` rather than a silently shifted date.
 */
export function parseIsoDate(value: string): CalendarDate | null {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

export function isIsoMonth(value: string): boolean {
  if (!ISO_MONTH_PATTERN.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

export function toIsoDate(date: CalendarDate): IsoDate {
  return `${String(date.year).padStart(4, '0')}-${pad2(date.month)}-${pad2(date.day)}`;
}

/** The `YYYY-MM` a date falls in. String slice: no arithmetic, no zone. */
export function monthOf(date: IsoDate): IsoMonth {
  return date.slice(0, 7);
}

export function firstDayOfMonth(month: IsoMonth): IsoDate {
  return `${month}-01`;
}

export function lastDayOfMonth(month: IsoMonth): IsoDate {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return `${month}-${pad2(daysInMonth(year, monthNumber))}`;
}

/** Days in the calendar month a `YYYY-MM` names. */
export function daysInIsoMonth(month: IsoMonth): number {
  return daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
}

function toUtcMillis(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function fromUtcMillis(millis: number): CalendarDate {
  const date = new Date(millis);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * Steps a date by whole days.
 *
 * Correct across month ends, year ends, and February 29 because the underlying
 * epoch arithmetic knows the calendar. Returns the input unchanged when it is
 * not a real date, so a malformed value never becomes a plausible-looking one.
 */
export function addDays(date: IsoDate, days: number): IsoDate {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  return toIsoDate(fromUtcMillis(toUtcMillis(parsed) + days * MS_PER_DAY));
}

/** Inclusive day count between two dates; negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (!start || !end) return 0;
  return Math.round((toUtcMillis(end) - toUtcMillis(start)) / MS_PER_DAY);
}

/** ISO dates sort lexically, which is the whole reason they are stored that way. */
export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive at both ends (§14.9). */
export function isWithinRange(date: IsoDate, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

export function previousMonth(month: IsoMonth): IsoMonth {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return monthNumber === 1 ? `${year - 1}-12` : `${year}-${pad2(monthNumber - 1)}`;
}

export function nextMonth(month: IsoMonth): IsoMonth {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return monthNumber === 12 ? `${year + 1}-01` : `${year}-${pad2(monthNumber + 1)}`;
}

/** Every `YYYY-MM` touched by a range, in order. Empty when the range is inverted. */
export function monthsInRange(range: DateRange): IsoMonth[] {
  if (!isIsoDate(range.start) || !isIsoDate(range.end)) return [];
  if (range.start > range.end) return [];
  const months: IsoMonth[] = [];
  let cursor = monthOf(range.start);
  const last = monthOf(range.end);
  while (cursor <= last) {
    months.push(cursor);
    cursor = nextMonth(cursor);
  }
  return months;
}

/**
 * True when a range is exactly one whole calendar month.
 *
 * The gate for month-over-month comparison (§14.8). "Exactly" is literal: the
 * first through the last day, with no day trimmed at either end.
 */
export function isWholeCalendarMonth(range: DateRange): boolean {
  if (!isIsoDate(range.start) || !isIsoDate(range.end)) return false;
  const month = monthOf(range.start);
  if (monthOf(range.end) !== month) return false;
  return range.start === firstDayOfMonth(month) && range.end === lastDayOfMonth(month);
}

export type WeekStart = 'sunday' | 'monday';

/**
 * The first day of the week containing `date`.
 *
 * Uses `getUTCDay` on an epoch-anchored value, so the weekday is a property of
 * the calendar date rather than of the machine's zone.
 */
export function startOfWeek(date: IsoDate, weekStart: WeekStart = 'sunday'): IsoDate {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  const weekday = new Date(toUtcMillis(parsed)).getUTCDay();
  const offset = weekStart === 'monday' ? (weekday + 6) % 7 : weekday;
  return addDays(date, -offset);
}
