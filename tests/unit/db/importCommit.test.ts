import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  buildStagedImport,
  commitImport,
  defaultKindForDirection,
  validateStagedImport,
  type BuildStagedImportInput,
  type StagedImport,
} from '../../../src/db/importCommit';
import { putAccount } from '../../../src/db/repositories/accounts';
import { saveMappingPreset } from '../../../src/db/repositories/mappingPresets';
import { getWorkspaceMode, setWorkspaceMode } from '../../../src/db/repositories/settings';
import { readSnapshot, replaceWorkspace } from '../../../src/db/workspace';
import { MAX_TEXT_FIELD_LENGTH } from '../../../src/db/bounds';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { normalizeFile } from '../../../src/import/normalizeFile';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { COMMA_UTF8, signedMapping, testSha256 } from '../import/helpers/fixtures';
import { account, presetDraft, resetRowSeed, stagedRow } from './helpers/importFixtures';

const IMPORTED_AT = '2026-08-01T12:00:00.000Z';
const CLOCK = fixedClock(IMPORTED_AT);

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
  resetRowSeed();
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

function stage(overrides: Partial<BuildStagedImportInput> = {}): StagedImport {
  return buildStagedImport({
    rowCount: 2,
    acceptedRows: [stagedRow(), stagedRow()],
    excludedRows: [],
    rejections: [],
    duplicateCandidates: [],
    warnings: [],
    sourceFileNames: ['statement.csv'],
    newAccounts: [],
    sessionId: 'session-1',
    newId: sequentialIds('txn'),
    clock: CLOCK,
    ...overrides,
  });
}

/** A workspace holding the user's own data, with one account already present. */
async function seedPersonalWorkspace(): Promise<void> {
  await putAccount(db, account());
  await setWorkspaceMode(db, 'personal', CLOCK);
}

/**
 * Makes the transaction write fail, without touching validation.
 *
 * This is the only way to reach the abort path: every collision the service can
 * see is refused before the transaction opens, so a genuine mid-write failure
 * has to be injected. `bulkAdd` runs *after* the accounts and the session have
 * already been written inside the transaction, which is exactly where a
 * non-atomic implementation would leave debris.
 */
function failTransactionWrite(): void {
  vi.spyOn(db.transactions, 'bulkAdd').mockImplementation((() => {
    throw new Error('injected storage failure');
  }) as never);
}

describe('committing an import into a personal workspace', () => {
  it('writes the session and its rows, and appends rather than replacing', async () => {
    await seedPersonalWorkspace();
    const first = await commitImport(db, stage());
    expect(first.ok).toBe(true);

    resetRowSeed();
    const second = await commitImport(
      db,
      stage({
        sessionId: 'session-2',
        newId: sequentialIds('later'),
        rowCount: 1,
        acceptedRows: [stagedRow()],
      }),
    );
    expect(second.ok).toBe(true);

    // The first import survives the second: a personal workspace is never cleared.
    expect(await db.importSessions.count()).toBe(2);
    expect(await db.transactions.count()).toBe(3);
    expect(await db.accounts.count()).toBe(1);
  });

  it('stores every field with the Phase 3 defaults, and nothing more', async () => {
    await seedPersonalWorkspace();
    await commitImport(db, stage({ rowCount: 1, acceptedRows: [stagedRow()] }));

    const stored = await db.transactions.get('txn-1');

    expect(stored).toEqual({
      id: 'txn-1',
      fingerprint: '0'.repeat(63) + '1',
      importSessionId: 'session-1',
      originalRow: 1,
      accountId: 'account-existing',
      postedDate: '2026-04-08',
      descriptionRaw: 'PINEBROOK MARKET 1',
      merchantNormalized: 'PINEBROOK MARKET 1',
      amountCents: 1234,
      direction: 'debit',
      kind: 'purchase',
      categoryId: 'other',
      categorySource: 'uncategorized',
      classificationConfidence: 'none',
      tags: [],
      excludedFromSpending: false,
      createdAt: IMPORTED_AT,
      updatedAt: IMPORTED_AT,
    });

    // Optional review fields are absent, not empty: an absent field says "not
    // decided", where a present empty one would say "decided, and it is blank".
    expect(stored).not.toHaveProperty('essentiality');
    expect(stored).not.toHaveProperty('variability');
    expect(stored).not.toHaveProperty('note');
    expect(stored).not.toHaveProperty('exclusionReason');
  });

  it('applies the documented direction defaults for kind', async () => {
    // data-methodology.md §3.5. A blanket `unknown` would leave every freshly
    // imported workspace reporting zero net spending, because
    // calculation-contract.md §3.3 excludes unknown debits from the total.
    expect(defaultKindForDirection('debit')).toBe('purchase');
    expect(defaultKindForDirection('credit')).toBe('unknown');

    await seedPersonalWorkspace();
    await commitImport(
      db,
      stage({
        rowCount: 2,
        acceptedRows: [stagedRow({ direction: 'debit' }), stagedRow({ direction: 'credit' })],
      }),
    );

    const kinds = (await db.transactions.orderBy('id').toArray()).map((row) => row.kind);
    expect(kinds).toEqual(['purchase', 'unknown']);
  });

  it('makes every transaction agree with the session that created it', async () => {
    await seedPersonalWorkspace();
    await commitImport(db, stage());

    const session = await db.importSessions.get('session-1');
    const rows = await db.transactions.toArray();

    expect(session).toBeDefined();
    expect(rows).toHaveLength(session!.acceptedCount);
    for (const row of rows) {
      expect(row.importSessionId).toBe(session!.id);
      expect(session!.accountIds).toContain(row.accountId);
    }
    expect(session!.rowCount).toBe(session!.acceptedCount + session!.rejectedCount);
  });

  it('ends in personal mode from an empty workspace', async () => {
    expect(await getWorkspaceMode(db)).toBe('empty');
    await putAccount(db, account());

    const result = await commitImport(db, stage());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspaceMode).toBe('personal');
    expect(await getWorkspaceMode(db)).toBe('personal');
  });
});

describe('creating a new account as part of the import', () => {
  it('writes the account and its transactions together', async () => {
    await setWorkspaceMode(db, 'personal', CLOCK);
    const created = account({ id: 'account-new', label: 'Rewards Card', type: 'credit_card' });

    const result = await commitImport(
      db,
      stage({
        rowCount: 1,
        acceptedRows: [stagedRow({ accountId: 'account-new' })],
        newAccounts: [created],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.createdAccountIds).toEqual(['account-new']);

    expect(await db.accounts.get('account-new')).toEqual(created);
    expect((await db.transactions.toArray())[0]?.accountId).toBe('account-new');
    expect((await db.importSessions.get('session-1'))?.accountIds).toContain('account-new');
  });

  it('leaves no account behind when the same transaction fails', async () => {
    await setWorkspaceMode(db, 'personal', CLOCK);
    failTransactionWrite();

    const result = await commitImport(
      db,
      stage({
        rowCount: 1,
        acceptedRows: [stagedRow({ accountId: 'account-new' })],
        newAccounts: [account({ id: 'account-new', label: 'Rewards Card' })],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workspace-write-failed');

    // The account write happens before the failing row write, inside the same
    // transaction. Finding it here would mean the commit was not atomic.
    expect(await db.accounts.count()).toBe(0);
    expect(await db.importSessions.count()).toBe(0);
    expect(await db.transactions.count()).toBe(0);
  });

  it('refuses an existing-account target that is not actually there', async () => {
    await setWorkspaceMode(db, 'personal', CLOCK);

    const result = await commitImport(db, stage());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-account-reference');
    expect(await db.importSessions.count()).toBe(0);
  });
});

describe('a failed commit changes nothing', () => {
  it('leaves an existing personal workspace byte-for-byte unchanged', async () => {
    await seedPersonalWorkspace();
    await commitImport(db, stage());
    const before = await readSnapshot(db);

    resetRowSeed();
    failTransactionWrite();
    const result = await commitImport(
      db,
      stage({ sessionId: 'session-2', newId: sequentialIds('later') }),
    );

    expect(result.ok).toBe(false);
    expect(await readSnapshot(db)).toEqual(before);
  });
});

describe('validation refuses a staged import before any write', () => {
  const cases: ReadonlyArray<{
    name: string;
    reason: string;
    build: (base: StagedImport) => StagedImport;
  }> = [
    {
      name: 'two transactions sharing one id',
      reason: 'duplicate-id-in-request',
      build: (base) => ({
        ...base,
        transactions: [
          base.transactions[0]!,
          { ...base.transactions[1]!, id: base.transactions[0]!.id },
        ],
      }),
    },
    {
      name: 'two new accounts sharing one id',
      reason: 'duplicate-id-in-request',
      build: (base) => ({
        ...base,
        newAccounts: [account({ id: 'dup' }), account({ id: 'dup', label: 'Other' })],
        session: { ...base.session, accountIds: [...base.session.accountIds, 'dup'] },
      }),
    },
    {
      name: 'an accepted count that does not match the rows',
      reason: 'count-mismatch',
      build: (base) => ({ ...base, session: { ...base.session, acceptedCount: 99 } }),
    },
    {
      name: 'a row count that does not equal accepted plus rejected',
      reason: 'count-mismatch',
      build: (base) => ({ ...base, session: { ...base.session, rowCount: 7 } }),
    },
    {
      name: 'more duplicate candidates than rows',
      reason: 'count-mismatch',
      build: (base) => ({ ...base, session: { ...base.session, duplicateCandidateCount: 99 } }),
    },
    {
      name: 'a statement range that ends before it begins',
      reason: 'invalid-statement-range',
      build: (base) => ({
        ...base,
        session: {
          ...base.session,
          statementRangeStart: '2026-04-30',
          statementRangeEnd: '2026-04-01',
        },
      }),
    },
    {
      name: 'a statement date that is not a real day',
      reason: 'invalid-shape',
      build: (base) => ({
        ...base,
        session: { ...base.session, statementRangeStart: '2026-02-30' },
      }),
    },
    {
      name: 'a fingerprint that is not a hex digest',
      reason: 'invalid-fingerprint',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, fingerprint: 'not-a-digest' }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'a fingerprint of the wrong length',
      reason: 'invalid-fingerprint',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, fingerprint: 'abc123' }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'a description past the stored text limit',
      reason: 'invalid-shape',
      build: (base) => ({
        ...base,
        transactions: [
          { ...base.transactions[0]!, descriptionRaw: 'x'.repeat(MAX_TEXT_FIELD_LENGTH + 1) },
        ],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'an unbounded warnings array',
      reason: 'invalid-shape',
      build: (base) => ({
        ...base,
        session: {
          ...base.session,
          warnings: Array.from({ length: 1_001 }, (_, index) => `warning ${index}`),
        },
      }),
    },
    {
      name: 'more source filenames than a session may carry',
      reason: 'invalid-shape',
      build: (base) => ({
        ...base,
        session: {
          ...base.session,
          sourceFileNames: Array.from({ length: 101 }, (_, index) => `file-${index}.csv`),
        },
      }),
    },
    {
      name: 'a transaction belonging to another session',
      reason: 'session-reference-mismatch',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, importSessionId: 'somewhere-else' }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'a transaction pointing at an account the session does not name',
      reason: 'session-reference-mismatch',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, accountId: 'account-elsewhere' }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'a new account in a currency this version does not support',
      reason: 'invalid-shape',
      build: (base) => ({
        ...base,
        newAccounts: [{ ...account({ id: 'account-eur' }), currency: 'EUR' } as never],
        session: { ...base.session, accountIds: [...base.session.accountIds, 'account-eur'] },
      }),
    },
    {
      name: 'a transaction that already carries a review decision',
      reason: 'unexpected-import-defaults',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, categorySource: 'user' }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'a transaction that arrives already excluded from spending',
      reason: 'unexpected-import-defaults',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, excludedFromSpending: true }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'a transaction that arrives already tagged',
      reason: 'unexpected-import-defaults',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, tags: ['groceries'] }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
    {
      name: 'a negative amount, which the sign convention forbids storing',
      reason: 'invalid-shape',
      build: (base) => ({
        ...base,
        transactions: [{ ...base.transactions[0]!, amountCents: -500 }],
        session: { ...base.session, acceptedCount: 1, rowCount: 1 },
      }),
    },
  ];

  it.each(cases)('refuses $name with no write at all', async ({ reason, build }) => {
    await seedPersonalWorkspace();
    const before = await readSnapshot(db);

    const staged = build(stage());

    // Both entry points agree, so a caller cannot reach the database by
    // skipping the pure check.
    expect(validateStagedImport(staged)?.reason).toBe(reason);

    const result = await commitImport(db, staged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      // A refusal explains itself with paths and counts, never row content.
      expect(result.message).not.toContain('PINEBROOK');
      for (const path of result.problemPaths) {
        expect(path).not.toContain('PINEBROOK');
      }
    }

    expect(await readSnapshot(db)).toEqual(before);
  });

  it('accepts the staged import every refusal above is derived from', async () => {
    await seedPersonalWorkspace();
    expect(validateStagedImport(stage())).toBeNull();
  });
});

describe('collisions with data already in the workspace', () => {
  it('refuses a transaction id that already exists, and writes nothing', async () => {
    await seedPersonalWorkspace();
    await commitImport(db, stage());
    const before = await readSnapshot(db);

    resetRowSeed();
    const colliding = stage({ sessionId: 'session-2', newId: sequentialIds('txn') });

    const result = await commitImport(db, colliding);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('id-already-exists');
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('refuses an account id that already exists, and writes nothing', async () => {
    await seedPersonalWorkspace();
    const before = await readSnapshot(db);

    const result = await commitImport(
      db,
      stage({
        rowCount: 1,
        acceptedRows: [stagedRow()],
        // `account-existing` is already stored; creating it again would
        // overwrite the label the user chose.
        newAccounts: [account({ label: 'Impostor' })],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('id-already-exists');
    expect(await readSnapshot(db)).toEqual(before);
    expect((await db.accounts.get('account-existing'))?.label).toBe('Everyday Checking');
  });

  it('cannot be double-submitted into two copies of one session', async () => {
    await seedPersonalWorkspace();
    const staged = stage();

    const first = await commitImport(db, staged);
    const second = await commitImport(db, staged);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('id-already-exists');

    expect(await db.importSessions.count()).toBe(1);
    expect(await db.transactions.count()).toBe(2);
  });

  it('cannot be double-submitted concurrently either', async () => {
    await seedPersonalWorkspace();
    const staged = stage();

    // Both start before either finishes, so neither sees the other's
    // pre-transaction check. `add` on the session's primary key is what
    // actually stops the second one.
    const [a, b] = await Promise.all([commitImport(db, staged), commitImport(db, staged)]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await db.importSessions.count()).toBe(1);
    expect(await db.transactions.count()).toBe(2);
  });
});

describe('replacing a demo workspace with real data', () => {
  beforeEach(async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
  });

  it('refuses without explicit confirmation, even though the UI would have asked', async () => {
    const before = await readSnapshot(db);

    const result = await commitImport(
      db,
      stage({
        rowCount: 1,
        acceptedRows: [stagedRow({ accountId: 'account-new' })],
        newAccounts: [account({ id: 'account-new' })],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('demo-replacement-not-confirmed');
    expect(await readSnapshot(db)).toEqual(before);
    expect(await getWorkspaceMode(db)).toBe('demo');
  });

  it('replaces the whole fictional dataset in one transaction when confirmed', async () => {
    const demoTransactionCount = await db.transactions.count();
    expect(demoTransactionCount).toBeGreaterThan(0);

    const result = await commitImport(
      db,
      stage({
        rowCount: 1,
        acceptedRows: [stagedRow({ accountId: 'account-new' })],
        newAccounts: [account({ id: 'account-new', label: 'Everyday Checking' })],
      }),
      { confirmDemoReplacement: true },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.replacedDemoWorkspace).toBe(true);

    // No demo row survives, and only the imported data is present.
    expect(await db.transactions.count()).toBe(1);
    expect(await db.importSessions.count()).toBe(1);
    expect(await db.accounts.toArray()).toEqual([
      account({ id: 'account-new', label: 'Everyday Checking' }),
    ]);
    expect(await db.merchantRules.count()).toBe(0);
    expect(await db.budgetPlans.count()).toBe(0);
    expect(await db.recurringSeries.count()).toBe(0);
    expect(await db.userEdits.count()).toBe(0);
    expect(await getWorkspaceMode(db)).toBe('personal');
  });

  it('keeps the user’s own saved column mappings, which are not demo data', async () => {
    await saveMappingPreset(db, presetDraft(), { id: 'preset-1', clock: CLOCK });

    await commitImport(
      db,
      stage({
        rowCount: 1,
        acceptedRows: [stagedRow({ accountId: 'account-new' })],
        newAccounts: [account({ id: 'account-new' })],
      }),
      { confirmDemoReplacement: true },
    );

    expect(await db.mappingPresets.get('preset-1')).toBeDefined();
  });

  it('restores every demo row when the replacement fails partway', async () => {
    const before = await readSnapshot(db);
    expect(before.transactions.length).toBeGreaterThan(0);

    failTransactionWrite();

    const result = await commitImport(
      db,
      stage({
        rowCount: 1,
        acceptedRows: [stagedRow({ accountId: 'account-new' })],
        newAccounts: [account({ id: 'account-new' })],
      }),
      { confirmDemoReplacement: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workspace-write-failed');

    // The clear already ran inside the transaction. If the transaction were not
    // atomic the workspace would now be empty — the single worst outcome this
    // service can produce, and the one §9 names explicitly.
    expect(await readSnapshot(db)).toEqual(before);
    expect(await getWorkspaceMode(db)).toBe('demo');
  });
});

describe('what reaches IndexedDB', () => {
  it('stores no value from an unmapped CSV column', async () => {
    await seedPersonalWorkspace();

    // Column 3 is never mapped, so nothing in it may be persisted anywhere.
    const csv = [
      'Date,Description,Amount,Memo',
      '2026-04-08,PINEBROOK MARKET,-12.34,SECRET-MEMO-DO-NOT-STORE',
      '2026-04-09,GARDEN STATE FUEL,-40.00,ANOTHER-SECRET-VALUE',
    ].join('\n');

    const outcome = await normalizeFile({
      fileName: 'statement.csv',
      bytes: new TextEncoder().encode(csv),
      format: COMMA_UTF8,
      mapping: signedMapping(),
      accountId: 'account-existing',
      maxRows: 100,
      sha256: testSha256,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const result = await commitImport(
      db,
      buildStagedImport({
        rowCount: outcome.result.rowCount,
        acceptedRows: outcome.result.rows,
        excludedRows: [],
        rejections: [...outcome.result.rejections],
        duplicateCandidates: [],
        warnings: [...outcome.result.structuralWarnings],
        sourceFileNames: ['statement.csv'],
        newAccounts: [],
        sessionId: 'session-1',
        newId: sequentialIds('txn'),
        clock: CLOCK,
      }),
    );

    expect(result.ok).toBe(true);

    const everythingStored = JSON.stringify(await readSnapshot(db));

    expect(everythingStored).not.toContain('SECRET-MEMO-DO-NOT-STORE');
    expect(everythingStored).not.toContain('ANOTHER-SECRET-VALUE');
    // No raw file content, no header row, no delimiter-joined line survives.
    expect(everythingStored).not.toContain('Date,Description,Amount,Memo');
    expect(everythingStored).not.toContain('-12.34');

    // The mapped description *is* kept: data-methodology.md §3.6 requires
    // `descriptionRaw` to remain visible to the user permanently. This test
    // proves the boundary, not that everything is discarded.
    expect(everythingStored).toContain('PINEBROOK MARKET');
  });

  it('stores a filename with no path and no directory traversal', async () => {
    await seedPersonalWorkspace();

    await commitImport(
      db,
      stage({ sourceFileNames: ['../../Users/someone/Desktop/statements/april.csv'] }),
    );

    const stored = (await db.importSessions.get('session-1'))!.sourceFileNames;

    expect(stored).toEqual(['Users-someone-Desktop-statements-april.csv']);
    for (const name of stored) {
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
      // A stored source name keeps its real extension — it is not a download.
      expect(name.endsWith('.json')).toBe(false);
    }
  });
});
