import { sanitizeForDisplay } from './canonical';
import type { ImportFailure } from './errors';
import { ACCEPTED_EXTENSIONS, MAX_FILE_BYTES, MAX_FILES_PER_SESSION } from './limits';

/**
 * Pre-read gatekeeping for selected files.
 *
 * threat-model.md §6: type and size are checked *before* the expensive work,
 * from metadata alone. `File.size` costs nothing; `file.arrayBuffer()` on a
 * multi-gigabyte file pulls it all into memory first.
 */

export interface CandidateFile {
  readonly name: string;
  readonly size: number;
  /** Browser-reported MIME type. Advisory only — see `isCsvName`. */
  readonly type: string;
}

/** Windows reserved device names; a file called `CON.csv` is a hazard. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Longest source filename kept, matching the backup helper's own ceiling. */
const MAX_FILE_NAME_LENGTH = 120;

/**
 * Neutralizes a source filename for display and for storage on the
 * `ImportSession` (threat-model.md §10).
 *
 * Path separators, control characters, zero-width and bidi marks, and reserved
 * device names are all removed, so a name can never traverse directories, carry
 * control bytes into IndexedDB, or reorder the text around it when rendered.
 *
 * Deliberately *not* `sanitizeFilename` from the backup module. That one names
 * a file the browser is about to write, so it forces a `.json` suffix — applied
 * here it turns `statement.csv` into `statement.csv.json`, which would then be
 * stored and shown to the user as the name of a file they never had. The
 * neutralization rules are the same; only the extension handling differs, and
 * it differs because the purposes do.
 *
 * The character stripping is delegated to `sanitizeForDisplay` rather than
 * restated as a regular expression. Writing control-character ranges as escapes
 * inline is how a literal NUL has previously ended up in a source file here and
 * made Git treat it as binary; reusing the audited stripper keeps every such
 * character out of this file altogether.
 */
export function sanitizeSourceFileName(name: string, fallback = 'imported file'): string {
  const cleaned = sanitizeForDisplay(name.replace(/[/\\]/g, '-'))
    .replace(/[<>:"|?*]/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, MAX_FILE_NAME_LENGTH);

  if (cleaned.length === 0) return fallback;

  // A reserved name is reserved with or without its extension, so the check
  // runs on the stem: `CON`, `CON.csv`, and `con.CSV` are all the same hazard.
  const stem = cleaned.replace(/\.[^.]*$/, '') || cleaned;
  return RESERVED_NAMES.test(stem) ? fallback : cleaned;
}

/**
 * Whether the filename claims to be CSV.
 *
 * The MIME type is deliberately *not* the gate: browsers report CSV as
 * `text/csv`, `application/vnd.ms-excel`, `application/csv`, or empty depending
 * on platform and whether Excel is installed. The extension is the only stable
 * signal, so it is required and the MIME type is only ever used to explain a
 * rejection.
 */
export function isCsvName(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

const MEGABYTE = 1024 * 1024;

export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MEGABYTE) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MEGABYTE).toFixed(1)} MB`;
}

const MAX_FILE_MIB = MAX_FILE_BYTES / MEGABYTE;

/** Validates one file's metadata. Returns null when it is acceptable. */
export function validateFile(file: CandidateFile): ImportFailure | null {
  const displayName = sanitizeSourceFileName(file.name, 'selected file');

  if (!isCsvName(file.name)) {
    return {
      code: 'file-not-csv',
      fileName: displayName,
      message: 'Only .csv files can be imported. Export a CSV from your bank and try again.',
    };
  }

  if (file.size === 0) {
    return { code: 'file-empty', fileName: displayName, message: 'This file is empty.' };
  }

  if (file.size > MAX_FILE_BYTES) {
    return {
      code: 'file-too-large',
      fileName: displayName,
      message: `This file is larger than the ${MAX_FILE_MIB} MiB limit for a single import file.`,
    };
  }

  return null;
}

export interface FileSelectionResult {
  readonly accepted: readonly CandidateFile[];
  readonly failures: readonly ImportFailure[];
}

/**
 * Validates a whole selection.
 *
 * Bad files are reported rather than silently dropped, and the good ones still
 * proceed — a user who drags a folder containing a stray PDF should not lose
 * the statements alongside it.
 */
export function validateSelection(files: readonly CandidateFile[]): FileSelectionResult {
  const failures: ImportFailure[] = [];
  const accepted: CandidateFile[] = [];

  if (files.length > MAX_FILES_PER_SESSION) {
    failures.push({
      code: 'too-many-files',
      message: `An import can include at most ${MAX_FILES_PER_SESSION} files. Import the rest as a separate session.`,
    });
    return { accepted, failures };
  }

  for (const file of files) {
    const failure = validateFile(file);
    if (failure) failures.push(failure);
    else accepted.push(file);
  }

  return { accepted, failures };
}

/**
 * The name shown in the UI and stored on the ImportSession.
 *
 * Routed through the same neutralizer as every other filename in the import
 * path, so a name can never carry path separators or control characters into
 * the interface or into storage.
 */
export function displayFileName(name: string): string {
  return sanitizeSourceFileName(name);
}
