/**
 * The calculation layer's public surface.
 *
 * Everything a dashboard consumer needs is re-exported here so a component
 * imports from one place rather than reaching into individual modules. That is
 * not tidiness: calculation-contract.md §1 rule 1 requires a single shared
 * layer, and a barrel makes `selectDashboard` the obvious thing to reach for
 * and a per-module import the conspicuous one.
 *
 * No budget or recurring selector appears here. Both are Phase 6 (§14.5).
 */

export type {
  AccountScope,
  BreakdownSlice,
  BucketGranularity,
  CashFlowSummary,
  Cents,
  ComparisonResult,
  CoverageSpan,
  DashboardFilters,
  DashboardInput,
  DashboardSelection,
  DataQualityFlags,
  DateRange,
  IncomeCompleteness,
  Measured,
  NetSpendingBreakdown,
  Ratio,
  ReconciliationCheck,
  ReconciliationReport,
  SelectableTransaction,
  StatementRange,
  TimeBucket,
  TreatmentPartition,
  UnavailableReason,
} from './types';

export { selectDashboard } from './selectors';

export {
  assertIntegerCents,
  isIntegerCents,
  ratioOf,
  subtractCents,
  sumBy,
  sumCents,
} from './money';

export {
  addDays,
  compareIsoDate,
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
  toIsoDate,
  type CalendarDate,
  type WeekStart,
} from './period';

export {
  accountsInScope,
  accountsMissingCoverage,
  buildAccountCoverage,
  completeMonthsForScope,
  coverageForAccount,
  hasCoverageGapForScope,
  isMonthCompleteForScope,
  isRangeCoveredForAccount,
  isRangeCoveredForScope,
  normalizeRangeAccountIds,
  type AccountCoverage,
  type CoverageReport,
} from './completeness';

export {
  countUnusableDates,
  normalizeDashboardFilters,
  selectPopulation,
  toTransactionFilters,
} from './population';

export {
  emptyPartition,
  includedRows,
  partitionByTreatment,
  selectNetSpending,
  signedContribution,
} from './netSpending';

export {
  excludedIncomeRows,
  includedIncomeRows,
  incomeCompletenessFrom,
  incomeCompletenessWarning,
  incomeUnavailableReason,
  selectCashFlow,
} from './cashFlow';

export {
  selectAccountBreakdown,
  selectCategoryBreakdown,
  sortSlices,
  totalNetCents,
} from './breakdowns';

export { bucketBoundaries, selectTimeSeries, totalBucketNetCents } from './timeSeries';

export { selectComparison } from './comparison';

export {
  completeMonthsInRange,
  isUncategorizedShareMaterial,
  selectDataQuality,
  MIN_COMPLETE_MONTHS_FOR_HISTORY,
  UNCATEGORIZED_MATERIAL_SHARE,
  type DataQualityInput,
} from './dataQuality';

export { reconcile, type ReconciliationInput } from './reconciliation';
