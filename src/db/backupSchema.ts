import { z } from 'zod';
import { CATEGORY_IDS } from '../domain/categories';

/**
 * Runtime validation for workspace backups.
 *
 * threat-model.md §10 requires a real schema over the whole document, not a
 * `typeof` check on a few fields. Restore is the one place an external file is
 * given authority over the entire workspace.
 *
 * Zod's default object mode *strips* unknown keys, and the restore path stores
 * the parsed output rather than the raw JSON. Unknown fields smuggled into a
 * backup therefore never reach IndexedDB.
 */

export const BACKUP_FORMAT = 'tri-state-spending-lens-workspace';

/** The backup envelope version, independent of the database schema version. */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Provisional bound on any stored text field.
 *
 * threat-model.md §16 leaves the exact field-length cap to be fixed in Phase 3
 * alongside the parser, once the fixtures show realistic bank description
 * lengths. Restore still needs *a* bound so a hostile backup cannot exhaust
 * memory, so this generous value applies until Phase 3 records the real one.
 */
export const MAX_TEXT_FIELD_LENGTH = 8192;

/**
 * Largest backup file the restore flow will read.
 *
 * Checked against the file's declared size *before* the bytes are read into
 * memory, so an oversized file costs nothing. The value is derived from the
 * import limits it has to be able to hold: 100,000 transactions per import
 * session (data-methodology.md §2.3), each a JSON object of a few hundred
 * bytes, plus room for several sessions' worth of history. 64 MB is generous
 * for that and still far below what would strain a browser tab.
 */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/**
 * Row ceilings per table.
 *
 * `transactions` matches the 100,000-row import cap. The rest are sized to be
 * unreachable in normal use but bounded, so a hostile document cannot force
 * unbounded allocation during validation.
 */
export const MAX_ROWS = {
  accounts: 1_000,
  importSessions: 10_000,
  transactions: 100_000,
  merchantRules: 10_000,
  budgetPlans: 1_200,
  budgetCategoryTargets: 20_000,
  recurringSeries: 10_000,
  userEdits: 200_000,
  appSettings: 100,
} as const;

/* ------------------------------------------------------------ primitives - */

const text = z.string().max(MAX_TEXT_FIELD_LENGTH);
const id = text.min(1);

/** A date string that names a day that actually exists on the calendar. */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Round-tripping catches 2026-02-30 and 2026-13-01, which the pattern alone
  // happily accepts. data-methodology.md §3.3 rejects impossible dates rather
  // than coercing them.
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isRealCalendarMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDate, { message: 'not a real calendar date' });

const isoMonth = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine(isRealCalendarMonth, { message: 'not a real calendar month' });

/** A UTC ISO-8601 instant that actually parses. */
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)) && isRealCalendarDate(value.slice(0, 10)), {
    message: 'not a real timestamp',
  });

// Every stored money value is an unsigned magnitude; the sign lives in
// `direction` (data-methodology.md §3.4), so a signed variant is never needed.
const magnitudeCents = z.number().int().nonnegative();

// The category set is closed in v1.0, so a backup naming an unknown category
// is rejected rather than quietly stored (category-rules.md §2).
const categoryId = z.enum(CATEGORY_IDS as unknown as [string, ...string[]]);

const transactionKind = z.enum([
  'purchase',
  'refund',
  'income',
  'transfer',
  'payment',
  'fee',
  'cash_withdrawal',
  'unknown',
]);

/* ---------------------------------------------------------------- rows - */

export const accountSchema = z.object({
  id,
  label: text,
  type: z.enum(['checking', 'savings', 'credit_card', 'cash', 'other']),
  currency: z.literal('USD'),
  archived: z.boolean(),
});

export const importSessionSchema = z.object({
  id,
  importedAt: isoTimestamp,
  sourceFileNames: z.array(text).max(100),
  accountIds: z.array(id).max(MAX_ROWS.accounts),
  mappingVersion: z.number().int(),
  rowCount: z.number().int().nonnegative().max(MAX_ROWS.transactions),
  acceptedCount: z.number().int().nonnegative().max(MAX_ROWS.transactions),
  rejectedCount: z.number().int().nonnegative().max(MAX_ROWS.transactions),
  duplicateCandidateCount: z.number().int().nonnegative().max(MAX_ROWS.transactions),
  warnings: z.array(text).max(1_000),
  statementRangeStart: isoDate.optional(),
  statementRangeEnd: isoDate.optional(),
});

export const transactionSchema = z.object({
  id,
  fingerprint: text,
  importSessionId: id,
  originalRow: z.number().int(),
  accountId: id,
  postedDate: isoDate,
  descriptionRaw: text,
  merchantNormalized: text,
  amountCents: magnitudeCents,
  direction: z.enum(['debit', 'credit']),
  kind: transactionKind,
  categoryId,
  categorySource: z.enum(['user_rule', 'merchant_rule', 'keyword_rule', 'user', 'uncategorized']),
  classificationConfidence: z.enum(['high', 'medium', 'low', 'none']),
  essentiality: z.enum(['essential', 'discretionary']).optional(),
  variability: z.enum(['fixed', 'variable']).optional(),
  tags: z.array(text).max(50),
  note: text.optional(),
  excludedFromSpending: z.boolean(),
  exclusionReason: text.optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export const merchantRuleSchema = z.object({
  id,
  matchType: z.enum(['exact', 'contains', 'starts_with']),
  pattern: text,
  normalizedMerchant: text.optional(),
  categoryId: categoryId.optional(),
  kind: transactionKind.optional(),
  priority: z.number().int(),
  createdByUser: z.boolean(),
});

export const budgetPlanSchema = z.object({
  id,
  month: isoMonth,
  overallLimitCents: magnitudeCents.optional(),
  incomeTargetCents: magnitudeCents.optional(),
  savingsTargetCents: magnitudeCents.optional(),
  copiedFromMonth: isoMonth.optional(),
  // Rollover is off in v1.0 and a backup may not turn it on.
  rolloverEnabled: z.literal(false),
});

export const budgetCategoryTargetSchema = z.object({
  id,
  budgetPlanId: id,
  categoryId,
  limitCents: magnitudeCents,
});

export const recurringSeriesSchema = z.object({
  id,
  merchantNormalized: text,
  categoryId,
  cadence: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual']),
  typicalAmountCents: magnitudeCents,
  amountMinCents: magnitudeCents,
  amountMaxCents: magnitudeCents,
  lastChargeDate: isoDate,
  expectedNextDate: isoDate,
  occurrenceCount: z.number().int().nonnegative().max(MAX_ROWS.transactions),
  confidence: z.enum(['high', 'medium', 'low']),
  confidenceReasons: z.array(text).max(20),
  priceChange: z
    .object({
      previousAmountCents: magnitudeCents,
      previousDate: isoDate,
      currentAmountCents: magnitudeCents,
      currentDate: isoDate,
    })
    .optional(),
  userStatus: z.enum(['unreviewed', 'confirmed', 'rejected']),
  excludedFromRecurringTotals: z.boolean(),
  transactionIds: z.array(id).max(MAX_ROWS.transactions),
  detectedAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

/**
 * Fields a user edit is allowed to describe.
 *
 * A user edit is replayable intent, so an edit naming a field that does not
 * exist is meaningless at best and a way to smuggle unexpected keys at worst.
 */
export const EDITABLE_FIELDS = {
  transaction: [
    'categoryId',
    'kind',
    'merchantNormalized',
    'essentiality',
    'variability',
    'note',
    'tags',
    'excludedFromSpending',
    'exclusionReason',
  ],
  recurring_series: ['userStatus', 'categoryId', 'cadence', 'excludedFromRecurringTotals'],
} as const;

export const userEditSchema = z.object({
  id,
  entityType: z.enum(['transaction', 'recurring_series']),
  entityId: id,
  field: text.min(1),
  previousValue: text.nullable(),
  nextValue: text.nullable(),
  editedAt: isoTimestamp,
});

/**
 * Settings are validated per key.
 *
 * The previous shape accepted any key with an unknown value, which meant a
 * backup could write arbitrary data into the settings table. Each supported
 * key now names the exact values it accepts, and an unrecognized key is
 * rejected rather than stored.
 */
export const appSettingSchema = z.discriminatedUnion('key', [
  z.object({
    key: z.literal('workspaceMode'),
    value: z.enum(['empty', 'demo', 'personal']),
    updatedAt: isoTimestamp,
  }),
  z.object({
    key: z.literal('demoSeedVersion'),
    value: z.number().int().nonnegative().max(1_000_000),
    updatedAt: isoTimestamp,
  }),
  z.object({
    key: z.literal('homeState'),
    value: z.enum(['NJ', 'NY', 'PA', 'none']),
    updatedAt: isoTimestamp,
  }),
  z.object({
    key: z.literal('weekStart'),
    value: z.enum(['sunday', 'monday']),
    updatedAt: isoTimestamp,
  }),
  z.object({
    key: z.literal('creditsRepresent'),
    value: z.enum(['income_or_refunds', 'unknown']),
    updatedAt: isoTimestamp,
  }),
  z.object({
    key: z.literal('incomeDataComplete'),
    value: z.boolean(),
    updatedAt: isoTimestamp,
  }),
]);

/* ------------------------------------------------------------ document - */

export const workspaceSnapshotSchema = z.object({
  accounts: z.array(accountSchema).max(MAX_ROWS.accounts),
  importSessions: z.array(importSessionSchema).max(MAX_ROWS.importSessions),
  transactions: z.array(transactionSchema).max(MAX_ROWS.transactions),
  merchantRules: z.array(merchantRuleSchema).max(MAX_ROWS.merchantRules),
  budgetPlans: z.array(budgetPlanSchema).max(MAX_ROWS.budgetPlans),
  budgetCategoryTargets: z.array(budgetCategoryTargetSchema).max(MAX_ROWS.budgetCategoryTargets),
  recurringSeries: z.array(recurringSeriesSchema).max(MAX_ROWS.recurringSeries),
  userEdits: z.array(userEditSchema).max(MAX_ROWS.userEdits),
  appSettings: z.array(appSettingSchema).max(MAX_ROWS.appSettings),
});

const rowCount = z.number().int().nonnegative();

/**
 * Exactly one count per backed-up table.
 *
 * `strictObject` rejects an extra key, and every key is required, so a missing
 * or invented count is refused rather than silently ignored.
 */
export const countsSchema = z.strictObject({
  accounts: rowCount,
  importSessions: rowCount,
  transactions: rowCount,
  merchantRules: rowCount,
  budgetPlans: rowCount,
  budgetCategoryTargets: rowCount,
  recurringSeries: rowCount,
  userEdits: rowCount,
  appSettings: rowCount,
});

export const backupDocumentSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  exportedAt: isoTimestamp,
  counts: countsSchema,
  data: workspaceSnapshotSchema,
});

export type BackupDocument = z.infer<typeof backupDocumentSchema>;
