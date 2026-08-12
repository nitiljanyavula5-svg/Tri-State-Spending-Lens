import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  editTransaction,
  editTransactions,
  normalizePatch,
  undoCommand,
  type UndoCommand,
} from '../../../src/db/transactionCommands';
import { EXCLUSION_REASONS } from '../../../src/classification/spending';
import {
  MAX_BULK_TRANSACTIONS,
  MAX_NOTE_LENGTH,
  MAX_TAGS_PER_TRANSACTION,
} from '../../../src/domain/reviewLimits';
import type { Transaction } from '../../../src/types/domain';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * Editing reviewed transactions.
 *
 * Every assertion reads the row back out of IndexedDB. The question is not
 * whether the command returned `ok`, but whether the stored row changed in
 * exactly the intended way and nothing else moved.
 */

const CREATED_AT = '2026-08-01T12:00:00.000Z';
const EDITED_AT = '2026-08-02T09:00:00.000Z';
const CLOCK = fixedClock(EDITED_AT);

let db: WorkspaceDatabase;

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
    descriptionRaw: 'PINEBROOK MARKET #114',
    merchantNormalized: 'PINEBROOK MARKET #114',
    amountCents: 1234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'other',
    categorySource: 'uncategorized',
    classificationConfidence: 'none',
    tags: [],
    excludedFromSpending: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

async function seed(...rows: Transaction[]): Promise<void> {
  await db.transactions.bulkAdd(rows.length > 0 ? rows : [transaction()]);
}

/**
 * One shared id source for the whole file.
 *
 * Deliberately not a factory. Two commands drawing from two counters would both
 * mint `generated-1`, collide on the audit log's primary key, and fail the
 * second command — which is correct behaviour, but makes a test look like a
 * staleness bug.
 */
let idCounter = 0;
const ids = () => () => {
  idCounter += 1;
  return `generated-${idCounter}`;
};

describe('editing one transaction', () => {
  it('persists the reviewed interpretation', async () => {
    await seed(transaction());

    const result = await editTransaction(
      db,
      'txn-1',
      {
        categoryId: 'groceries',
        merchantNormalized: 'pinebrook market',
        kind: 'purchase',
        essentiality: 'essential',
        variability: 'variable',
        tags: ['weekly', 'weekly', '  '],
        note: '  Split with a housemate  ',
      },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.ok).toBe(true);

    const stored = await db.transactions.get('txn-1');
    expect(stored?.categoryId).toBe('groceries');
    // Canonicalized on the way in.
    expect(stored?.merchantNormalized).toBe('PINEBROOK MARKET');
    expect(stored?.essentiality).toBe('essential');
    expect(stored?.variability).toBe('variable');
    // Duplicates and blanks dropped.
    expect(stored?.tags).toEqual(['WEEKLY']);
    expect(stored?.note).toBe('Split with a housemate');
    expect(stored?.updatedAt).toBe(EDITED_AT);

    // A manual change becomes a tier-1 decision, which is what stops a later
    // rule from overwriting it.
    expect(stored?.categorySource).toBe('user');
    expect(stored?.classificationConfidence).toBe('high');
  });

  it('never touches a source field', async () => {
    const original = transaction();
    await seed(original);

    await editTransaction(
      db,
      'txn-1',
      { categoryId: 'dining', kind: 'refund', merchantNormalized: 'SOMETHING ELSE' },
      { clock: CLOCK, newId: ids() },
    );

    const stored = await db.transactions.get('txn-1');
    expect(stored?.id).toBe(original.id);
    expect(stored?.fingerprint).toBe(original.fingerprint);
    expect(stored?.importSessionId).toBe(original.importSessionId);
    expect(stored?.originalRow).toBe(original.originalRow);
    expect(stored?.accountId).toBe(original.accountId);
    expect(stored?.postedDate).toBe(original.postedDate);
    // The raw description is permanently visible and permanently unchanged.
    expect(stored?.descriptionRaw).toBe(original.descriptionRaw);
    expect(stored?.amountCents).toBe(original.amountCents);
    expect(stored?.direction).toBe(original.direction);
    expect(stored?.createdAt).toBe(original.createdAt);
  });

  it('records what changed as an audit entry', async () => {
    await seed(transaction());
    await editTransaction(db, 'txn-1', { categoryId: 'dining' }, { clock: CLOCK, newId: ids() });

    const edits = await db.userEdits.toArray();
    const category = edits.find((edit) => edit.field === 'categoryId');
    expect(category?.entityType).toBe('transaction');
    expect(category?.entityId).toBe('txn-1');
    expect(category?.previousValue).toBe('other');
    expect(category?.nextValue).toBe('dining');
  });

  it('clears an optional field when asked', async () => {
    await seed(transaction({ essentiality: 'essential', note: 'old note' }));

    await editTransaction(
      db,
      'txn-1',
      { essentiality: null, note: null },
      { clock: CLOCK, newId: ids() },
    );

    const stored = await db.transactions.get('txn-1');
    // Absent, not empty: "not decided" and "decided, and it is blank" differ.
    expect(stored).not.toHaveProperty('essentiality');
    expect(stored).not.toHaveProperty('note');
  });
});

describe('exclusion follows the calculation contract', () => {
  it('stores a fixed reason when the user excludes a row', async () => {
    await seed(transaction());
    await editTransaction(
      db,
      'txn-1',
      { excludedFromSpending: true },
      { clock: CLOCK, newId: ids() },
    );

    const stored = await db.transactions.get('txn-1');
    expect(stored?.excludedFromSpending).toBe(true);
    expect(stored?.exclusionReason).toBe(EXCLUSION_REASONS.userExcluded);
  });

  it('drops a user exclusion when the kind already excludes the row', async () => {
    await seed(
      transaction({
        excludedFromSpending: true,
        exclusionReason: EXCLUSION_REASONS.userExcluded,
      }),
    );

    await editTransaction(db, 'txn-1', { kind: 'transfer' }, { clock: CLOCK, newId: ids() });

    const stored = await db.transactions.get('txn-1');
    expect(stored?.kind).toBe('transfer');
    // The kind now does the work; a leftover flag would misreport why.
    expect(stored?.excludedFromSpending).toBe(false);
    expect(stored).not.toHaveProperty('exclusionReason');
  });

  it('refuses to mark a transfer as excluded-by-user', async () => {
    await seed(transaction({ kind: 'transfer' }));
    await editTransaction(
      db,
      'txn-1',
      { excludedFromSpending: true },
      { clock: CLOCK, newId: ids() },
    );

    const stored = await db.transactions.get('txn-1');
    expect(stored?.excludedFromSpending).toBe(false);
  });
});

describe('validation refuses before writing', () => {
  const cases = [
    { name: 'an unknown category', patch: { categoryId: 'not-real' }, path: 'categoryId' },
    { name: 'an empty merchant', patch: { merchantNormalized: '   ' }, path: 'merchantNormalized' },
    {
      name: 'an over-long note',
      patch: { note: 'x'.repeat(MAX_NOTE_LENGTH + 1) },
      path: 'note',
    },
    {
      name: 'too many tags',
      patch: {
        tags: Array.from({ length: MAX_TAGS_PER_TRANSACTION + 1 }, (_, i) => `tag-${i}`),
      },
      path: 'tags',
    },
  ];

  it.each(cases)('refuses $name and changes nothing', async ({ patch, path }) => {
    await seed(transaction());
    const before = await db.transactions.get('txn-1');

    expect(normalizePatch(patch).problems).toContain(path);

    const result = await editTransaction(db, 'txn-1', patch, { clock: CLOCK, newId: ids() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-value');
      // A refusal names fields, never values.
      expect(result.message).not.toMatch(/PINEBROOK|xxx/);
    }

    expect(await db.transactions.get('txn-1')).toEqual(before);
    expect(await db.userEdits.count()).toBe(0);
  });

  it('refuses a transaction that is not there', async () => {
    await seed(transaction());
    const result = await editTransaction(db, 'nope', { categoryId: 'dining' }, { clock: CLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
  });
});

describe('bulk edits are one atomic command', () => {
  const three = () => [
    transaction({ id: 'a' }),
    transaction({ id: 'b' }),
    transaction({ id: 'c' }),
  ];

  it('updates every selected row and leaves the rest alone', async () => {
    await seed(...three(), transaction({ id: 'untouched' }));

    const result = await editTransactions(
      db,
      ['a', 'b', 'c'],
      { categoryId: 'dining' },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedCount).toBe(3);

    for (const id of ['a', 'b', 'c']) {
      expect((await db.transactions.get(id))?.categoryId).toBe('dining');
    }
    const untouched = await db.transactions.get('untouched');
    expect(untouched?.categoryId).toBe('other');
    expect(untouched?.updatedAt).toBe(CREATED_AT);
  });

  it('changes no row at all when one of them is missing', async () => {
    await seed(...three());
    const before = await db.transactions.toArray();

    const result = await editTransactions(
      db,
      ['a', 'b', 'ghost'],
      { categoryId: 'dining' },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.ok).toBe(false);
    // Either every selected row changes or none does.
    expect(await db.transactions.toArray()).toEqual(before);
  });

  it('changes no row when the write fails partway', async () => {
    await seed(...three());
    const before = await db.transactions.toArray();

    vi.spyOn(db.userEdits, 'bulkAdd').mockImplementation((() => {
      throw new Error('injected storage failure');
    }) as never);

    const result = await editTransactions(
      db,
      ['a', 'b', 'c'],
      { categoryId: 'dining' },
      { clock: CLOCK, newId: ids() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workspace-write-failed');
    // The transaction rows were written before the audit entries failed; the
    // Dexie transaction has to have rolled them back.
    expect(await db.transactions.toArray()).toEqual(before);
  });

  it('refuses an over-large selection', async () => {
    await seed(transaction());
    const many = Array.from({ length: MAX_BULK_TRANSACTIONS + 1 }, (_, i) => `id-${i}`);

    const result = await editTransactions(db, many, { categoryId: 'dining' }, { clock: CLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-many-rows');
  });

  it('refuses an empty selection', async () => {
    const result = await editTransactions(db, [], { categoryId: 'dining' }, { clock: CLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nothing-selected');
  });
});

describe('undo', () => {
  async function editAndCapture(): Promise<UndoCommand> {
    const result = await editTransactions(
      db,
      ['a', 'b'],
      { categoryId: 'dining', tags: ['reviewed'] },
      { clock: CLOCK, newId: ids() },
    );
    if (!result.ok) throw new Error(result.reason);
    return result.undo;
  }

  beforeEach(async () => {
    await seed(transaction({ id: 'a' }), transaction({ id: 'b' }), transaction({ id: 'other' }));
  });

  it('restores the exact previous values', async () => {
    const before = await db.transactions.bulkGet(['a', 'b']);
    const undo = await editAndCapture();

    const result = await undoCommand(db, undo);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedCount).toBe(2);

    expect(await db.transactions.bulkGet(['a', 'b'])).toEqual(before);
  });

  it('treats one bulk action as one undo unit', async () => {
    const undo = await editAndCapture();
    expect(undo.previous).toHaveLength(2);

    await undoCommand(db, undo);
    // Both rows come back together, not one at a time.
    expect((await db.transactions.get('a'))?.categoryId).toBe('other');
    expect((await db.transactions.get('b'))?.categoryId).toBe('other');
  });

  it('removes the audit entries the command wrote', async () => {
    const undo = await editAndCapture();
    expect(await db.userEdits.count()).toBeGreaterThan(0);

    await undoCommand(db, undo);
    // The log describes what the workspace actually contains.
    expect(await db.userEdits.count()).toBe(0);
  });

  it('leaves unrelated rows alone', async () => {
    const other = await db.transactions.get('other');
    const undo = await editAndCapture();
    await undoCommand(db, undo);

    expect(await db.transactions.get('other')).toEqual(other);
  });

  it('refuses when a row changed after the command', async () => {
    const undo = await editAndCapture();

    // Someone edited one of the rows since.
    await editTransaction(
      db,
      'a',
      { note: 'later change' },
      { clock: fixedClock('2026-08-03T09:00:00.000Z'), newId: ids() },
    );
    const afterLaterEdit = await db.transactions.toArray();

    const result = await undoCommand(db, undo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale');
    // Undoing would have discarded the later edit, so nothing moved.
    expect(await db.transactions.toArray()).toEqual(afterLaterEdit);
  });

  it('cannot be applied twice', async () => {
    const undo = await editAndCapture();

    expect((await undoCommand(db, undo)).ok).toBe(true);
    const second = await undoCommand(db, undo);

    // The rows now carry their original `updatedAt`, which no longer matches
    // what the command recorded, so the repeat is refused as stale.
    expect(second.ok).toBe(false);
  });
});
