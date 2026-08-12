import { canonicalizeText } from '../import/canonical';

/**
 * Conservative merchant normalization.
 *
 * category-rules.md §6.2 is the binding constraint here, and it is a constraint
 * on what this module may **not** do:
 *
 *   `SQ *GREEN HOUSE` and `GREEN HOUSE RENTALS` must not be merged merely
 *   because they share words.
 *
 * So there is no edit distance, no token overlap, no fuzzy matching, and no
 * blanket store-number regex. Every transformation below is either a documented
 * card-network prefix, or an explicit entry in a versioned alias table. When
 * nothing applies, the result is the canonicalized description — §6.2 states
 * plainly that a fallback is always preferable to an invented merchant.
 *
 * `descriptionRaw` is never touched. This produces `merchantNormalized`, a
 * derived field, and the raw description remains permanently visible.
 */

/**
 * Bumped whenever the prefix list or alias table changes.
 *
 * Stored alongside affected transactions so a later improvement is an explicit,
 * migrated event rather than a silent mass re-identification (§6.3). It is
 * deliberately *not* part of any fingerprint — fingerprints must survive alias
 * improvements unchanged (data-methodology.md §4.2).
 */
export const MERCHANT_ALIAS_VERSION = 1;

/** Longest merchant string stored. Matches the shared stored-text ceiling. */
export const MAX_MERCHANT_LENGTH = 200;

/**
 * Card-network and processor prefixes.
 *
 * Each is a payment rail stamping its own marker onto the front of a
 * descriptor; none is part of the merchant's name. They are matched only at the
 * *start* of the string and only when followed by more text, so a merchant
 * genuinely called "SQ" survives.
 *
 * Ordered longest-first so `POS DEBIT ` is removed before `POS `.
 */
const NETWORK_PREFIXES: readonly string[] = [
  'CHECKCARD PURCHASE ',
  'RECURRING PAYMENT ',
  'PREAUTHORIZED DEBIT ',
  'POS PURCHASE ',
  'POS DEBIT ',
  'DEBIT CARD PURCHASE ',
  'CARD PURCHASE ',
  'CHECKCARD ',
  'VISA PURCHASE ',
  'DEBIT PURCHASE ',
  'PURCHASE AUTHORIZED ON ',
  'SQ *',
  'TST* ',
  'TST*',
  'SP *',
  'SP*',
  'PY *',
  'PY*',
  'PAYPAL *',
  'PAYPAL*',
  'POS ',
  'ACH DEBIT ',
  'ACH CREDIT ',
];

/**
 * Explicit, reviewed aliases.
 *
 * Deliberately tiny. Every entry is a claim that two strings name the same
 * merchant, and a wrong claim silently merges two businesses' spending. The
 * table grows only through review, never through inference — and §6.2 forbids
 * store-number stripping except where an alias declares it safe for that
 * family, which is what `prefixMatch` entries express.
 */
interface AliasEntry {
  /** Canonical merchant this maps to. */
  readonly merchant: string;
  /**
   * When true, any canonicalized description *starting* with the key belongs to
   * this merchant — the reviewed, per-family form of store-number stripping.
   */
  readonly prefixMatch?: boolean;
}

const ALIASES: ReadonlyMap<string, AliasEntry> = new Map([
  // Exact aliases: the whole canonical string means this merchant.
  ['AMZN MKTP US', { merchant: 'AMAZON' }],
  ['AMAZON.COM', { merchant: 'AMAZON' }],
  ['AMAZON MKTPLACE PMTS', { merchant: 'AMAZON' }],
  ['WM SUPERCENTER', { merchant: 'WALMART' }],
  ['WAL-MART', { merchant: 'WALMART' }],

  // Reviewed prefix families. A store number after the name is noise for these
  // specific chains; it is not stripped generally.
  ['WHOLEFDS', { merchant: 'WHOLE FOODS', prefixMatch: true }],
  ['TRADER JOE S #', { merchant: 'TRADER JOES', prefixMatch: true }],
  ['SHOPRITE #', { merchant: 'SHOPRITE', prefixMatch: true }],
  ['WAWA #', { merchant: 'WAWA', prefixMatch: true }],
  ['DUNKIN #', { merchant: 'DUNKIN', prefixMatch: true }],
  ['CVS/PHARMACY #', { merchant: 'CVS PHARMACY', prefixMatch: true }],
  ['WALGREENS #', { merchant: 'WALGREENS', prefixMatch: true }],
  ['TARGET T-', { merchant: 'TARGET', prefixMatch: true }],
]);

/** Trailing transaction noise banks append after the merchant name. */
const TRAILING_NOISE: readonly RegExp[] = [
  // A trailing date stamp: `... 03/14`, `... 03/14/26`.
  /\s+\d{2}\/\d{2}(\/\d{2,4})?$/,
  // A long trailing reference number, which is never part of a name.
  /\s+#?\d{6,}$/,
];

/**
 * Removes one leading network prefix, if any.
 *
 * Only one: chaining removals would let `POS POS COFFEE` become `COFFEE`, which
 * is a guess about a merchant whose name genuinely starts with `POS`.
 */
function stripNetworkPrefix(canonical: string): string {
  for (const prefix of NETWORK_PREFIXES) {
    if (!canonical.startsWith(prefix)) continue;
    const remainder = canonical.slice(prefix.length).trim();
    // Never strip a prefix down to nothing — that would invent an empty
    // merchant out of a description that really did say only "POS".
    if (remainder.length > 0) return remainder;
  }
  return canonical;
}

function stripTrailingNoise(value: string): string {
  for (const pattern of TRAILING_NOISE) {
    const stripped = value.replace(pattern, '').trim();
    if (stripped.length > 0 && stripped !== value) return stripped;
  }
  return value;
}

/** Applies the alias table, exact entries before prefix families. */
function applyAlias(value: string): string | null {
  const exact = ALIASES.get(value);
  if (exact && !exact.prefixMatch) return exact.merchant;

  let best: { key: string; merchant: string } | null = null;
  for (const [key, entry] of ALIASES) {
    if (!entry.prefixMatch || !value.startsWith(key)) continue;
    // Longest matching family wins, so a more specific entry can be added later
    // without being shadowed by a shorter one.
    if (!best || key.length > best.key.length) best = { key, merchant: entry.merchant };
  }
  return best?.merchant ?? null;
}

export interface NormalizedMerchant {
  readonly merchant: string;
  /** Which step produced it, for provenance display. */
  readonly source: 'alias' | 'prefix-stripped' | 'canonical';
  readonly aliasVersion: number;
}

/**
 * Derives a merchant from a raw bank description.
 *
 * Idempotent by construction: the output of one call is a valid input to the
 * next and produces the same string. That is asserted in the tests, because an
 * idempotence failure would make a merchant drift every time classification
 * re-ran.
 */
export function normalizeMerchant(descriptionRaw: string): NormalizedMerchant {
  const canonical = canonicalizeText(descriptionRaw);
  if (canonical.length === 0) {
    return { merchant: '', source: 'canonical', aliasVersion: MERCHANT_ALIAS_VERSION };
  }

  // Alias first: an entry may deliberately describe a string that still carries
  // its network prefix.
  const directAlias = applyAlias(canonical);
  if (directAlias !== null) {
    return {
      merchant: cap(directAlias),
      source: 'alias',
      aliasVersion: MERCHANT_ALIAS_VERSION,
    };
  }

  const withoutPrefix = stripNetworkPrefix(canonical);
  const aliasAfterPrefix = applyAlias(withoutPrefix);
  if (aliasAfterPrefix !== null) {
    return {
      merchant: cap(aliasAfterPrefix),
      source: 'alias',
      aliasVersion: MERCHANT_ALIAS_VERSION,
    };
  }

  const cleaned = stripTrailingNoise(withoutPrefix);
  return {
    merchant: cap(cleaned),
    source: cleaned === canonical ? 'canonical' : 'prefix-stripped',
    aliasVersion: MERCHANT_ALIAS_VERSION,
  };
}

function cap(value: string): string {
  return value.slice(0, MAX_MERCHANT_LENGTH);
}

/** The merchant a user typed, bounded and canonicalized the same way. */
export function normalizeUserMerchant(value: string): string {
  return cap(canonicalizeText(value));
}
