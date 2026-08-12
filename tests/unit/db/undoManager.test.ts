import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { createUndoManager } from '../../../src/db/undoManager';
import { editTransaction, editTransactions } from '../../../src/db/transactionCommands';
import { MAX_UNDO_HISTORY } from '../../../src/domain/reviewLimits';
import type { Transaction } from '../../../src/types/domain';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * The bounded, session-local undo stack.
 *
 * The honest limitation under test: undo history is memory-only, so it does not
 * survive a reload — while the edits themselves always do. These assert both
 * halves, because a product that lost the edit would be broken and one that
 * implied undo survived a refresh would be lying.
 */

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

function transaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
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

/**
 * A distinct, always-valid timestamp per command.
 *
 * Advances hours and minutes rather than days: walking the day field past 31
 * produces `2026-08-32`, which the stored-row schema correctly refuses as not a
 * real calendar date, and every later command then fails for a reason that has
 * nothing to do with undo.
 */
let clockTick = 0;
function nextClock() {
  clockTick += 1;
  const hours = String(clockTick % 24).padStart(2, '0');
  const minutes = String(Math.floor(clockTick / 24) % 60).padStart(2, '0');
  return fixedClock(`2026-08-02T${hours}:${minutes}:00.000Z`);
}

async function edit(id: string, categoryId: string) {
  return editTransaction(db, id, { categoryId }, { clock: nextClock(), newId: ids() });
}

describe('recording commands', () => {
  it('keeps only successful commands', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();

    const good = await edit('a', 'dining');
    if (good.ok) manager.push(good.undo);

    const bad = await editTransaction(db, 'a', { categoryId: 'nope' }, { newId: ids() });
    expect(bad.ok).toBe(false);
    // A failed command has no undo to record.

    expect(manager.size()).toBe(1);
  });

  it('treats one bulk command as one entry', async () => {
    await db.transactions.bulkAdd([transaction('a'), transaction('b'), transaction('c')]);
    const manager = createUndoManager();

    const result = await editTransactions(
      db,
      ['a', 'b', 'c'],
      { categoryId: 'dining' },
      { clock: nextClock(), newId: ids() },
    );
    if (result.ok) manager.push(result.undo);

    // Three rows changed; one thing to undo.
    expect(manager.size()).toBe(1);
    expect(manager.peek()?.previous).toHaveLength(3);
  });

  it('evicts the oldest beyond the ceiling', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();

    for (let index = 0; index < MAX_UNDO_HISTORY + 5; index += 1) {
      const result = await edit('a', index % 2 === 0 ? 'dining' : 'groceries');
      if (result.ok) manager.push(result.undo);
    }

    expect(MAX_UNDO_HISTORY).toBe(20);
    expect(manager.size()).toBe(MAX_UNDO_HISTORY);
  });

  it('ignores a command with nothing to restore', () => {
    const manager = createUndoManager();
    manager.push({
      id: 'empty',
      label: 'nothing',
      previous: [],
      expectedUpdatedAt: new Map(),
      userEditIds: [],
    });
    expect(manager.size()).toBe(0);
  });
});

describe('undoing', () => {
  it('restores exact previous values and pops the entry', async () => {
    await db.transactions.add(transaction('a'));
    const before = await db.transactions.get('a');
    const manager = createUndoManager();

    const result = await edit('a', 'dining');
    if (result.ok) manager.push(result.undo);

    const undone = await manager.undo(db);
    expect(undone?.ok).toBe(true);
    expect(await db.transactions.get('a')).toEqual(before);
    expect(manager.size()).toBe(0);
  });

  it('reverses commands newest first', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();

    const first = await edit('a', 'dining');
    if (first.ok) manager.push(first.undo);
    const second = await edit('a', 'travel');
    if (second.ok) manager.push(second.undo);

    await manager.undo(db);
    // The most recent change is the one reversed.
    expect((await db.transactions.get('a'))?.categoryId).toBe('dining');

    await manager.undo(db);
    expect((await db.transactions.get('a'))?.categoryId).toBe('other');
  });

  it('leaves unrelated rows alone', async () => {
    await db.transactions.bulkAdd([transaction('a'), transaction('untouched')]);
    const other = await db.transactions.get('untouched');
    const manager = createUndoManager();

    const result = await edit('a', 'dining');
    if (result.ok) manager.push(result.undo);
    await manager.undo(db);

    expect(await db.transactions.get('untouched')).toEqual(other);
  });

  it('returns null and changes nothing when there is nothing to undo', async () => {
    await db.transactions.add(transaction('a'));
    const before = await db.transactions.toArray();
    const manager = createUndoManager();

    expect(await manager.undo(db)).toBeNull();
    expect(await db.transactions.toArray()).toEqual(before);
  });

  it('discards an entry the workspace has moved past', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();

    const result = await edit('a', 'dining');
    if (result.ok) manager.push(result.undo);

    // Someone edits the row again afterwards.
    await edit('a', 'travel');
    const afterLater = await db.transactions.toArray();

    const undone = await manager.undo(db);
    expect(undone?.ok).toBe(false);
    if (undone && !undone.ok) expect(undone.reason).toBe('stale');

    // The later edit is preserved, and the doomed entry is gone rather than
    // being offered again to fail identically.
    expect(await db.transactions.toArray()).toEqual(afterLater);
    expect(manager.size()).toBe(0);
  });

  it('cannot be started twice at once', async () => {
    await db.transactions.bulkAdd([transaction('a'), transaction('b')]);
    const manager = createUndoManager();

    const first = await edit('a', 'dining');
    if (first.ok) manager.push(first.undo);
    const second = await editTransaction(
      db,
      'b',
      { categoryId: 'travel' },
      { clock: nextClock(), newId: ids() },
    );
    if (second.ok) manager.push(second.undo);

    // Both start before either finishes.
    const [a, b] = await Promise.all([manager.undo(db), manager.undo(db)]);

    // Exactly one ran; the other was refused by the in-flight guard.
    expect([a, b].filter((result) => result !== null)).toHaveLength(1);
    expect(manager.size()).toBe(1);
  });

  it('reports whether an undo is available', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();

    expect(manager.canUndo()).toBe(false);
    const result = await edit('a', 'dining');
    if (result.ok) manager.push(result.undo);
    expect(manager.canUndo()).toBe(true);
    expect(manager.isPending()).toBe(false);
  });
});

describe('reload semantics', () => {
  it('loses the undo history but never the edit', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();

    const result = await edit('a', 'dining');
    if (result.ok) manager.push(result.undo);
    expect(manager.canUndo()).toBe(true);

    // A reload constructs a fresh manager; the stack is memory-only.
    const afterReload = createUndoManager();
    expect(afterReload.canUndo()).toBe(false);
    expect(afterReload.size()).toBe(0);

    // The edit itself is in the database and is entirely unaffected.
    expect((await db.transactions.get('a'))?.categoryId).toBe('dining');
  });

  it('keeps nothing in the database for the stack itself', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();
    const result = await edit('a', 'dining');
    if (result.ok) manager.push(result.undo);

    // The audit log records the field change; there is no undo-snapshot table.
    expect(await db.userEdits.count()).toBeGreaterThan(0);
    expect(db.tables.map((table) => table.name)).not.toContain('undoHistory');
  });

  it('clears on demand', async () => {
    await db.transactions.add(transaction('a'));
    const manager = createUndoManager();
    const result = await edit('a', 'dining');
    if (result.ok) manager.push(result.undo);

    manager.clear();
    expect(manager.size()).toBe(0);
    expect(manager.canUndo()).toBe(false);
  });
});
