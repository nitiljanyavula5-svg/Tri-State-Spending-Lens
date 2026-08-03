import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appliedSchemaVersion,
  openWorkspace,
  recordAppliedMigrations,
  storedNativeVersion,
  WorkspaceDatabase,
} from '../../../src/db/database';
import {
  expectedNativeVersion,
  MIGRATIONS,
  SCHEMA_VERSION,
  TABLE_NAMES,
} from '../../../src/db/schema';
import { createTestDatabase, destroyTestDatabase, TEST_CLOCK } from '../helpers/testDatabase';

const opened: WorkspaceDatabase[] = [];

let uniqueSuffix = 0;
const counter = () => {
  uniqueSuffix += 1;
  return `${uniqueSuffix}`;
};

afterEach(async () => {
  while (opened.length > 0) {
    const db = opened.pop();
    if (db) await destroyTestDatabase(db);
  }
});

async function freshDatabase() {
  const db = await createTestDatabase();
  opened.push(db);
  return db;
}

describe('schema definition', () => {
  it('declares one migration step per schema version, in order', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(Math.max(...versions)).toBe(SCHEMA_VERSION);
  });

  it('every migration step carries a description', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.description.length).toBeGreaterThan(0);
    }
  });

  it('excludes schemaMigrations from the tables backup and delete-all touch', () => {
    // The migration log describes *this database*, not the data in it, so a
    // restored backup must not overwrite it and delete-all must not clear it.
    expect(TABLE_NAMES).not.toContain('schemaMigrations');
  });
});

describe('opening the workspace', () => {
  it('opens and exposes every declared table', async () => {
    const db = await freshDatabase();
    for (const name of TABLE_NAMES) {
      expect(await db.table(name).count()).toBe(0);
    }
  });

  it('records the schema versions this build applied', async () => {
    const db = await freshDatabase();
    const rows = await db.schemaMigrations.toArray();

    expect(rows).toHaveLength(MIGRATIONS.length);
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.appliedAt).toBe(TEST_CLOCK());
    expect(await appliedSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('does not rewrite migration history when the workspace is reopened', async () => {
    const db = await freshDatabase();
    const before = await db.schemaMigrations.toArray();

    await recordAppliedMigrations(db, () => '2099-01-01T00:00:00.000Z');
    const after = await db.schemaMigrations.toArray();

    expect(after).toEqual(before);
  });

  it('pins the native version Dexie actually uses, so the newer-build guard cannot silently break', async () => {
    // The guard compares native IndexedDB versions before opening, which
    // depends on Dexie's version×10 mapping. If Dexie ever changes that, this
    // fails here rather than leaving a newer database unprotected.
    const db = await freshDatabase();
    expect(db.backendDB().version).toBe(expectedNativeVersion());
    expect(await storedNativeVersion(db.name)).toBe(expectedNativeVersion());
  });

  it('refuses to open a database created by a newer build, rather than mutating it', async () => {
    const name = `newer-version-${counter()}`;

    // Simulate a future build having created this database at a higher version.
    const future = new Dexie(name);
    future.version(SCHEMA_VERSION + 5).stores({ transactions: 'id' });
    await future.open();
    const futureNativeVersion = future.backendDB().version;
    future.close();

    const result = await openWorkspace(new WorkspaceDatabase(name), TEST_CLOCK);

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('newer-schema-version');
      // The message must explain the refusal without leaking any stored value.
      expect(result.message).toMatch(/newer version/i);
      expect(result.message).toMatch(/nothing will be written/i);
    }

    // Dexie would happily open such a database and bump its native version to
    // reconcile the schema. The stored database must be left exactly as found.
    expect(await storedNativeVersion(name)).toBe(futureNativeVersion);

    await Dexie.delete(name);
  });
});
