import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  appendUserEdit,
  commitImportSession,
  countTransactions,
  deleteImportSession,
  getBudgetPlanForMonth,
  listAccounts,
  listImportSessions,
  listMerchantRules,
  listTransactions,
  listTransactionsBySession,
  listUserEditsForEntity,
  putAccounts,
  putMerchantRule,
  saveBudgetPlanWithTargets,
  setWorkspaceMode,
  sortRulesByPrecedence,
  transactionDateRange,
  getWorkspaceMode,
} from '../../../src/db/repositories';
import { countAll, deleteAllData, summarizeWorkspace } from '../../../src/db/workspace';
import type { ImportSession, MerchantRule, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase, TEST_CLOCK } from '../helpers/testDatabase';

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

function transaction(overrides: Partial<Transaction> & Pick<Transaction, 'id'>): Transaction {
  return {
    fingerprint: `fp-${overrides.id}`,
    importSessionId: 'session-a',
    originalRow: 2,
    accountId: 'account-1',
    postedDate: '2026-04-01',
    descriptionRaw: 'PINEBROOK MARKET',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'groceries',
    categorySource: 'merchant_rule',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: TEST_CLOCK(),
    updatedAt: TEST_CLOCK(),
    ...overrides,
  };
}

function session(id: string): ImportSession {
  return {
    id,
    importedAt: TEST_CLOCK(),
    sourceFileNames: ['fictional.csv'],
    accountIds: ['account-1'],
    mappingVersion: 1,
    rowCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
  };
}

describe('accounts', () => {
  it('stores and lists accounts alphabetically', async () => {
    await putAccounts(db, [
      {
        id: 'b',
        label: 'Rewards Card (demo)',
        type: 'credit_card',
        currency: 'USD',
        archived: false,
      },
      {
        id: 'a',
        label: 'Everyday Checking (demo)',
        type: 'checking',
        currency: 'USD',
        archived: false,
      },
    ]);

    expect((await listAccounts(db)).map((a) => a.label)).toEqual([
      'Everyday Checking (demo)',
      'Rewards Card (demo)',
    ]);
  });
});

describe('import sessions', () => {
  it('commits a session and its rows together', async () => {
    await commitImportSession(db, session('session-a'), [
      transaction({ id: 't1' }),
      transaction({ id: 't2', postedDate: '2026-04-09' }),
    ]);

    expect(await countTransactions(db)).toBe(2);
    expect(await listImportSessions(db)).toHaveLength(1);
  });

  it('removes only the target session on rollback', async () => {
    await commitImportSession(db, session('session-a'), [
      transaction({ id: 'a1' }),
      transaction({ id: 'a2' }),
    ]);
    await commitImportSession(db, session('session-b'), [
      transaction({ id: 'b1', importSessionId: 'session-b', postedDate: '2026-05-02' }),
    ]);

    const removed = await deleteImportSession(db, 'session-a');

    expect(removed).toBe(2);
    expect(await countTransactions(db)).toBe(1);
    expect((await listTransactionsBySession(db, 'session-b')).map((t) => t.id)).toEqual(['b1']);
    expect(await listImportSessions(db)).toHaveLength(1);
  });

  it('leaves budgets and rules untouched when a session is rolled back', async () => {
    await commitImportSession(db, session('session-a'), [transaction({ id: 'a1' })]);
    await saveBudgetPlanWithTargets(
      db,
      { id: 'plan-1', month: '2026-04', overallLimitCents: 100_000, rolloverEnabled: false },
      [{ id: 'target-1', budgetPlanId: 'plan-1', categoryId: 'dining', limitCents: 20_000 }],
    );
    await putMerchantRule(db, {
      id: 'rule-1',
      matchType: 'contains',
      pattern: 'PINEBROOK',
      priority: 1,
      createdByUser: true,
    });

    await deleteImportSession(db, 'session-a');

    expect(await getBudgetPlanForMonth(db, '2026-04')).toBeDefined();
    expect(await listMerchantRules(db)).toHaveLength(1);
  });
});

describe('transactions', () => {
  it('reports the stored date span', async () => {
    await commitImportSession(db, session('session-a'), [
      transaction({ id: 't1', postedDate: '2026-06-30' }),
      transaction({ id: 't2', postedDate: '2026-04-02' }),
      transaction({ id: 't3', postedDate: '2026-05-15' }),
    ]);

    expect(await transactionDateRange(db)).toEqual({ start: '2026-04-02', end: '2026-06-30' });
  });

  it('has no date span when nothing is stored', async () => {
    expect(await transactionDateRange(db)).toBeNull();
  });

  it('lists transactions in posted-date order', async () => {
    await commitImportSession(db, session('session-a'), [
      transaction({ id: 'late', postedDate: '2026-07-01' }),
      transaction({ id: 'early', postedDate: '2026-04-01' }),
    ]);

    expect((await listTransactions(db)).map((t) => t.id)).toEqual(['early', 'late']);
  });
});

describe('budgets', () => {
  it('replaces category targets rather than accumulating them', async () => {
    const plan = { id: 'plan-1', month: '2026-04', rolloverEnabled: false } as const;

    await saveBudgetPlanWithTargets(db, plan, [
      { id: 't-a', budgetPlanId: 'plan-1', categoryId: 'dining', limitCents: 10_000 },
      { id: 't-b', budgetPlanId: 'plan-1', categoryId: 'groceries', limitCents: 40_000 },
    ]);
    await saveBudgetPlanWithTargets(db, plan, [
      { id: 't-c', budgetPlanId: 'plan-1', categoryId: 'dining', limitCents: 12_000 },
    ]);

    const counts = await countAll(db);
    expect(counts.budgetCategoryTargets).toBe(1);
  });
});

describe('merchant rule precedence', () => {
  it('orders user rules first, then priority, specificity, pattern length, and id', () => {
    const make = (over: Partial<MerchantRule> & Pick<MerchantRule, 'id'>): MerchantRule => ({
      matchType: 'contains',
      pattern: 'AAA',
      priority: 0,
      createdByUser: false,
      ...over,
    });

    const ordered = sortRulesByPrecedence([
      make({ id: 'builtin-contains' }),
      make({ id: 'builtin-exact', matchType: 'exact' }),
      make({ id: 'builtin-high-priority', priority: 5 }),
      make({ id: 'user-rule', createdByUser: true }),
      make({ id: 'builtin-long-pattern', pattern: 'AAAAAAAA' }),
    ]).map((rule) => rule.id);

    expect(ordered[0]).toBe('user-rule');
    expect(ordered[1]).toBe('builtin-high-priority');
    expect(ordered[2]).toBe('builtin-exact');
    expect(ordered[3]).toBe('builtin-long-pattern');
  });

  it('is deterministic for otherwise identical rules', () => {
    const base: MerchantRule = {
      id: 'b',
      matchType: 'contains',
      pattern: 'AAA',
      priority: 0,
      createdByUser: false,
    };
    const input = [
      { ...base, id: 'c' },
      { ...base, id: 'a' },
      { ...base, id: 'b' },
    ];

    expect(sortRulesByPrecedence(input).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortRulesByPrecedence([...input].reverse()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('user edits', () => {
  it('appends edits and returns them in order for one entity', async () => {
    await appendUserEdit(db, {
      id: 'edit-1',
      entityType: 'transaction',
      entityId: 't1',
      field: 'categoryId',
      previousValue: 'other',
      nextValue: 'dining',
      editedAt: '2026-08-01T10:00:00.000Z',
    });
    await appendUserEdit(db, {
      id: 'edit-2',
      entityType: 'transaction',
      entityId: 't1',
      field: 'kind',
      previousValue: 'purchase',
      nextValue: 'refund',
      editedAt: '2026-08-01T11:00:00.000Z',
    });
    await appendUserEdit(db, {
      id: 'edit-3',
      entityType: 'recurring_series',
      entityId: 't1',
      field: 'userStatus',
      previousValue: null,
      nextValue: 'confirmed',
      editedAt: '2026-08-01T09:00:00.000Z',
    });

    const edits = await listUserEditsForEntity(db, 'transaction', 't1');
    expect(edits.map((e) => e.id)).toEqual(['edit-1', 'edit-2']);
  });
});

describe('workspace summary and deletion', () => {
  it('summarizes what is stored without producing any financial total', async () => {
    await putAccounts(db, [
      {
        id: 'account-1',
        label: 'Everyday Checking (demo)',
        type: 'checking',
        currency: 'USD',
        archived: false,
      },
    ]);
    await commitImportSession(db, session('session-a'), [
      transaction({ id: 't1', postedDate: '2026-04-01' }),
      transaction({ id: 't2', postedDate: '2026-05-01' }),
    ]);
    await setWorkspaceMode(db, 'demo', TEST_CLOCK);

    const summary = await summarizeWorkspace(db);

    expect(summary.mode).toBe('demo');
    expect(summary.counts.transactions).toBe(2);
    expect(summary.storedDateRange).toEqual({ start: '2026-04-01', end: '2026-05-01' });
    expect(summary.accountLabels).toEqual(['Everyday Checking (demo)']);
    expect(summary.isEmpty).toBe(false);

    // The summary is record counts only — no contract figure may leak in here.
    expect(Object.keys(summary)).toEqual(
      expect.not.arrayContaining(['netSpendingCents', 'moneyInCents', 'savingsRate']),
    );
  });

  it('delete-all clears transactions, budgets, rules, recurring series, and settings', async () => {
    await commitImportSession(db, session('session-a'), [transaction({ id: 't1' })]);
    await saveBudgetPlanWithTargets(
      db,
      { id: 'plan-1', month: '2026-04', rolloverEnabled: false },
      [{ id: 'target-1', budgetPlanId: 'plan-1', categoryId: 'dining', limitCents: 1000 }],
    );
    await putMerchantRule(db, {
      id: 'rule-1',
      matchType: 'exact',
      pattern: 'X',
      priority: 0,
      createdByUser: true,
    });
    await setWorkspaceMode(db, 'demo', TEST_CLOCK);

    await deleteAllData(db);

    const counts = await countAll(db);
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} should be empty after delete-all`).toBe(0);
    }
    expect(await getWorkspaceMode(db)).toBe('empty');

    // The migration log survives: it describes the database, not the data.
    expect(await db.schemaMigrations.count()).toBeGreaterThan(0);
  });
});
