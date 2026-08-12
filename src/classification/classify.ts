import type {
  CategorySource,
  ClassificationConfidence,
  Direction,
  MerchantRule,
  TransactionKind,
} from '../types/domain';
import {
  KIND_DEFAULT_CATEGORY,
  UNCATEGORIZED_CATEGORY_ID,
  isCategoryId,
} from '../domain/categories';
import {
  AUTO_KIND_KEYWORDS,
  CATEGORY_KEYWORDS,
  SUGGESTED_KIND_KEYWORDS,
  matchKeyword,
} from './keywords';
import { MERCHANT_ALIAS_VERSION, normalizeMerchant } from './merchants';

/**
 * The single classification boundary.
 *
 * category-rules.md §5 defines one chain, walked in order, stopping at the
 * first match:
 *
 *   1. Explicit per-transaction user edit
 *   2. User-created merchant rule
 *   3. Exact built-in merchant alias
 *   4. Built-in keyword rule
 *   5. Uncategorized / Other
 *
 * This function is the only implementation of that chain. The import commit
 * path and the review UI both call it, which is what makes the wizard preview,
 * the Health Report's uncategorized count, and the committed rows agree — they
 * are not three implementations that happen to match today.
 *
 * Pure: no database, no clock, no randomness. The same row and the same rules
 * always produce the same decision, which is what §8 requires be testable.
 */

/** Debits default to `purchase`, credits to `unknown` (data-methodology.md §3.5). */
export function defaultKindForDirection(direction: Direction): TransactionKind {
  return direction === 'debit' ? 'purchase' : 'unknown';
}

/** What classification is asked about. Only fields a decision may depend on. */
export interface ClassifiableRow {
  readonly descriptionRaw: string;
  readonly direction: Direction;
  readonly amountCents: number;
}

/**
 * A decision the user has already made about this exact row.
 *
 * Tier 1. Present only for a stored transaction whose `categorySource` is
 * `user`; a fresh import has none.
 */
export interface UserDecision {
  readonly merchantNormalized?: string;
  readonly categoryId?: string;
  readonly kind?: TransactionKind;
}

/** A kind the built-in rules propose but may not apply on their own. */
export interface KindSuggestion {
  readonly kind: TransactionKind;
  readonly confidence: ClassificationConfidence;
  /** Constant, value-free explanation. */
  readonly reason: string;
}

export interface Classification {
  readonly merchantNormalized: string;
  readonly categoryId: string;
  readonly kind: TransactionKind;
  readonly categorySource: CategorySource;
  readonly classificationConfidence: ClassificationConfidence;
  /** Which rule decided it, for the provenance display. Never a decimal score. */
  readonly provenance: string;
  /** Alias-table version this merchant was derived under (§6.3). */
  readonly aliasVersion: number;
  /**
   * A kind the built-ins propose but did not apply, because applying it would
   * change whether the transaction counts as spending (§7).
   */
  readonly kindSuggestion: KindSuggestion | null;
}

export interface ClassifyInput {
  readonly row: ClassifiableRow;
  /** User rules, already in precedence order (`sortRulesByPrecedence`). */
  readonly userRules: readonly MerchantRule[];
  readonly userDecision?: UserDecision | undefined;
}

const SUGGESTION_REASONS: Readonly<Record<string, string>> = {
  transfer:
    'The description looks like a transfer between your own accounts. Transfers are excluded from spending, so this is only a suggestion until you confirm it.',
  payment:
    'The description looks like a credit-card payment. Card payments are excluded from spending, so this is only a suggestion until you confirm it.',
  income:
    'The description looks like income. Income is excluded from spending, so this is only a suggestion until you confirm it.',
  refund:
    'The description looks like a refund. A refund reduces spending, so this is only a suggestion until you confirm it.',
};

/**
 * Resolves a category that a rule or keyword proposed.
 *
 * An unknown category id is ignored rather than stored: the category set is
 * closed in v1.0, and writing an id outside it would fail the backup schema on
 * the next export.
 */
function safeCategory(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  return isCategoryId(candidate) ? candidate : undefined;
}

/** Literal matching only. A user pattern is never compiled as a regex. */
export function ruleMatches(rule: MerchantRule, merchant: string): boolean {
  const pattern = rule.pattern.trim().toUpperCase();
  if (pattern.length === 0) return false;

  const target = merchant.toUpperCase();
  if (rule.matchType === 'exact') return target === pattern;
  if (rule.matchType === 'starts_with') return target.startsWith(pattern);
  return target.includes(pattern);
}

export function classify(input: ClassifyInput): Classification {
  const { row, userRules, userDecision } = input;

  const derived = normalizeMerchant(row.descriptionRaw);
  const baseKind = defaultKindForDirection(row.direction);

  /* ------------------------------------------------- tier 1: user edit - */

  // A user decision is final. Nothing below may demote it, and re-running
  // classification must never overwrite it (§5.4).
  if (userDecision) {
    const merchant = userDecision.merchantNormalized ?? derived.merchant;
    const kind = userDecision.kind ?? baseKind;
    const category =
      safeCategory(userDecision.categoryId) ??
      safeCategory(KIND_DEFAULT_CATEGORY[kind]) ??
      UNCATEGORIZED_CATEGORY_ID;

    return {
      merchantNormalized: merchant,
      categoryId: category,
      kind,
      categorySource: 'user',
      classificationConfidence: 'high',
      provenance: 'You set this',
      aliasVersion: derived.aliasVersion,
      kindSuggestion: null,
    };
  }

  /* ------------------------------------------- tier 2: user-made rule - */

  // Rules match against the normalized merchant, never the raw description, so
  // alias behaviour stays predictable (§5.2).
  for (const rule of userRules) {
    if (!rule.createdByUser) continue;
    if (!ruleMatches(rule, derived.merchant)) continue;

    const merchant = rule.normalizedMerchant?.trim()
      ? rule.normalizedMerchant.trim().toUpperCase()
      : derived.merchant;
    const kind = rule.kind ?? baseKind;
    const category =
      safeCategory(rule.categoryId) ??
      safeCategory(KIND_DEFAULT_CATEGORY[kind]) ??
      UNCATEGORIZED_CATEGORY_ID;

    return {
      merchantNormalized: merchant,
      categoryId: category,
      kind,
      categorySource: 'user_rule',
      classificationConfidence: 'high',
      provenance: 'Your rule',
      aliasVersion: derived.aliasVersion,
      kindSuggestion: null,
    };
  }

  /* ------------------------------------------ tier 3: built-in alias - */

  // An alias is an exact, reviewed identity claim, so it carries high
  // confidence — but it names a *merchant*, not a category. The category still
  // comes from the keyword tier below.
  const fromAlias = derived.source === 'alias';

  /* ---------------------------------------- tier 4: built-in keyword - */

  const autoKind = matchKeyword(derived.merchant, row.direction, AUTO_KIND_KEYWORDS);
  const kind = autoKind?.rule.kind ?? baseKind;

  // Suggestions are computed even when a kind was applied, so the review queue
  // can still raise "this looks like a transfer" on a debit that defaulted to
  // purchase.
  const suggested = matchKeyword(derived.merchant, row.direction, SUGGESTED_KIND_KEYWORDS);
  const kindSuggestion: KindSuggestion | null =
    suggested?.rule.kind && suggested.rule.kind !== kind
      ? {
          kind: suggested.rule.kind,
          // Every suggested kind changes whether the row counts, so §7 pins
          // these at low confidence and requires confirmation.
          confidence: 'low',
          reason: SUGGESTION_REASONS[suggested.rule.kind] ?? 'This may need review.',
        }
      : null;

  const kindCategory = safeCategory(KIND_DEFAULT_CATEGORY[kind]);
  const keyword = matchKeyword(derived.merchant, row.direction, CATEGORY_KEYWORDS);
  const keywordCategory = safeCategory(keyword?.rule.categoryId);

  // A kind-implied category wins over a keyword: `fee` means Fees & Interest
  // regardless of what words the descriptor happens to contain (§3.3).
  const category = kindCategory ?? keywordCategory ?? UNCATEGORIZED_CATEGORY_ID;

  if (kindCategory !== undefined && autoKind) {
    return {
      merchantNormalized: derived.merchant,
      categoryId: category,
      kind,
      categorySource: 'keyword_rule',
      classificationConfidence: autoKind.confidence,
      provenance: 'Built-in keyword rule',
      aliasVersion: derived.aliasVersion,
      kindSuggestion,
    };
  }

  if (keywordCategory !== undefined) {
    return {
      merchantNormalized: derived.merchant,
      categoryId: keywordCategory,
      kind,
      categorySource: fromAlias ? 'merchant_rule' : 'keyword_rule',
      classificationConfidence: fromAlias ? 'high' : keyword!.confidence,
      provenance: fromAlias ? 'Built-in merchant alias' : 'Built-in keyword rule',
      aliasVersion: derived.aliasVersion,
      kindSuggestion,
    };
  }

  /* ------------------------------------------- tier 5: uncategorized - */

  return {
    merchantNormalized: derived.merchant,
    categoryId: UNCATEGORIZED_CATEGORY_ID,
    kind,
    categorySource: 'uncategorized',
    classificationConfidence: 'none',
    provenance: 'Not yet categorized',
    aliasVersion: MERCHANT_ALIAS_VERSION,
    kindSuggestion,
  };
}

/**
 * Whether a stored row's classification may be recomputed.
 *
 * §5.4: re-running classification preserves every tier-1 and tier-2 decision
 * and only recomputes rows whose source is a built-in rule or uncategorized.
 */
export function isRecomputable(categorySource: CategorySource): boolean {
  return (
    categorySource === 'merchant_rule' ||
    categorySource === 'keyword_rule' ||
    categorySource === 'uncategorized'
  );
}
