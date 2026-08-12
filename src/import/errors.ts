/**
 * Structured outcomes for a single source row.
 *
 * threat-model.md §8 / §15 item 4: an error carries the row number, the field
 * name, and a code — never the offending value. `"Row 42: amount is not
 * numeric"` is correct; echoing the cell is not. Every message in this module
 * is therefore a constant, and nothing here interpolates row content.
 */

export type RejectionCode =
  // date
  | 'date-missing'
  | 'date-unparseable'
  | 'date-not-a-real-day'
  | 'date-format-conflict'
  // amount
  | 'amount-missing'
  | 'amount-not-numeric'
  | 'amount-exponent-notation'
  | 'amount-too-precise'
  | 'amount-out-of-range'
  | 'amount-malformed-grouping'
  | 'amount-both-debit-and-credit'
  | 'amount-neither-debit-nor-credit'
  | 'amount-non-usd-symbol'
  // structure
  | 'row-field-count-mismatch'
  | 'row-missing-mapped-column'
  | 'field-too-long'
  // session
  | 'session-row-limit-exceeded'
  // user decision
  | 'excluded-duplicate-candidate';

/** Non-fatal observations. The row is still imported. */
export type QuestionableCode =
  | 'description-empty'
  | 'description-whitespace-only'
  | 'description-truncated'
  | 'amount-zero'
  | 'text-had-invalid-characters';

export interface RowRejection {
  /** 1-based logical data-row number within its source file. */
  readonly originalRow: number;
  readonly fileName: string;
  readonly code: RejectionCode;
  /** Which mapped field failed, when the failure is field-specific. */
  readonly field?: string;
  /** Constant, value-free explanation safe to render. */
  readonly message: string;
}

export interface RowQuestion {
  readonly originalRow: number;
  readonly fileName: string;
  readonly code: QuestionableCode;
  readonly field?: string;
  readonly message: string;
}

export const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  'date-missing': 'The date cell is empty.',
  'date-unparseable': 'The date does not match the confirmed date format.',
  'date-not-a-real-day': 'That date does not exist on the calendar.',
  'date-format-conflict':
    'This row is impossible under the confirmed date format — the day and month may be swapped.',
  'amount-missing': 'The amount cell is empty.',
  'amount-not-numeric': 'The amount is not a number.',
  'amount-exponent-notation': 'Exponent notation is not accepted for money.',
  'amount-too-precise': 'The amount has more than two decimal places.',
  'amount-out-of-range': 'The amount is larger than this product will store.',
  'amount-malformed-grouping': 'The thousands separators in this amount are inconsistent.',
  'amount-both-debit-and-credit': 'Both the debit and the credit cell contain a value.',
  'amount-neither-debit-nor-credit': 'Neither the debit nor the credit cell contains a value.',
  'amount-non-usd-symbol': 'The amount carries a currency symbol other than USD.',
  'row-field-count-mismatch': 'This row has a different number of fields than the header.',
  'row-missing-mapped-column': 'A column this mapping requires is absent from this row.',
  'field-too-long': 'A field exceeds the maximum length this product will store.',
  'session-row-limit-exceeded': 'This row is past the maximum number of rows for one import.',
  'excluded-duplicate-candidate': 'You chose to exclude this duplicate candidate.',
};

export const QUESTIONABLE_MESSAGES: Record<QuestionableCode, string> = {
  'description-empty': 'The description is empty. The row was imported and needs review.',
  'description-whitespace-only':
    'The description contains only spaces. The row was imported and needs review.',
  'description-truncated':
    'The description was longer than the storage limit and was shortened. The original length is not preserved.',
  'amount-zero': 'The amount is zero. Banks do emit zero-value adjustments, so it was kept.',
  'text-had-invalid-characters':
    'Some characters could not be decoded and were replaced. The row was imported and needs review.',
};

export function rejectRow(
  fileName: string,
  originalRow: number,
  code: RejectionCode,
  field?: string,
): RowRejection {
  return {
    originalRow,
    fileName,
    code,
    ...(field === undefined ? {} : { field }),
    message: REJECTION_MESSAGES[code],
  };
}

export function questionRow(
  fileName: string,
  originalRow: number,
  code: QuestionableCode,
  field?: string,
): RowQuestion {
  return {
    originalRow,
    fileName,
    code,
    ...(field === undefined ? {} : { field }),
    message: QUESTIONABLE_MESSAGES[code],
  };
}

/**
 * Failures that stop a whole file or session rather than one row.
 *
 * Kept separate from `RejectionCode` because these never reach the Health
 * Report's per-row accounting — they prevent the import from starting.
 */
export type ImportFailureCode =
  | 'file-not-csv'
  | 'file-too-large'
  | 'file-empty'
  | 'too-many-files'
  | 'encoding-unsupported'
  | 'encoding-undecodable'
  | 'delimiter-undetectable'
  | 'header-not-found'
  | 'too-many-columns'
  | 'session-row-limit-exceeded'
  | 'mapping-invalid'
  | 'cancelled'
  | 'worker-failed';

export interface ImportFailure {
  readonly code: ImportFailureCode;
  readonly message: string;
  /** File this failure belongs to, when it is file-specific. */
  readonly fileName?: string;
}
