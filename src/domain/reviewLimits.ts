/**
 * Bounds on everything a user can type or select during review.
 *
 * threat-model.md §6 requires that no user-controlled collection or text field
 * be unbounded. These are the Phase 4 caps, gathered here so the editor, the
 * bulk command, the repository, and the backup schema cannot disagree about
 * them — a field the UI allows but the schema rejects would be a save that
 * fails only after the user has done the work.
 */

/** A normalized merchant. Matches `MAX_MERCHANT_LENGTH` in the classifier. */
export const MAX_MERCHANT_LENGTH = 200;

/**
 * A note. Generous enough for a real explanation, far below the 8192-character
 * stored-text ceiling, so a note can never be the thing that makes a backup
 * refuse to validate.
 */
export const MAX_NOTE_LENGTH = 1_000;

/** Tags per transaction. The backup schema caps the array at 50; this is tighter. */
export const MAX_TAGS_PER_TRANSACTION = 20;

/** One tag. Long enough to be descriptive, short enough to render in a chip. */
export const MAX_TAG_LENGTH = 40;

/**
 * Rows one bulk command may touch.
 *
 * A bulk edit reads every affected row, rewrites it, and keeps a copy for undo,
 * so the cost is bounded by this rather than by how many rows a filter happens
 * to match. Selecting more than this is refused with an explanation instead of
 * being silently truncated.
 */
export const MAX_BULK_TRANSACTIONS = 2_000;

/** A user rule's pattern. Long patterns are pointless and hard to reason about. */
export const MAX_RULE_PATTERN_LENGTH = 200;

/**
 * Shortest `contains` pattern accepted.
 *
 * A two-character `contains` rule matches almost everything, and a rule that
 * matches everything silently recategorizes a whole workspace on the next
 * import. Exact and starts-with rules are inherently narrower and are allowed
 * to be shorter.
 */
export const MIN_CONTAINS_PATTERN_LENGTH = 3;

/** Below this, a `contains` rule is accepted but warned about. */
export const BROAD_CONTAINS_PATTERN_LENGTH = 5;

/** Rules a workspace may hold. */
export const MAX_USER_RULES = 500;

/**
 * Undo commands retained, in memory, for this session only.
 *
 * Bounded on purpose: an unbounded history is an unbounded record of what
 * someone changed and when, which privacy-model.md would rather not keep.
 * Twenty covers "I just did that by mistake" and a short run of bulk edits
 * without becoming an audit log.
 *
 * Each entry holds whole previous rows, so the ceiling also bounds how much
 * transaction data sits in memory outside the database.
 */
export const MAX_UNDO_HISTORY = 20;

/** Rows rendered per page in the review grid. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** Rules listed per page in the rule manager. */
export const RULES_PAGE_SIZE = 10;

/** Bounded match-count preview when creating a rule. */
export const MAX_RULE_MATCH_PREVIEW = 500;

/**
 * Suggested relationships offered at once.
 *
 * A suggestion list is a queue of decisions, and a queue nobody can finish is
 * indistinguishable from a broken one. Fifty is enough to work through in a
 * sitting; anything beyond it is reported as truncated rather than silently
 * dropped, so the interface never implies it found everything.
 */
export const MAX_REVIEW_SUGGESTIONS = 50;

/**
 * Rows examined per equal-amount group when collecting suggestions.
 *
 * Pairing is quadratic within a group, so a workspace holding thousands of
 * identical amounts — a fixed subscription across four years, say — would
 * otherwise make the review page hang. The cap keeps the work bounded and the
 * collector reports the truncation instead of hiding it.
 */
export const MAX_SUGGESTION_GROUP_SIZE = 200;
