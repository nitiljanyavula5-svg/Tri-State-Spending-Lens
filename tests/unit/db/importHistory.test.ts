import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { buildStagedImport, commitImport } from '../../../src/db/importCommit';
import { listImportHistory, rollbackImportSession } from '../../../src/db/importHistory';
import { putAccount } from '../../../src/db/repositories/accounts';
import { putMerchantRule } from '../../../src/db/repositories/rules';
import { saveBudgetPlanWithTargets } from '../../../src/db/repositories/budgets';
import { deleteImportSession } from '../../../src/db/repositories/transactions';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { readSnapshot } from '../../../src/db/workspace';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { account, resetRowSeed, stagedRow } from './helpers/importFixtures';

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
  resetRowSeed();
  await setWorkspaceMode(db, 'personal', fixedClock('2026-08-01T12:00:00.000Z'));
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

function sequentialIds(prefix: string) {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

/**
 * Commits one session through the real service.
 *
 * Building history from actual commits rather than hand-written rows means
 * these tests exercise the same records the product will roll back.
 */
async function commitSession(options: {
  sessionId: string;
  accountId: string;
  rows: number;
  importedAt: string;
  fileName?: string;
  createAccount?: boolean;
}): Promise<void> {
  const acceptedRows = Array.from({ length: options.rows }, () =>
    stagedRow({ accountId: options.accountId, fileName: options.fileName ?? 'statement.csv' }),
  );

  const result = await commitImport(
    db,
    buildStagedImport({
      rowCount: options.rows,
      acceptedRows,
      excludedRows: [],
      rejections: [],
      duplicateCandidates: [],
      warnings: [],
      sourceFileNames: [options.fileName ?? 'statement.csv'],
      newAccounts: options.createAccount ? [account({ id: options.accountId })] : [],
      sessionId: options.sessionId,
      newId: sequentialIds(options.sessionId),
      clock: fixedClock(options.importedAt),
    }),
  );

  expect(result.ok).toBe(true);
}

describe('import history', () => {
  it('describes each stored session safely, newest first', async () => {
    await putAccount(db, account({ id: 'account-a', label: 'Everyday Checking' }));
    await commitSession({
      sessionId: 'session-a',
      accountId: 'account-a',
      rows: 2,
      importedAt: '2026-05-01T10:00:00.000Z',
      fileName: '../../secret/path/april.csv',
    });
    await commitSession({
      sessionId: 'session-b',
      accountId: 'account-a',
      rows: 3,
      importedAt: '2026-06-01T10:00:00.000Z',
    });

    const history = await listImportHistory(db);

    expect(history.map((entry) => entry.sessionId)).toEqual(['session-b', 'session-a']);

    const april = history[1]!;
    expect(april.importedAt).toBe('2026-05-01T10:00:00.000Z');
    expect(april.accountIds).toEqual(['account-a']);
    expect(april.accountLabels).toEqual(['Everyday Checking']);
    expect(april.rowCount).toBe(2);
    expect(april.acceptedCount).toBe(2);
    expect(april.rejectedCount).toBe(0);
    expect(april.duplicateCandidateCount).toBe(0);
    expect(april.storedTransactionCount).toBe(2);
    expect(april.countsReconcile).toBe(true);

    // The filename is stored and displayed with no path component at all.
    expect(april.sourceFileNames).toEqual(['secret-path-april.csv']);
  });

  it('counts a duplicate candidate the user excluded as rejected, never as accepted', async () => {
    await putAccount(db, account({ id: 'account-a' }));

    const kept = [stagedRow({ accountId: 'account-a' }), stagedRow({ accountId: 'account-a' })];
    const excluded = [stagedRow({ accountId: 'account-a' })];

    const result = await commitImport(
      db,
      buildStagedImport({
        // Three rows were read; the user excluded one duplicate candidate.
        rowCount: 3,
        acceptedRows: kept,
        excludedRows: excluded,
        rejections: [],
        // Two rows were *flagged*; only one was excluded. Flagging alone never
        // rejects anything (data-methodology.md §4.1).
        duplicateCandidates: [
          {
            fingerprint: kept[1]!.fingerprint,
            fileName: 'statement.csv',
            originalRow: kept[1]!.originalRow,
            source: 'staged-session',
            reason: 'An identical row appears earlier in the files you selected.',
          },
          {
            fingerprint: excluded[0]!.fingerprint,
            fileName: 'statement.csv',
            originalRow: excluded[0]!.originalRow,
            source: 'staged-session',
            reason: 'An identical row appears earlier in the files you selected.',
          },
        ],
        warnings: [],
        sourceFileNames: ['statement.csv'],
        newAccounts: [],
        sessionId: 'session-a',
        newId: sequentialIds('txn'),
        clock: fixedClock('2026-05-01T10:00:00.000Z'),
      }),
    );

    expect(result.ok).toBe(true);

    const [entry] = await listImportHistory(db);
    expect(entry?.rowCount).toBe(3);
    expect(entry?.acceptedCount).toBe(2);
    expect(entry?.rejectedCount).toBe(1);
    expect(entry?.duplicateCandidateCount).toBe(2);
    expect(entry?.countsReconcile).toBe(true);

    // The kept candidate really is still in the workspace — flagging removed
    // nothing.
    expect(await db.transactions.count()).toBe(2);
  });
});

describe('rolling back one session', () => {
  beforeEach(async () => {
    await putAccount(db, account({ id: 'account-shared', label: 'Shared Checking' }));
    await commitSession({
      sessionId: 'session-a',
      accountId: 'account-shared',
      rows: 3,
      importedAt: '2026-05-01T10:00:00.000Z',
    });
    await commitSession({
      sessionId: 'session-b',
      accountId: 'account-shared',
      rows: 2,
      importedAt: '2026-06-01T10:00:00.000Z',
    });
  });

  it('removes only that session’s transactions and reports the exact count', async () => {
    const result = await rollbackImportSession(db, 'session-a');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removedTransactionCount).toBe(3);

    expect(await db.transactions.count()).toBe(2);
    const remaining = await db.transactions.toArray();
    for (const row of remaining) {
      expect(row.importSessionId).toBe('session-b');
    }
  });

  it('preserves the other session record itself', async () => {
    await rollbackImportSession(db, 'session-a');

    expect(await db.importSessions.get('session-a')).toBeUndefined();
    expect(await db.importSessions.get('session-b')).toBeDefined();
    expect((await listImportHistory(db)).map((entry) => entry.sessionId)).toEqual(['session-b']);
  });

  it('never deletes an account another session is still using', async () => {
    const result = await rollbackImportSession(db, 'session-a');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Still referenced by session-b's rows, so not even reported as emptied.
      expect(result.emptiedAccountIds).toEqual([]);
    }
    expect(await db.accounts.get('account-shared')).toBeDefined();
  });

  it('reports an account left empty but preserves it', async () => {
    await rollbackImportSession(db, 'session-a');
    const result = await rollbackImportSession(db, 'session-b');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.emptiedAccountIds).toEqual(['account-shared']);

    // Reported, not removed: nothing in the data contract distinguishes an
    // account an import created from one the user made themselves.
    expect(await db.accounts.get('account-shared')).toBeDefined();
    expect(await db.transactions.count()).toBe(0);
  });

  it('leaves budgets, merchant rules, and settings alone', async () => {
    await saveBudgetPlanWithTargets(
      db,
      { id: 'plan-1', month: '2026-05', overallLimitCents: 100_000, rolloverEnabled: false },
      [{ id: 'target-1', budgetPlanId: 'plan-1', categoryId: 'dining', limitCents: 20_000 }],
    );
    await putMerchantRule(db, {
      id: 'rule-1',
      matchType: 'contains',
      pattern: 'PINEBROOK',
      priority: 1,
      createdByUser: true,
    });

    await rollbackImportSession(db, 'session-a');

    expect(await db.budgetPlans.count()).toBe(1);
    expect(await db.budgetCategoryTargets.count()).toBe(1);
    expect(await db.merchantRules.count()).toBe(1);
    expect(await db.appSettings.get('workspaceMode')).toBeDefined();
  });

  it('is truthful about a session that is not there, and safe to repeat', async () => {
    const first = await rollbackImportSession(db, 'session-a');
    expect(first.ok).toBe(true);

    const second = await rollbackImportSession(db, 'session-a');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('session-not-found');

    const never = await rollbackImportSession(db, 'no-such-session');
    expect(never.ok).toBe(false);
    if (!never.ok) expect(never.reason).toBe('session-not-found');

    // The repeated calls changed nothing beyond the first rollback.
    expect(await db.transactions.count()).toBe(2);
    expect(await db.importSessions.count()).toBe(1);
  });

  it('changes nothing at all when the delete fails partway', async () => {
    const before = await readSnapshot(db);

    // The transactions are deleted before the session record is. Making the
    // second step fail is what proves the first is undone.
    vi.spyOn(db.importSessions, 'delete').mockImplementation((() => {
      throw new Error('injected storage failure');
    }) as never);

    const result = await rollbackImportSession(db, 'session-a');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workspace-write-failed');

    expect(await readSnapshot(db)).toEqual(before);
  });
});

describe('the deleteImportSession primitive', () => {
  beforeEach(async () => {
    await putAccount(db, account({ id: 'account-shared' }));
    await commitSession({
      sessionId: 'session-a',
      accountId: 'account-shared',
      rows: 3,
      importedAt: '2026-05-01T10:00:00.000Z',
    });
  });

  it('returns the exact number of transactions it removed', async () => {
    expect(await deleteImportSession(db, 'session-a')).toBe(3);
    expect(await deleteImportSession(db, 'session-a')).toBe(0);
  });

  it('refuses an empty session id rather than matching something arbitrary', async () => {
    await expect(deleteImportSession(db, '')).rejects.toThrow(/import session id/i);
    expect(await db.transactions.count()).toBe(3);
  });
});
