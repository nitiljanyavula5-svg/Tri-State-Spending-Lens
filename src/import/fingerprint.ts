import type { Direction } from '../types/domain';

/**
 * Local content fingerprints for duplicate-candidate detection.
 *
 * data-methodology.md §4.2: SHA-256 here is a *content fingerprint*, not a
 * claim of encryption, and a fingerprint is **not** proof that two transactions
 * are the same — it only nominates candidates for the user to judge (§4.1).
 *
 * The canonical input is version-pinned so a future change to canonicalization
 * is an explicit, migrated event rather than a silent mass re-identification.
 */

export const FINGERPRINT_VERSION = 'fp-v1';

export interface FingerprintInput {
  readonly accountId: string;
  readonly postedDate: string;
  readonly direction: Direction;
  readonly amountCents: number;
  /** Already canonicalized (see `canonicalizeText`). */
  readonly descriptionCanonical: string;
  /**
   * 0-based index among rows in the same file that are otherwise identical.
   *
   * This is what keeps two legitimate identical same-day purchases distinct
   * (they become occurrence 0 and 1, so neither can absorb the other) while
   * still letting the *same file* reimported produce the same two fingerprints
   * and be recognized.
   */
  readonly occurrenceIndex: number;
}

/**
 * Builds the exact string that gets hashed.
 *
 * Each field is length-prefixed rather than delimiter-joined. A description
 * containing the delimiter would otherwise be able to shift the field
 * boundaries and collide with a different row — length prefixes make the
 * encoding unambiguous for any content whatsoever.
 */
export function fingerprintCanonicalString(input: FingerprintInput): string {
  const fields = [
    FINGERPRINT_VERSION,
    input.accountId,
    input.postedDate,
    input.direction,
    String(input.amountCents),
    input.descriptionCanonical,
    String(input.occurrenceIndex),
  ];

  return fields.map((field) => `${field.length}:${field}`).join('');
}

/** Injectable so tests and non-browser environments can supply a digest. */
export type Sha256 = (input: string) => Promise<string>;

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 via Web Crypto, which exists in browsers, workers, and Node 19+. */
export const webCryptoSha256: Sha256 = async (input) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('A SHA-256 implementation is required but Web Crypto is unavailable.');
  }
  const encoded = new TextEncoder().encode(input);
  return toHex(await subtle.digest('SHA-256', encoded));
};

export async function computeFingerprint(
  input: FingerprintInput,
  sha256: Sha256 = webCryptoSha256,
): Promise<string> {
  return sha256(fingerprintCanonicalString(input));
}

/** A stored fingerprint is 64 lowercase hex characters. Validated before commit. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function isValidFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value);
}

/**
 * Assigns occurrence indexes across a batch.
 *
 * Rows that agree on every fingerprint component *except* the index are the
 * same "occurrence group"; each gets the next index in source order. Source
 * order is what makes this deterministic: the same file always produces the
 * same assignment.
 */
export function assignOccurrenceIndexes<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = keyOf(row);
    const next = seen.get(key) ?? 0;
    seen.set(key, next + 1);
    return next;
  });
}

/** The grouping key used by `assignOccurrenceIndexes` — everything but the index. */
export function occurrenceGroupKey(input: Omit<FingerprintInput, 'occurrenceIndex'>): string {
  return fingerprintCanonicalString({ ...input, occurrenceIndex: -1 });
}
