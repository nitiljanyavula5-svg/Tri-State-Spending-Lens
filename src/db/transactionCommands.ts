import type { WorkspaceDatabase } from './database';
import { transactionSchema } from './backupSchema';
import type {
  Essentiality,
  Transaction,
  TransactionKind,
  TransactionLink,
  UserEdit,
  Variability,
} from '../types/domain';
import { isCategoryId } from '../domain/categories';
import {
  MAX_BULK_TRANSACTIONS,
  MAX_MERCHANT_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TAGS_PER_TRANSACTION,
  MAX_TAG_LENGTH,
} from '../domain/reviewLimits';
import { reconcileExclusionForKind, userExclusionApplies } from '../classification/spending';
import { canonicalizeText } from '../import/canonical';
import { systemClock, type Clock } from '../lib/clock';
import { newId } from '../lib/ids';

/**
 * Editing reviewed transactions.
 *
 * Every write in Phase 4 goes through this module. Components never touch
 * Dexie, for the same reason the import path does not: an edit has to be
 * atomic, has to preserve the audit fields, and has to be able to say exactly
 * what it changed so it can be undone. Spreading that across components would
 * make each of those a convention rather than a guarantee.
 *
 * **Immutable by construction.** `TransactionPatch` has no field for `id`,
 * `fingerprint`, `importSessionId`, `originalRow`, `accountId`, `postedDate`,
 * `descriptionRaw`, `amountCents`, `direction`, or `createdAt`. A caller cannot
 * express a change to source information, so the type system enforces §7 rather
 * than a runtime check hoping to catch it.
 */

/** The reviewed interpretation a user may change. Source fields are absent. */
export interface TransactionPatch {
  readonly merchantNormalized?: string;
  readonly categoryId?: string;
  readonly kind?: TransactionKind;
  /** `null` clears the value back to "not decided". */
  readonly essentiality?: Essentiality | null;
  readonly variability?: Variability | null;
  readonly tags?: readonly string[];
  readonly note?: string | null;
  readonly excludedFromSpending?: boolean;
}

export type CommandRejectionReason =
  | 'not-found'
  | 'invalid-value'
  | 'too-many-rows'
  | 'nothing-selected'
  | 'stale'
  | 'workspace-write-failed';

export interface CommandRejection {
  readonly ok: false;
  readonly reason: CommandRejectionReason;
  /** Fixed text. Never contains a field value or a Dexie detail. */
  readonly message: string;
  readonly problemPaths: readonly string[];
}

/**
 * Everything needed to put the workspace back exactly as it was.
 *
 * Holds whole previous rows rather than a field-level delta: restoring a
 * snapshot is one `bulkPut`, and it cannot drift from what the forward command
 * actually did.
 */
export interface UndoCommand {
  readonly id: string;
  readonly label: string;
  readonly previous: readonly Transaction[];
  /** `updatedAt` at the time of the command, to detect later changes. */
  readonly expectedUpdatedAt: ReadonlyMap<string, string>;
  readonly userEditIds: readonly string[];
  /**
   * Rules this command created, removed again on undo.
   *
   * "Edit this transaction and create a rule" is one action to the user, so it
   * has to be one undo unit. Leaving the rule behind would mean undoing the
   * visible half while the invisible half kept classifying future imports.
   */
  readonly createdRuleIds?: readonly string[];
  /** Relationships this command created, removed again on undo. */
  readonly createdLinkIds?: readonly string[];
  /**
   * Relationships this command removed, restored on undo.
   *
   * Whole rows rather than ids, because an unlink destroys the only record of
   * what the relationship was — there would be nothing left to rebuild it from.
   */
  readonly removedLinks?: readonly TransactionLink[];
}

/** What extra work inside a command produced, so undo can reverse it. */
export interface CommitSideEffects {
  readonly createdRuleIds?: readonly string[];
  readonly createdLinkIds?: readonly string[];
  readonly removedLinks?: readonly TransactionLink[];
}

export interface CommandSuccess {
  readonly ok: true;
  readonly changedCount: number;
  readonly undo: UndoCommand;
}

export type CommandResult = CommandSuccess | CommandRejection;

const MESSAGES: Record<CommandRejectionReason, string> = {
  'not-found': 'That transaction is no longer in your workspace. Nothing was changed.',
  'invalid-value': 'Some of those values could not be saved. Nothing was changed.',
  'too-many-rows': `A single change can cover at most ${MAX_BULK_TRANSACTIONS.toLocaleString('en-US')} transactions. Narrow the selection and try again. Nothing was changed.`,
  'nothing-selected': 'No transactions were selected, so nothing was changed.',
  stale:
    'Those transactions changed since this action, so it was not applied. Nothing was changed.',
  'workspace-write-failed':
    'That change could not be saved. Nothing was changed — your workspace is exactly as it was.',
};

function reject(
  reason: CommandRejectionReason,
  problemPaths: readonly string[] = [],
): CommandRejection {
  return { ok: false, reason, message: MESSAGES[reason], problemPaths };
}

/* ------------------------------------------------------------ validation - */

export interface NormalizedPatch {
  readonly patch: TransactionPatch;
  readonly problems: readonly string[];
}

/**
 * Bounds and cleans a patch before anything is written.
 *
 * Values are *normalized* rather than rejected where a safe reading exists — a
 * merchant is trimmed and capped, tags are de-duplicated — because refusing a
 * save over trailing whitespace helps nobody. Anything with no safe reading is
 * a problem path.
 */
export function normalizePatch(patch: TransactionPatch): NormalizedPatch {
  const problems: string[] = [];
  const next: {
    -readonly [K in keyof TransactionPatch]: TransactionPatch[K];
  } = {};

  if (patch.merchantNormalized !== undefined) {
    const merchant = canonicalizeText(patch.merchantNormalized).slice(0, MAX_MERCHANT_LENGTH);
    if (merchant.length === 0) problems.push('merchantNormalized');
    else next.merchantNormalized = merchant;
  }

  if (patch.categoryId !== undefined) {
    if (!isCategoryId(patch.categoryId)) problems.push('categoryId');
    else next.categoryId = patch.categoryId;
  }

  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.essentiality !== undefined) next.essentiality = patch.essentiality;
  if (patch.variability !== undefined) next.variability = patch.variability;
  if (patch.excludedFromSpending !== undefined) {
    next.excludedFromSpending = patch.excludedFromSpending;
  }

  if (patch.tags !== undefined) {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const raw of patch.tags) {
      const tag = canonicalizeText(raw).slice(0, MAX_TAG_LENGTH);
      // A blank tag is dropped rather than stored: an empty chip is noise, and
      // whitespace-only input is almost always a slip.
      if (tag.length === 0 || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length > MAX_TAGS_PER_TRANSACTION) problems.push('tags');
    else next.tags = tags;
  }

  if (patch.note !== undefined) {
    if (patch.note === null) next.note = null;
    else {
      const note = patch.note.trim();
      if (note.length > MAX_NOTE_LENGTH) problems.push('note');
      else next.note = note.length === 0 ? null : note;
    }
  }

  return { patch: next, problems };
}

/**
 * Applies a validated patch to one row.
 *
 * Source fields are copied through untouched. A kind change reconciles the
 * exclusion fields in the same step, so the two can never disagree — §18
 * requires that to be deterministic and atomic, and doing it here means it
 * happens on every path that changes a kind.
 */
function applyPatch(row: Transaction, patch: TransactionPatch, now: string): Transaction {
  const next: Transaction = {
    ...row,
    ...(patch.merchantNormalized === undefined
      ? {}
      : { merchantNormalized: patch.merchantNormalized }),
    ...(patch.categoryId === undefined ? {} : { categoryId: patch.categoryId }),
    ...(patch.kind === undefined ? {} : { kind: patch.kind }),
    ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
    updatedAt: now,
    // Any manual change makes this a tier-1 decision, which is what stops a
    // later rule or alias improvement from overwriting it (§5.4).
    categorySource: 'user',
    classificationConfidence: 'high',
  };

  if (patch.essentiality !== undefined) {
    if (patch.essentiality === null) delete (next as { essentiality?: unknown }).essentiality;
    else next.essentiality = patch.essentiality;
  }
  if (patch.variability !== undefined) {
    if (patch.variability === null) delete (next as { variability?: unknown }).variability;
    else next.variability = patch.variability;
  }
  if (patch.note !== undefined) {
    if (patch.note === null) delete (next as { note?: unknown }).note;
    else next.note = patch.note;
  }

  const kind = patch.kind ?? row.kind;
  const wantsExcluded = patch.excludedFromSpending ?? row.excludedFromSpending;

  // An exclusion the user asks for only sticks on a kind where it means
  // something; on `transfer` the kind already excludes it (§18).
  const reconciled = reconcileExclusionForKind(kind, {
    excludedFromSpending: userExclusionApplies(kind) ? wantsExcluded : false,
    ...(row.exclusionReason === undefined ? {} : { exclusionReason: row.exclusionReason }),
  });

  next.excludedFromSpending = reconciled.excludedFromSpending;
  if (reconciled.exclusionReason === undefined) {
    delete (next as { exclusionReason?: unknown }).exclusionReason;
  } else {
    next.exclusionReason = reconciled.exclusionReason;
  }

  return next;
}

/** Field-level audit entries, the record category-rules.md §5.4 relies on. */
function auditEntries(
  before: Transaction,
  after: Transaction,
  at: string,
  generateId: () => string,
): UserEdit[] {
  const edits: UserEdit[] = [];
  const record = (field: string, previous: string | null, nextValue: string | null) => {
    if (previous === nextValue) return;
    edits.push({
      id: generateId(),
      entityType: 'transaction',
      entityId: after.id,
      field,
      previousValue: previous,
      nextValue,
      editedAt: at,
    });
  };

  record('categoryId', before.categoryId, after.categoryId);
  record('kind', before.kind, after.kind);
  record('merchantNormalized', before.merchantNormalized, after.merchantNormalized);
  record('essentiality', before.essentiality ?? null, after.essentiality ?? null);
  record('variability', before.variability ?? null, after.variability ?? null);
  record('note', before.note ?? null, after.note ?? null);
  record('tags', before.tags.join(' '), after.tags.join(' '));
  record(
    'excludedFromSpending',
    String(before.excludedFromSpending),
    String(after.excludedFromSpending),
  );

  return edits;
}

export interface CommandOptions {
  readonly clock?: Clock;
  readonly newId?: () => string;
  /** Shown in the undo control. Constant text, never a field value. */
  readonly label?: string;
  /**
   * Extra work to perform inside this command's own transaction.
   *
   * Exists so "edit this transaction and create a rule" can be one atomic
   * action rather than two that might half-apply. Whatever ids it returns are
   * attached to the undo command, so undoing the edit also removes what this
   * created. Throwing aborts the entire command, including the row updates.
   */
  readonly beforeCommit?: () => Promise<CommitSideEffects>;
}

/* --------------------------------------------------------------- commands - */

/**
 * Applies one patch to a set of transactions, atomically.
 *
 * Individual and bulk edits are the same command with one or many ids, so there
 * is a single implementation of "either every selected row changes or none
 * does". Validation happens before the write transaction opens; the write then
 * reads the rows, applies the patch, and puts them back in one Dexie
 * transaction.
 */
export async function editTransactions(
  db: WorkspaceDatabase,
  ids: readonly string[],
  rawPatch: TransactionPatch,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const clock = options.clock ?? systemClock;
  const generateId = options.newId ?? newId;

  const unique = [...new Set(ids)];
  if (unique.length === 0) return reject('nothing-selected');
  if (unique.length > MAX_BULK_TRANSACTIONS) return reject('too-many-rows');

  const { patch, problems } = normalizePatch(rawPatch);
  if (problems.length > 0) return reject('invalid-value', problems);
  if (Object.keys(patch).length === 0) return reject('invalid-value', ['(no change requested)']);

  const now = clock();

  try {
    return await db.transaction(
      'rw',
      db.transactions,
      db.userEdits,
      db.merchantRules,
      db.transactionLinks,
      async (): Promise<CommandResult> => {
        const rows = await db.transactions.bulkGet([...unique]);

        const previous: Transaction[] = [];
        const updated: Transaction[] = [];
        const expectedUpdatedAt = new Map<string, string>();
        const edits: UserEdit[] = [];

        for (let index = 0; index < unique.length; index += 1) {
          const row = rows[index];
          // One missing row fails the whole command. A bulk edit that silently
          // skipped a deleted row would report a count the user cannot reconcile.
          if (!row) return reject('not-found', [`transactions.${index}`]);

          const next = applyPatch(row, patch, now);

          // The row is validated against the same schema a backup is held to,
          // so an edit can never write a shape that would later fail export.
          const parsed = transactionSchema.safeParse(next);
          if (!parsed.success) {
            return reject(
              'invalid-value',
              parsed.error.issues.slice(0, 10).map((issue) => issue.path.map(String).join('.')),
            );
          }

          previous.push(row);
          updated.push(next);
          expectedUpdatedAt.set(next.id, next.updatedAt);
          edits.push(...auditEntries(row, next, now, generateId));
        }

        // Runs before the row writes so a refusal here costs nothing, and
        // inside the transaction so a throw takes the whole command with it.
        const sideEffects: CommitSideEffects = options.beforeCommit
          ? await options.beforeCommit()
          : {};

        await db.transactions.bulkPut(updated);
        if (edits.length > 0) await db.userEdits.bulkAdd(edits);

        return {
          ok: true,
          changedCount: updated.length,
          undo: {
            id: generateId(),
            label: options.label ?? (updated.length === 1 ? 'edit' : 'bulk edit'),
            previous,
            expectedUpdatedAt,
            userEditIds: edits.map((edit) => edit.id),
            ...(sideEffects.createdRuleIds?.length
              ? { createdRuleIds: [...sideEffects.createdRuleIds] }
              : {}),
            ...(sideEffects.createdLinkIds?.length
              ? { createdLinkIds: [...sideEffects.createdLinkIds] }
              : {}),
            ...(sideEffects.removedLinks?.length
              ? { removedLinks: [...sideEffects.removedLinks] }
              : {}),
          },
        };
      },
    );
  } catch {
    return reject('workspace-write-failed');
  }
}

/** Convenience wrapper for the single-row editor. */
export async function editTransaction(
  db: WorkspaceDatabase,
  id: string,
  patch: TransactionPatch,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return editTransactions(db, [id], patch, { ...options, label: options.label ?? 'edit' });
}

/**
 * Puts the workspace back exactly as an undo command recorded it.
 *
 * Refuses when any affected row has changed since — an undo that overwrote a
 * newer edit would silently discard work the user did after the action they are
 * undoing. The audit entries the command wrote are removed too, so the log
 * describes what the workspace actually contains.
 */
export async function undoCommand(
  db: WorkspaceDatabase,
  command: UndoCommand,
): Promise<CommandResult> {
  if (command.previous.length === 0) return reject('nothing-selected');

  try {
    return await db.transaction(
      'rw',
      db.transactions,
      db.userEdits,
      db.merchantRules,
      db.transactionLinks,
      async (): Promise<CommandResult> => {
        const current = await db.transactions.bulkGet(command.previous.map((row) => row.id));

        for (let index = 0; index < current.length; index += 1) {
          const row = current[index];
          if (!row) return reject('not-found', [`transactions.${index}`]);

          const expected = command.expectedUpdatedAt.get(row.id);
          if (expected !== undefined && row.updatedAt !== expected) {
            return reject('stale', [`transactions.${index}`]);
          }
        }

        await db.transactions.bulkPut([...command.previous]);
        if (command.userEditIds.length > 0) {
          await db.userEdits.bulkDelete([...command.userEditIds]);
        }
        if (command.createdRuleIds && command.createdRuleIds.length > 0) {
          await db.merchantRules.bulkDelete([...command.createdRuleIds]);
        }
        if (command.createdLinkIds && command.createdLinkIds.length > 0) {
          await db.transactionLinks.bulkDelete([...command.createdLinkIds]);
        }
        if (command.removedLinks && command.removedLinks.length > 0) {
          await db.transactionLinks.bulkAdd([...command.removedLinks]);
        }

        return {
          ok: true,
          changedCount: command.previous.length,
          undo: {
            // Undoing is not itself undoable: §17 rules out a redo system.
            id: command.id,
            label: command.label,
            previous: [],
            expectedUpdatedAt: new Map(),
            userEditIds: [],
          },
        };
      },
    );
  } catch {
    return reject('workspace-write-failed');
  }
}
