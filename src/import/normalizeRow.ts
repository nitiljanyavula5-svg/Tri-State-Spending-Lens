import type { Direction } from '../types/domain';
import { canonicalizeText, hasReplacementCharacters, sanitizeForDisplay } from './canonical';
import { normalizeDate } from './dates';
import { questionRow, rejectRow, type RowQuestion, type RowRejection } from './errors';
import { MAX_FIELD_LENGTH } from './limits';
import type { FileMapping } from './mapping';
import { parseAmountToCents } from './money';
import type { ParsedRow } from './parseCsv';

/**
 * One source row becomes one normalized row, or one structured rejection.
 *
 * data-methodology.md §3: dates become ISO calendar dates, money becomes
 * integer cents with the sign carried by `direction`, `descriptionRaw` is
 * preserved for auditability, and anything that cannot be read exactly is
 * rejected rather than coerced.
 */

export interface NormalizedRow {
  readonly fileName: string;
  /** 1-based logical data-row number in the source file. */
  readonly originalRow: number;
  readonly postedDate: string;
  /** Preserved exactly as it appeared, subject only to the length cap. */
  readonly descriptionRaw: string;
  /** Conservative canonical form — Phase 4 owns real merchant cleanup. */
  readonly merchantNormalized: string;
  /** The canonical string fed to the fingerprint. */
  readonly descriptionCanonical: string;
  readonly amountCents: number;
  readonly direction: Direction;
  /** Non-fatal observations. The row is still imported. */
  readonly questions: readonly RowQuestion[];
}

export type NormalizeRowResult =
  | { readonly ok: true; readonly row: NormalizedRow }
  | { readonly ok: false; readonly rejection: RowRejection };

function cell(fields: readonly string[], index: number): string | undefined {
  return index < fields.length ? fields[index] : undefined;
}

/**
 * Resolves direction for a single signed amount column.
 *
 * The user confirms which sign means money leaving the account
 * (data-methodology.md §3.4); this only applies that decision. Zero is assigned
 * `debit` by convention because zero carries no sign and contributes nothing to
 * any total either way — the convention exists so the field is never null.
 */
function directionForSigned(negative: boolean, negativeMeans: 'debit' | 'credit'): Direction {
  if (negativeMeans === 'debit') return negative ? 'debit' : 'credit';
  return negative ? 'credit' : 'debit';
}

export function normalizeRow(
  parsed: ParsedRow,
  mapping: FileMapping,
  fileName: string,
  /**
   * Number of columns the header declared. A row that disagrees is ragged and
   * is rejected outright (threat-model.md §6): if the field count is wrong then
   * every column index after the discrepancy points at the wrong value, so the
   * row cannot be read safely even when the mapped indexes happen to exist.
   */
  expectedColumnCount?: number,
): NormalizeRowResult {
  const questions: RowQuestion[] = [];
  const reject = (code: Parameters<typeof rejectRow>[2], field?: string): NormalizeRowResult => ({
    ok: false,
    rejection: rejectRow(fileName, parsed.logicalRow, code, field),
  });

  if (expectedColumnCount !== undefined && parsed.fields.length !== expectedColumnCount) {
    return reject('row-field-count-mismatch');
  }

  const dateCell = cell(parsed.fields, mapping.dateColumn);
  const descriptionCell = cell(parsed.fields, mapping.descriptionColumn);

  if (dateCell === undefined) return reject('row-missing-mapped-column', 'date');
  if (descriptionCell === undefined) return reject('row-missing-mapped-column', 'description');

  // Length is checked before anything else touches the value, so an absurd cell
  // cannot drive downstream work (threat-model.md §6).
  for (const [field, value] of [
    ['date', dateCell],
    ['description', descriptionCell],
  ] as const) {
    if (value.length > MAX_FIELD_LENGTH * 4) return reject('field-too-long', field);
  }

  const date = normalizeDate(dateCell, mapping.dateFormat);
  if (!date.ok) return reject(date.code, 'date');

  /* ------------------------------------------------------------- amount - */

  let amountCents: number;
  let direction: Direction;

  if (mapping.amount.kind === 'signed') {
    const amountCell = cell(parsed.fields, mapping.amount.amountColumn);
    if (amountCell === undefined) return reject('row-missing-mapped-column', 'amount');

    const parsedAmount = parseAmountToCents(amountCell);
    if (!parsedAmount.ok) return reject(parsedAmount.code, 'amount');

    amountCents = parsedAmount.value.cents;
    direction = directionForSigned(parsedAmount.value.negative, mapping.amount.negativeMeans);
  } else {
    const debitCell = cell(parsed.fields, mapping.amount.debitColumn);
    const creditCell = cell(parsed.fields, mapping.amount.creditColumn);

    if (debitCell === undefined) return reject('row-missing-mapped-column', 'debit');
    if (creditCell === undefined) return reject('row-missing-mapped-column', 'credit');

    const hasDebit = debitCell.trim().length > 0;
    const hasCredit = creditCell.trim().length > 0;

    // Exactly one cell must carry a value (data-methodology.md §3.4). Both
    // populated is ambiguous, and guessing which one the bank meant would
    // silently invert a transaction's direction.
    if (hasDebit && hasCredit) return reject('amount-both-debit-and-credit', 'debit');
    if (!hasDebit && !hasCredit) return reject('amount-neither-debit-nor-credit', 'debit');

    const field = hasDebit ? 'debit' : 'credit';
    const parsedAmount = parseAmountToCents(hasDebit ? debitCell : creditCell);
    if (!parsedAmount.ok) return reject(parsedAmount.code, field);

    amountCents = parsedAmount.value.cents;
    // A separate debit/credit layout states the direction structurally, so a
    // stray minus sign inside the cell must not flip it.
    direction = hasDebit ? 'debit' : 'credit';
  }

  if (amountCents === 0) {
    questions.push(questionRow(fileName, parsed.logicalRow, 'amount-zero', 'amount'));
  }

  /* -------------------------------------------------------- description - */

  let descriptionRaw = descriptionCell;
  if (descriptionRaw.length > MAX_FIELD_LENGTH) {
    descriptionRaw = descriptionRaw.slice(0, MAX_FIELD_LENGTH);
    questions.push(
      questionRow(fileName, parsed.logicalRow, 'description-truncated', 'description'),
    );
  }

  if (descriptionRaw.length === 0) {
    questions.push(questionRow(fileName, parsed.logicalRow, 'description-empty', 'description'));
  } else if (descriptionRaw.trim().length === 0) {
    questions.push(
      questionRow(fileName, parsed.logicalRow, 'description-whitespace-only', 'description'),
    );
  }

  if (hasReplacementCharacters(descriptionRaw)) {
    questions.push(
      questionRow(fileName, parsed.logicalRow, 'text-had-invalid-characters', 'description'),
    );
  }

  const descriptionCanonical = canonicalizeText(descriptionRaw);

  return {
    ok: true,
    row: {
      fileName,
      originalRow: parsed.logicalRow,
      postedDate: date.value,
      descriptionRaw,
      // Phase 3 has no alias table, so the canonical form *is* the merchant.
      // category-rules.md §6.2 names this the correct fallback.
      merchantNormalized: descriptionCanonical,
      descriptionCanonical,
      amountCents,
      direction,
      questions,
    },
  };
}

/** Display-safe description, for previews. Never used for storage or hashing. */
export function previewDescription(row: NormalizedRow): string {
  return sanitizeForDisplay(row.descriptionRaw);
}
