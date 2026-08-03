/**
 * Domain types for the local workspace.
 *
 * `Transaction`, `ImportSession`, `Account`, `MerchantRule`, `BudgetPlan`, and
 * `BudgetCategoryTarget` are transcribed from docs/data-methodology.md §2.1 /
 * §3.1 and the master plan §9 — do not "improve" a field here without changing
 * the specification first.
 *
 * `RecurringSeries`, `UserEdit`, `AppSetting`, and `SchemaMigration` are named
 * but not shaped by the specifications (master plan §9 lists them as required
 * tables). Their shapes below are Phase 2 decisions, derived from the
 * requirements that reference them, and are recorded as such in the Phase 2
 * report.
 */

export type TransactionKind =
  'purchase' | 'refund' | 'income' | 'transfer' | 'payment' | 'fee' | 'cash_withdrawal' | 'unknown';

export type ClassificationConfidence = 'high' | 'medium' | 'low' | 'none';

export type Direction = 'debit' | 'credit';

export type CategorySource =
  'user_rule' | 'merchant_rule' | 'keyword_rule' | 'user' | 'uncategorized';

export type Essentiality = 'essential' | 'discretionary';
export type Variability = 'fixed' | 'variable';

/** ISO calendar date, `YYYY-MM-DD`, with no time and no timezone. */
export type IsoDate = string;
/** ISO timestamp for record bookkeeping (not transaction posting dates). */
export type IsoTimestamp = string;
/** Calendar month, `YYYY-MM`. */
export type IsoMonth = string;

export interface Transaction {
  id: string;
  fingerprint: string;
  importSessionId: string;
  originalRow: number;
  accountId: string;

  postedDate: IsoDate;
  descriptionRaw: string;
  merchantNormalized: string;

  /** Unsigned magnitude in integer cents; the sign lives in `direction`. */
  amountCents: number;
  direction: Direction;
  kind: TransactionKind;

  categoryId: string;
  categorySource: CategorySource;
  classificationConfidence: ClassificationConfidence;

  essentiality?: Essentiality;
  variability?: Variability;
  tags: string[];
  note?: string;

  excludedFromSpending: boolean;
  exclusionReason?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ImportSession {
  id: string;
  importedAt: IsoTimestamp;
  sourceFileNames: string[];
  accountIds: string[];
  mappingVersion: number;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCandidateCount: number;
  warnings: string[];
  /**
   * Month completeness comes from the confirmed statement range, not from
   * observed transaction dates (data-methodology.md §6).
   */
  statementRangeStart?: IsoDate;
  statementRangeEnd?: IsoDate;
}

export type AccountType = 'checking' | 'savings' | 'credit_card' | 'cash' | 'other';

export interface Account {
  id: string;
  label: string;
  type: AccountType;
  currency: 'USD';
  archived: boolean;
}

export type MerchantMatchType = 'exact' | 'contains' | 'starts_with';

export interface MerchantRule {
  id: string;
  matchType: MerchantMatchType;
  /** Matched literally. Never compiled as a regular expression. */
  pattern: string;
  normalizedMerchant?: string;
  categoryId?: string;
  kind?: TransactionKind;
  priority: number;
  createdByUser: boolean;
}

export interface BudgetPlan {
  id: string;
  month: IsoMonth;
  overallLimitCents?: number;
  incomeTargetCents?: number;
  savingsTargetCents?: number;
  copiedFromMonth?: IsoMonth;
  /** Rollover is off in v1.0 (calculation-contract.md §4.4). */
  rolloverEnabled: false;
}

export interface BudgetCategoryTarget {
  id: string;
  budgetPlanId: string;
  categoryId: string;
  limitCents: number;
}

export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
export type RecurringConfidence = 'high' | 'medium' | 'low';
export type RecurringUserStatus = 'unreviewed' | 'confirmed' | 'rejected';

/**
 * A detected recurring series is a suggestion, not a fact
 * (data-methodology.md §5.1). Every field that would let the UI present it as
 * certain is paired with the evidence behind it.
 *
 * Annualized cost is deliberately NOT stored: it is derived from
 * `typicalAmountCents` and `cadence` by the Phase 6 detection layer, so a
 * stored value can never drift from the cadence that justified it.
 */
export interface RecurringSeries {
  id: string;
  merchantNormalized: string;
  categoryId: string;
  cadence: RecurringCadence;
  typicalAmountCents: number;
  amountMinCents: number;
  amountMaxCents: number;
  lastChargeDate: IsoDate;
  expectedNextDate: IsoDate;
  occurrenceCount: number;
  confidence: RecurringConfidence;
  /** Human-readable evidence for the confidence label; never a bare decimal. */
  confidenceReasons: string[];
  priceChange?: {
    previousAmountCents: number;
    previousDate: IsoDate;
    currentAmountCents: number;
    currentDate: IsoDate;
  };
  userStatus: RecurringUserStatus;
  excludedFromRecurringTotals: boolean;
  transactionIds: string[];
  detectedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type UserEditEntityType = 'transaction' | 'recurring_series';

/**
 * An explicit, undoable user decision, stored separately from the records it
 * affects so that re-running a better normalization algorithm cannot erase it
 * (privacy-model.md §3.3, category-rules.md §5.4).
 */
export interface UserEdit {
  id: string;
  entityType: UserEditEntityType;
  entityId: string;
  field: string;
  previousValue: string | null;
  nextValue: string | null;
  editedAt: IsoTimestamp;
}

export interface AppSetting {
  key: string;
  value: unknown;
  updatedAt: IsoTimestamp;
}

export interface SchemaMigration {
  version: number;
  description: string;
  appliedAt: IsoTimestamp;
}
