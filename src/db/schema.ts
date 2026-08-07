/**
 * IndexedDB schema definition.
 *
 * privacy-model.md §3.1: IndexedDB, scoped to this origin, is the only place
 * normalized personal financial data is persisted.
 *
 * threat-model.md §11: every schema change needs a versioned migration and
 * must not silently drop or reinterpret user data. Adding a table or an index
 * therefore means adding a new entry to `MIGRATIONS` — never editing an
 * existing one.
 */

export const DATABASE_NAME = 'tri-state-spending-lens';

/** The schema version this build understands. */
export const SCHEMA_VERSION = 2;

/**
 * Dexie maps its own version numbers onto native IndexedDB versions by
 * multiplying by ten, so Dexie version 1 is IndexedDB version 10.
 *
 * We depend on this because it is the only way to learn how new a stored
 * database is *before* opening it — and opening first is not an option. Dexie
 * does not refuse a database created by a newer build; it opens it and
 * increments the native version to reconcile the schema difference, which is
 * exactly the silent mutation threat-model.md §11 forbids.
 *
 * `schema.test.ts` pins this multiplier against Dexie's real behaviour, so a
 * future change in Dexie fails a test rather than quietly disabling the guard.
 */
export const NATIVE_VERSION_MULTIPLIER = 10;

export function expectedNativeVersion(schemaVersion: number = SCHEMA_VERSION): number {
  return schemaVersion * NATIVE_VERSION_MULTIPLIER;
}

export interface MigrationStep {
  readonly version: number;
  readonly description: string;
  /**
   * Dexie index declarations for this version. Dexie carries forward the
   * previous version's stores, so each step lists the full desired shape.
   */
  readonly stores: Readonly<Record<string, string | null>>;
}

/**
 * Index choices follow the access patterns the specifications require:
 *  - `importSessionId` — rollback removes only one session's rows (§2.2)
 *  - `fingerprint`     — duplicate candidate grouping (§4.2/§4.3)
 *  - `postedDate`      — every period selector in the calculation contract
 *  - `accountId`, `categoryId`, `kind` — filters in the transaction grid
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    description: 'Initial workspace schema: transactions, accounts, budgets, rules, and settings.',
    stores: {
      transactions:
        'id, fingerprint, importSessionId, accountId, postedDate, categoryId, kind, merchantNormalized, excludedFromSpending',
      importSessions: 'id, importedAt',
      accounts: 'id, type, archived',
      merchantRules: 'id, createdByUser, priority',
      budgetPlans: 'id, &month',
      budgetCategoryTargets: 'id, budgetPlanId, categoryId, [budgetPlanId+categoryId]',
      recurringSeries: 'id, merchantNormalized, userStatus, cadence',
      userEdits: 'id, entityType, entityId, editedAt',
      appSettings: '&key',
      schemaMigrations: '&version',
    },
  },
  {
    version: 2,
    description: 'Add mappingPresets: reusable CSV column mappings and convention choices.',
    stores: {
      // Version 1's stores are restated unchanged. Dexie carries the previous
      // version forward and only needs the difference, but writing the full
      // desired shape means this entry can be read on its own to know exactly
      // what a version 2 database looks like — and a table accidentally
      // dropped from the list is visible in review rather than inferred.
      transactions:
        'id, fingerprint, importSessionId, accountId, postedDate, categoryId, kind, merchantNormalized, excludedFromSpending',
      importSessions: 'id, importedAt',
      accounts: 'id, type, archived',
      merchantRules: 'id, createdByUser, priority',
      budgetPlans: 'id, &month',
      budgetCategoryTargets: 'id, budgetPlanId, categoryId, [budgetPlanId+categoryId]',
      recurringSeries: 'id, merchantNormalized, userStatus, cadence',
      userEdits: 'id, entityType, entityId, editedAt',
      appSettings: '&key',
      schemaMigrations: '&version',
      /**
       * Adding a table is the one schema change that cannot lose data: existing
       * stores are untouched, and every Phase 2 row survives the upgrade
       * unread. `name` is indexed but deliberately not unique — two presets may
       * share a display name, and refusing the second would be a data-loss
       * failure at exactly the moment a user is trying to save work.
       */
      mappingPresets: 'id, name',
    },
  },
];

/** Table names in a fixed order, used by backup, restore, and delete-all. */
export const TABLE_NAMES = [
  'accounts',
  'importSessions',
  'transactions',
  'merchantRules',
  'budgetPlans',
  'budgetCategoryTargets',
  'recurringSeries',
  'userEdits',
  'appSettings',
  /**
   * Presets are user-authored configuration, so they are backed up, restored,
   * and cleared by delete-all like everything else here. They hold no
   * transaction content — see `mappingPresetSchema` — so including them widens
   * what a backup carries without widening what it discloses.
   */
  'mappingPresets',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

/**
 * `schemaMigrations` is deliberately absent from `TABLE_NAMES`: it records what
 * this database has been through, so it is never carried across in a backup and
 * never cleared by delete-all. Restoring a workspace must not rewrite the
 * migration history of the database receiving it.
 */
