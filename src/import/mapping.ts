import { z } from 'zod';
import type { AccountType } from '../types/domain';
import type { DateFormat } from './dates';
import { isRealCalendarDate, validateStatementRange } from './dates';
import type { Delimiter } from './detectFormat';
import type { Encoding } from './decode';
import { MAX_COLUMNS, MAX_FIELD_LENGTH, MAX_PRESET_NAME_LENGTH } from './limits';

/**
 * Column mapping and convention confirmation.
 *
 * data-methodology.md §2.4 / §2.5: the user maps date, description, and either
 * one signed amount column *or* separate debit/credit columns, and confirms the
 * sign and date conventions before anything is committed. The two amount models
 * are mutually exclusive, and unmapped columns are ignored rather than guessed
 * at.
 */

/** Zero-based index into the header's columns. */
const columnIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_COLUMNS - 1);

export const amountModelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('signed'),
    amountColumn: columnIndex,
    /**
     * Which sign means money leaving the account. Confirmed explicitly — the
     * wizard shows worked examples from the user's own file before commit
     * (data-methodology.md §3.4).
     */
    negativeMeans: z.enum(['debit', 'credit']),
  }),
  z.object({
    kind: z.literal('debit-credit'),
    debitColumn: columnIndex,
    creditColumn: columnIndex,
  }),
]);

export type AmountModel = z.infer<typeof amountModelSchema>;

export const accountTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), accountId: z.string().min(1).max(MAX_FIELD_LENGTH) }),
  z.object({
    kind: z.literal('new'),
    label: z.string().min(1).max(120),
    accountType: z.enum(['checking', 'savings', 'credit_card', 'cash', 'other']),
    /** USD-only operation is confirmed, not assumed (product-spec.md §6). */
    currencyConfirmed: z.literal(true),
  }),
]);

export type AccountTarget = z.infer<typeof accountTargetSchema>;

export const fileMappingSchema = z
  .object({
    dateColumn: columnIndex,
    descriptionColumn: columnIndex,
    amount: amountModelSchema,
    /** Optional passthrough columns. Neither is interpreted in Phase 3. */
    accountLabelColumn: columnIndex.optional(),
    typeColumn: columnIndex.optional(),
    dateFormat: z.enum(['iso', 'us', 'eu']),
    account: accountTargetSchema,
    statementRangeStart: z.string().optional(),
    statementRangeEnd: z.string().optional(),
  })
  .superRefine((mapping, ctx) => {
    // One source column may not satisfy two incompatible required fields:
    // mapping description onto the date column would silently produce garbage
    // that still validates row-by-row.
    const used = new Map<number, string>();
    const claim = (index: number | undefined, field: string) => {
      if (index === undefined) return;
      const existing = used.get(index);
      if (existing !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `This column is already mapped to ${existing}. Each required field needs its own column.`,
        });
        return;
      }
      used.set(index, field);
    };

    claim(mapping.dateColumn, 'date');
    claim(mapping.descriptionColumn, 'description');

    if (mapping.amount.kind === 'signed') {
      claim(mapping.amount.amountColumn, 'amount');
    } else {
      claim(mapping.amount.debitColumn, 'debit');
      claim(mapping.amount.creditColumn, 'credit');
    }

    const range = validateStatementRange(mapping.statementRangeStart, mapping.statementRangeEnd);
    if (!range.ok) {
      ctx.addIssue({ code: 'custom', path: ['statementRange'], message: range.message });
    }
  });

export type FileMapping = z.infer<typeof fileMappingSchema>;

/** How a file's bytes should be read. Confirmed in the Identify-format step. */
export interface FileFormat {
  readonly encoding: Encoding;
  readonly delimiter: Delimiter;
  /** 0-based physical line holding the header. */
  readonly headerLineIndex: number;
}

export interface MappedFile {
  readonly fileName: string;
  readonly format: FileFormat;
  readonly mapping: FileMapping;
  readonly columns: readonly string[];
}

export type MappingValidation =
  | { readonly ok: true; readonly mapping: FileMapping }
  | { readonly ok: false; readonly issues: readonly { path: string; message: string }[] };

/**
 * Validates a mapping before any preview is generated.
 *
 * Issue paths carry field names only — never cell values (threat-model.md §8).
 */
export function validateMapping(candidate: unknown): MappingValidation {
  const parsed = fileMappingSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, mapping: parsed.data };

  return {
    ok: false,
    issues: parsed.error.issues.slice(0, 25).map((issue) => ({
      path: issue.path.map((part) => String(part)).join('.') || '(mapping)',
      message: issue.message,
    })),
  };
}

/* --------------------------------------------------------------- presets - */

export const MAPPING_PRESET_VERSION = 1;

/**
 * A UTC ISO-8601 instant naming a day that actually exists.
 *
 * `backupSchema.ts` has an equivalent validator, but importing it here would
 * close the module cycle described in `src/db/bounds.ts`.
 *
 * Both halves of the check are load-bearing. `Date.parse` rejects impossible
 * *time* components (`T99:00:00Z`), but it does **not** reject an impossible
 * *date*: `2026-02-30T00:00:00.000Z` parses happily as March 2nd, which is the
 * silent rollover data-methodology.md §3.3 forbids everywhere else in this
 * pipeline. `isRealCalendarDate` is the project's rollover-free check and is
 * what actually refuses that value.
 */
const presetTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  .refine(
    (value) => {
      if (Number.isNaN(Date.parse(value))) return false;
      const [year, month, day] = value.slice(0, 10).split('-').map(Number);
      return isRealCalendarDate(year!, month!, day!);
    },
    { message: 'not a real timestamp' },
  );

/**
 * A saved column mapping.
 *
 * data-methodology.md §2.4: presets contain column positions and convention
 * choices only — **never transaction content** — and must not identify a bank
 * unless the user names it. The schema below has no field capable of holding a
 * row value, which is what makes that guarantee structural rather than a
 * promise.
 *
 * `strictObject`, not `object`: this is a persisted row, and it is the one
 * stored shape a user can author indirectly by editing a backup file. Every
 * other table relies on Zod stripping unknown keys before the parsed output is
 * stored, which is safe but silent. Here a smuggled key is refused outright,
 * because a preset carrying a field this product does not recognize is far more
 * likely to be tampering than a forward-compatible export — the version literal
 * exists precisely so that a genuine future shape announces itself.
 */
export const mappingPresetSchema = z.strictObject({
  id: z.string().min(1).max(MAX_FIELD_LENGTH),
  /** User-supplied name. The only free text a preset carries. */
  name: z.string().min(1).max(MAX_PRESET_NAME_LENGTH),
  presetVersion: z.literal(MAPPING_PRESET_VERSION),
  createdAt: presetTimestamp,
  encoding: z.enum(['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'windows-1252']),
  delimiter: z.enum([',', ';', '\t', '|']),
  headerLineIndex: z.number().int().min(0).max(200),
  dateColumn: columnIndex,
  descriptionColumn: columnIndex,
  amount: amountModelSchema,
  accountLabelColumn: columnIndex.optional(),
  typeColumn: columnIndex.optional(),
  dateFormat: z.enum(['iso', 'us', 'eu']),
  /** Column names at save time, so the preset can be matched to a new file. */
  columnNames: z.array(z.string().max(200)).max(MAX_COLUMNS),
});

export type MappingPreset = z.infer<typeof mappingPresetSchema>;

export interface PresetDraft {
  readonly name: string;
  readonly format: FileFormat;
  readonly mapping: FileMapping;
  readonly columns: readonly string[];
}

/** Builds a preset from a confirmed mapping, dropping everything file-specific. */
export function buildPreset(draft: PresetDraft, id: string, createdAt: string): MappingPreset {
  return {
    id,
    name: draft.name.slice(0, MAX_PRESET_NAME_LENGTH),
    presetVersion: MAPPING_PRESET_VERSION,
    createdAt,
    encoding: draft.format.encoding,
    delimiter: draft.format.delimiter,
    headerLineIndex: draft.format.headerLineIndex,
    dateColumn: draft.mapping.dateColumn,
    descriptionColumn: draft.mapping.descriptionColumn,
    amount: draft.mapping.amount,
    ...(draft.mapping.accountLabelColumn === undefined
      ? {}
      : { accountLabelColumn: draft.mapping.accountLabelColumn }),
    ...(draft.mapping.typeColumn === undefined ? {} : { typeColumn: draft.mapping.typeColumn }),
    dateFormat: draft.mapping.dateFormat,
    // Account target is deliberately absent: a preset describes how to *read* a
    // file, not where its rows belong.
    columnNames: draft.columns.slice(0, MAX_COLUMNS).map((name) => name.slice(0, 200)),
  };
}

/** How well a saved preset matches a file's detected columns, 0..1. */
export function presetMatchScore(preset: MappingPreset, columns: readonly string[]): number {
  if (preset.columnNames.length === 0 || columns.length === 0) return 0;
  const target = columns.map((name) => name.trim().toLowerCase());
  const saved = preset.columnNames.map((name) => name.trim().toLowerCase());
  if (saved.length !== target.length) return 0;

  const matches = saved.filter((name, index) => name === target[index]).length;
  return matches / saved.length;
}

export type { AccountType, DateFormat };
