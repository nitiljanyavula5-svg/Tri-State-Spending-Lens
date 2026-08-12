import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  applyRuleToTransactions,
  countMatchingTransactions,
  createUserRule,
  deleteUserRule,
  editTransactionAndCreateRule,
  listUserRules,
  updateUserRule,
  validateRuleDraft,
} from '../../../src/db/ruleCommands';
import { undoCommand } from '../../../src/db/transactionCommands';
import { classify } from '../../../src/classification/classify';
import { sortRulesByPrecedence } from '../../../src/db/repositories/rules';
import { exportWorkspace, parseBackup, serializeBackup } from '../../../src/db/backup';
import { readSnapshot, replaceWorkspace } from '../../../src/db/workspace';
import { MAX_USER_RULES, MIN_CONTAINS_PATTERN_LENGTH } from '../../../src/domain/reviewLimits';
import type { Transaction } from '../../../src/types/domain';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * User rules: creation, management, and the combined edit-plus-rule command.
 *
 * The property under test throughout is blast radius. A rule changes how future
 * data is read; it must never quietly rewrite what is already stored.
 */

const CLOCK = fixedClock('2026-08-02T09:00:00.000Z');

let db: WorkspaceDatabase;
let idCounter = 0;
const ids = () => () => {
  idCounter += 1;
  return `gen-${idCounter}`;
};

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn-1',
    fingerprint: '0'.repeat(64),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'account-1',
    postedDate: '2026-04-08',
    descriptionRaw: 'PINEBROOK MARKET',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1000,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'other',
    categorySource: 'uncategorized',
    classificationConfidence: 'none',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('validating a draft rule', () => {
  it('accepts a well-formed rule and canonicalizes its pattern', () => {
    const result = validateRuleDraft({
      matchType: 'contains',
      pattern: '  pinebrook  ',
      categoryId: 'groceries',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Rules match against `merchantNormalized`, so the pattern is canonicalized
    // the same way — otherwise it would silently never match.
    expect(result.rule.pattern).toBe('PINEBROOK');
    expect(result.rule.createdByUser).toBe(true);
  });

  const refusals = [
    {
      name: 'an empty pattern',
      draft: { matchType: 'exact' as const, pattern: '   ', categoryId: 'dining' },
      reason: 'invalid-pattern',
    },
    {
      name: 'a dangerously broad contains rule',
      draft: { matchType: 'contains' as const, pattern: 'A', categoryId: 'dining' },
      reason: 'pattern-too-broad',
    },
    {
      name: 'a rule that changes nothing',
      draft: { matchType: 'exact' as const, pattern: 'PINEBROOK' },
      reason: 'no-effect',
    },
    {
      name: 'an unknown category',
      draft: { matchType: 'exact' as const, pattern: 'PINEBROOK', categoryId: 'nope' },
      reason: 'invalid-category',
    },
    {
      name: 'a non-integer priority',
      draft: { matchType: 'exact' as const, pattern: 'P', categoryId: 'dining', priority: 1.5 },
      reason: 'invalid-priority',
    },
    {
      name: 'an out-of-range priority',
      draft: { matchType: 'exact' as const, pattern: 'P', categoryId: 'dining', priority: 99_999 },
      reason: 'invalid-priority',
    },
  ];

  it.each(refusals)('refuses $name', ({ draft, reason }) => {
    const result = validateRuleDraft(draft);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      // A refusal names fields, never the pattern the user typed.
      expect(result.message).not.toContain('PINEBROOK');
    }
  });

  it('allows a short exact pattern, which is inherently narrow', () => {
    expect(
      validateRuleDraft({ matchType: 'exact', pattern: 'BP', categoryId: 'transportation' }).ok,
    ).toBe(true);
  });

  it('warns about a short contains pattern without refusing it', () => {
    const result = validateRuleDraft({
      matchType: 'contains',
      pattern: 'X'.repeat(MIN_CONTAINS_PATTERN_LENGTH),
      categoryId: 'dining',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toMatch(/may match more transactions/i);
  });
});

describe('rule persistence', () => {
  it('creates a rule that survives a reload', async () => {
    const result = await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Read back from storage, not from the return value.
    const stored = await db.merchantRules.get(result.rule.id);
    expect(stored?.pattern).toBe('PINEBROOK MARKET');
    expect(stored?.categoryId).toBe('groceries');
    expect(stored?.createdByUser).toBe(true);
  });

  it('lists rules in precedence order, not database order', async () => {
    await db.merchantRules.bulkAdd([
      {
        id: 'z',
        matchType: 'contains',
        pattern: 'PINE',
        categoryId: 'dining',
        priority: 0,
        createdByUser: true,
      },
      {
        id: 'a',
        matchType: 'exact',
        pattern: 'PINEBROOK MARKET',
        categoryId: 'groceries',
        priority: 0,
        createdByUser: true,
      },
      {
        id: 'm',
        matchType: 'contains',
        pattern: 'MARKET',
        categoryId: 'shopping',
        priority: 9,
        createdByUser: true,
      },
    ]);

    const page = await listUserRules(db);
    expect(page.rules.map((rule) => rule.id)).toEqual(['m', 'a', 'z']);
    expect(page.totalCount).toBe(3);
  });

  it('pages rules and clamps an out-of-range page', async () => {
    await db.merchantRules.bulkAdd(
      Array.from({ length: 7 }, (_, index) => ({
        id: `rule-${index}`,
        matchType: 'exact' as const,
        pattern: `PATTERN ${index}`,
        categoryId: 'dining',
        priority: index,
        createdByUser: true,
      })),
    );

    const page = await listUserRules(db, 99, 3);
    expect(page.pageCount).toBe(3);
    expect(page.page).toBe(2);
    expect(page.rules).toHaveLength(1);
  });

  it('edits a rule in place', async () => {
    const created = await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK', categoryId: 'groceries' },
      { newId: ids() },
    );
    if (!created.ok) throw new Error(created.reason);

    const updated = await updateUserRule(db, created.rule.id, {
      matchType: 'starts_with',
      pattern: 'PINEBROOK',
      categoryId: 'dining',
    });

    expect(updated.ok).toBe(true);
    const stored = await db.merchantRules.get(created.rule.id);
    expect(stored?.matchType).toBe('starts_with');
    expect(stored?.categoryId).toBe('dining');
  });

  it('refuses to exceed the rule ceiling and writes nothing when it does', async () => {
    await db.merchantRules.bulkAdd(
      Array.from({ length: MAX_USER_RULES }, (_, index) => ({
        id: `rule-${index}`,
        matchType: 'exact' as const,
        pattern: `PATTERN ${index}`,
        categoryId: 'dining',
        priority: 0,
        createdByUser: true,
      })),
    );

    const result = await createUserRule(
      db,
      { matchType: 'exact', pattern: 'ONE TOO MANY', categoryId: 'dining' },
      { newId: ids() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-many-rules');
    expect(await db.merchantRules.count()).toBe(MAX_USER_RULES);
  });
});

describe('deleting a rule', () => {
  it('removes the rule and preserves every transaction', async () => {
    await db.transactions.add(
      transaction({ categoryId: 'groceries', categorySource: 'user_rule' }),
    );
    const created = await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );
    if (!created.ok) throw new Error(created.reason);

    const result = await deleteUserRule(db, created.rule.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deleted).toBe(true);

    expect(await db.merchantRules.count()).toBe(0);
    // Deleting a rule must not recategorize history or remove rows.
    const stored = await db.transactions.get('txn-1');
    expect(stored?.categoryId).toBe('groceries');
    expect(stored?.descriptionRaw).toBe('PINEBROOK MARKET');
  });

  it('is truthful and safe when the rule is already gone', async () => {
    const result = await deleteUserRule(db, 'never-existed');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deleted).toBe(false);
  });
});

describe('the bounded match preview', () => {
  it('counts matching stored rows without returning them', async () => {
    await db.transactions.bulkAdd([
      transaction({ id: 'a', merchantNormalized: 'PINEBROOK MARKET' }),
      transaction({ id: 'b', merchantNormalized: 'PINEBROOK MARKET' }),
      transaction({ id: 'c', merchantNormalized: 'HARBOR BEAN COFFEE' }),
    ]);

    const result = await countMatchingTransactions(db, {
      matchType: 'contains',
      pattern: 'PINEBROOK',
    });

    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
    // A count, deliberately — not a page of personal records.
    expect(Object.keys(result)).toEqual(['count', 'truncated']);
  });
});

describe('edit this transaction and create a rule', () => {
  it('changes only the selected row and creates the rule atomically', async () => {
    await db.transactions.bulkAdd([
      transaction({ id: 'selected' }),
      transaction({ id: 'other-match', merchantNormalized: 'PINEBROOK MARKET' }),
    ]);

    const result = await editTransactionAndCreateRule(
      db,
      'selected',
      { categoryId: 'groceries' },
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.command.ok).toBe(true);
    expect(result.rule).not.toBeNull();

    expect((await db.transactions.get('selected'))?.categoryId).toBe('groceries');
    // The rule affects the *future*; the other matching row is untouched.
    const other = await db.transactions.get('other-match');
    expect(other?.categoryId).toBe('other');
    expect(other?.categorySource).toBe('uncategorized');

    expect(await db.merchantRules.count()).toBe(1);
  });

  it('writes neither half when the edit is invalid', async () => {
    await db.transactions.add(transaction());
    const before = await readSnapshot(db);

    const result = await editTransactionAndCreateRule(
      db,
      'txn-1',
      { categoryId: 'not-a-category' },
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.command.ok).toBe(false);
    expect(result.rule).toBeNull();
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('writes neither half when the rule is invalid', async () => {
    await db.transactions.add(transaction());
    const before = await readSnapshot(db);

    const result = await editTransactionAndCreateRule(
      db,
      'txn-1',
      { categoryId: 'groceries' },
      { matchType: 'contains', pattern: 'A', categoryId: 'groceries' },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.command.ok).toBe(false);
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('writes neither half when the row write fails', async () => {
    await db.transactions.add(transaction());
    const before = await readSnapshot(db);

    vi.spyOn(db.transactions, 'bulkPut').mockImplementation((() => {
      throw new Error('injected storage failure');
    }) as never);

    const result = await editTransactionAndCreateRule(
      db,
      'txn-1',
      { categoryId: 'groceries' },
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.command.ok).toBe(false);
    // The rule was added before the row write inside the same transaction, so
    // the abort has to have taken it back out.
    expect(await readSnapshot(db)).toEqual(before);
    expect(await db.merchantRules.count()).toBe(0);
  });

  it('is one undo unit that reverses both halves', async () => {
    await db.transactions.add(transaction());

    const result = await editTransactionAndCreateRule(
      db,
      'txn-1',
      { categoryId: 'groceries' },
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { clock: CLOCK, newId: ids() },
    );
    if (!result.command.ok) throw new Error('setup failed');

    const undone = await undoCommand(db, result.command.undo);
    expect(undone.ok).toBe(true);

    expect((await db.transactions.get('txn-1'))?.categoryId).toBe('other');
    // Undoing the visible half must not leave the invisible half classifying
    // future imports.
    expect(await db.merchantRules.count()).toBe(0);
  });
});

describe('applying a rule to history is a separate, explicit action', () => {
  it('changes exactly the rows the user selected', async () => {
    await db.transactions.bulkAdd([
      transaction({ id: 'a' }),
      transaction({ id: 'b' }),
      transaction({ id: 'c' }),
    ]);

    const created = await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );
    if (!created.ok) throw new Error(created.reason);

    const result = await applyRuleToTransactions(db, created.rule, ['a', 'b'], {
      clock: CLOCK,
      newId: ids(),
    });

    expect(result.ok).toBe(true);
    expect((await db.transactions.get('a'))?.categoryId).toBe('groceries');
    expect((await db.transactions.get('b'))?.categoryId).toBe('groceries');
    // Not selected, not changed.
    expect((await db.transactions.get('c'))?.categoryId).toBe('other');
  });
});

describe('rules survive backup and restore', () => {
  it('round-trips through export and restore', async () => {
    await createUserRule(
      db,
      { matchType: 'starts_with', pattern: 'PINEBROOK', categoryId: 'groceries', priority: 3 },
      { newId: ids() },
    );
    const before = await readSnapshot(db);

    const parsed = parseBackup(serializeBackup(await exportWorkspace(db, CLOCK)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    await replaceWorkspace(db, parsed.document.data as never);

    expect((await readSnapshot(db)).merchantRules).toEqual(before.merchantRules);
  });

  it('keeps classifying the same way after a restore', async () => {
    await createUserRule(
      db,
      { matchType: 'exact', pattern: 'PINEBROOK MARKET', categoryId: 'groceries' },
      { newId: ids() },
    );

    const rulesBefore = sortRulesByPrecedence(await db.merchantRules.toArray());
    const decisionBefore = classify({
      row: { descriptionRaw: 'PINEBROOK MARKET', direction: 'debit', amountCents: 1000 },
      userRules: rulesBefore,
    });

    const parsed = parseBackup(serializeBackup(await exportWorkspace(db, CLOCK)));
    if (!parsed.ok) throw new Error('export failed');
    await replaceWorkspace(db, parsed.document.data as never);

    const rulesAfter = sortRulesByPrecedence(await db.merchantRules.toArray());
    const decisionAfter = classify({
      row: { descriptionRaw: 'PINEBROOK MARKET', direction: 'debit', amountCents: 1000 },
      userRules: rulesAfter,
    });

    expect(decisionAfter).toEqual(decisionBefore);
    expect(decisionAfter.categorySource).toBe('user_rule');
  });
});
