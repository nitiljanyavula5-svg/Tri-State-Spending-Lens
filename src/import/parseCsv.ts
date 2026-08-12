import Papa from 'papaparse';
import type { Delimiter } from './detectFormat';
import { MAX_COLUMNS } from './limits';

/**
 * Papa Parse integration.
 *
 * Parsing is done once, in one place, with the delimiter the user confirmed.
 * Papa handles the parts that are genuinely hard and easy to get wrong: quoted
 * delimiters, escaped quotes, embedded newlines, and mixed CRLF/LF endings.
 */

export interface ParsedRow {
  /** Raw cell values in column order, exactly as they appeared. */
  readonly fields: readonly string[];
  /**
   * 1-based logical data-row number within the file.
   *
   * "Logical" means rows the user would count: the header is not one, and
   * skipped blank lines do not consume a number. A row spanning two physical
   * lines via an embedded newline is still one logical row.
   */
  readonly logicalRow: number;
}

export interface ParseOutcome {
  readonly header: readonly string[];
  readonly rows: readonly ParsedRow[];
  /** Structural complaints from Papa, already stripped of cell content. */
  readonly structuralWarnings: readonly string[];
  /** True when parsing stopped early because the row cap was reached. */
  readonly truncated: boolean;
}

export interface ParseOptions {
  readonly delimiter: Delimiter;
  /** 0-based physical line where the header sits. Lines above it are ignored. */
  readonly headerLineIndex: number;
  /** Hard ceiling on logical data rows. Parsing stops once it is reached. */
  readonly maxRows: number;
}

/**
 * Blank-line rule (one deterministic rule, documented once):
 *
 * a physical line that is empty, or contains only whitespace and delimiters, is
 * skipped and does **not** consume a logical row number. Banks pad exports with
 * trailing newlines and separator rows; counting those as data would make every
 * row number off by the number of blanks above it.
 */
function isBlankRow(fields: readonly string[]): boolean {
  return fields.every((field) => field.trim().length === 0);
}

/** Removes anything that could echo a cell value out of a Papa error. */
function sanitizeParseError(error: Papa.ParseError): string {
  const row = typeof error.row === 'number' ? ` on row ${error.row + 1}` : '';
  switch (error.code) {
    case 'TooManyFields':
      return `A row has more fields than the header${row}.`;
    case 'TooFewFields':
      return `A row has fewer fields than the header${row}.`;
    case 'UndetectableDelimiter':
      return 'The delimiter could not be detected automatically.';
    case 'MissingQuotes':
      return `A quoted field is not closed${row}.`;
    default:
      // Papa's own message can quote file content, so it is never forwarded.
      return `The file could not be parsed cleanly${row}.`;
  }
}

/**
 * Parses already-decoded CSV text.
 *
 * Takes text rather than a File so the same function serves the worker, the
 * fixtures, and the tests identically — and so nothing here ever holds a File
 * reference alive.
 */
export function parseCsvText(text: string, options: ParseOptions): ParseOutcome {
  const result = Papa.parse<string[]>(text, {
    delimiter: options.delimiter,
    // Header handling is ours: the header may not be on line 0, and Papa's
    // object mode would silently drop duplicate column names.
    header: false,
    skipEmptyLines: false,
    newline: undefined,
    dynamicTyping: false,
    // Keep everything as written; normalization happens downstream.
    transform: undefined,
  });

  const structuralWarnings = new Set<string>();
  for (const error of result.errors.slice(0, 50)) {
    structuralWarnings.add(sanitizeParseError(error));
  }

  const allRows = result.data;
  const headerRow = allRows[options.headerLineIndex] ?? [];
  const header = headerRow.slice(0, MAX_COLUMNS).map((cell) => String(cell ?? '').trim());

  const rows: ParsedRow[] = [];
  let logicalRow = 0;
  let truncated = false;

  for (let index = options.headerLineIndex + 1; index < allRows.length; index += 1) {
    const raw = allRows[index];
    if (!raw) continue;

    const fields = raw.map((cell) => String(cell ?? ''));
    if (isBlankRow(fields)) continue;

    if (rows.length >= options.maxRows) {
      truncated = true;
      break;
    }

    logicalRow += 1;
    rows.push({ fields, logicalRow });
  }

  return { header, rows, structuralWarnings: [...structuralWarnings], truncated };
}
