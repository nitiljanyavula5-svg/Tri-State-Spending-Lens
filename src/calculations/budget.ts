import type { IsoDate, IsoMonth } from '../types/domain';
import { CATEGORIES } from '../domain/categories';
import type {
  AccountScope,
  BudgetProgress,
  Cents,
  IncomeCompleteness,
  Measured,
  Ratio,
  SelectableTransaction,
  StatementRange,
  UnavailableReason,
} from './types';
import { ratioOf, subtractCents } from './money';
import {
  daysBetween,
  daysInIsoMonth,
  firstDayOfMonth,
  isIsoDate,
  isIsoMonth,
  lastDayOfMonth,
  monthOf,
} from './period';
import {
  accountsInScope,
  accountsMissingCoverage,
  buildAccountCoverage,
  isRangeCoveredForScope,
} from './completeness';
import { selectPopulation } from './population';
import { partitionByTreatment, selectNetSpending } from './netSpending';
import { selectCategoryBreakdown } from './breakdowns';
import { selectCashFlow } from './cashFlow';

/**
 * Budget progress for one calendar month.
 *
 * calculation-contract.md §1 rule 1 forbids a second implementation of a shared
 * rule, and "what did this month cost" is the most shared rule there is. So
 * nothing here decides which rows count: the population comes from
 * `selectPopulation`, the treatment from `partitionByTreatment`, the total from
 * `selectNetSpending`, the per-category totals from `selectCategoryBreakdown`,
 * and observed income from `selectCashFlow`. A budget is a *limit placed beside*
 * those figures, never a second way of computing them.
 *
 * On account scope (§14.11): a monthly plan is workspace-wide and applies to
 * every **active** account. Archived accounts contribute nothing. That scope is
 * applied here by pre-filtering transactions against an explicit set rather than
 * by passing account ids through `DashboardFilters`, for two reasons that are
 * defects rather than preferences:
 *
 *   - `normalizeDashboardFilters` reads an empty account list as "no filter", so
 *     a workspace whose accounts are all archived would silently budget against
 *     every transaction it holds.
 *   - `boundedIds` truncates the list at `MAX_FILTER_VALUES`, a ceiling that
 *     exists to bound a user-driven multi-select. Scope is not user-driven, and
 *     an account dropped by that ceiling would vanish from actual spending with
 *     no warning.
 *
 * Dashboard filters, category selections, tags, and search state are deliberately
 * absent from this input. A budget answers "how does this month compare with the
 * plan", and a figure narrowed by whatever the user last clicked would not.
 */

/** The plan fields the calculation depends on. Presentation and ids stay out. */
export interface BudgetPlanInput {
  readonly month: IsoMonth;
  readonly overallLimitCents?: Cents | undefined;
  readonly incomeTargetCents?: Cents | undefined;
  readonly savingsTargetCents?: Cents | undefined;
}

export interface BudgetCategoryTargetInput {
  readonly categoryId: string;
  readonly limitCents: Cents;
}

export interface BudgetInput {
  readonly month: IsoMonth;
  /** `null` when no plan exists for this month. Not an empty plan (§10.2). */
  readonly plan: BudgetPlanInput | null;
  readonly categoryTargets: readonly BudgetCategoryTargetInput[];
  readonly transactions: readonly SelectableTransaction[];
  readonly accounts: readonly AccountScope[];
  readonly coverage: readonly StatementRange[];
  readonly incomeCompleteness: IncomeCompleteness;
  /** Local calendar day, injected so a test can freeze it (§14.9). */
  readonly today: IsoDate;
}

export type BudgetStatus = 'no-limit' | 'under' | 'at' | 'over';
export type CategoryBudgetStatus = 'under' | 'at' | 'over';
export type MonthPosition = 'past' | 'current' | 'future';

/**
 * Conditions that qualify a *plan*, not a figure.
 *
 * Both are neutral observations the interface reports and neither is a
 * validation failure: §10.4 allows category limits that exceed the overall
 * limit, and a savings target above the planned margin is a real thing a person
 * may intend. Rewriting either value to make them agree would answer a question
 * the user did not ask.
 */
export type BudgetPlanWarning =
  'category-targets-exceed-overall-limit' | 'savings-target-exceeds-planned-margin';

export interface CategoryBudgetProgress {
  readonly categoryId: string;
  readonly limitCents: Cents;
  readonly spentCents: Cents;
  readonly remainingCents: Cents;
  /** Unavailable for a zero limit: every share of zero is undefined, not 0%. */
  readonly usedRatio: Measured<Ratio>;
  readonly status: CategoryBudgetStatus;
}

export interface BudgetPace {
  readonly elapsedDays: number;
  readonly totalDays: number;
  readonly elapsedRatio: Ratio;
  readonly monthToDateCents: Cents;
  /** A modelling approximation, rounded to whole cents on purpose (§10.6). */
  readonly projectedSpendCents: Cents;
  /** limit − projected. Positive is under plan, negative is over. */
  readonly projectedOverUnderCents: Measured<Cents>;
}

export interface SavingsTargetProgress {
  readonly targetCents: Cents;
  readonly actualCents: Cents;
  readonly differenceCents: Cents;
  readonly meetsTarget: boolean;
}

export interface BudgetSelection {
  readonly month: IsoMonth;
  readonly monthPosition: MonthPosition;
  readonly hasPlan: boolean;

  readonly limitCents: Measured<Cents>;
  /** Canonical monthly net spending: gross included outflow − included refunds. */
  readonly actualCents: Cents;
  readonly grossOutflowCents: Cents;
  readonly refundsCents: Cents;
  readonly includedTransactionCount: number;
  readonly populationCount: number;
  readonly includedTransactionIds: readonly string[];

  readonly remainingCents: Measured<Cents>;
  /** The exact ratio. Clamping for a progress bar is presentation only (§10.3). */
  readonly usedRatio: Measured<Ratio>;
  readonly status: BudgetStatus;

  readonly categories: readonly CategoryBudgetProgress[];
  readonly categoryTargetTotalCents: Cents;
  /** Spending in categories with no target. Part of the overall actual (§10.4). */
  readonly untargetedSpendCents: Cents;
  readonly warnings: readonly BudgetPlanWarning[];

  readonly incomeTargetCents: Measured<Cents>;
  readonly savingsTargetCents: Measured<Cents>;
  readonly plannedMarginCents: Measured<Cents>;

  readonly observedIncomeCents: Measured<Cents>;
  readonly observedNetCashFlowCents: Measured<Cents>;
  readonly savingsTargetProgress: Measured<SavingsTargetProgress>;

  /** True only when every in-scope account independently covers the whole month. */
  readonly monthComplete: boolean;
  readonly accountsMissingCoverage: readonly string[];
  readonly scope: readonly string[];

  readonly pace: Measured<BudgetPace>;

  /** The settled Phase 0 `BudgetProgress` shape, so §14.5 is satisfied exactly. */
  readonly progress: BudgetProgress;
}

const unavailable = <T>(reason: UnavailableReason): Measured<T> => ({ available: false, reason });
const available = <T>(value: T): Measured<T> => ({ available: true, value });

/** Permanent domain order, never locale order or object insertion order (§10.4). */
const CATEGORY_ORDER = new Map(CATEGORIES.map((category, index) => [category.id, index]));

function compareCategories(a: string, b: string): number {
  const left = CATEGORY_ORDER.get(a);
  const right = CATEGORY_ORDER.get(b);
  // An id the domain does not know sorts after every known one, then by id, so
  // an unrecognised category is still deterministic rather than dropped.
  if (left === undefined && right === undefined) return a < b ? -1 : a > b ? 1 : 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function statusFor(limitCents: Cents, spentCents: Cents): CategoryBudgetStatus {
  if (spentCents > limitCents) return 'over';
  if (spentCents === limitCents) return 'at';
  return 'under';
}

/**
 * Where the month sits relative to the injected today.
 *
 * Compared as `YYYY-MM` strings, which order lexicographically exactly as they
 * order chronologically — so no calendar date is ever parsed into an instant
 * (§14.9).
 */
export function monthPositionOf(month: IsoMonth, today: IsoDate): MonthPosition {
  const current = monthOf(today);
  if (month < current) return 'past';
  if (month > current) return 'future';
  return 'current';
}

/** Net spending over an inclusive date range, for one already-scoped row set. */
function netOverRange(
  scoped: readonly SelectableTransaction[],
  start: IsoDate,
  end: IsoDate,
): {
  netCents: Cents;
  grossOutflowCents: Cents;
  refundsCents: Cents;
  rows: readonly SelectableTransaction[];
} {
  const population = selectPopulation(scoped, { range: { start, end } });
  const partition = partitionByTreatment(population);
  const net = selectNetSpending(partition);
  return {
    netCents: net.netSpendingCents,
    grossOutflowCents: net.grossOutflowCents,
    refundsCents: net.refundsCents,
    rows: population,
  };
}

/**
 * Budget progress for one month.
 *
 * Pure and total: no clock, no database, no I/O. Every branch returns a fully
 * populated selection, so a component never has to ask whether a field is
 * meaningful — an unavailable figure carries its own reason.
 */
export function selectBudgetProgress(input: BudgetInput): BudgetSelection {
  const { month, plan, today } = input;
  const monthStart = firstDayOfMonth(month);
  const monthEnd = lastDayOfMonth(month);
  const totalDays = daysInIsoMonth(month);
  const monthPosition = monthPositionOf(month, today);

  const coverage = buildAccountCoverage(input.coverage);
  const scope = accountsInScope(input.accounts, { range: { start: monthStart, end: monthEnd } });
  const inScope = new Set(scope);

  // Explicit scope, applied before the canonical population filter. See the
  // module comment for why this is not routed through `DashboardFilters`.
  const scoped = input.transactions.filter((row) => inScope.has(row.accountId));

  const monthTotals = netOverRange(scoped, monthStart, monthEnd);
  const population = monthTotals.rows;
  const partition = partitionByTreatment(population);
  const netSpending = selectNetSpending(partition);
  const actualCents = netSpending.netSpendingCents;

  const byCategory = selectCategoryBreakdown(partition);
  const spentByCategory = new Map(byCategory.map((slice) => [slice.key, slice.netCents]));

  /* ------------------------------------------------------------- overall - */

  const limit = plan?.overallLimitCents;
  const hasLimit = limit !== undefined;
  const limitCents: Measured<Cents> = hasLimit
    ? available(limit)
    : unavailable(plan === null ? 'no-budget-plan' : 'no-budget-limit-set');

  const remainingCents: Measured<Cents> = hasLimit
    ? available(subtractCents(limit, actualCents))
    : unavailable(plan === null ? 'no-budget-plan' : 'no-budget-limit-set');

  // `ratioOf` returns null for a zero denominator rather than Infinity or NaN.
  // A zero-dollar limit still has a computable *remaining*; what it has no
  // meaning for is a share of itself (§10.3).
  const rawUsedRatio = hasLimit ? ratioOf(actualCents, limit) : null;
  const usedRatio: Measured<Ratio> = !hasLimit
    ? unavailable(plan === null ? 'no-budget-plan' : 'no-budget-limit-set')
    : rawUsedRatio === null
      ? unavailable('not-applicable')
      : available(rawUsedRatio);

  const status: BudgetStatus = hasLimit ? statusFor(limit, actualCents) : 'no-limit';

  /* ------------------------------------------------------------ category - */

  const targets = [...input.categoryTargets].sort((a, b) =>
    compareCategories(a.categoryId, b.categoryId),
  );
  const targeted = new Set(targets.map((target) => target.categoryId));

  const categories: CategoryBudgetProgress[] = targets.map((target) => {
    const spentCents = spentByCategory.get(target.categoryId) ?? 0;
    const raw = ratioOf(spentCents, target.limitCents);
    return {
      categoryId: target.categoryId,
      limitCents: target.limitCents,
      spentCents,
      remainingCents: subtractCents(target.limitCents, spentCents),
      usedRatio: raw === null ? unavailable<Ratio>('not-applicable') : available(raw),
      status: statusFor(target.limitCents, spentCents),
    };
  });

  const categoryTargetTotalCents = targets.reduce((total, target) => total + target.limitCents, 0);

  // Kept visible rather than folded away: a category with no limit still spent
  // money, and the overall actual already contains it.
  const untargetedSpendCents = byCategory
    .filter((slice) => !targeted.has(slice.key))
    .reduce((total, slice) => total + slice.netCents, 0);

  /* -------------------------------------------------------------- income - */

  const incomeTarget = plan?.incomeTargetCents;
  const savingsTarget = plan?.savingsTargetCents;

  const incomeTargetCents: Measured<Cents> =
    incomeTarget === undefined ? unavailable('not-applicable') : available(incomeTarget);
  const savingsTargetCents: Measured<Cents> =
    savingsTarget === undefined ? unavailable('not-applicable') : available(savingsTarget);

  // A plan-side figure only. Never presented as observed income (§10.5).
  const plannedMarginCents: Measured<Cents> =
    incomeTarget === undefined || limit === undefined
      ? unavailable('not-applicable')
      : available(subtractCents(incomeTarget, limit));

  const warnings: BudgetPlanWarning[] = [];
  if (limit !== undefined && targets.length > 0 && categoryTargetTotalCents > limit) {
    warnings.push('category-targets-exceed-overall-limit');
  }
  if (
    savingsTarget !== undefined &&
    plannedMarginCents.available &&
    savingsTarget > plannedMarginCents.value
  ) {
    warnings.push('savings-target-exceeds-planned-margin');
  }

  // Observed income passes through the Phase 5 tri-state gate untouched, so a
  // budget page can never publish an income figure the Overview would withhold.
  const cashFlow = selectCashFlow(population, netSpending, input.incomeCompleteness);
  const observedIncomeCents = cashFlow.moneyInCents;
  const observedNetCashFlowCents = cashFlow.netCashFlowCents;

  const savingsTargetProgress: Measured<SavingsTargetProgress> =
    savingsTarget === undefined
      ? unavailable('not-applicable')
      : observedNetCashFlowCents.available
        ? available({
            targetCents: savingsTarget,
            actualCents: observedNetCashFlowCents.value,
            differenceCents: subtractCents(observedNetCashFlowCents.value, savingsTarget),
            meetsTarget: observedNetCashFlowCents.value >= savingsTarget,
          })
        : unavailable(observedNetCashFlowCents.reason);

  /* ---------------------------------------------------------- completeness */

  const missing = accountsMissingCoverage({ start: monthStart, end: monthEnd }, coverage, scope);
  const monthComplete = isRangeCoveredForScope(
    { start: monthStart, end: monthEnd },
    coverage,
    scope,
  );

  /* ------------------------------------------------------------------ pace */

  const pace = selectPace({
    month,
    monthPosition,
    monthStart,
    totalDays,
    today,
    scoped,
    scope,
    coverage,
    ambiguousAccountIds: coverage.ambiguousAccountIds,
    limitCents: limit,
  });

  const elapsedFraction: Measured<Ratio> = pace.available
    ? available(pace.value.elapsedRatio)
    : unavailable(pace.reason);
  const projectedSpendCents: Measured<Cents> = pace.available
    ? available(pace.value.projectedSpendCents)
    : unavailable(pace.reason);

  return {
    month,
    monthPosition,
    hasPlan: plan !== null,

    limitCents,
    actualCents,
    grossOutflowCents: netSpending.grossOutflowCents,
    refundsCents: netSpending.refundsCents,
    includedTransactionCount: netSpending.includedTransactionCount,
    populationCount: partition.populationCount,
    includedTransactionIds: [...partition.includedOutflow, ...partition.includedRefund]
      .map((row) => row.id)
      .sort(),

    remainingCents,
    usedRatio,
    status,

    categories,
    categoryTargetTotalCents,
    untargetedSpendCents,
    warnings,

    incomeTargetCents,
    savingsTargetCents,
    plannedMarginCents,

    observedIncomeCents,
    observedNetCashFlowCents,
    savingsTargetProgress,

    monthComplete,
    accountsMissingCoverage: missing,
    scope,

    pace,

    // The Phase 0 contract shape, filled from the same values above so the two
    // can never disagree.
    progress: {
      month,
      limitCents,
      spentCents: actualCents,
      remainingCents,
      spentFraction: usedRatio,
      elapsedFraction,
      projectedSpendCents,
    },
  };
}

interface PaceInput {
  readonly month: IsoMonth;
  readonly monthPosition: MonthPosition;
  readonly monthStart: IsoDate;
  readonly totalDays: number;
  readonly today: IsoDate;
  readonly scoped: readonly SelectableTransaction[];
  readonly scope: readonly string[];
  readonly coverage: ReturnType<typeof buildAccountCoverage>;
  readonly ambiguousAccountIds: readonly string[];
  readonly limitCents: Cents | undefined;
}

/**
 * A projection, or a named reason there is none.
 *
 * Every refusal below is deliberate. A projection is the one figure on this
 * page that describes a month that has not happened, so it is offered only when
 * the evidence supports the whole elapsed part of it: statements covering the
 * first of the month through today, for every account in scope, with no
 * ambiguous attribution among them. Projecting from partial statements would
 * scale a number that is already missing rows.
 */
function selectPace(input: PaceInput): Measured<BudgetPace> {
  const { month, monthPosition, monthStart, totalDays, today, scoped, scope, coverage } = input;

  // A finished month reports what happened. A future month has nothing to
  // extrapolate from. Neither is a failure, so both are "not applicable".
  if (monthPosition !== 'current') return unavailable('not-applicable');
  if (!isIsoMonth(month) || !isIsoDate(today)) return unavailable('not-applicable');
  if (scope.length === 0) return unavailable('not-applicable');

  // One ambiguous range naming an in-scope account is enough: it establishes
  // coverage for no account it names (§14.11), so the elapsed period cannot be
  // shown to be fully recorded.
  const ambiguous = new Set(input.ambiguousAccountIds);
  if (scope.some((accountId) => ambiguous.has(accountId))) {
    return unavailable('budget-coverage-incomplete');
  }

  if (!isRangeCoveredForScope({ start: monthStart, end: today }, coverage, scope)) {
    return unavailable('budget-coverage-incomplete');
  }

  // The current day counts as elapsed, so the first of the month is day 1.
  const elapsedDays = daysBetween(monthStart, today) + 1;
  if (elapsedDays <= 0 || elapsedDays > totalDays) return unavailable('not-applicable');

  const monthToDate = netOverRange(scoped, monthStart, today);
  const monthToDateCents = monthToDate.netCents;

  // Rounded because a projection *is* an approximation; §9 forbids feeding a
  // rounded presentation value back into a calculation, and this is not one —
  // it is the modelled figure itself, produced in whole cents.
  const projectedSpendCents = Math.round((monthToDateCents * totalDays) / elapsedDays);

  return available({
    elapsedDays,
    totalDays,
    elapsedRatio: elapsedDays / totalDays,
    monthToDateCents,
    projectedSpendCents,
    projectedOverUnderCents:
      input.limitCents === undefined
        ? unavailable<Cents>('no-budget-limit-set')
        : available(subtractCents(input.limitCents, projectedSpendCents)),
  });
}
