import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { rollbackImportSession } from '../../../src/db/importHistory';
import {
  deleteImportSession,
  deleteLinksTouching,
} from '../../../src/db/repositories/transactions';
import { parseBackup, serializeBackup, exportWorkspace } from '../../../src/db/backup';
import { deleteAllData, readSnapshot, replaceWorkspace } from '../../../src/db/workspace';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { resetDemoWorkspace } from '../../../src/data/demo/seed';
import type { ImportSession, Transaction, TransactionLink } from '../../../src/types/domain';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * Relationship integrity across deletion.
 *
 * A `transactionLink` names two transaction ids and nothing else. If one of
 * those rows is deleted and the link survives, the workspace holds a
 * relationship pointing at nothing — and backup validation refuses such a
 * document, so the orphan would make the workspace un-exportable. These tests
 * assert the stored tables after each deletion path, not the return values.
 */

const CLOCK = fixedClock('2026-08-02T09:00:00.000Z');

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

function transaction(
  id: string,
  sessionId: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: sessionId,
    originalRow: 1,
    accountId: 'account-1',
    postedDate: '2026-04-08',
    descriptionRaw: `ROW ${id}`,
    merchantNormalized: `ROW ${id}`,
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

function session(id: string): ImportSession {
  return {
    id,
    importedAt: '2026-08-01T12:00:00.000Z',
    sourceFileNames: ['statement.csv'],
    accountIds: ['account-1'],
    mappingVersion: 1,
    rowCount: 2,
    acceptedCount: 2,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
  };
}

function link(id: string, from: string, to: string): TransactionLink {
  return {
    id,
    kind: 'refund',
    fromTransactionId: from,
    toTransactionId: to,
    createdAt: '2026-08-01T13:00:00.000Z',
  };
}

/**
 * Two sessions, each with two rows, plus three links:
 * one wholly inside session A, one wholly inside session B, and one crossing.
 */
async function seedTwoSessions(): Promise<void> {
  await db.accounts.add({
    id: 'account-1',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  });
  await db.importSessions.bulkAdd([session('session-a'), session('session-b')]);
  await db.transactions.bulkAdd([
    transaction('a1', 'session-a'),
    transaction('a2', 'session-a'),
    transaction('b1', 'session-b'),
    transaction('b2', 'session-b'),
  ]);
  await db.transactionLinks.bulkAdd([
    link('link-inside-a', 'a1', 'a2'),
    link('link-inside-b', 'b1', 'b2'),
  ]);
}

describe('rolling back a session', () => {
  it('removes links whose endpoints it deletes, and no others', async () => {
    await seedTwoSessions();

    const result = await rollbackImportSession(db, 'session-a');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.removedTransactionCount).toBe(2);
      expect(result.removedLinkCount).toBe(1);
    }

    const links = await db.transactionLinks.toArray();
    expect(links.map((row) => row.id)).toEqual(['link-inside-b']);
    // The other session's rows and its relationship are untouched.
    expect((await db.transactions.toArray()).map((row) => row.id).sort()).toEqual(['b1', 'b2']);
  });

  it('removes a link that only crosses into the rolled-back session', async () => {
    await seedTwoSessions();
    // A refund in session B pointing at a purchase in session A.
    await db.transactionLinks.add(link('link-crossing', 'b1', 'a1'));

    await rollbackImportSession(db, 'session-a');

    const links = await db.transactionLinks.toArray();
    // The crossing link went, because one endpoint no longer exists.
    expect(links.map((row) => row.id)).toEqual(['link-inside-b']);
  });

  it('leaves no orphan for backup validation to reject', async () => {
    await seedTwoSessions();
    await db.transactionLinks.add(link('link-crossing', 'b1', 'a1'));

    await rollbackImportSession(db, 'session-a');

    // The real proof: the workspace still exports and re-parses cleanly.
    const parsed = parseBackup(serializeBackup(await exportWorkspace(db, CLOCK)));
    expect(parsed.ok).toBe(true);
  });

  it('changes neither transactions nor links when the rollback fails', async () => {
    await seedTwoSessions();
    const before = await readSnapshot(db);

    // The links cascade runs before the session delete; making that later step
    // fail is what proves the cascade is inside the same transaction.
    vi.spyOn(db.importSessions, 'delete').mockImplementation((() => {
      throw new Error('injected storage failure');
    }) as never);

    const result = await rollbackImportSession(db, 'session-a');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workspace-write-failed');
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('is still safe to repeat', async () => {
    await seedTwoSessions();

    expect((await rollbackImportSession(db, 'session-a')).ok).toBe(true);
    const second = await rollbackImportSession(db, 'session-a');

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('session-not-found');
    expect(await db.transactionLinks.count()).toBe(1);
  });
});

describe('the deletion primitive', () => {
  it('cascades to links as well', async () => {
    await seedTwoSessions();

    const removed = await deleteImportSession(db, 'session-a');

    expect(removed).toBe(2);
    expect((await db.transactionLinks.toArray()).map((row) => row.id)).toEqual(['link-inside-b']);
  });

  it('removes exactly the links touching the named rows', async () => {
    await seedTwoSessions();

    const removed = await deleteLinksTouching(db, ['a1']);

    expect(removed).toBe(1);
    expect((await db.transactionLinks.toArray()).map((row) => row.id)).toEqual(['link-inside-b']);
  });

  it('does nothing for an empty id list', async () => {
    await seedTwoSessions();
    expect(await deleteLinksTouching(db, [])).toBe(0);
    expect(await db.transactionLinks.count()).toBe(2);
  });
});

describe('whole-workspace paths', () => {
  it('delete-all clears links with everything else', async () => {
    await seedTwoSessions();
    await deleteAllData(db);
    expect(await db.transactionLinks.count()).toBe(0);
  });

  it('demo reset leaves no link from the previous workspace', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    await db.transactionLinks.add(
      link(
        'link-demo',
        (await db.transactions.toArray())[0]!.id,
        (await db.transactions.toArray())[1]!.id,
      ),
    );

    await resetDemoWorkspace(db);

    // Reset is a full replacement with a dataset that ships no relationships.
    expect(await db.transactionLinks.count()).toBe(0);
  });

  it('restoring a workspace replaces links rather than merging them', async () => {
    await seedTwoSessions();
    const document = await exportWorkspace(db, CLOCK);

    await deleteAllData(db);
    await replaceWorkspace(db, document.data as never);

    expect((await db.transactionLinks.toArray()).map((row) => row.id).sort()).toEqual([
      'link-inside-a',
      'link-inside-b',
    ]);
  });
});

describe('backup validation still refuses an incoherent document', () => {
  type Doc = {
    counts: Record<string, number | undefined>;
    data: Record<string, unknown[]>;
  };

  async function corrupted(mutate: (doc: Doc) => void): Promise<ReturnType<typeof parseBackup>> {
    await seedTwoSessions();
    const doc = JSON.parse(serializeBackup(await exportWorkspace(db, CLOCK))) as Doc;
    mutate(doc);
    return parseBackup(JSON.stringify(doc));
  }

  it('rejects a link whose endpoint is missing', async () => {
    const parsed = await corrupted((doc) => {
      (doc.data.transactionLinks[0] as TransactionLink).toTransactionId = 'not-here';
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('inconsistent-references');
  });

  it('rejects a link from a transaction to itself', async () => {
    const parsed = await corrupted((doc) => {
      const first = doc.data.transactionLinks[0] as TransactionLink;
      first.toTransactionId = first.fromTransactionId;
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('inconsistent-references');
  });

  it('rejects a transaction paired twice', async () => {
    const parsed = await corrupted((doc) => {
      doc.data.transactionLinks.push({
        ...(doc.data.transactionLinks[0] as TransactionLink),
        id: 'link-duplicate-endpoint',
      });
      doc.counts.transactionLinks = doc.data.transactionLinks.length;
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('inconsistent-references');
  });

  it('rejects an unknown link kind', async () => {
    const parsed = await corrupted((doc) => {
      (doc.data.transactionLinks[0] as { kind: string }).kind = 'something-else';
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('invalid-shape');
  });

  it('still restores an older backup that has no links at all', async () => {
    await seedTwoSessions();
    const doc = JSON.parse(serializeBackup(await exportWorkspace(db, CLOCK))) as Doc & {
      schemaVersion: number;
    };
    // A Phase 3 backup: the key does not exist, rather than being empty.
    delete doc.data.transactionLinks;
    delete doc.counts.transactionLinks;
    doc.schemaVersion = 2;

    const parsed = parseBackup(JSON.stringify(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.data.transactionLinks).toEqual([]);
  });
});
