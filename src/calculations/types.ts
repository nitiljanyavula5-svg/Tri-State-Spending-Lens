/**
 * Shared calculation interfaces.
 *
 * Master plan §16 Phase 2 delivers "repositories and shared calculation
 * interfaces"; Phase 5 delivers "the calculation contract as pure tested
 * selectors". This file is therefore the *contract only* — the types every
 * card, chart, table, and budget bar will be built against. It intentionally
 * contains no arithmetic.
 *
 * The single most important design decision here is `Measured<T>`. The
 * calculation contract (§1 rule 5) requires that an undefined value be hidden
 * with an explanation and never rendered as `0`, `—`, or `0%`. Returning a
 * bare `number` would make that rule a convention nobody enforces; returning a
 * discriminated union makes "0" and "not computable" impossible to confuse,
 * because the type system will not let a caller read `.value` without first
 * handling the unavailable case.
 */

import type { Account, IsoDate, IsoMonth, TransactionKind } from '../types/domain';

/**
 * Why a figure cannot be shown. Each maps to a gate in calculation-contract.md §6.
 *
 * `income-data-incomplete` and `income-completeness-unconfirmed` are
 * deliberately separate (§14.1). One is a statement the user made; the other is
 * the absence of one, and collapsing them would let an unconfirmed workspace
 * present the same explanation as a confirmed-incomplete one. There are exactly
 * these two income-completeness reasons; no alias for either exists.
 */
export type UnavailableReason =
  | 'no-income-data'
  | 'income-data-incomplete'
  | 'income-completeness-unconfirmed'
  | 'no-budget-limit-set'
  | 'partial-month'
  | 'insufficient-history'
  | 'no-included-transactions'
  /** The selected range is not exactly one complete calendar month (§14.8). */
  | 'period-not-complete-month'
  /** The immediately preceding calendar month is not complete (§14.8). */
  | 'prior-month-incomplete'
  | 'not-applicable'
  /**
   * Phase 6A budget reasons.
   *
   * Additive. `no-budget-limit-set` was reserved for budgeting from the start,
   * and these three name the other ways a budget figure can be honestly absent:
   * no plan at all, a period that is not one calendar month, and an elapsed
   * period the statements do not cover well enough to project from. Reusing
   * `period-not-complete-month` for the second was rejected because its copy
   * speaks about comparison, and a Budget Remaining card that told the user to
   * pick a month "to compare" would explain the wrong feature.
   */
  | 'no-budget-plan'
  | 'budget-period-not-one-month'
  | 'budget-coverage-incomplete';

export type Measured<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: UnavailableReason };

/** Integer cents. Never a floating-point dollar amount (§1 rule 4). */
export type Cents = number;

/** A ratio in its raw form; rounding happens only at display (§9). */
export type Ratio = number;

export interface DateRange {
  readonly start: IsoDate;
  /** Inclusive. */
  readonly end: IsoDate;
}

export type PeriodPreset =
  'current-month' | 'previous-month' | 'last-90-days' | 'year-to-date' | 'custom';

export interface SelectedPeriod {
  readonly preset: PeriodPreset;
  readonly range: DateRange;
  /**
   * True only when the period's calendar span is fully covered by a confirmed
   * statement range (data-methodology.md §6) — never inferred from the
   * earliest and latest transaction dates.
   */
  readonly isCompleteCalendarMonth: boolean;
}

/**
 * Everything a selector is allowed to read.
 *
 * Selectors are pure functions of this input (§1 rule 2). Anything not
 * reachable from here — the database, the clock, the DOM — is out of bounds,
 * which is what makes the same figures reproducible in a test.
 */
export interface SelectorInput {
  readonly transactions: readonly SelectableTransaction[];
  readonly period: SelectedPeriod;
  readonly incomeDataComplete: boolean;
}

/** The transaction fields the calculation contract actually depends on. */
export interface SelectableTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly postedDate: IsoDate;
  readonly amountCents: Cents;
  readonly direction: 'debit' | 'credit';
  readonly kind: TransactionKind;
  readonly categoryId: string;
  readonly merchantNormalized: string;
  readonly excludedFromSpending: boolean;
}

/**
 * Net spending, with the parts that produced it.
 *
 * The dashboard must allow inspection of both gross outflow and refunds even
 * when the headline card shows net spending (§5.1), so the breakdown travels
 * with the total rather than being recomputed somewhere else.
 */
export interface NetSpendingBreakdown {
  readonly grossOutflowCents: Cents;
  readonly refundsCents: Cents;
  readonly netSpendingCents: Cents;
  readonly includedTransactionCount: number;
}

export interface CashFlowSummary {
  readonly netSpending: NetSpendingBreakdown;
  readonly moneyInCents: Measured<Cents>;
  readonly netCashFlowCents: Measured<Cents>;
  readonly savingsRate: Measured<Ratio>;
}

export interface BudgetProgress {
  readonly month: IsoMonth;
  readonly limitCents: Measured<Cents>;
  readonly spentCents: Cents;
  readonly remainingCents: Measured<Cents>;
  readonly spentFraction: Measured<Ratio>;
  readonly elapsedFraction: Measured<Ratio>;
  readonly projectedSpendCents: Measured<Cents>;
}

/**
 * Mirrors the warning table in data-methodology.md §6.
 *
 * The last four fields are Phase 5 additions (calculation-contract.md §14.4,
 * §14.10, §14.3). They are additive: no field above them changed meaning.
 */
export interface DataQualityFlags {
  readonly partialMonth: boolean;
  /**
   * Legacy boolean, retained for compatibility only.
   *
   * True for *both* non-confirmed states, so it cannot distinguish
   * "the user said income is incomplete" from "nobody ever said". New interfaces
   * must read `incomeCompletenessWarning` instead (§14.1); inferring the
   * distinction from this boolean is not possible and must not be attempted.
   */
  readonly incompleteIncome: boolean;
  /**
   * The authoritative income-completeness signal (§14.1).
   *
   * `null` means completeness was confirmed and income figures are publishable.
   * The two non-null values are the same identifiers used as `UnavailableReason`
   * values, so a warning banner and a hidden card cannot describe the same
   * workspace differently.
   */
  readonly incomeCompletenessWarning:
    'income-data-incomplete' | 'income-completeness-unconfirmed' | null;
  readonly unreviewedCredits: number;
  readonly uncategorizedIncludedCents: Cents;
  readonly coverageGap: boolean;
  readonly singleAccountWithPayments: boolean;
  readonly rejectedRowsPresent: boolean;
  readonly insufficientHistory: boolean;
  /**
   * Unknown *debits* in the population (§14.4).
   *
   * Reported separately from `unreviewedCredits` because the two bias a total
   * in opposite directions: an unknown debit understates spending, an unknown
   * credit understates income. One combined count would hide which.
   */
  readonly unreviewedDebits: number;
  /**
   * Income transactions suppressed from money in by the exclusion contract (§14.10).
   *
   * Not named for a user action: `excludedFromSpending` can arrive through CSV
   * import or backup restoration, and the schema stores no provenance for it, so
   * attributing the exclusion to anyone would be a claim the data cannot support.
   * Zero is a valid count.
   */
  readonly excludedIncomeTransactionCount: number;
  /** Committed sessions missing one or both statement-range endpoints (§14.3). */
  readonly sessionsMissingStatementRange: number;
  /** Committed sessions whose statement range is reversed or not a calendar date (§14.3). */
  readonly sessionsWithMalformedStatementRange: number;
  /**
   * Validly dated statement ranges naming zero unique accounts (§14.11).
   *
   * Unreachable in persisted data — commit validation names every account a
   * session's rows landed in — but the selector is pure and must fail safely on
   * whatever input it is handed rather than trusting the writer.
   */
  readonly sessionsWithUnattributedStatementRange: number;
  /**
   * Validly dated statement ranges naming more than one unique account (§14.11).
   *
   * A session stores one range however many accounts it names, so such a range
   * cannot say what period any individual account's statement covered. It is
   * excluded from completeness rather than credited to all of them. This
   * describes stored data granularity, not a mistake anyone made.
   */
  readonly ambiguousMultiAccountStatementRangeCount: number;
  /** Deduplicated, sorted accounts touched by an ambiguous range (§14.11). */
  readonly accountsWithAmbiguousStatementCoverage: readonly string[];
  /** Accounts in scope lacking complete coverage of the selected period (§14.11). */
  readonly accountsWithIncompleteCoverage: readonly string[];
}

/* ------------------------------------------------- Phase 5 selector surface - */

/**
 * The dashboard's filter surface.
 *
 * Deliberately narrower than `TransactionFilters`. The review grid filters by
 * kind, tag, and treatment because a reviewer is hunting for rows; the dashboard
 * answers financial questions about a period, and exposing a kind filter there
 * would let someone build a "net spending" figure with transfers filtered in.
 * Nothing here is persisted, serialized, or put in a URL.
 */
export interface DashboardFilters {
  readonly range: DateRange;
  readonly accountIds?: readonly string[];
  readonly categoryIds?: readonly string[];
}

/**
 * The user's confirmation state for imported income (§14.1).
 *
 * Three states, because "never asked" is not an answer. Modeled as a union
 * rather than `boolean | undefined` so a caller cannot drop the third case by
 * writing `if (complete)`.
 */
export type IncomeCompleteness = 'confirmed-complete' | 'confirmed-incomplete' | 'unconfirmed';

/** Everything the Phase 5 selectors read. Pure input; no database, no clock. */
export interface DashboardInput {
  readonly transactions: readonly SelectableTransaction[];
  readonly filters: DashboardFilters;
  readonly incomeCompleteness: IncomeCompleteness;
  /** Committed sessions only — presence in the table is the commit proof (§14.3). */
  readonly coverage: readonly StatementRange[];
  /**
   * Accounts the workspace holds, with their archived state.
   *
   * Required, not optional: completeness is account-scoped (§14.11), and a
   * count alone cannot say *which* accounts must be covered. Supplying only a
   * tally is what allowed one account's statement to fill another's gap.
   */
  readonly accounts: readonly AccountScope[];
  readonly granularity: BucketGranularity;
  /** Sessions that rejected rows, for the §6 rejected-rows warning. */
  readonly rejectedRowsPresent?: boolean;
}

/**
 * An account as the calculation layer needs it.
 *
 * Derived from the established `Account` type by `Pick` rather than redeclared,
 * so a field cannot drift. Label, type, and currency are display concerns and
 * are deliberately absent — the calculation layer has no use for a name.
 */
export type AccountScope = Pick<Account, 'id' | 'archived'>;

/**
 * A confirmed statement range as stored on an import session.
 *
 * `accountIds` carries the session's own `ImportSession.accountIds`. That field
 * is lossless for *identity* — commit validation rejects any transaction whose
 * account the session did not declare — but it is not per-account *evidence*:
 * one session stores one range however many accounts it names (§14.11).
 *
 * A range naming exactly one unique account is usable evidence for that account.
 * A range naming more than one is **ambiguous** and establishes coverage for
 * none of them, because nothing records which endpoint belonged to which
 * account.
 */
export interface StatementRange {
  readonly start?: string;
  readonly end?: string;
  readonly accountIds: readonly string[];
}

/** An inclusive, validated, merged coverage span. */
export interface CoverageSpan {
  readonly start: IsoDate;
  readonly end: IsoDate;
}

/**
 * The population split by spending treatment.
 *
 * Mutually exclusive and exhaustive: every filtered row lands in exactly one
 * bucket, and the five counts sum to the filtered population size. That is what
 * makes `excluded` rows auditable rather than merely absent.
 */
export interface TreatmentPartition {
  readonly includedOutflow: readonly SelectableTransaction[];
  readonly includedRefund: readonly SelectableTransaction[];
  readonly excludedByKind: readonly SelectableTransaction[];
  readonly excludedByUser: readonly SelectableTransaction[];
  readonly needsReview: readonly SelectableTransaction[];
  /** Size of the filtered population this partition was built from. */
  readonly populationCount: number;
}

/** One row of a breakdown. `netCents` may be negative (§5.3). */
export interface BreakdownSlice {
  readonly key: string;
  readonly grossOutflowCents: Cents;
  readonly refundsCents: Cents;
  readonly netCents: Cents;
  readonly transactionCount: number;
}

export type BucketGranularity = 'day' | 'week' | 'month';

/** One time bucket. Dense: emitted even when empty, so a gap is visible. */
export interface TimeBucket extends BreakdownSlice {
  readonly start: IsoDate;
  /** Inclusive. */
  readonly end: IsoDate;
  /** True only when statement coverage spans the whole bucket (§14.2). */
  readonly isComplete: boolean;
}

export interface ComparisonResult {
  readonly currentMonth: IsoMonth;
  readonly priorMonth: IsoMonth;
  readonly currentNetCents: Cents;
  readonly priorNetCents: Cents;
  readonly deltaCents: Cents;
  /** Unavailable when the prior month's net spending is zero — no ratio exists. */
  readonly deltaRatio: Measured<Ratio>;
}

/** A single proven invariant. `holds: false` is a defect, never a rounding note. */
export interface ReconciliationCheck {
  readonly name: string;
  readonly holds: boolean;
  readonly expected: number;
  readonly actual: number;
}

export interface ReconciliationReport {
  readonly holds: boolean;
  readonly checks: readonly ReconciliationCheck[];
  readonly failures: readonly ReconciliationCheck[];
}

/** Everything one dashboard render needs, computed once from one population. */
export interface DashboardSelection {
  readonly population: readonly SelectableTransaction[];
  readonly partition: TreatmentPartition;
  readonly netSpending: NetSpendingBreakdown;
  readonly cashFlow: CashFlowSummary;
  readonly byCategory: readonly BreakdownSlice[];
  readonly byAccount: readonly BreakdownSlice[];
  readonly timeSeries: readonly TimeBucket[];
  readonly comparison: Measured<ComparisonResult>;
  readonly dataQuality: DataQualityFlags;
  readonly reconciliation: ReconciliationReport;
}

/**
 * The declared selector surface.
 *
 * Declaring it as one interface means the UI can be written against a stable
 * contract now, and there is exactly one place to look to confirm that every
 * dashboard value has a defined source (§1 rule 1).
 *
 * `budgetProgress` was deferred through Phase 5 and is **implemented in Phase
 * 6A**. `selectBudgetProgress` in `./budget` produces a `BudgetSelection`, whose
 * `progress` member is exactly this `BudgetProgress` shape — so the Phase 0
 * contract is satisfied by the same values the budget page renders rather than
 * by a parallel computation. Recurring detection and insights remain unbuilt.
 */
export interface WorkspaceSelectors {
  netSpending(input: SelectorInput): NetSpendingBreakdown;
  cashFlow(input: SelectorInput): CashFlowSummary;
  /** Phase 6A. Satisfied by `selectBudgetProgress(...).progress`. */
  budgetProgress(input: SelectorInput, month: IsoMonth): BudgetProgress;
  dataQuality(input: SelectorInput): DataQualityFlags;
}
