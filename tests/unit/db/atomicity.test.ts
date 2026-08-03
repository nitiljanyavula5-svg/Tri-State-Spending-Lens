import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  exportWorkspace,
  parseBackup,
  restoreBackup,
  serializeBackup,
} from '../../../src/db/backup';
import { MAX_BACKUP_BYTES } from '../../../src/db/backupSchema';
import { readSnapshot, replaceWorkspace } from '../../../src/db/workspace';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { resetDemoWorkspace } from '../../../src/data/demo/seed';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

const CLOCK = fixedClock('2026-08-01T12:00:00.000Z');

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

describe('replaceWorkspace is all-or-nothing', () => {
  it('leaves the previous workspace intact when the write fails partway', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    const before = await readSnapshot(db);
    expect(before.transactions.length).toBeGreaterThan(0);

    // Two accounts sharing a primary key makes bulkAdd raise a constraint
    // error *after* the clear has already run inside the transaction. If the
    // transaction were not atomic, the workspace would now be empty.
    const broken = buildDemoWorkspace();
    broken.accounts = [...broken.accounts, { ...broken.accounts[0]! }];

    await expect(replaceWorkspace(db, broken)).rejects.toThrow();

    const after = await readSnapshot(db);
    expect(after).toEqual(before);
  });
});

describe('resetting the demo is a single transaction', () => {
  it('restores the original dataset', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    await db.transactions.where('id').equals('demo-txn-0001').delete();

    await resetDemoWorkspace(db);

    const restored = await readSnapshot(db);
    expect(restored.transactions).toHaveLength(buildDemoWorkspace().transactions.length);
  });

  it('never empties the workspace as a separate step before re-seeding', async () => {
    // An earlier implementation deleted the demo import session first and then
    // re-seeded. A failure between those two writes destroyed the workspace
    // without restoring anything. Observing the row count throughout the reset
    // proves there is no such window: it never dips below the full dataset.
    await replaceWorkspace(db, buildDemoWorkspace());
    const expected = buildDemoWorkspace().transactions.length;

    const observed: number[] = [];
    let sampling = true;
    const sample = async () => {
      while (sampling) {
        observed.push(await db.transactions.count());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    const sampler = sample();
    await resetDemoWorkspace(db);
    sampling = false;
    await sampler;

    expect(observed.length).toBeGreaterThan(0);
    for (const count of observed) {
      expect(count).toBe(expected);
    }
  });
});

describe('every restore rejection leaves the workspace byte-for-byte unchanged', () => {
  const corruptions: ReadonlyArray<{ name: string; corrupt: (text: string) => string }> = [
    {
      name: 'an oversized file',
      corrupt: () => 'x'.repeat(MAX_BACKUP_BYTES + 1),
    },
    {
      name: 'an impossible date',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { transactions: Record<string, unknown>[] } };
        doc.data.transactions[0]!.postedDate = '2026-02-30';
        return JSON.stringify(doc);
      },
    },
    {
      name: 'an invalid setting value',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { appSettings: Record<string, unknown>[] } };
        doc.data.appSettings[0]!.key = 'somethingUnexpected';
        return JSON.stringify(doc);
      },
    },
    {
      name: 'a missing count',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { counts: Record<string, number> };
        delete doc.counts.transactions;
        return JSON.stringify(doc);
      },
    },
    {
      name: 'a broken account reference',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { transactions: Record<string, unknown>[] } };
        doc.data.transactions[0]!.accountId = 'missing-account';
        return JSON.stringify(doc);
      },
    },
    {
      name: 'a duplicate primary key',
      corrupt: (text) => {
        const doc = JSON.parse(text) as {
          data: { accounts: Record<string, unknown>[] };
          counts: Record<string, number>;
        };
        doc.data.accounts.push({ ...doc.data.accounts[0]! });
        doc.counts.accounts = doc.data.accounts.length;
        return JSON.stringify(doc);
      },
    },
    {
      name: 'a recurring series citing an absent transaction',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { recurringSeries: Record<string, unknown>[] } };
        doc.data.recurringSeries[0]!.transactionIds = ['nope'];
        return JSON.stringify(doc);
      },
    },
    {
      name: 'an import session citing an account that is not in the file',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { importSessions: Record<string, unknown>[] } };
        doc.data.importSessions[0]!.accountIds = ['ghost-account'];
        return JSON.stringify(doc);
      },
    },
    {
      name: 'a user edit pointing at an entity that is not in the file',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { userEdits: Record<string, unknown>[] } };
        doc.data.userEdits[0]!.entityId = 'not-a-real-series';
        return JSON.stringify(doc);
      },
    },
  ];

  it.each(corruptions)('refuses $name with no write at all', async ({ corrupt }) => {
    await replaceWorkspace(db, buildDemoWorkspace());
    const before = await readSnapshot(db);
    const goodText = serializeBackup(await exportWorkspace(db, CLOCK));

    const parsed = parseBackup(corrupt(goodText));
    expect(parsed.ok).toBe(false);

    // Nothing may reach IndexedDB: restoreBackup is never reached on a
    // rejection, and the workspace is identical afterwards.
    if (parsed.ok) await restoreBackup(db, parsed.document);

    expect(await readSnapshot(db)).toEqual(before);
  });
});
