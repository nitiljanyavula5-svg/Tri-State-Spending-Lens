import type { WorkspaceDatabase } from './database';
import { merchantRuleSchema } from './backupSchema';
import { sortRulesByPrecedence } from './repositories/rules';
import {
  editTransactions,
  normalizePatch,
  type CommandResult,
  type TransactionPatch,
} from './transactionCommands';
import { classify, ruleMatches } from '../classification/classify';
import { normalizeUserMerchant } from '../classification/merchants';
import { isCategoryId } from '../domain/categories';
import {
  BROAD_CONTAINS_PATTERN_LENGTH,
  MAX_BULK_TRANSACTIONS,
  MAX_RULE_MATCH_PREVIEW,
  MAX_RULE_PATTERN_LENGTH,
  MAX_USER_RULES,
  MIN_CONTAINS_PATTERN_LENGTH,
} from '../domain/reviewLimits';
import type { MerchantRule, TransactionKind } from '../types/domain';
import { canonicalizeText } from '../import/canonical';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/ids';

/**
 * Creating and managing user classification rules.
 *
 * A rule is the one thing a user can create that changes how *future* data is
 * interpreted, so the constraints here are about blast radius rather than
 * storage. A `contains` rule two characters long matches nearly everything and
 * would silently recategorize a whole workspace on the next import; a rule with
 * no outputs is a no-op that looks like it did something.
 *
 * Rules never rewrite history. Creating one affects classification from that
 * point on (category-rules.md §5.3); changing existing rows is a separate,
 * explicit bulk action the user chooses.
 */

export type RuleRejectionReason =
  | 'invalid-pattern'
  | 'pattern-too-broad'
  | 'no-effect'
  | 'invalid-category'
  | 'invalid-priority'
  | 'too-many-rules'
  | 'not-found'
  | 'workspace-write-failed';

export interface RuleRejection {
  readonly ok: false;
  readonly reason: RuleRejectionReason;
  /** Fixed text. Never contains a pattern, a merchant, or a Dexie detail. */
  readonly message: string;
  readonly problemPaths: readonly string[];
}

const MESSAGES: Record<RuleRejectionReason, string> = {
  'invalid-pattern': 'That rule needs a pattern to match against. Nothing was changed.',
  'pattern-too-broad': `A "contains" rule needs at least ${MIN_CONTAINS_PATTERN_LENGTH} characters, because a shorter one would match almost every transaction. Nothing was changed.`,
  'no-effect':
    'A rule has to change something — a merchant, a category, or a kind. Nothing was changed.',
  'invalid-category': 'That category is not one this version recognizes. Nothing was changed.',
  'invalid-priority':
    'That priority is not a whole number in the allowed range. Nothing was changed.',
  'too-many-rules': `This workspace already holds the maximum of ${MAX_USER_RULES} rules. Delete one you no longer use, then try again.`,
  'not-found': 'That rule is no longer in your workspace. Nothing was changed.',
  'workspace-write-failed':
    'That rule could not be saved. Nothing was changed — your workspace is exactly as it was.',
};

function reject(reason: RuleRejectionReason, problemPaths: readonly string[] = []): RuleRejection {
  return { ok: false, reason, message: MESSAGES[reason], problemPaths };
}

/** Priority is a small signed integer; anything wider is a mistake, not intent. */
const MAX_PRIORITY = 1_000;

export interface RuleDraft {
  readonly matchType: MerchantRule['matchType'];
  readonly pattern: string;
  readonly normalizedMerchant?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly kind?: TransactionKind | undefined;
  readonly priority?: number | undefined;
}

export interface RuleValidation {
  readonly ok: true;
  readonly rule: Omit<MerchantRule, 'id'>;
  /** Shown before confirmation; not an error. */
  readonly warning: string | null;
}

export type ValidateRuleResult = RuleValidation | RuleRejection;

/**
 * Validates and normalizes a draft rule.
 *
 * Pure, so the rule manager can show the same verdict while the user types as
 * the write path will apply. Patterns are canonicalized the same way merchants
 * are, because rules match against `merchantNormalized` (§5.2) — a pattern
 * carrying stray casing or whitespace would silently never match.
 */
export function validateRuleDraft(draft: RuleDraft): ValidateRuleResult {
  const pattern = canonicalizeText(draft.pattern).slice(0, MAX_RULE_PATTERN_LENGTH);
  if (pattern.length === 0) return reject('invalid-pattern', ['pattern']);

  if (draft.matchType === 'contains' && pattern.length < MIN_CONTAINS_PATTERN_LENGTH) {
    return reject('pattern-too-broad', ['pattern']);
  }

  const merchant =
    draft.normalizedMerchant === undefined || draft.normalizedMerchant.trim().length === 0
      ? undefined
      : normalizeUserMerchant(draft.normalizedMerchant);

  if (draft.categoryId !== undefined && !isCategoryId(draft.categoryId)) {
    return reject('invalid-category', ['categoryId']);
  }

  // A rule that sets nothing would match rows and then leave them exactly as
  // they were, which reads as a broken rule rather than an empty one.
  if (merchant === undefined && draft.categoryId === undefined && draft.kind === undefined) {
    return reject('no-effect', ['outputs']);
  }

  const priority = draft.priority ?? 0;
  if (!Number.isInteger(priority) || Math.abs(priority) > MAX_PRIORITY) {
    return reject('invalid-priority', ['priority']);
  }

  const rule: Omit<MerchantRule, 'id'> = {
    matchType: draft.matchType,
    pattern,
    ...(merchant === undefined ? {} : { normalizedMerchant: merchant }),
    ...(draft.categoryId === undefined ? {} : { categoryId: draft.categoryId }),
    ...(draft.kind === undefined ? {} : { kind: draft.kind }),
    priority,
    // Everything created here is a tier-2 user rule by definition.
    createdByUser: true,
  };

  const warning =
    draft.matchType === 'contains' && pattern.length < BROAD_CONTAINS_PATTERN_LENGTH
      ? 'This is a short “contains” pattern, so it may match more transactions than you expect. Check the match count before saving.'
      : null;

  return { ok: true, rule, warning };
}

/* ----------------------------------------------------------------- reading - */

export interface RulePage {
  readonly rules: readonly MerchantRule[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

/**
 * User rules in precedence order.
 *
 * Ordered by `sortRulesByPrecedence`, the same total order classification uses,
 * so the manager lists rules in the sequence they actually apply — never in
 * database iteration order.
 */
export async function listUserRules(
  db: WorkspaceDatabase,
  page = 0,
  pageSize = 50,
): Promise<RulePage> {
  const all = sortRulesByPrecedence(await db.merchantRules.toArray()).filter(
    (rule) => rule.createdByUser,
  );

  const size = Math.min(200, Math.max(1, Math.floor(pageSize)));
  const pageCount = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);

  return {
    rules: all.slice(current * size, current * size + size),
    totalCount: all.length,
    page: current,
    pageSize: size,
    pageCount,
  };
}

/**
 * How many stored transactions a rule would match, bounded.
 *
 * For awareness only. §12 is explicit that creating a rule must not
 * retroactively change anything, so this counts and stops — it never returns
 * the matching rows, which would put a page of personal records on screen for a
 * question the user only asked numerically.
 */
export async function countMatchingTransactions(
  db: WorkspaceDatabase,
  rule: Pick<MerchantRule, 'matchType' | 'pattern'>,
): Promise<{ readonly count: number; readonly truncated: boolean }> {
  let count = 0;
  let truncated = false;

  await db.transactions.each((row) => {
    if (count >= MAX_RULE_MATCH_PREVIEW) {
      truncated = true;
      return;
    }
    if (ruleMatches(rule as MerchantRule, row.merchantNormalized)) count += 1;
  });

  return { count, truncated };
}

/**
 * The ids a rule would change, bounded by what one command may touch.
 *
 * Separate from `countMatchingTransactions` because the two answer different
 * questions with different ceilings: the count is an awareness figure capped at
 * `MAX_RULE_MATCH_PREVIEW`, while this is the actual work list and is capped at
 * `MAX_BULK_TRANSACTIONS` — the limit `editTransactions` enforces. Returning
 * more than that would build a selection the command is bound to refuse.
 *
 * Reads only. Ids are returned in a deterministic order so two calls against an
 * unchanged workspace produce the same list, and `truncated` is reported rather
 * than the list being silently cut.
 */
export async function collectMatchingTransactionIds(
  db: WorkspaceDatabase,
  rule: Pick<MerchantRule, 'matchType' | 'pattern'>,
  limit: number = MAX_BULK_TRANSACTIONS,
): Promise<{ readonly ids: readonly string[]; readonly truncated: boolean }> {
  const matched: string[] = [];
  let truncated = false;

  await db.transactions.each((row) => {
    if (!ruleMatches(rule as MerchantRule, row.merchantNormalized)) return;
    if (matched.length >= limit) {
      truncated = true;
      return;
    }
    matched.push(row.id);
  });

  return { ids: matched.sort((a, b) => a.localeCompare(b)), truncated };
}

/* ----------------------------------------------------------------- writing - */

export interface RuleSuccess {
  readonly ok: true;
  readonly rule: MerchantRule;
}

export type RuleCommandResult = RuleSuccess | RuleRejection;

export interface RuleCommandOptions {
  readonly newId?: () => string;
  readonly clock?: Clock;
}

export async function createUserRule(
  db: WorkspaceDatabase,
  draft: RuleDraft,
  options: RuleCommandOptions = {},
): Promise<RuleCommandResult> {
  const validated = validateRuleDraft(draft);
  if (!validated.ok) return validated;

  const generateId = options.newId ?? newId;
  const rule: MerchantRule = { ...validated.rule, id: generateId() };

  const parsed = merchantRuleSchema.safeParse(rule);
  if (!parsed.success) {
    return reject(
      'invalid-pattern',
      parsed.error.issues.slice(0, 5).map((issue) => issue.path.map(String).join('.')),
    );
  }

  try {
    return await db.transaction('rw', db.merchantRules, async (): Promise<RuleCommandResult> => {
      // Counted and written inside one transaction, so two saves racing cannot
      // both observe room for one more.
      const existing = await db.merchantRules.filter((row) => row.createdByUser).count();
      if (existing >= MAX_USER_RULES) return reject('too-many-rules');

      await db.merchantRules.add(rule);
      return { ok: true, rule };
    });
  } catch {
    return reject('workspace-write-failed');
  }
}

export async function updateUserRule(
  db: WorkspaceDatabase,
  id: string,
  draft: RuleDraft,
): Promise<RuleCommandResult> {
  const validated = validateRuleDraft(draft);
  if (!validated.ok) return validated;

  try {
    return await db.transaction('rw', db.merchantRules, async (): Promise<RuleCommandResult> => {
      const existing = await db.merchantRules.get(id);
      if (!existing) return reject('not-found', ['id']);

      const rule: MerchantRule = { ...validated.rule, id };
      await db.merchantRules.put(rule);
      return { ok: true, rule };
    });
  } catch {
    return reject('workspace-write-failed');
  }
}

/**
 * Removes a rule.
 *
 * Transactions are untouched, deliberately. A stored row already carries the
 * classification it was given; deleting the rule that produced it must not
 * silently recategorize history, and must never remove the row itself.
 */
export async function deleteUserRule(
  db: WorkspaceDatabase,
  id: string,
): Promise<{ ok: true; deleted: boolean } | RuleRejection> {
  try {
    return await db.transaction('rw', db.merchantRules, async () => {
      const existing = await db.merchantRules.get(id);
      if (!existing) return { ok: true as const, deleted: false };
      await db.merchantRules.delete(id);
      return { ok: true as const, deleted: true };
    });
  } catch {
    return reject('workspace-write-failed');
  }
}

/* -------------------------------------------------- edit plus future rule - */

export interface EditAndRuleResult {
  readonly command: CommandResult;
  readonly rule: MerchantRule | null;
}

/**
 * "Change this transaction, and create a rule for future ones."
 *
 * One action to the user, so one database transaction and one undo unit. The
 * edit applies to the selected row only; the rule affects classification from
 * now on. §12 forbids the rule reaching back over stored rows, so nothing else
 * is touched — applying a rule to existing transactions is a separate bulk
 * action the user chooses explicitly.
 *
 * Both halves are validated before either is written, and the whole thing runs
 * inside `editTransactions`' transaction so a failure in either leaves the
 * workspace unchanged.
 */
export async function editTransactionAndCreateRule(
  db: WorkspaceDatabase,
  transactionId: string,
  patch: TransactionPatch,
  draft: RuleDraft,
  options: RuleCommandOptions = {},
): Promise<EditAndRuleResult> {
  const validatedRule = validateRuleDraft(draft);
  if (!validatedRule.ok) {
    return { command: validatedRule as unknown as CommandResult, rule: null };
  }

  const { problems } = normalizePatch(patch);
  if (problems.length > 0) {
    return {
      command: {
        ok: false,
        reason: 'invalid-value',
        message: 'Some of those values could not be saved. Nothing was changed.',
        problemPaths: problems,
      },
      rule: null,
    };
  }

  const generateId = options.newId ?? newId;
  const rule: MerchantRule = { ...validatedRule.rule, id: generateId() };

  let created: MerchantRule | null = null;

  const command = await editTransactions(db, [transactionId], patch, {
    ...(options.clock ? { clock: options.clock } : {}),
    newId: generateId,
    label: 'edit and rule',
    // Runs inside the same Dexie transaction as the row update, so the rule and
    // the edit commit together or not at all.
    beforeCommit: async () => {
      const existing = await db.merchantRules.filter((row) => row.createdByUser).count();
      if (existing >= MAX_USER_RULES) throw new Error('rule-limit');
      await db.merchantRules.add(rule);
      created = rule;
      return { createdRuleIds: [rule.id] };
    },
  });

  return { command, rule: command.ok ? created : null };
}

/**
 * Applies a rule to transactions the user explicitly chose.
 *
 * Separate from rule creation on purpose. Rules do not reach backwards; a user
 * who wants history changed says so, and this is that action — one atomic bulk
 * command with one undo unit.
 */
export async function applyRuleToTransactions(
  db: WorkspaceDatabase,
  rule: MerchantRule,
  transactionIds: readonly string[],
  options: RuleCommandOptions = {},
): Promise<CommandResult> {
  const patch: TransactionPatch = {
    ...(rule.normalizedMerchant === undefined
      ? {}
      : { merchantNormalized: rule.normalizedMerchant }),
    ...(rule.categoryId === undefined ? {} : { categoryId: rule.categoryId }),
    ...(rule.kind === undefined ? {} : { kind: rule.kind }),
  };

  return editTransactions(db, transactionIds, patch, {
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
    label: 'apply rule',
  });
}

/** Re-exported so callers classify through the one shared boundary. */
export { classify };
