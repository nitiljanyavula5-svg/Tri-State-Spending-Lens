import type { IsoMonth } from '../types/domain';
import type {
  AccountScope,
  CoverageSpan,
  DashboardFilters,
  DateRange,
  StatementRange,
} from './types';
import { addDays, firstDayOfMonth, isIsoDate, lastDayOfMonth, monthsInRange } from './period';

/**
 * What the imported statements actually cover, per account.
 *
 * calculation-contract.md §14.2: completeness comes from confirmed statement
 * ranges and never from observed transaction dates. That distinction is the
 * whole point — a month in which someone simply spent nothing on the 1st is
 * complete, while a month whose statement begins on the 12th is not.
 *
 * §14.11 adds the second half: coverage is evaluated **per account**. Merging
 * every account's ranges into one union is how
 *
 *   Account A: January 1–15
 *   Account B: January 16–31
 *
 * comes to report a complete January that neither account has. The union covers
 * the month; each account is missing half of it, and a figure spanning both
 * would hide half of each account's activity behind a "complete" label.
 *
 * On "committed": `ImportSession` carries no status field, because it needs
 * none. `commitImportSession` writes the session row and its transactions in
 * one Dexie transaction, so a session row exists if and only if its import
 * completed. Presence in the table *is* the commit proof.
 */

export interface CoverageReport {
  /** Merged, sorted, non-overlapping, inclusive spans for one account. */
  readonly spans: readonly CoverageSpan[];
}

export interface AccountCoverage {
  /** Per-account merged coverage. Absent key means no usable range at all. */
  readonly byAccount: ReadonlyMap<string, CoverageReport>;
  /** Contributed nothing because an endpoint was absent. */
  readonly missingEndpoints: number;
  /** Contributed nothing because the range was reversed or not a calendar date. */
  readonly malformed: number;
  /** Contributed nothing because it named no account (§14.11). */
  readonly unattributed: number;
  /** Contributed nothing because it named more than one unique account (§14.11). */
  readonly ambiguousMultiAccount: number;
  /** Deduplicated, sorted accounts named by an ambiguous range (§14.11). */
  readonly ambiguousAccountIds: readonly string[];
}

/** Merges one account's spans. Adjacent spans merge, so a boundary is not a gap. */
function mergeSpans(spans: CoverageSpan[]): CoverageSpan[] {
  const sorted = [...spans].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: CoverageSpan[] = [];
  for (const span of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= addDays(previous.end, 1)) {
      if (span.end > previous.end) {
        merged[merged.length - 1] = { start: previous.start, end: span.end };
      }
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/** Deduplicated, deterministically ordered account ids for one range (§14.11). */
export function normalizeRangeAccountIds(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds)].sort((a, b) => a.localeCompare(b));
}

/**
 * Validates statement ranges and merges the usable ones **within each account**.
 *
 * `ImportSession.accountIds` is lossless for *identity* — commit validation
 * rejects any transaction whose account the session did not declare — but it is
 * not per-account *evidence*. A session stores one range however many accounts
 * it names, so a range naming several accounts cannot say what period any one
 * of their statements covered. Crediting it to all of them is how a January
 * checking statement comes to vouch for a card statement that started on the
 * 12th (§14.11).
 *
 * Each range therefore lands in exactly one bucket, in a fixed order, and is
 * counted once. Date validation runs before the account check: a range whose
 * dates are unusable carries no period at all, so its attribution is moot and
 * it is reported as malformed only, never also as ambiguous.
 *
 *   1. missing endpoint   → `missingEndpoints`
 *   2. malformed dates    → `malformed`
 *   3. zero unique ids    → `unattributed`
 *   4. many unique ids    → `ambiguousMultiAccount` (+ `ambiguousAccountIds`)
 *   5. one unique id      → establishes coverage
 *
 * Only case 5 produces coverage. The conservative direction is deliberate:
 * withholding a comparison is recoverable by importing per-account statements,
 * publishing one built on ambiguous evidence is not.
 */
export function buildAccountCoverage(ranges: readonly StatementRange[]): AccountCoverage {
  const perAccount = new Map<string, CoverageSpan[]>();
  const ambiguousAccounts = new Set<string>();
  let missingEndpoints = 0;
  let malformed = 0;
  let unattributed = 0;
  let ambiguousMultiAccount = 0;

  for (const range of ranges) {
    const { start, end } = range;
    if (start === undefined || end === undefined || start === '' || end === '') {
      missingEndpoints += 1;
      continue;
    }
    if (!isIsoDate(start) || !isIsoDate(end) || start > end) {
      malformed += 1;
      continue;
    }

    // `["acct-a", "acct-a"]` is one account, not two, and stays usable.
    const accountIds = normalizeRangeAccountIds(range.accountIds);

    if (accountIds.length === 0) {
      unattributed += 1;
      continue;
    }
    if (accountIds.length > 1) {
      ambiguousMultiAccount += 1;
      for (const accountId of accountIds) ambiguousAccounts.add(accountId);
      continue;
    }

    const accountId = accountIds[0] as string;
    const spans = perAccount.get(accountId);
    if (spans) spans.push({ start, end });
    else perAccount.set(accountId, [{ start, end }]);
  }

  const byAccount = new Map<string, CoverageReport>();
  for (const [accountId, spans] of perAccount) {
    byAccount.set(accountId, { spans: mergeSpans(spans) });
  }

  return {
    byAccount,
    missingEndpoints,
    malformed,
    unattributed,
    ambiguousMultiAccount,
    ambiguousAccountIds: [...ambiguousAccounts].sort((a, b) => a.localeCompare(b)),
  };
}

/** One account's merged coverage; empty when it has no usable range. */
export function coverageForAccount(coverage: AccountCoverage, accountId: string): CoverageReport {
  return coverage.byAccount.get(accountId) ?? { spans: [] };
}

/**
 * The accounts a calculation must have covered (§14.11).
 *
 * An explicit filter wins outright, archived or not: the user asked for those
 * accounts by name. With no filter, scope is every non-archived account, using
 * the domain's existing `archived` flag rather than an invented activity state.
 *
 * Category filters are ignored here on purpose. Filtering to Dining does not
 * reduce which accounts must be covered — a missing statement still hides
 * Dining rows.
 */
export function accountsInScope(
  accounts: readonly AccountScope[],
  filters: DashboardFilters,
): readonly string[] {
  if (filters.accountIds && filters.accountIds.length > 0) {
    return [...new Set(filters.accountIds)].sort((a, b) => a.localeCompare(b));
  }
  return accounts
    .filter((account) => !account.archived)
    .map((account) => account.id)
    .sort((a, b) => a.localeCompare(b));
}

/** True when every date in the inclusive range falls inside one merged span. */
export function isRangeCoveredForAccount(range: DateRange, report: CoverageReport): boolean {
  if (!isIsoDate(range.start) || !isIsoDate(range.end) || range.start > range.end) return false;
  return report.spans.some((span) => span.start <= range.start && span.end >= range.end);
}

/**
 * Accounts in scope that do not independently cover the range.
 *
 * Returned as a list rather than a boolean so the interface can name what is
 * missing instead of saying only that something is.
 */
export function accountsMissingCoverage(
  range: DateRange,
  coverage: AccountCoverage,
  scope: readonly string[],
): string[] {
  return scope.filter(
    (accountId) => !isRangeCoveredForAccount(range, coverageForAccount(coverage, accountId)),
  );
}

/**
 * True when every account in scope independently covers the range.
 *
 * An empty scope is **not** covered. A workspace with no accounts in scope has
 * no evidence of coverage at all, and reporting vacuous truth as a measured
 * result is exactly what §1 rule 5 forbids.
 */
export function isRangeCoveredForScope(
  range: DateRange,
  coverage: AccountCoverage,
  scope: readonly string[],
): boolean {
  if (scope.length === 0) return false;
  return accountsMissingCoverage(range, coverage, scope).length === 0;
}

/** True when every account in scope independently covers the whole month (§14.11). */
export function isMonthCompleteForScope(
  month: IsoMonth,
  coverage: AccountCoverage,
  scope: readonly string[],
): boolean {
  return isRangeCoveredForScope(
    { start: firstDayOfMonth(month), end: lastDayOfMonth(month) },
    coverage,
    scope,
  );
}

/**
 * Every calendar month complete for the whole scope.
 *
 * Candidate months come from the scope's own spans, so an accidental year-3000
 * range costs a bounded number of checks rather than a walk through the
 * intervening centuries.
 */
export function completeMonthsForScope(
  coverage: AccountCoverage,
  scope: readonly string[],
): ReadonlySet<IsoMonth> {
  const complete = new Set<IsoMonth>();
  if (scope.length === 0) return complete;

  const candidates = new Set<IsoMonth>();
  for (const accountId of scope) {
    for (const span of coverageForAccount(coverage, accountId).spans) {
      for (const month of monthsInRange({ start: span.start, end: span.end })) {
        candidates.add(month);
      }
    }
  }

  for (const month of candidates) {
    if (isMonthCompleteForScope(month, coverage, scope)) complete.add(month);
  }
  return complete;
}

/**
 * True when any account in scope has discontinuous coverage.
 *
 * Because touching spans already merged, a second span means a genuinely
 * missing stretch of statement, which trend charts must break across rather
 * than draw through.
 */
export function hasCoverageGapForScope(
  coverage: AccountCoverage,
  scope: readonly string[],
): boolean {
  return scope.some((accountId) => coverageForAccount(coverage, accountId).spans.length > 1);
}
