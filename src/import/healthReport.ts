import type { RowQuestion, RowRejection } from './errors';
import { MAX_PREVIEW_ROWS, MAX_REJECTION_SAMPLES, MAX_WARNINGS } from './limits';
import type { DuplicateCandidate } from './duplicates';
import { previewDescription, type NormalizedRow } from './normalizeRow';
import type { FingerprintedRow } from './normalizeFile';

/**
 * The Import Health Report.
 *
 * data-methodology.md §3.7: the report summarizes accepted, rejected,
 * duplicate-candidate, questionable, and uncategorized rows, and **these
 * numbers must reconcile against `rowCount`**.
 *
 * The invariant that matters most is `rowCount === acceptedCount +
 * rejectedCount`. Everything else — questionable, uncategorized, duplicate
 * candidates — *overlaps* accepted rows and is reported separately rather than
 * folded into the split.
 */

export interface PreviewRow {
  readonly fileName: string;
  readonly originalRow: number;
  readonly postedDate: string;
  /** Display-safe: control and bidi characters already removed. */
  readonly description: string;
  readonly amountCents: number;
  readonly direction: 'debit' | 'credit';
  readonly isDuplicateCandidate: boolean;
  readonly isQuestionable: boolean;
}

export interface HealthReport {
  /** Logical data rows encountered across every file. */
  readonly rowCount: number;
  /** Rows that will actually be committed. */
  readonly acceptedCount: number;
  /** Rows not committed: invalid, or excluded by the user. */
  readonly rejectedCount: number;
  /** Of `rejectedCount`, how many were invalid rows. */
  readonly invalidCount: number;
  /** Of `rejectedCount`, how many the user chose to exclude. */
  readonly excludedDuplicateCount: number;
  /** Flagged as candidates, whether ultimately kept or excluded. */
  readonly duplicateCandidateCount: number;
  /** Accepted rows carrying at least one questionable flag. Overlaps accepted. */
  readonly questionableCount: number;
  /** Accepted rows with no category. In Phase 3 that is all of them. */
  readonly uncategorizedCount: number;

  readonly warnings: readonly string[];
  readonly rejectionSamples: readonly RowRejection[];
  readonly previewRows: readonly PreviewRow[];
  /** True when any bounded collection dropped entries. */
  readonly truncatedReporting: boolean;
}

export interface HealthReportInput {
  readonly rowCount: number;
  /** Rows that survived normalization, before duplicate decisions. */
  readonly normalizedRows: readonly FingerprintedRow[];
  /** Rows the user chose to exclude. */
  readonly excludedRows: readonly FingerprintedRow[];
  readonly rejections: readonly RowRejection[];
  readonly questions: readonly RowQuestion[];
  readonly duplicateCandidates: readonly DuplicateCandidate[];
  readonly warnings: readonly string[];
  /**
   * Which accepted rows carry a questionable flag, **by reference**.
   *
   * Resolved by the caller rather than matched here, because a `RowQuestion`
   * identifies its row by file name and row number — and two staged files can
   * share a name. Matching on that pair would let a flag raised about one
   * file's row 3 appear on a different file's row 3. The caller knows which
   * staged file each row and each question came from; this module does not, so
   * it is given the answer instead of guessing at it.
   */
  readonly questionableRows: ReadonlySet<FingerprintedRow>;
  /** Which accepted rows are duplicate candidates, by reference. Same reason. */
  readonly candidateRows: ReadonlySet<FingerprintedRow>;
  /**
   * The sanitized name to show for a row's source file.
   *
   * Defaults to the row's own `fileName`. Supplied so a caller that tracks
   * staged files by an internal identity still renders the user's filename,
   * never that identity.
   */
  readonly displayFileNameFor?: (row: FingerprintedRow) => string;
}

/**
 * Builds the report and asserts its own invariants.
 *
 * The assertion is deliberate: a Health Report whose numbers do not add up is
 * worse than no report, because a user reconciling against their statement
 * would trust it. Failing loudly here surfaces the bug in a test rather than in
 * someone's finances.
 */
export function buildHealthReport(input: HealthReportInput): HealthReport {
  // Excluded rows are matched by **identity**, not by `fileName#originalRow`.
  //
  // A user may stage two files that carry the same name — one statement pulled
  // from two folders, or the same export downloaded twice. Their row numbers
  // then collide, and a key-based match would treat excluding row 1 of the
  // first as excluding row 1 of *both*. `acceptedCount` would silently
  // understate what is about to be committed, and `commitImport` would refuse
  // the whole import on a count mismatch it could not explain.
  //
  // `excludedRows` is documented as a subset of `normalizedRows`, so the rows
  // are the same objects and reference identity is both exact and free.
  const excluded = new Set<FingerprintedRow>(input.excludedRows);
  const accepted = input.normalizedRows.filter((row) => !excluded.has(row));

  const acceptedCount = accepted.length;
  const invalidCount = input.rejections.length;
  const excludedDuplicateCount = input.excludedRows.length;
  const rejectedCount = invalidCount + excludedDuplicateCount;

  const questionableCount = accepted.filter((row) => input.questionableRows.has(row)).length;

  const displayName = input.displayFileNameFor ?? ((row: FingerprintedRow) => row.fileName);

  const previewRows: PreviewRow[] = accepted.slice(0, MAX_PREVIEW_ROWS).map((row) => ({
    fileName: displayName(row),
    originalRow: row.originalRow,
    postedDate: row.postedDate,
    description: previewDescription(row as NormalizedRow),
    amountCents: row.amountCents,
    direction: row.direction,
    // Reference identity throughout: no row can inherit another row's flag.
    isDuplicateCandidate: input.candidateRows.has(row),
    isQuestionable: input.questionableRows.has(row),
  }));

  const warnings = [...new Set(input.warnings)].slice(0, MAX_WARNINGS);
  const rejectionSamples = input.rejections.slice(0, MAX_REJECTION_SAMPLES);

  const report: HealthReport = {
    rowCount: input.rowCount,
    acceptedCount,
    rejectedCount,
    invalidCount,
    excludedDuplicateCount,
    duplicateCandidateCount: input.duplicateCandidates.length,
    questionableCount,
    // Phase 3 assigns no categories at all, so every accepted row is
    // uncategorized by construction. Phase 4 changes this.
    uncategorizedCount: acceptedCount,
    warnings,
    rejectionSamples,
    previewRows,
    truncatedReporting:
      warnings.length < input.warnings.length ||
      rejectionSamples.length < input.rejections.length ||
      previewRows.length < acceptedCount,
  };

  assertHealthReportInvariants(report);
  return report;
}

export class HealthReportInvariantError extends Error {}

/**
 * The documented count invariants, checked rather than merely described.
 *
 * Messages carry counts only — never a row, a description, or an amount.
 */
export function assertHealthReportInvariants(report: HealthReport): void {
  const fail = (message: string): never => {
    throw new HealthReportInvariantError(message);
  };

  if (report.rowCount !== report.acceptedCount + report.rejectedCount) {
    fail(
      `rowCount (${report.rowCount}) must equal acceptedCount (${report.acceptedCount}) + rejectedCount (${report.rejectedCount}).`,
    );
  }

  if (report.rejectedCount !== report.invalidCount + report.excludedDuplicateCount) {
    fail(
      `rejectedCount (${report.rejectedCount}) must equal invalidCount (${report.invalidCount}) + excludedDuplicateCount (${report.excludedDuplicateCount}).`,
    );
  }

  // Questionable and uncategorized overlap accepted rows, so they may never
  // exceed it — but they are not part of the accepted/rejected split.
  if (report.questionableCount > report.acceptedCount) {
    fail(
      `questionableCount (${report.questionableCount}) cannot exceed acceptedCount (${report.acceptedCount}).`,
    );
  }

  if (report.uncategorizedCount > report.acceptedCount) {
    fail(
      `uncategorizedCount (${report.uncategorizedCount}) cannot exceed acceptedCount (${report.acceptedCount}).`,
    );
  }

  if (report.excludedDuplicateCount > report.duplicateCandidateCount) {
    fail(
      `excludedDuplicateCount (${report.excludedDuplicateCount}) cannot exceed duplicateCandidateCount (${report.duplicateCandidateCount}).`,
    );
  }

  for (const [name, value] of Object.entries(report)) {
    if (typeof value === 'number' && (!Number.isInteger(value) || value < 0)) {
      fail(`${name} must be a non-negative integer.`);
    }
  }
}
