// Imported from the leaf `bounds` module rather than from `backupSchema`, which
// re-exports it: `backupSchema` now validates mapping presets defined in this
// layer, so taking it as a dependency here would close a module cycle. See
// `src/db/bounds.ts`.
import { MAX_TEXT_FIELD_LENGTH } from '../db/bounds';

/**
 * Every bound the import pipeline enforces.
 *
 * threat-model.md §6: limits are checked *before* doing the expensive work, and
 * exceeding one is a clean explained refusal — never a crash, a hang, or a
 * silent partial import. They live in one module so the UI and the pipeline
 * cannot drift apart and let a caller bypass a limit by going around the
 * wizard.
 */

/** data-methodology.md §2.3 — CSV only. */
export const ACCEPTED_EXTENSIONS = ['.csv'] as const;

/**
 * 10 MiB per file, read from `File.size` before a single byte is decoded.
 *
 * The spec says "10 MB"; MiB is the stricter reading of the two and is what
 * browsers report, so it is the one enforced.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** data-methodology.md §2.3 — 100,000 rows per import session, across all files. */
export const MAX_SESSION_ROWS = 100_000;

/**
 * A session is one statement export, possibly split across a few files. Ten is
 * generous for that and stops a directory drop from queueing thousands.
 */
export const MAX_FILES_PER_SESSION = 10;

/** Reuses the stored text ceiling so nothing can be imported that cannot be backed up. */
export const MAX_FIELD_LENGTH = MAX_TEXT_FIELD_LENGTH;

/**
 * Header detection reads a bounded prefix. Scanning a whole file to find a
 * header would make a hostile file expensive before any limit applied.
 */
export const HEADER_SEARCH_LINES = 25;

/** Bytes decoded for encoding/delimiter/header detection before full parsing. */
export const DETECTION_SAMPLE_BYTES = 64 * 1024;

/** A bank export with more than this many columns is not a bank export. */
export const MAX_COLUMNS = 128;

/** Bounds on everything the pipeline hands back to the UI. */
export const MAX_PREVIEW_ROWS = 50;
export const MAX_REJECTION_SAMPLES = 200;
export const MAX_WARNINGS = 200;
export const MAX_DUPLICATE_GROUPS = 500;

/**
 * Largest magnitude a single transaction may carry, in integer cents.
 *
 * $10,000,000 — far above any plausible personal transaction, and chosen so
 * that a *whole session* still sums exactly: 100,000 rows × 1e9 cents = 1e14,
 * comfortably inside `Number.MAX_SAFE_INTEGER` (~9.007e15). A larger per-row
 * cap would let a full session overflow into imprecise territory, which is
 * exactly the floating-point failure the calculation contract forbids.
 */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

/** v1.0 is USD only (product-spec.md §6). */
export const SUPPORTED_CURRENCY = 'USD' as const;

/** Preset names are user text and are bounded like any other stored string. */
export const MAX_PRESET_NAME_LENGTH = 120;
export const MAX_PRESETS = 50;
