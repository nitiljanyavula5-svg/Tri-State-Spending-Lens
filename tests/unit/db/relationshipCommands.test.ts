import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  confirmRefundLink,
  confirmTransferPair,
  linkFor,
  linkedTransactionIds,
  suggestRefundMatches,
  suggestTransferPairs,
  unlinkTransactions,
  MAX_SUGGESTIONS,
  REFUND_LOOKBACK_DAYS,
  TRANSFER_WINDOW_DAYS,
} from '../../../src/db/relationshipCommands';
import { undoCommand, type CommandResult } from '../../../src/db/transactionCommands';
import { rollbackImportSession } from '../../../src/db/importHistory';
import { spendingTreatment } from '../../../src/classification/spending';
import { readSnapshot } from '../../../src/db/workspace';
import type { Account, Transaction } from '../../../src/types/domain';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * Transfer, card-payment, and refund relationships.
 *
 * The failure that matters is silent: `transfer` and `payment` are excluded
 * from net spending, so an incorrect automatic pairing hides real money. Every
 * suggestion test therefore asserts that **nothing was written**, and every
 * confirmation test reads the rows back out.
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

const ACCOUNTS: readonly Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  { id: 'savings', label: 'Savings', type: 'savings', currency: 'USD', archived: false },
  { id: 'card', label: 'Rewards Card', type: 'credit_card', currency: 'USD', archived: false },
];

function transaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'checking',
    postedDate: '2026-04-08',
    descriptionRaw: 'TRANSFER TO SAVINGS',
    merchantNormalized: 'TRANSFER TO SAVINGS',
    amountCents: 50_000,
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

async function seed(...rows: Transaction[]): Promise<void> {
  await db.accounts.bulkAdd([...ACCOUNTS]);
  await db.importSessions.add({
    id: 'session-1',
    importedAt: '2026-08-01T12:00:00.000Z',
    sourceFileNames: ['statement.csv'],
    accountIds: ['checking', 'savings', 'card'],
    mappingVersion: 1,
    rowCount: rows.length,
    acceptedCount: rows.length,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
  });
  await db.transactions.bulkAdd(rows);
}

function assertCommand(result: CommandResult | { ok: false; reason: string }): CommandResult {
  return result as CommandResult;
}

/* ------------------------------------------------------- suggestions - */

describe('transfer suggestions never mutate anything', () => {
  it('proposes an opposite-direction match in another account', async () => {
    const out = transaction('out', { accountId: 'checking', direction: 'debit' });
    const inn = transaction('in', { accountId: 'savings', direction: 'credit' });
    await seed(out, inn);
    const before = await readSnapshot(db);

    const suggestions = suggestTransferPairs({
      transaction: out,
      candidates: [inn],
      accounts: ACCOUNTS,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.counterpartId).toBe('in');
    expect(suggestions[0]?.proposedKind).toBe('transfer');
    expect(suggestions[0]?.confirmed).toBe(false);
    // A suggestion is a read. The workspace is untouched.
    expect(await readSnapshot(db)).toEqual(before);
    expect(out.kind).toBe('purchase');
  });

  it('proposes a card payment when a credit card is involved', () => {
    const out = transaction('out', { accountId: 'checking', direction: 'debit' });
    const inn = transaction('in', { accountId: 'card', direction: 'credit' });

    const [suggestion] = suggestTransferPairs({
      transaction: out,
      candidates: [inn],
      accounts: ACCOUNTS,
    });
    expect(suggestion?.proposedKind).toBe('payment');
  });

  it('leaves two unrelated same-value purchases alone', () => {
    // Same amount, same direction, same account — an ordinary pair of
    // purchases, and nothing about them says "transfer".
    const a = transaction('a', { accountId: 'checking', direction: 'debit' });
    const b = transaction('b', { accountId: 'checking', direction: 'debit' });

    expect(suggestTransferPairs({ transaction: a, candidates: [b], accounts: ACCOUNTS })).toEqual(
      [],
    );
  });

  it('requires a different account, opposite direction, equal amount, and a nearby date', () => {
    const base = transaction('base', { accountId: 'checking', direction: 'debit' });
    const reject = (overrides: Partial<Transaction>) =>
      suggestTransferPairs({
        transaction: base,
        candidates: [
          transaction('other', { accountId: 'savings', direction: 'credit', ...overrides }),
        ],
        accounts: ACCOUNTS,
      });

    expect(reject({})).toHaveLength(1);
    expect(reject({ accountId: 'checking' })).toHaveLength(0);
    expect(reject({ direction: 'debit' })).toHaveLength(0);
    expect(reject({ amountCents: 49_999 })).toHaveLength(0);
    expect(reject({ postedDate: '2026-05-30' })).toHaveLength(0);
  });

  it('respects the date window exactly', () => {
    const base = transaction('base', { postedDate: '2026-04-08' });
    const within = transaction('within', {
      accountId: 'savings',
      direction: 'credit',
      postedDate: '2026-04-12',
    });
    const outside = transaction('outside', {
      accountId: 'savings',
      direction: 'credit',
      postedDate: '2026-04-13',
    });

    expect(TRANSFER_WINDOW_DAYS).toBe(4);
    expect(
      suggestTransferPairs({ transaction: base, candidates: [within], accounts: ACCOUNTS }),
    ).toHaveLength(1);
    expect(
      suggestTransferPairs({ transaction: base, candidates: [outside], accounts: ACCOUNTS }),
    ).toHaveLength(0);
  });

  it('is deterministic and bounded', () => {
    const base = transaction('base');
    const candidates = Array.from({ length: 50 }, (_, index) =>
      transaction(`c-${String(index).padStart(3, '0')}`, {
        accountId: 'savings',
        direction: 'credit',
      }),
    );

    const first = suggestTransferPairs({ transaction: base, candidates, accounts: ACCOUNTS });
    const second = suggestTransferPairs({
      transaction: base,
      candidates: [...candidates].reverse(),
      accounts: ACCOUNTS,
    });

    expect(first).toHaveLength(MAX_SUGGESTIONS);
    expect(first.map((s) => s.counterpartId)).toEqual(second.map((s) => s.counterpartId));
  });

  it('skips transactions already spoken for', () => {
    const base = transaction('base');
    const other = transaction('other', { accountId: 'savings', direction: 'credit' });

    expect(
      suggestTransferPairs({
        transaction: base,
        candidates: [other],
        accounts: ACCOUNTS,
        linkedTransactionIds: new Set(['other']),
      }),
    ).toEqual([]);
  });

  it('names no cell value in its reason', () => {
    const [suggestion] = suggestTransferPairs({
      transaction: transaction('out'),
      candidates: [transaction('in', { accountId: 'savings', direction: 'credit' })],
      accounts: ACCOUNTS,
    });
    expect(suggestion?.reason).not.toMatch(/TRANSFER TO SAVINGS|500|50000/);
    expect(suggestion?.reason).toMatch(/nothing changes until you confirm/i);
  });
});

describe('refund suggestions never mutate anything', () => {
  const purchase = transaction('purchase', {
    direction: 'debit',
    merchantNormalized: 'QUILL AND PAGE BOOKS',
    amountCents: 4_800,
    postedDate: '2026-04-01',
    categoryId: 'shopping',
    categorySource: 'user',
  });
  const refund = transaction('refund', {
    direction: 'credit',
    merchantNormalized: 'QUILL AND PAGE BOOKS',
    amountCents: 4_800,
    postedDate: '2026-04-20',
  });

  it('proposes the earlier matching purchase', () => {
    const [suggestion] = suggestRefundMatches({ refund, candidates: [purchase] });
    expect(suggestion?.purchaseId).toBe('purchase');
    expect(suggestion?.confirmed).toBe(false);
  });

  it('requires credit direction, exact amount, same merchant, and same account', () => {
    const check = (overrides: Partial<Transaction>) =>
      suggestRefundMatches({
        refund,
        candidates: [transaction('p', { ...purchase, ...overrides })],
      });

    expect(check({})).toHaveLength(1);
    expect(check({ amountCents: 4_799 })).toHaveLength(0);
    expect(check({ merchantNormalized: 'SOMEWHERE ELSE' })).toHaveLength(0);
    expect(check({ accountId: 'savings' })).toHaveLength(0);
    // A refund cannot precede the purchase it returns.
    expect(check({ postedDate: '2026-04-21' })).toHaveLength(0);
  });

  it('ignores a debit that is not a refund', () => {
    expect(
      suggestRefundMatches({
        refund: transaction('d', { direction: 'debit' }),
        candidates: [purchase],
      }),
    ).toEqual([]);
  });

  it('respects the lookback window', () => {
    const old = transaction('old', { ...purchase, postedDate: '2025-01-01' });
    expect(REFUND_LOOKBACK_DAYS).toBe(120);
    expect(suggestRefundMatches({ refund, candidates: [old] })).toHaveLength(0);
  });

  it('returns a bounded, deterministic list when several purchases match', () => {
    const candidates = Array.from({ length: 40 }, (_, index) =>
      transaction(`p-${String(index).padStart(3, '0')}`, {
        ...purchase,
        postedDate: '2026-04-01',
      }),
    );

    const first = suggestRefundMatches({ refund, candidates });
    const second = suggestRefundMatches({ refund, candidates: [...candidates].reverse() });

    expect(first).toHaveLength(MAX_SUGGESTIONS);
    expect(first.map((s) => s.purchaseId)).toEqual(second.map((s) => s.purchaseId));
  });
});

/* ------------------------------------------------------ confirmation - */

describe('confirming a transfer pair', () => {
  it('classifies both rows and records the link atomically', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    );

    const result = assertCommand(
      await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() }),
    );
    expect(result.ok).toBe(true);

    const out = await db.transactions.get('out');
    const inn = await db.transactions.get('in');
    // Both sides move together — a half-classified pair would double-count.
    expect(out?.kind).toBe('transfer');
    expect(inn?.kind).toBe('transfer');

    expect(await db.transactionLinks.count()).toBe(1);
    const link = (await db.transactionLinks.toArray())[0];
    // Debit side is `from`, credit side is `to`, regardless of argument order.
    expect(link?.fromTransactionId).toBe('out');
    expect(link?.toTransactionId).toBe('in');
  });

  it('gives both rows the excluded-by-kind treatment', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'card', direction: 'credit' }),
    );

    await confirmTransferPair(db, 'out', 'in', 'payment', { clock: CLOCK, newId: ids() });

    for (const id of ['out', 'in']) {
      const row = (await db.transactions.get(id))!;
      expect(spendingTreatment(row)).toBe('excluded-by-kind');
    }
  });

  it('refuses to pair a transaction twice', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
      transaction('other', { accountId: 'card', direction: 'credit' }),
    );

    await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() });
    const second = await confirmTransferPair(db, 'out', 'other', 'transfer', {
      clock: CLOCK,
      newId: ids(),
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect((second as { reason: string }).reason).toBe('already-linked');
    expect(await db.transactionLinks.count()).toBe(1);
  });

  it('refuses same-account and same-direction pairs', async () => {
    await seed(
      transaction('a', { accountId: 'checking', direction: 'debit' }),
      transaction('b', { accountId: 'checking', direction: 'credit' }),
      transaction('c', { accountId: 'savings', direction: 'debit' }),
    );

    expect((await confirmTransferPair(db, 'a', 'b', 'transfer', { newId: ids() })).ok).toBe(false);
    expect((await confirmTransferPair(db, 'a', 'c', 'transfer', { newId: ids() })).ok).toBe(false);
    expect(await db.transactionLinks.count()).toBe(0);
  });

  it('writes nothing when the row update fails', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    );
    const before = await readSnapshot(db);

    vi.spyOn(db.transactions, 'bulkPut').mockImplementation((() => {
      throw new Error('injected storage failure');
    }) as never);

    const result = await confirmTransferPair(db, 'out', 'in', 'transfer', {
      clock: CLOCK,
      newId: ids(),
    });

    expect(result.ok).toBe(false);
    // The link was added before the row write inside the same transaction.
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('is one undo unit that reverses both rows and the link', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    );

    const result = assertCommand(
      await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() }),
    );
    if (!result.ok) throw new Error('setup failed');

    expect((await undoCommand(db, result.undo)).ok).toBe(true);

    expect((await db.transactions.get('out'))?.kind).toBe('purchase');
    expect((await db.transactions.get('in'))?.kind).toBe('purchase');
    expect(await db.transactionLinks.count()).toBe(0);
  });
});

describe('confirming a refund', () => {
  async function seedRefundPair(): Promise<void> {
    await seed(
      transaction('purchase', {
        direction: 'debit',
        merchantNormalized: 'QUILL AND PAGE BOOKS',
        amountCents: 4_800,
        postedDate: '2026-04-01',
        categoryId: 'shopping',
        categorySource: 'user',
      }),
      transaction('refund', {
        direction: 'credit',
        merchantNormalized: 'QUILL AND PAGE BOOKS',
        amountCents: 4_800,
        postedDate: '2026-04-20',
        kind: 'unknown',
      }),
    );
  }

  it('inherits the reviewed merchant and category, and stays a refund', async () => {
    await seedRefundPair();

    const result = assertCommand(
      await confirmRefundLink(db, 'refund', 'purchase', { clock: CLOCK, newId: ids() }),
    );
    expect(result.ok).toBe(true);

    const refund = await db.transactions.get('refund');
    expect(refund?.kind).toBe('refund');
    expect(refund?.categoryId).toBe('shopping');
    expect(refund?.merchantNormalized).toBe('QUILL AND PAGE BOOKS');
    // A refund reduces spending; it is not excluded.
    expect(spendingTreatment(refund!)).toBe('included-refund');
  });

  it('leaves the purchase itself untouched', async () => {
    await seedRefundPair();
    const before = await db.transactions.get('purchase');

    await confirmRefundLink(db, 'refund', 'purchase', { clock: CLOCK, newId: ids() });

    expect(await db.transactions.get('purchase')).toEqual(before);
  });

  it('cannot reduce spending twice', async () => {
    await seedRefundPair();
    await db.transactions.add(
      transaction('refund-2', {
        direction: 'credit',
        merchantNormalized: 'QUILL AND PAGE BOOKS',
        amountCents: 4_800,
        postedDate: '2026-04-21',
      }),
    );

    await confirmRefundLink(db, 'refund', 'purchase', { clock: CLOCK, newId: ids() });
    const second = await confirmRefundLink(db, 'refund-2', 'purchase', {
      clock: CLOCK,
      newId: ids(),
    });

    // One purchase absorbs one refund.
    expect(second.ok).toBe(false);
    expect(await db.transactionLinks.count()).toBe(1);
  });

  it('refuses a pair with the wrong directions', async () => {
    await seedRefundPair();
    const result = await confirmRefundLink(db, 'purchase', 'refund', { newId: ids() });
    expect(result.ok).toBe(false);
  });

  it('is undoable as one unit', async () => {
    await seedRefundPair();
    const result = assertCommand(
      await confirmRefundLink(db, 'refund', 'purchase', { clock: CLOCK, newId: ids() }),
    );
    if (!result.ok) throw new Error('setup failed');

    await undoCommand(db, result.undo);

    const refund = await db.transactions.get('refund');
    expect(refund?.kind).toBe('unknown');
    expect(refund?.categoryId).toBe('other');
    expect(await db.transactionLinks.count()).toBe(0);
  });

  it('leaves an unmatched refund manually editable', async () => {
    await seed(transaction('lonely', { direction: 'credit', kind: 'unknown' }));
    expect(
      suggestRefundMatches({ refund: (await db.transactions.get('lonely'))!, candidates: [] }),
    ).toEqual([]);
    // No relationship, no obstruction — the row is a normal editable row.
    expect(await db.transactionLinks.count()).toBe(0);
  });
});

describe('unlinking', () => {
  it('removes the relationship and leaves the classification alone', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    );
    await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() });
    const linkId = (await db.transactionLinks.toArray())[0]!.id;

    const result = assertCommand(
      await unlinkTransactions(db, linkId, { clock: CLOCK, newId: ids() }),
    );
    expect(result.ok).toBe(true);

    expect(await db.transactionLinks.count()).toBe(0);
    // Unlinking says the pairing was wrong, not the classification. Silently
    // reverting the kind would change spending totals as a side effect.
    expect((await db.transactions.get('out'))?.kind).toBe('transfer');
  });

  it('restores the relationship on undo', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    );
    await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() });
    const before = await db.transactionLinks.toArray();

    const unlinked = assertCommand(
      await unlinkTransactions(db, before[0]!.id, { clock: CLOCK, newId: ids() }),
    );
    if (!unlinked.ok) throw new Error('setup failed');

    await undoCommand(db, unlinked.undo);

    expect(await db.transactionLinks.toArray()).toEqual(before);
  });

  it('is truthful about a link that is already gone', async () => {
    const result = await unlinkTransactions(db, 'never-existed', { newId: ids() });
    expect(result.ok).toBe(false);
  });
});

describe('relationships and rollback', () => {
  it('leaves no orphan when the import that created a row is rolled back', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    );
    await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() });
    expect(await db.transactionLinks.count()).toBe(1);

    const rolled = await rollbackImportSession(db, 'session-1');
    expect(rolled.ok).toBe(true);
    if (rolled.ok) expect(rolled.removedLinkCount).toBe(1);

    expect(await db.transactionLinks.count()).toBe(0);
    expect(await db.transactions.count()).toBe(0);
  });
});

describe('link lookups', () => {
  it('reports which transactions are spoken for and who the counterpart is', async () => {
    await seed(
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    );
    await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() });

    expect([...(await linkedTransactionIds(db))].sort()).toEqual(['in', 'out']);
    expect((await linkFor(db, 'out'))?.counterpartId).toBe('in');
    expect((await linkFor(db, 'in'))?.counterpartId).toBe('out');
    expect(await linkFor(db, 'nobody')).toBeNull();
  });
});
