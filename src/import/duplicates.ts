import { occurrenceGroupKey } from './fingerprint';
import { MAX_DUPLICATE_GROUPS } from './limits';
import type { FingerprintedRow } from './normalizeFile';

/**
 * Duplicate-candidate analysis.
 *
 * data-methodology.md §4.1: this is a **suggestion mechanism, not a deletion
 * mechanism**. Nothing here removes, rejects, or excludes anything — it
 * nominates candidates and records why, and the user decides. The safe default
 * preserves data.
 */

export type CandidateSource = 'within-file' | 'staged-session' | 'existing-workspace';

export interface DuplicateCandidate {
  readonly fingerprint: string;
  readonly fileName: string;
  /** 1-based logical row in its source file. */
  readonly originalRow: number;
  readonly source: CandidateSource;
  /** Constant, value-free explanation. */
  readonly reason: string;
  /** Where the earlier match lives, so the UI can point at it. */
  readonly matchedFileName?: string;
  readonly matchedOriginalRow?: number;
}

export interface DuplicateAnalysisInput {
  /** Every staged row across all files, in file order then row order. */
  readonly rows: readonly FingerprintedRow[];
  /** Fingerprints already stored in IndexedDB. */
  readonly existingFingerprints: ReadonlySet<string>;
}

export interface DuplicateAnalysis {
  readonly candidates: readonly DuplicateCandidate[];
  /** Fingerprints flagged at least once, for quick membership tests. */
  readonly candidateFingerprints: ReadonlySet<string>;
  /** True when more candidates existed than the reporting cap allows. */
  readonly truncated: boolean;
}

const REASONS = {
  'existing-workspace':
    'A transaction with the same account, date, direction, amount, and description is already in your workspace.',
  'staged-session':
    'An identical row appears earlier in the files you selected, so these files overlap.',
  'within-file':
    'An earlier row in this same file has the same account, date, direction, amount, and description. Two real purchases can look like this, so nothing is removed unless you say so.',
} as const satisfies Record<CandidateSource, string>;

/**
 * Flags candidates in three scopes.
 *
 * *Within one file* needs no work: the occurrence index is part of the
 * fingerprint, so two legitimate identical same-day purchases in one file are
 * already distinct and can never nominate each other (§4.3). What remains is
 * overlap **across staged files** and collision **against the workspace**.
 *
 * Order matters. Rows are walked in source order and the *first* sighting is
 * treated as the keeper, so a re-downloaded statement that overlaps an earlier
 * file flags the repeat rather than the original.
 */
export function analyzeDuplicates(input: DuplicateAnalysisInput): DuplicateAnalysis {
  const candidates: DuplicateCandidate[] = [];
  const candidateFingerprints = new Set<string>();
  const seenInSession = new Map<string, { fileName: string; originalRow: number }>();
  let truncated = false;

  for (const row of input.rows) {
    const firstSighting = seenInSession.get(row.fingerprint);

    let source: CandidateSource | null = null;
    if (input.existingFingerprints.has(row.fingerprint)) {
      source = 'existing-workspace';
    } else if (firstSighting) {
      source = 'staged-session';
    }

    if (!firstSighting) {
      seenInSession.set(row.fingerprint, {
        fileName: row.fileName,
        originalRow: row.originalRow,
      });
    }

    if (!source) continue;

    candidateFingerprints.add(row.fingerprint);

    if (candidates.length >= MAX_DUPLICATE_GROUPS) {
      truncated = true;
      continue;
    }

    candidates.push({
      fingerprint: row.fingerprint,
      fileName: row.fileName,
      originalRow: row.originalRow,
      source,
      reason: REASONS[source],
      ...(source === 'staged-session' && firstSighting
        ? { matchedFileName: firstSighting.fileName, matchedOriginalRow: firstSighting.originalRow }
        : {}),
    });
  }

  return { candidates, candidateFingerprints, truncated };
}

/**
 * Repeats **inside one file**, as candidates.
 *
 * This is a second, deliberately separate comparison from `analyzeDuplicates`,
 * and the separation is the point.
 *
 * A fingerprint includes the repeated-occurrence index (§4.3), so two identical
 * rows in one file are *distinct by construction* and can never nominate each
 * other by fingerprint — which is exactly what keeps two real same-day coffees
 * from absorbing one another in storage. That property must not be weakened, so
 * this function does not touch fingerprints at all. It compares the same
 * business fields the fingerprint uses **minus the occurrence index**, via
 * `occurrenceGroupKey` — the identical length-prefixed encoding, so a
 * description containing any character whatsoever still cannot shift a field
 * boundary.
 *
 * Scope is one file per call. The caller passes a single file's rows, so two
 * staged files that happen to share a name can never be conflated here; overlap
 * *between* files is `analyzeDuplicates`' job.
 *
 * Order matters and matches the rest of the module: the first sighting is the
 * keeper and every later repeat is nominated, so excluding a candidate removes
 * the repeat rather than the original. Nothing is removed automatically —
 * these are suggestions, and the default is to keep (§4.1).
 */
export function analyzeWithinFileDuplicates(
  fileRows: readonly FingerprintedRow[],
): DuplicateAnalysis {
  const candidates: DuplicateCandidate[] = [];
  const candidateFingerprints = new Set<string>();
  const firstSighting = new Map<string, { fileName: string; originalRow: number }>();
  let truncated = false;

  for (const row of fileRows) {
    const key = occurrenceGroupKey({
      accountId: row.accountId,
      postedDate: row.postedDate,
      direction: row.direction,
      amountCents: row.amountCents,
      descriptionCanonical: row.descriptionCanonical,
    });

    const first = firstSighting.get(key);
    if (!first) {
      firstSighting.set(key, { fileName: row.fileName, originalRow: row.originalRow });
      continue;
    }

    candidateFingerprints.add(row.fingerprint);

    if (candidates.length >= MAX_DUPLICATE_GROUPS) {
      truncated = true;
      continue;
    }

    candidates.push({
      fingerprint: row.fingerprint,
      fileName: row.fileName,
      originalRow: row.originalRow,
      source: 'within-file',
      reason: REASONS['within-file'],
      matchedFileName: first.fileName,
      matchedOriginalRow: first.originalRow,
    });
  }

  return { candidates, candidateFingerprints, truncated };
}

/**
 * The user's keep/exclude decisions, keyed by fingerprint.
 *
 * Absent means keep. Encoding it this way makes "preserve data" the structural
 * default: forgetting to record a decision cannot silently drop a row.
 */
export type DuplicateDecisions = ReadonlyMap<string, 'keep' | 'exclude'>;

export function isExcluded(decisions: DuplicateDecisions, fingerprint: string): boolean {
  return decisions.get(fingerprint) === 'exclude';
}

/** Applies decisions, returning the rows that will actually be committed. */
export function applyDuplicateDecisions(
  rows: readonly FingerprintedRow[],
  decisions: DuplicateDecisions,
): { readonly kept: readonly FingerprintedRow[]; readonly excluded: readonly FingerprintedRow[] } {
  const kept: FingerprintedRow[] = [];
  const excluded: FingerprintedRow[] = [];

  for (const row of rows) {
    if (isExcluded(decisions, row.fingerprint)) excluded.push(row);
    else kept.push(row);
  }

  return { kept, excluded };
}
