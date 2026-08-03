import Dexie, { type EntityTable } from 'dexie';
import type {
  Account,
  AppSetting,
  BudgetCategoryTarget,
  BudgetPlan,
  ImportSession,
  MerchantRule,
  RecurringSeries,
  SchemaMigration,
  Transaction,
  UserEdit,
} from '../types/domain';
import { systemClock, type Clock } from '../lib/clock';
import { DATABASE_NAME, expectedNativeVersion, MIGRATIONS, SCHEMA_VERSION } from './schema';

export class WorkspaceDatabase extends Dexie {
  transactions!: EntityTable<Transaction, 'id'>;
  importSessions!: EntityTable<ImportSession, 'id'>;
  accounts!: EntityTable<Account, 'id'>;
  merchantRules!: EntityTable<MerchantRule, 'id'>;
  budgetPlans!: EntityTable<BudgetPlan, 'id'>;
  budgetCategoryTargets!: EntityTable<BudgetCategoryTarget, 'id'>;
  recurringSeries!: EntityTable<RecurringSeries, 'id'>;
  userEdits!: EntityTable<UserEdit, 'id'>;
  appSettings!: EntityTable<AppSetting, 'key'>;
  schemaMigrations!: EntityTable<SchemaMigration, 'version'>;

  constructor(name: string = DATABASE_NAME) {
    super(name);

    for (const migration of MIGRATIONS) {
      this.version(migration.version).stores(migration.stores);
    }
  }
}

export type OpenFailureReason =
  /**
   * The stored database is newer than this build understands. Dexie raises
   * VersionError rather than downgrading. threat-model.md §11 requires that we
   * refuse to write and explain why, never guess a backward migration.
   */
  | 'newer-schema-version'
  /** IndexedDB is unavailable — private browsing, a disabled setting, or a hostile embedder. */
  | 'indexeddb-unavailable'
  | 'unknown';

export type OpenResult =
  | { status: 'ready'; db: WorkspaceDatabase }
  | { status: 'blocked'; reason: OpenFailureReason; message: string };

const FAILURE_MESSAGES: Record<OpenFailureReason, string> = {
  'newer-schema-version':
    'This workspace was created by a newer version of Tri-State Spending Lens. To avoid changing data this build does not understand, nothing will be written. Open the newer version, or download a backup from it first.',
  'indexeddb-unavailable':
    'This browser is not allowing local database storage, which private browsing and some privacy settings block. Your data cannot be saved here.',
  unknown:
    'The local workspace could not be opened. Nothing has been changed. Reloading the page may help.',
};

function classifyOpenError(error: unknown): OpenFailureReason {
  if (error instanceof Dexie.VersionError) return 'newer-schema-version';

  const name = (error as { name?: string } | null)?.name;
  if (name === 'VersionError') return 'newer-schema-version';
  if (name === 'InvalidStateError' || name === 'SecurityError') return 'indexeddb-unavailable';
  if (typeof indexedDB === 'undefined') return 'indexeddb-unavailable';

  return 'unknown';
}

/**
 * Reads the stored database's native version without opening it through Dexie.
 *
 * Returns `null` when the database does not exist yet or the version cannot be
 * determined. `indexedDB.databases()` is preferred because it has no side
 * effects; the fallback probe creates an empty database when none exists, which
 * Dexie then upgrades normally.
 */
export async function storedNativeVersion(name: string): Promise<number | null> {
  const idb = globalThis.indexedDB;
  if (!idb) return null;

  if (typeof idb.databases === 'function') {
    try {
      const found = (await idb.databases()).find((entry) => entry.name === name);
      return found?.version ?? null;
    } catch {
      // Fall through to the probe below.
    }
  }

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(name);
    } catch {
      resolve(null);
      return;
    }
    request.onsuccess = () => {
      const { version } = request.result;
      request.result.close();
      resolve(version);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * Opens the workspace and records the schema versions this database has been
 * through. Never throws: a workspace that cannot be opened is a state the UI
 * has to render honestly, not an exception to swallow.
 */
export async function openWorkspace(
  db: WorkspaceDatabase = new WorkspaceDatabase(),
  clock: Clock = systemClock,
): Promise<OpenResult> {
  // Check how new the stored database is BEFORE Dexie touches it. Dexie does
  // not refuse a newer database — it opens it and bumps the native version to
  // reconcile the schema — so waiting for an exception here would mean the
  // mutation has already happened (threat-model.md §11).
  const blocked = (reason: OpenFailureReason): OpenResult => ({
    status: 'blocked',
    reason,
    // Messages are deliberately generic. threat-model.md §8 forbids putting
    // field values into anything that could be logged or displayed as an error.
    message: FAILURE_MESSAGES[reason],
  });

  // Every await lives inside the try so this function keeps the promise its
  // documentation makes. A rejection here would surface as an unhandled
  // rejection and leave the interface stuck on "opening" forever.
  try {
    const existingVersion = await storedNativeVersion(db.name);
    if (existingVersion !== null && existingVersion > expectedNativeVersion()) {
      return blocked('newer-schema-version');
    }

    await db.open();

    // Secondary guard: a database whose own migration log names a version newer
    // than this build understands must not be written to either, even if the
    // native version happened to line up.
    if ((await appliedSchemaVersion(db)) > SCHEMA_VERSION) {
      db.close();
      return blocked('newer-schema-version');
    }

    await recordAppliedMigrations(db, clock);
    return { status: 'ready', db };
  } catch (error) {
    return blocked(classifyOpenError(error));
  }
}

/**
 * Writes one `schemaMigrations` row per version this build declares, so the
 * database carries its own upgrade history. Idempotent: re-opening an existing
 * workspace does not rewrite the timestamps already recorded.
 */
export async function recordAppliedMigrations(
  db: WorkspaceDatabase,
  clock: Clock = systemClock,
): Promise<void> {
  await db.transaction('rw', db.schemaMigrations, async () => {
    for (const migration of MIGRATIONS) {
      const existing = await db.schemaMigrations.get(migration.version);
      if (existing) continue;

      await db.schemaMigrations.add({
        version: migration.version,
        description: migration.description,
        appliedAt: clock(),
      });
    }
  });
}

/** The highest schema version recorded in this database. */
export async function appliedSchemaVersion(db: WorkspaceDatabase): Promise<number> {
  const versions = await db.schemaMigrations.toCollection().keys();
  return versions.reduce<number>((max, key) => Math.max(max, Number(key)), 0);
}

export { SCHEMA_VERSION };
