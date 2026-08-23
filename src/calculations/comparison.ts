import type {
  ComparisonResult,
  DashboardFilters,
  Measured,
  Ratio,
  SelectableTransaction,
  UnavailableReason,
} from './types';
import { ratioOf, subtractCents } from './money';
import {
  firstDayOfMonth,
  isWholeCalendarMonth,
  lastDayOfMonth,
  monthOf,
  previousMonth,
} from './period';
import { isMonthCompleteForScope, type AccountCoverage } from './completeness';
import { selectPopulation } from './population';
import { partitionByTreatment, selectNetSpending } from './netSpending';

/**
 * Current versus prior complete calendar month.
 *
 * calculation-contract.md §14.8 makes both conditions binding: the selected
 * period must be exactly one complete calendar month, and the *immediately*
 * preceding month must also be complete. Neither may be relaxed.
 *
 * The rule that matters most is the one about skipping. If March is incomplete,
 * a comparison of April against February is not a worse comparison — it is a
 * different claim, presented in the place a user reads as "versus last month".
 * Silently substituting an older month is how a percentage comes to describe a
 * period nobody selected, so an incomplete prior month yields an unavailable
 * result with a specific reason instead.
 *
 * §6 already forbids a month-over-month percentage when either month is
 * incomplete; this file is where that becomes unrepresentable rather than
 * merely discouraged.
 */

function unavailable(reason: UnavailableReason): Measured<ComparisonResult> {
  return { available: false, reason };
}

/**
 * Net spending for one whole calendar month, under the same account and
 * category filters as the selected period.
 *
 * The filters travel with the comparison deliberately: comparing a filtered
 * April against an unfiltered March would be a category error dressed up as a
 * trend.
 */
function netForMonth(
  transactions: readonly SelectableTransaction[],
  month: string,
  filters: DashboardFilters,
): number {
  const monthFilters: DashboardFilters = {
    range: { start: firstDayOfMonth(month), end: lastDayOfMonth(month) },
    ...(filters.accountIds ? { accountIds: filters.accountIds } : {}),
    ...(filters.categoryIds ? { categoryIds: filters.categoryIds } : {}),
  };
  const population = selectPopulation(transactions, monthFilters);
  return selectNetSpending(partitionByTreatment(population)).netSpendingCents;
}

export function selectComparison(
  transactions: readonly SelectableTransaction[],
  filters: DashboardFilters,
  coverage: AccountCoverage,
  scope: readonly string[],
): Measured<ComparisonResult> {
  if (!isWholeCalendarMonth(filters.range)) {
    return unavailable('period-not-complete-month');
  }

  // Both months are tested against the same account scope (§14.11), so one
  // account's statement can never complete a month for another.
  const currentMonth = monthOf(filters.range.start);
  if (!isMonthCompleteForScope(currentMonth, coverage, scope)) {
    return unavailable('partial-month');
  }

  const priorMonth = previousMonth(currentMonth);
  if (!isMonthCompleteForScope(priorMonth, coverage, scope)) {
    return unavailable('prior-month-incomplete');
  }

  const currentNetCents = netForMonth(transactions, currentMonth, filters);
  const priorNetCents = netForMonth(transactions, priorMonth, filters);
  const deltaCents = subtractCents(currentNetCents, priorNetCents);
  const ratio = ratioOf(deltaCents, priorNetCents);

  return {
    available: true,
    value: {
      currentMonth,
      priorMonth,
      currentNetCents,
      priorNetCents,
      deltaCents,
      // A prior month of exactly zero has no ratio: every change from zero is
      // an infinite percentage, which §1 rule 5 says to hide rather than print.
      deltaRatio:
        ratio === null
          ? ({ available: false, reason: 'not-applicable' } as Measured<Ratio>)
          : ({ available: true, value: ratio } as Measured<Ratio>),
    },
  };
}
