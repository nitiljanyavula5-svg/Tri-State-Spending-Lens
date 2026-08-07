import { decodeBytes } from './decode';
import type { ImportFailure, RowQuestion, RowRejection } from './errors';
import {
  assignOccurrenceIndexes,
  computeFingerprint,
  occurrenceGroupKey,
  webCryptoSha256,
  type Sha256,
} from './fingerprint';
import type { FileFormat, FileMapping } from './mapping';
import { normalizeRow, type NormalizedRow } from './normalizeRow';
import { parseCsvText } from './parseCsv';

/**
 * File-level orchestration:
 *
 *   bytes -> decode -> parse -> map -> normalize -> fingerprint -> result
 *
 * Pure with respect to the workspace: it reads no database and writes nothing.
 * That is what lets the worker run it, the tests drive it directly, and the
 * same bytes produce the same output every time.
 */

export interface FingerprintedRow extends NormalizedRow {
  readonly fingerprint: string;
  readonly occurrenceIndex: number;
  /** Account this row will belong to once committed. */
  readonly accountId: string;
}

export interface NormalizeFileInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly format: FileFormat;
  readonly mapping: FileMapping;
  /** Resolved target account id — real, or provisional for a new account. */
  readonly accountId: string;
  /** Remaining row budget for the whole session. */
  readonly maxRows: number;
  readonly sha256?: Sha256;
  /** Called with bounded frequency, never per row. */
  readonly onProgress?: (processed: number, total: number) => void;
}

export interface NormalizedFileResult {
  readonly fileName: string;
  /** Logical data rows encountered, before any acceptance decision. */
  readonly rowCount: number;
  readonly rows: readonly FingerprintedRow[];
  readonly rejections: readonly RowRejection[];
  readonly questions: readonly RowQuestion[];
  readonly structuralWarnings: readonly string[];
  /** True when the session row budget cut the file short. */
  readonly truncated: boolean;
  readonly hadInvalidBytes: boolean;
}

export type NormalizeFileOutcome =
  | { readonly ok: true; readonly result: NormalizedFileResult }
  | { readonly ok: false; readonly failure: ImportFailure };

/** Progress is reported at most this many times per file. */
const PROGRESS_STEPS = 20;

export async function normalizeFile(input: NormalizeFileInput): Promise<NormalizeFileOutcome> {
  const decoded = decodeBytes(input.bytes, input.format.encoding, input.fileName);
  if (!decoded.ok) return { ok: false, failure: decoded.failure };

  const parsed = parseCsvText(decoded.text, {
    delimiter: input.format.delimiter,
    headerLineIndex: input.format.headerLineIndex,
    maxRows: input.maxRows,
  });

  const normalized: NormalizedRow[] = [];
  const rejections: RowRejection[] = [];
  const questions: RowQuestion[] = [];

  const total = parsed.rows.length;
  const stride = Math.max(1, Math.floor(total / PROGRESS_STEPS));

  for (let index = 0; index < parsed.rows.length; index += 1) {
    const outcome = normalizeRow(
      parsed.rows[index]!,
      input.mapping,
      input.fileName,
      parsed.header.length,
    );
    if (outcome.ok) {
      normalized.push(outcome.row);
      questions.push(...outcome.row.questions);
    } else {
      rejections.push(outcome.rejection);
    }

    // Bounded progress: a per-row message would flood the channel and cost more
    // than the parsing it reports on.
    if (input.onProgress && (index % stride === 0 || index === total - 1)) {
      input.onProgress(index + 1, total);
    }
  }

  /* --------------------------------------------------------- fingerprints - */

  // Occurrence indexes are assigned across the accepted rows in source order,
  // so two legitimate identical purchases become occurrence 0 and 1 and end up
  // with different fingerprints (data-methodology.md §4.3).
  const groupKeys = normalized.map((row) =>
    occurrenceGroupKey({
      accountId: input.accountId,
      postedDate: row.postedDate,
      direction: row.direction,
      amountCents: row.amountCents,
      descriptionCanonical: row.descriptionCanonical,
    }),
  );
  const occurrenceIndexes = assignOccurrenceIndexes(groupKeys, (key) => key);

  const sha256 = input.sha256 ?? webCryptoSha256;
  const rows: FingerprintedRow[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const row = normalized[index]!;
    const occurrenceIndex = occurrenceIndexes[index]!;
    const fingerprint = await computeFingerprint(
      {
        accountId: input.accountId,
        postedDate: row.postedDate,
        direction: row.direction,
        amountCents: row.amountCents,
        descriptionCanonical: row.descriptionCanonical,
        occurrenceIndex,
      },
      sha256,
    );

    rows.push({ ...row, fingerprint, occurrenceIndex, accountId: input.accountId });
  }

  return {
    ok: true,
    result: {
      fileName: input.fileName,
      // Every logical row encountered, whether it survived or not. This is the
      // `rowCount` the Health Report reconciles against.
      rowCount: parsed.rows.length,
      rows,
      rejections,
      questions,
      structuralWarnings: parsed.structuralWarnings,
      truncated: parsed.truncated,
      hadInvalidBytes: decoded.hadInvalidBytes,
    },
  };
}
