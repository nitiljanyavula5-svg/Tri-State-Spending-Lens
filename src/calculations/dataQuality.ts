import { UNCATEGORIZED_CATEGORY_ID } from '../domain/categories';
import type {
  DataQualityFlags,
  IncomeCompleteness,
  SelectableTransaction,
  TreatmentPartition,
} from './types';
import type { DashboardFilters } from './types';
import { sumBy } from './money';
import { isWholeCalendarMonth, monthOf, monthsInRange } from './period';
import { excludedIncomeRows, incomeCompletenessWarning } from './cashFlow';
import {
  accountsMissingCoverage,
  hasCoverageGapForScope,
  type AccountCoverage,
} from './completeness';
import { firstDayOfMonth, lastDayOfMonth } from './period';

/**
 * Every condition that qualifies a figure on this dashboard.
 *
 * data-methodology.md §6 requires analysis to state when it is standing on
 * incomplete data, and calculation-contract.md §14.7 makes the selector — not
 * the UI — responsible for detecting it. A warning computed in a component
 * would be a warning that disappears the moment someone builds a second view.
 *
 * Two conditions here are Phase 5 additions. Unknown *debits* are counted
 * separately from unknown credits (§14.4) because they bias a total the
 * opposite way: an unknown debit understates spending while an unknown credit
 * understates income, and one combined number would hide which. Income rows
 * carrying the user-exclusion flag are counted (§14.10) because the contract
 * removes them from money in and nothing else on the page would say so.
 */

/**
 * Share of included spending sitting in the uncategorized bucket, above which
 * the category breakdown is annotated (§6, "uncategorized share").
 *
 * A tenth is the point at which an "Other" slice stops being a rounding detail
 * and starts being the largest thing on the chart. Expressed as a ratio of
 * gross outflow, not of net, so a large refund cannot mask it.
 */
export const UNCATEGORIZED_MATERIAL_SHARE = 0.1;

/** Complete calendar months required before comparisons are offered (§6). */
export const MIN_COMPLETE_MONTHS_FOR_HISTORY = 2;

export interface DataQualityInput {
  readonly population: readonly SelectableTransaction[];
  readonly partition: TreatmentPartition;
  readonly filters: DashboardFilters;
  readonly coverage: AccountCoverage;
  /** Accounts that must independently be covered (§14.11). */
  readonly scope: readonly string[];
  readonly completeMonths: ReadonlySet<string>;
  readonly incomeCompleteness: IncomeCompleteness;
  readonly accountCount: number;
  readonly rejectedRowsPresent: boolean;
}

/**
 * Accounts in scope that do not independently cover the selected period.
 *
 * Deliberately broader than "the selected month is partial": any range with an
 * uncovered day is standing on data the import never claimed to hold, and a
 * month-over-month percentage drawn from it would be false precision. When the
 * period is a whole calendar month the month's own bounds are used, so a range
 * clipped to the month reads the same as the month itself.
 */
function uncoveredAccounts(input: DataQualityInput): string[] {
  const { filters, coverage, scope } = input;
  const range = isWholeCalendarMonth(filters.range)
    ? {
        start: firstDayOfMonth(monthOf(filters.range.start)),
        end: lastDayOfMonth(monthOf(filters.range.start)),
      }
    : filters.range;
  // An empty scope has no evidence of coverage; it is never complete (§14.11),
  // and reporting it as uncovered is how that surfaces.
  if (scope.length === 0) return [];
  return accountsMissingCoverage(range, coverage, scope);
}

export function selectDataQuality(input: DataQualityInput): DataQualityFlags {
  const { population, partition, coverage, scope, completeMonths, incomeCompleteness } = input;

  const unreviewedCredits = population.filter(
    (row) => row.kind === 'unknown' && row.direction === 'credit',
  ).length;
  const unreviewedDebits = population.filter(
    (row) => row.kind === 'unknown' && row.direction === 'debit',
  ).length;

  const uncategorizedIncludedCents = sumBy(
    [...partition.includedOutflow, ...partition.includedRefund].filter(
      (row) => row.categoryId === UNCATEGORIZED_CATEGORY_ID,
    ),
    (row) => row.amountCents,
  );

  // A card payment present with only one account imported means the other side
  // of the pair was never imported, so cash-flow claims are one-sided (§8).
  const hasPayments = population.some((row) => row.kind === 'payment');

  const uncovered = uncoveredAccounts(input);

  return {
    // Scope-empty is never complete (§14.11), so an empty scope is partial even
    // though no individual account can be named as missing.
    partialMonth: scope.length === 0 || uncovered.length > 0,
    // Legacy boolean: true for both non-confirmed states, and unable to say
    // which. `incomeCompletenessWarning` is the field new UI must read.
    incompleteIncome: incomeCompleteness !== 'confirmed-complete',
    incomeCompletenessWarning: incomeCompletenessWarning(incomeCompleteness),
    unreviewedCredits,
    uncategorizedIncludedCents,
    coverageGap: hasCoverageGapForScope(coverage, scope),
    singleAccountWithPayments: hasPayments && input.accountCount <= 1,
    rejectedRowsPresent: input.rejectedRowsPresent,
    insufficientHistory: completeMonths.size < MIN_COMPLETE_MONTHS_FOR_HISTORY,
    unreviewedDebits,
    excludedIncomeTransactionCount: excludedIncomeRows(population).length,
    sessionsMissingStatementRange: coverage.missingEndpoints,
    sessionsWithMalformedStatementRange: coverage.malformed,
    sessionsWithUnattributedStatementRange: coverage.unattributed,
    // Reported whole-workspace rather than scope-filtered: a range naming three
    // accounts is ambiguous however many of them the user is looking at, and
    // hiding that from a filtered view would make the same data explain a
    // missing comparison on one screen and not on another.
    ambiguousMultiAccountStatementRangeCount: coverage.ambiguousMultiAccount,
    accountsWithAmbiguousStatementCoverage: coverage.ambiguousAccountIds,
    accountsWithIncompleteCoverage: uncovered,
  };
}

/**
 * True when the uncategorized share is material enough to annotate the
 * category breakdown (§6).
 *
 * Returns false at zero gross outflow rather than dividing: no spending means
 * no share, which is a different statement from "zero percent uncategorized".
 */
export function isUncategorizedShareMaterial(
  uncategorizedIncludedCents: number,
  grossOutflowCents: number,
): boolean {
  if (grossOutflowCents <= 0) return false;
  return uncategorizedIncludedCents / grossOutflowCents >= UNCATEGORIZED_MATERIAL_SHARE;
}

/** Complete calendar months intersecting the selected range, for labelling averages (§7). */
export function completeMonthsInRange(
  filters: DashboardFilters,
  completeMonths: ReadonlySet<string>,
): string[] {
  return monthsInRange(filters.range).filter((month) => completeMonths.has(month));
}
