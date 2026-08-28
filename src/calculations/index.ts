/**
 * The calculation layer's public surface.
 *
 * Everything a dashboard consumer needs is re-exported here so a component
 * imports from one place rather than reaching into individual modules. That is
 * not tidiness: calculation-contract.md §1 rule 1 requires a single shared
 * layer, and a barrel makes `selectDashboard` the obvious thing to reach for
 * and a per-module import the conspicuous one.
 *
 * The budget selector is Phase 6A and appears here. Recurring detection and
 * insights are Phase 6B and 6C and still do not.
 */

export type {
  AccountScope,
  BudgetProgress,
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

export {
  monthPositionOf,
  selectBudgetProgress,
  type BudgetCategoryTargetInput,
  type BudgetInput,
  type BudgetPace,
  type BudgetPlanInput,
  type BudgetPlanWarning,
  type BudgetSelection,
  type BudgetStatus,
  type CategoryBudgetProgress,
  type CategoryBudgetStatus,
  type MonthPosition,
  type SavingsTargetProgress,
} from './budget';
