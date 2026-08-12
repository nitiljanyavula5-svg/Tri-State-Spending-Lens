import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  collectRefundSuggestions,
  collectTransferSuggestions,
  collectUnmatchedRefunds,
  confirmTransferPair,
  listConfirmedRelationships,
} from '../../../src/db/relationshipCommands';
import { readSnapshot } from '../../../src/db/workspace';
import { MAX_SUGGESTION_GROUP_SIZE } from '../../../src/domain/reviewLimits';
import type { Account, Transaction } from '../../../src/types/domain';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * Collecting suggestions across a whole workspace.
 *
 * These collectors are the only new service surface Phase 4D adds, and the
 * property that matters most is negative: **reading suggestions must write
 * nothing**. Every test that generates a list compares a full snapshot taken
 * before and after, so a stray write anywhere in the path fails here rather
 * than being discovered by a user whose spending total quietly dropped.
 */

const CLOCK = fixedClock('2026-08-02T09:00:00.000Z');

let db: WorkspaceDatabase;
let idCounter = 0;
const ids = () => () => {
  idCounter += 1;
  return `gen-${idCounter}`;
};

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

beforeEach(async () => {
  db = await createTestDatabase();
  await db.accounts.bulkAdd([...ACCOUNTS]);
  await db.importSessions.add({
    id: 'session-1',
    importedAt: '2026-08-01T12:00:00.000Z',
    sourceFileNames: ['statement.csv'],
    accountIds: ['checking', 'savings', 'card'],
    mappingVersion: 1,
    rowCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
  });
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

describe('collecting transfer suggestions', () => {
  it('finds the opposite side in another account and writes nothing', async () => {
    await db.transactions.bulkAdd([
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit', postedDate: '2026-04-09' }),
    ]);

    const before = await readSnapshot(db);
    const found = await collectTransferSuggestions(db);
    const after = await readSnapshot(db);

    expect(found.suggestions).toHaveLength(1);
    expect(found.suggestions[0]?.outgoing.id).toBe('out');
    expect(found.suggestions[0]?.incoming.id).toBe('in');
    expect(found.suggestions[0]?.proposedKind).toBe('transfer');
    // Looking is not deciding.
    expect(after).toEqual(before);
  });

  it('proposes a card payment when a credit card is one of the two accounts', async () => {
    await db.transactions.bulkAdd([
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'card', direction: 'credit' }),
    ]);

    const found = await collectTransferSuggestions(db);
    expect(found.suggestions[0]?.proposedKind).toBe('payment');
  });

  it('leaves two same-value purchases in one account completely alone', async () => {
    await db.transactions.bulkAdd([
      transaction('a', { accountId: 'checking', direction: 'debit' }),
      transaction('b', { accountId: 'checking', direction: 'debit' }),
    ]);

    const before = await readSnapshot(db);
    const found = await collectTransferSuggestions(db);

    // Buying the same thing twice is ordinary. A transfer moves money between
    // accounts and reverses direction; neither is true here.
    expect(found.suggestions).toEqual([]);
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('produces each pair once rather than once per side', async () => {
    await db.transactions.bulkAdd([
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    ]);

    const found = await collectTransferSuggestions(db);
    expect(found.suggestions).toHaveLength(1);
  });

  it('skips endpoints that already belong to a confirmed relationship', async () => {
    await db.transactions.bulkAdd([
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
      transaction('other', { accountId: 'card', direction: 'credit' }),
    ]);

    const confirmed = await confirmTransferPair(db, 'out', 'in', 'transfer', {
      clock: CLOCK,
      newId: ids(),
    });
    expect(confirmed.ok).toBe(true);

    const found = await collectTransferSuggestions(db);
    // `out` is spoken for, so it is not offered again against `other`.
    expect(found.suggestions).toEqual([]);
  });

  it('is deterministic across repeated calls', async () => {
    await db.transactions.bulkAdd([
      transaction('out-1', { accountId: 'checking', direction: 'debit', amountCents: 1_000 }),
      transaction('in-1', { accountId: 'savings', direction: 'credit', amountCents: 1_000 }),
      transaction('out-2', { accountId: 'checking', direction: 'debit', amountCents: 2_000 }),
      transaction('in-2', { accountId: 'card', direction: 'credit', amountCents: 2_000 }),
    ]);

    const first = await collectTransferSuggestions(db);
    const second = await collectTransferSuggestions(db);

    const shape = (c: Awaited<ReturnType<typeof collectTransferSuggestions>>) =>
      c.suggestions.map((s) => `${s.outgoing.id}->${s.incoming.id}:${s.proposedKind}`);

    expect(shape(first)).toEqual(shape(second));
    expect(shape(first)).toEqual(['out-1->in-1:transfer', 'out-2->in-2:payment']);
  });

  it('reports truncation rather than silently returning a short list', async () => {
    const rows: Transaction[] = [];
    for (let index = 0; index < 12; index += 1) {
      rows.push(
        transaction(`out-${String(index).padStart(2, '0')}`, {
          accountId: 'checking',
          direction: 'debit',
        }),
        transaction(`in-${String(index).padStart(2, '0')}`, {
          accountId: 'savings',
          direction: 'credit',
        }),
      );
    }
    await db.transactions.bulkAdd(rows);

    const found = await collectTransferSuggestions(db, 5);
    expect(found.suggestions).toHaveLength(5);
    expect(found.truncated).toBe(true);
  });

  it('caps an oversized equal-amount group and says so', async () => {
    const rows: Transaction[] = [];
    for (let index = 0; index < MAX_SUGGESTION_GROUP_SIZE + 10; index += 1) {
      rows.push(
        transaction(`row-${String(index).padStart(4, '0')}`, {
          accountId: index % 2 === 0 ? 'checking' : 'savings',
          direction: index % 2 === 0 ? 'debit' : 'credit',
        }),
      );
    }
    await db.transactions.bulkAdd(rows);

    const found = await collectTransferSuggestions(db, 3);
    expect(found.truncated).toBe(true);
  });
});

describe('collecting refund suggestions', () => {
  const purchase = (id: string, overrides: Partial<Transaction> = {}) =>
    transaction(id, {
      accountId: 'card',
      direction: 'debit',
      kind: 'purchase',
      merchantNormalized: 'QUILL AND PAGE BOOKS',
      descriptionRaw: 'QUILL AND PAGE BOOKS',
      amountCents: 2_400,
      categoryId: 'shopping',
      postedDate: '2026-04-01',
      ...overrides,
    });

  const refund = (id: string, overrides: Partial<Transaction> = {}) =>
    transaction(id, {
      accountId: 'card',
      direction: 'credit',
      kind: 'refund',
      merchantNormalized: 'QUILL AND PAGE BOOKS',
      descriptionRaw: 'QUILL AND PAGE BOOKS',
      amountCents: 2_400,
      categoryId: 'other',
      postedDate: '2026-04-20',
      ...overrides,
    });

  it('offers the earlier exact purchase and writes nothing', async () => {
    await db.transactions.bulkAdd([purchase('p'), refund('r')]);

    const before = await readSnapshot(db);
    const found = await collectRefundSuggestions(db);

    expect(found.suggestions).toHaveLength(1);
    expect(found.suggestions[0]?.refund.id).toBe('r');
    expect(found.suggestions[0]?.candidates.map((c) => c.purchase.id)).toEqual(['p']);
    expect(found.suggestions[0]?.ambiguous).toBe(false);
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('marks a group ambiguous instead of picking one', async () => {
    await db.transactions.bulkAdd([
      purchase('p1', { postedDate: '2026-04-01' }),
      purchase('p2', { postedDate: '2026-04-10' }),
      refund('r'),
    ]);

    const found = await collectRefundSuggestions(db);
    expect(found.suggestions).toHaveLength(1);
    expect(found.suggestions[0]?.ambiguous).toBe(true);
    // Both are offered. The product does not guess which one it was.
    expect(found.suggestions[0]?.candidates).toHaveLength(2);
  });

  it('never offers a purchase that posted after the refund', async () => {
    await db.transactions.bulkAdd([purchase('p', { postedDate: '2026-05-01' }), refund('r')]);
    const found = await collectRefundSuggestions(db);
    expect(found.suggestions).toEqual([]);
  });

  it('lists a credit with no exact match as unmatched rather than hiding it', async () => {
    await db.transactions.bulkAdd([
      purchase('p', { amountCents: 9_999 }),
      refund('r'),
      // A different merchant at the same price is not a candidate either.
      purchase('other', { merchantNormalized: 'GREENLEAF GROCERS' }),
    ]);

    const matched = await collectRefundSuggestions(db);
    const unmatched = await collectUnmatchedRefunds(db);

    expect(matched.suggestions).toEqual([]);
    expect(unmatched.suggestions.map((row) => row.id)).toContain('r');
  });

  it('includes an undecided credit, because that is exactly what needs review', async () => {
    await db.transactions.bulkAdd([purchase('p'), refund('r', { kind: 'unknown' })]);
    const found = await collectRefundSuggestions(db);
    expect(found.suggestions[0]?.refund.id).toBe('r');
  });
});

describe('listing confirmed relationships', () => {
  it('returns both rows for each link and nothing when there are none', async () => {
    await db.transactions.bulkAdd([
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'savings', direction: 'credit' }),
    ]);

    expect((await listConfirmedRelationships(db)).suggestions).toEqual([]);

    await confirmTransferPair(db, 'out', 'in', 'transfer', { clock: CLOCK, newId: ids() });

    const links = await listConfirmedRelationships(db);
    expect(links.suggestions).toHaveLength(1);
    expect(links.suggestions[0]?.from.id).toBe('out');
    expect(links.suggestions[0]?.to.id).toBe('in');
    expect(links.suggestions[0]?.link.kind).toBe('transfer');
  });
});
