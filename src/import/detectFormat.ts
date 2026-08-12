import { HEADER_SEARCH_LINES, MAX_COLUMNS } from './limits';
import type { DetectionConfidence } from './decode';

/**
 * Delimiter and header-row detection.
 *
 * data-methodology.md §2.4: detection is *a suggestion the user can override*,
 * never a silent decision. Scoring is therefore deterministic and its reasoning
 * is reported so the wizard can show why a delimiter was proposed.
 *
 * threat-model.md §6: the header search reads a bounded prefix. Scanning an
 * unlimited file to find a header would make a hostile file expensive before
 * any limit applied.
 */

export type Delimiter = ',' | ';' | '\t' | '|';

export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];

export const DELIMITER_LABELS: Record<Delimiter, string> = {
  ',': 'Comma',
  ';': 'Semicolon',
  '\t': 'Tab',
  '|': 'Pipe',
};

/**
 * Splits one CSV line on a delimiter, respecting double-quoted fields.
 *
 * Only used for *scoring* candidate delimiters, never for the real parse — Papa
 * Parse does that. It has to be quote-aware anyway, because a description
 * containing a comma would otherwise make the comma look far more frequent than
 * it is and skew detection toward the wrong answer.
 */
export function countFields(line: string, delimiter: Delimiter): number {
  let fields = 1;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      // A doubled quote inside a quoted field is an escaped quote.
      if (inQuotes && line[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      fields += 1;
    }
  }

  return fields;
}

/** Splits text into physical lines, tolerating CRLF, LF, and lone CR. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export interface DelimiterScore {
  readonly delimiter: Delimiter;
  /** Most common field count produced by this delimiter. */
  readonly modalFieldCount: number;
  /** Share of sampled lines that produced the modal count, 0..1. */
  readonly consistency: number;
  readonly score: number;
}

export interface DelimiterDetection {
  readonly delimiter: Delimiter;
  readonly confidence: DetectionConfidence;
  readonly reason: string;
  readonly scores: readonly DelimiterScore[];
}

function scoreDelimiter(lines: readonly string[], delimiter: Delimiter): DelimiterScore {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const fields = countFields(line, delimiter);
    counts.set(fields, (counts.get(fields) ?? 0) + 1);
  }

  let modalFieldCount = 1;
  let modalOccurrences = 0;
  // Iterate deterministically: highest occurrence wins, ties break on the
  // larger field count, so the same input always scores identically.
  for (const [fields, occurrences] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (
      occurrences > modalOccurrences ||
      (occurrences === modalOccurrences && fields > modalFieldCount)
    ) {
      modalFieldCount = fields;
      modalOccurrences = occurrences;
    }
  }

  const consistency = lines.length === 0 ? 0 : modalOccurrences / lines.length;

  // A delimiter that never splits anything is worthless regardless of how
  // "consistent" that is — every line agreeing on one field is what you get
  // from the wrong delimiter.
  const score = modalFieldCount < 2 ? 0 : consistency * Math.min(modalFieldCount, 12);

  return { delimiter, modalFieldCount, consistency, score };
}

/**
 * Proposes a delimiter from a bounded sample of non-empty lines.
 *
 * Low confidence is reported rather than hidden: `data-methodology.md` §2.4
 * forbids silently choosing a low-confidence result.
 */
export function detectDelimiter(sampleLines: readonly string[]): DelimiterDetection {
  const lines = sampleLines.filter((line) => line.trim().length > 0).slice(0, HEADER_SEARCH_LINES);

  const scores = DELIMITERS.map((delimiter) => scoreDelimiter(lines, delimiter)).sort(
    // Highest score first; ties break on the canonical delimiter order so the
    // result never depends on array iteration luck.
    (a, b) =>
      b.score - a.score || DELIMITERS.indexOf(a.delimiter) - DELIMITERS.indexOf(b.delimiter),
  );

  const best = scores[0]!;
  const runnerUp = scores[1];

  if (lines.length === 0 || best.score === 0) {
    return {
      delimiter: ',',
      confidence: 'low',
      reason: 'No delimiter separated this file into columns. Please choose one.',
      scores,
    };
  }

  const clearlyBest = !runnerUp || best.score >= runnerUp.score * 1.5;
  const confidence: DetectionConfidence =
    best.consistency >= 0.95 && clearlyBest ? 'high' : best.consistency >= 0.75 ? 'medium' : 'low';

  return {
    delimiter: best.delimiter,
    confidence,
    reason: `${DELIMITER_LABELS[best.delimiter]} produced ${best.modalFieldCount} columns on ${Math.round(
      best.consistency * 100,
    )}% of the sampled lines.`,
    scores,
  };
}

/* --------------------------------------------------------------- header - */

/** Words that commonly name a column in a bank export. Used only for scoring. */
const HEADER_HINTS = [
  'date',
  'posted',
  'transaction',
  'description',
  'memo',
  'payee',
  'merchant',
  'amount',
  'debit',
  'credit',
  'withdrawal',
  'deposit',
  'balance',
  'type',
  'category',
  'reference',
  'account',
];

export interface HeaderDetection {
  /** 0-based index into the physical lines of the file. */
  readonly headerLineIndex: number;
  readonly columns: readonly string[];
  readonly confidence: DetectionConfidence;
  readonly reason: string;
  /** Lines skipped before the header, e.g. an exported title block. */
  readonly skippedLines: number;
}

function looksLikeHeader(fields: readonly string[]): number {
  let hits = 0;
  let nonEmpty = 0;

  for (const field of fields) {
    const value = field.trim().toLowerCase().replace(/^"|"$/g, '');
    if (value.length === 0) continue;
    nonEmpty += 1;
    if (HEADER_HINTS.some((hint) => value.includes(hint))) hits += 1;
  }

  return nonEmpty === 0 ? 0 : hits / nonEmpty;
}

function splitLineToFields(line: string, delimiter: Delimiter): string[] {
  // Mirrors `countFields`, but keeps the text. Scoring only.
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Finds the most likely header row within the first `HEADER_SEARCH_LINES`.
 *
 * Some exports open with a title, an account summary, or a blank line before
 * the real header, so the search cannot simply assume line 0 — but it is
 * bounded so a file cannot make this expensive.
 */
export function detectHeaderRow(
  sampleLines: readonly string[],
  delimiter: Delimiter,
): HeaderDetection | null {
  const searchWindow = sampleLines.slice(0, HEADER_SEARCH_LINES);

  let bestIndex = -1;
  let bestScore = 0;
  let bestFields: string[] = [];

  for (let index = 0; index < searchWindow.length; index += 1) {
    const line = searchWindow[index]!;
    if (line.trim().length === 0) continue;

    const fields = splitLineToFields(line, delimiter);
    if (fields.length < 2 || fields.length > MAX_COLUMNS) continue;

    const score = looksLikeHeader(fields);
    // Strictly greater keeps the *earliest* best row, which is what a reader
    // would pick when two rows score alike.
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      bestFields = fields;
    }
  }

  if (bestIndex === -1) {
    // Nothing looked like a header. Fall back to the first non-empty line so
    // the user has something concrete to correct.
    const firstIndex = searchWindow.findIndex((line) => line.trim().length > 0);
    if (firstIndex === -1) return null;

    const fields = splitLineToFields(searchWindow[firstIndex]!, delimiter);
    if (fields.length > MAX_COLUMNS) return null;

    return {
      headerLineIndex: firstIndex,
      columns: fields.map((field) => field.trim()),
      confidence: 'low',
      reason:
        'No row looked like a column header, so the first row is offered. Please confirm or choose another.',
      skippedLines: firstIndex,
    };
  }

  const confidence: DetectionConfidence =
    bestScore >= 0.6 ? 'high' : bestScore >= 0.34 ? 'medium' : 'low';

  return {
    headerLineIndex: bestIndex,
    columns: bestFields.map((field) => field.trim()),
    confidence,
    reason:
      bestIndex === 0
        ? `The first row names ${Math.round(bestScore * 100)}% of its columns like a bank export.`
        : `Row ${bestIndex + 1} names ${Math.round(bestScore * 100)}% of its columns like a bank export; the ${bestIndex} row(s) above it look like a title block.`,
    skippedLines: bestIndex,
  };
}
