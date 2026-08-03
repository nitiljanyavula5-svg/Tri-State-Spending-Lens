import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  buildBackupDocument,
  exportWorkspace,
  parseBackup,
  restoreBackup,
  serializeBackup,
} from '../../../src/db/backup';
import { SCHEMA_VERSION } from '../../../src/db/schema';
import { countAll, deleteAllData, readSnapshot, replaceWorkspace } from '../../../src/db/workspace';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
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

/** Restores only if the text validates — the exact guard the UI applies. */
async function attemptRestore(text: string): Promise<'restored' | 'rejected'> {
  const parsed = parseBackup(text);
  if (!parsed.ok) return 'rejected';
  await restoreBackup(db, parsed.document);
  return 'restored';
}

describe('backup then restore', () => {
  it('reproduces the workspace exactly after deleting everything', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());

    const before = await readSnapshot(db);
    const text = serializeBackup(await exportWorkspace(db, CLOCK));

    await deleteAllData(db);
    const cleared = await countAll(db);
    expect(Object.values(cleared).every((count) => count === 0)).toBe(true);

    expect(await attemptRestore(text)).toBe('restored');

    const after = await readSnapshot(db);
    // Sorted comparison: restore must preserve content, not insertion order.
    const sortById = <T extends { id?: string; key?: string }>(rows: T[]) =>
      [...rows].sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));

    for (const table of Object.keys(before) as (keyof typeof before)[]) {
      expect(sortById(after[table] as { id?: string; key?: string }[])).toEqual(
        sortById(before[table] as { id?: string; key?: string }[]),
      );
    }
  });

  it('replaces rather than merges, so restoring never doubles a workspace', async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
    const text = serializeBackup(await exportWorkspace(db, CLOCK));
    const originalCount = (await countAll(db)).transactions;

    await attemptRestore(text);
    await attemptRestore(text);

    expect((await countAll(db)).transactions).toBe(originalCount);
  });
});

describe('a rejected restore leaves the workspace untouched', () => {
  const corruptions: ReadonlyArray<{ name: string; corrupt: (text: string) => string }> = [
    { name: 'malformed JSON', corrupt: (text) => text.slice(0, Math.floor(text.length / 2)) },
    { name: 'a foreign document', corrupt: () => JSON.stringify({ format: 'something-else' }) },
    {
      name: 'a future schema version',
      corrupt: (text) => {
        const doc = JSON.parse(text) as Record<string, unknown>;
        doc.schemaVersion = SCHEMA_VERSION + 1;
        return JSON.stringify(doc);
      },
    },
    {
      name: 'a truncated table',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { transactions: unknown[] } };
        doc.data.transactions = doc.data.transactions.slice(0, 3);
        return JSON.stringify(doc);
      },
    },
    {
      name: 'a wrongly typed field',
      corrupt: (text) => {
        const doc = JSON.parse(text) as { data: { transactions: Record<string, unknown>[] } };
        doc.data.transactions[0]!.postedDate = 'the fourth of April';
        return JSON.stringify(doc);
      },
    },
  ];

  it.each(corruptions)('refuses $name without changing current data', async ({ corrupt }) => {
    await replaceWorkspace(db, buildDemoWorkspace());
    const before = await readSnapshot(db);
    const goodText = serializeBackup(await exportWorkspace(db, CLOCK));

    expect(await attemptRestore(corrupt(goodText))).toBe('rejected');

    const after = await readSnapshot(db);
    expect(after).toEqual(before);
  });
});

describe('restoring an older schema version', () => {
  it('is accepted and reported as a migration', async () => {
    const document = buildBackupDocument(buildDemoWorkspace(), CLOCK);
    // Only reachable once a second schema version exists; until then this
    // asserts the branch is wired, not that a real migration ran.
    const parsed = parseBackup(
      JSON.stringify({ ...document, schemaVersion: Math.max(1, SCHEMA_VERSION - 1) }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const outcome = await restoreBackup(db, parsed.document);
    expect(outcome.restored).toBe(true);
    expect(parsed.requiresMigration).toBe(SCHEMA_VERSION > 1);
  });
});
