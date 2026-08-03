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

import type { IsoDate, IsoMonth, TransactionKind } from '../types/domain';

/** Why a figure cannot be shown. Each maps to a gate in calculation-contract.md §6. */
export type UnavailableReason =
  | 'no-income-data'
  | 'income-marked-incomplete'
  | 'no-budget-limit-set'
  | 'partial-month'
  | 'insufficient-history'
  | 'no-included-transactions'
  | 'not-applicable';

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

/** Mirrors the warning table in data-methodology.md §6. */
export interface DataQualityFlags {
  readonly partialMonth: boolean;
  readonly incompleteIncome: boolean;
  readonly unreviewedCredits: number;
  readonly uncategorizedIncludedCents: Cents;
  readonly coverageGap: boolean;
  readonly singleAccountWithPayments: boolean;
  readonly rejectedRowsPresent: boolean;
  readonly insufficientHistory: boolean;
}

/**
 * The full selector surface Phase 5 must implement.
 *
 * Declaring it as one interface means the UI can be written against a stable
 * contract now, and there is exactly one place to look to confirm that every
 * dashboard value has a defined source (§1 rule 1).
 */
export interface WorkspaceSelectors {
  netSpending(input: SelectorInput): NetSpendingBreakdown;
  cashFlow(input: SelectorInput): CashFlowSummary;
  budgetProgress(input: SelectorInput, month: IsoMonth): BudgetProgress;
  dataQuality(input: SelectorInput): DataQualityFlags;
}
