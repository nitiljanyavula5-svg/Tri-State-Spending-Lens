import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appliedSchemaVersion,
  openWorkspace,
  storedNativeVersion,
  WorkspaceDatabase,
} from '../../../src/db/database';
import { expectedNativeVersion, MIGRATIONS, SCHEMA_VERSION } from '../../../src/db/schema';
import { readSnapshot } from '../../../src/db/workspace';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { TEST_CLOCK } from '../helpers/testDatabase';

/**
 * Upgrading a real schema version 1 database to version 2.
 *
 * The database under test is created by a Dexie instance that declares *only*
 * version 1 — the literal store definitions this project shipped in Phase 2 —
 * so this exercises the actual upgrade path rather than a simulation of it. If
 * migration 1 were ever edited, the fixture below would stop matching what
 * Phase 2 wrote and these tests would no longer prove anything about real
 * stored data; that is the reason migration entries are append-only.
 */

const PHASE_2_STORES = MIGRATIONS[0]!.stores;
const PHASE_2_APPLIED_AT = '2026-07-01T09:00:00.000Z';

/** Sorts rows by whichever primary key the table uses, so comparisons are stable. */
function byKey<T extends { id?: string; key?: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id ?? a.key ?? '').localeCompare(b.id ?? b.key ?? ''));
}

let names: string[] = [];
let uniqueSuffix = 0;

afterEach(async () => {
  while (names.length > 0) {
    const name = names.pop();
    if (name) await Dexie.delete(name);
  }
  names = [];
});

/**
 * Creates and populates a database that only knows schema version 1.
 *
 * The demo workspace is used as the payload because it is the largest
 * deterministic dataset in the project and touches every Phase 2 table.
 */
async function createPhase2Database(): Promise<{ name: string; written: number }> {
  uniqueSuffix += 1;
  const name = `phase-2-workspace-${uniqueSuffix}`;
  names.push(name);

  const legacy = new Dexie(name);
  legacy.version(1).stores(PHASE_2_STORES);
  await legacy.open();

  expect(legacy.backendDB().version).toBe(expectedNativeVersion(1));

  const snapshot = buildDemoWorkspace();
  // Passed as an array: Dexie's variadic overloads stop at a handful of tables,
  // and a version 1 database has ten.
  await legacy.transaction('rw', legacy.tables, async () => {
    await legacy.table('accounts').bulkAdd(snapshot.accounts);
    await legacy.table('importSessions').bulkAdd(snapshot.importSessions);
    await legacy.table('transactions').bulkAdd(snapshot.transactions);
    await legacy.table('merchantRules').bulkAdd(snapshot.merchantRules);
    await legacy.table('budgetPlans').bulkAdd(snapshot.budgetPlans);
    await legacy.table('budgetCategoryTargets').bulkAdd(snapshot.budgetCategoryTargets);
    await legacy.table('recurringSeries').bulkAdd(snapshot.recurringSeries);
    await legacy.table('userEdits').bulkAdd(snapshot.userEdits);
    await legacy.table('appSettings').bulkAdd(snapshot.appSettings);
    // A Phase 2 database has already recorded its own migration.
    await legacy.table('schemaMigrations').add({
      version: 1,
      description: MIGRATIONS[0]!.description,
      appliedAt: PHASE_2_APPLIED_AT,
    });
  });

  const written = await legacy.table('transactions').count();
  legacy.close();

  return { name, written };
}

describe('upgrading a Phase 2 database to schema version 2', () => {
  it('opens without refusing, and reaches the version this build declares', async () => {
    const { name } = await createPhase2Database();

    const result = await openWorkspace(new WorkspaceDatabase(name), TEST_CLOCK);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(await appliedSchemaVersion(result.db)).toBe(SCHEMA_VERSION);
    expect(await storedNativeVersion(name)).toBe(expectedNativeVersion());
    result.db.close();
  });

  it('carries every Phase 2 row across unchanged', async () => {
    const { name, written } = await createPhase2Database();
    const expected = buildDemoWorkspace();

    const result = await openWorkspace(new WorkspaceDatabase(name), TEST_CLOCK);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    const after = await readSnapshot(result.db);

    // Row-for-row, not merely count-for-count: a migration that silently
    // reshaped a field would keep the counts and fail here.
    //
    // Compared after sorting by primary key, because IndexedDB returns rows in
    // key order rather than insertion order. That is storage behaviour, not
    // something a migration is allowed to change or expected to preserve.
    expect(after.transactions).toHaveLength(written);
    expect(byKey(after.transactions)).toEqual(byKey(expected.transactions));
    expect(byKey(after.accounts)).toEqual(byKey(expected.accounts));
    expect(byKey(after.importSessions)).toEqual(byKey(expected.importSessions));
    expect(byKey(after.merchantRules)).toEqual(byKey(expected.merchantRules));
    expect(byKey(after.budgetPlans)).toEqual(byKey(expected.budgetPlans));
    expect(byKey(after.budgetCategoryTargets)).toEqual(byKey(expected.budgetCategoryTargets));
    expect(byKey(after.recurringSeries)).toEqual(byKey(expected.recurringSeries));
    expect(byKey(after.userEdits)).toEqual(byKey(expected.userEdits));
    expect(byKey(after.appSettings)).toEqual(byKey(expected.appSettings));

    result.db.close();
  });

  it('adds an empty mappingPresets table rather than inventing presets', async () => {
    const { name } = await createPhase2Database();

    const result = await openWorkspace(new WorkspaceDatabase(name), TEST_CLOCK);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(await result.db.mappingPresets.count()).toBe(0);
    expect((await readSnapshot(result.db)).mappingPresets).toEqual([]);

    result.db.close();
  });

  it('appends version 2 to the migration log without rewriting version 1', async () => {
    const { name } = await createPhase2Database();

    const result = await openWorkspace(new WorkspaceDatabase(name), TEST_CLOCK);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    const log = await result.db.schemaMigrations.orderBy('version').toArray();

    expect(log.map((row) => row.version)).toEqual([1, 2]);
    // The original timestamp is history, not something this build may restate.
    expect(log[0]?.appliedAt).toBe(PHASE_2_APPLIED_AT);
    expect(log[1]?.appliedAt).toBe(TEST_CLOCK());

    result.db.close();
  });

  it('is idempotent: reopening changes nothing', async () => {
    const { name } = await createPhase2Database();

    const first = await openWorkspace(new WorkspaceDatabase(name), TEST_CLOCK);
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    const afterFirst = await readSnapshot(first.db);
    const logAfterFirst = await first.db.schemaMigrations.toArray();
    first.db.close();

    const second = await openWorkspace(
      new WorkspaceDatabase(name),
      () => '2099-01-01T00:00:00.000Z',
    );
    expect(second.status).toBe('ready');
    if (second.status !== 'ready') return;

    expect(await readSnapshot(second.db)).toEqual(afterFirst);
    expect(await second.db.schemaMigrations.toArray()).toEqual(logAfterFirst);
    expect(await storedNativeVersion(name)).toBe(expectedNativeVersion());

    second.db.close();
  });
});

describe('schema version 2 declaration', () => {
  it('adds mappingPresets without editing version 1', () => {
    // Migration 1 is frozen. Editing it would change what an already-migrated
    // database is assumed to contain, which is the silent reinterpretation
    // threat-model.md §11 forbids.
    expect(MIGRATIONS[0]?.version).toBe(1);
    expect(Object.keys(MIGRATIONS[0]!.stores)).not.toContain('mappingPresets');

    expect(MIGRATIONS[1]?.version).toBe(2);
    expect(MIGRATIONS[1]?.stores.mappingPresets).toBeDefined();

    // Version 2 must not drop a table version 1 declared.
    for (const table of Object.keys(MIGRATIONS[0]!.stores)) {
      expect(MIGRATIONS[1]!.stores[table]).toBe(MIGRATIONS[0]!.stores[table]);
    }
  });
});
