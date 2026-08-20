import type { DashboardInput, DashboardSelection } from './types';
import { accountsInScope, buildAccountCoverage, completeMonthsForScope } from './completeness';
import { normalizeDashboardFilters, selectPopulation } from './population';
import { partitionByTreatment, selectNetSpending } from './netSpending';
import { selectCashFlow } from './cashFlow';
import { selectAccountBreakdown, selectCategoryBreakdown } from './breakdowns';
import { selectTimeSeries } from './timeSeries';
import { selectComparison } from './comparison';
import { selectDataQuality } from './dataQuality';
import { reconcile } from './reconciliation';

/**
 * One dashboard render, computed once.
 *
 * calculation-contract.md §1 rule 1: every card, chart, and table reads from a
 * single shared layer, because totals cannot disagree when there is only one
 * implementation. This function is that single entry point — the population is
 * filtered once, the treatment partition is built once, and every downstream
 * figure is derived from those same two values.
 *
 * Computing the pieces separately would reintroduce exactly the failure the
 * rule forbids: two callers passing slightly different filters would produce a
 * category chart that does not sum to the card above it, and each would be
 * internally consistent.
 *
 * Pure. No React, no Dexie, no clock, no I/O — everything it reads arrives in
 * `DashboardInput`, which is what makes the same figures reproducible in a test.
 */
export function selectDashboard(input: DashboardInput): DashboardSelection {
  const filters = normalizeDashboardFilters(input.filters);
  const coverage = buildAccountCoverage(input.coverage);
  // The accounts that must independently be covered (§14.11). Computed once and
  // threaded through every coverage question, so the time series, the warnings,
  // and the comparison can never disagree about which accounts were required.
  const scope = accountsInScope(input.accounts, filters);

  const population = selectPopulation(input.transactions, filters);
  const partition = partitionByTreatment(population);
  const netSpending = selectNetSpending(partition);

  const byCategory = selectCategoryBreakdown(partition);
  const byAccount = selectAccountBreakdown(partition);
  const timeSeries = selectTimeSeries(partition, filters.range, input.granularity, coverage, scope);

  return {
    population,
    partition,
    netSpending,
    cashFlow: selectCashFlow(population, netSpending, input.incomeCompleteness),
    byCategory,
    byAccount,
    timeSeries,
    comparison: selectComparison(input.transactions, filters, coverage, scope),
    dataQuality: selectDataQuality({
      population,
      partition,
      filters,
      coverage,
      scope,
      completeMonths: completeMonthsForScope(coverage, scope),
      incomeCompleteness: input.incomeCompleteness,
      accountCount: input.accounts.length,
      rejectedRowsPresent: input.rejectedRowsPresent ?? false,
    }),
    reconciliation: reconcile({
      population,
      partition,
      netSpending,
      byCategory,
      byAccount,
      timeSeries,
    }),
  };
}
