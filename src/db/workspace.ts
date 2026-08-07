import type { WorkspaceDatabase } from './database';
import { TABLE_NAMES, type TableName } from './schema';
import type {
  Account,
  AppSetting,
  BudgetCategoryTarget,
  BudgetPlan,
  ImportSession,
  IsoDate,
  MappingPreset,
  MerchantRule,
  RecurringSeries,
  Transaction,
  UserEdit,
} from '../types/domain';
import { getWorkspaceMode, type WorkspaceMode } from './repositories/settings';
import { transactionDateRange } from './repositories/transactions';

/** Every row in the workspace, table by table. */
export interface WorkspaceSnapshot {
  accounts: Account[];
  importSessions: ImportSession[];
  transactions: Transaction[];
  merchantRules: MerchantRule[];
  budgetPlans: BudgetPlan[];
  budgetCategoryTargets: BudgetCategoryTarget[];
  recurringSeries: RecurringSeries[];
  userEdits: UserEdit[];
  appSettings: AppSetting[];
  mappingPresets: MappingPreset[];
}

export function emptySnapshot(): WorkspaceSnapshot {
  return {
    accounts: [],
    importSessions: [],
    transactions: [],
    merchantRules: [],
    budgetPlans: [],
    budgetCategoryTargets: [],
    recurringSeries: [],
    userEdits: [],
    appSettings: [],
    mappingPresets: [],
  };
}

/**
 * The tables a workspace-wide transaction must hold open.
 *
 * Exported so services that replace or clear the workspace — import commit,
 * demo replacement — take exactly the same scope as backup and restore.
 * `schemaMigrations` is absent by construction, because it is absent from
 * `TABLE_NAMES`: the migration log describes this database, not its contents.
 */
export function workspaceTables(db: WorkspaceDatabase) {
  return TABLE_NAMES.map((name) => db.table(name));
}

/** Reads the whole workspace in one consistent read transaction. */
export async function readSnapshot(db: WorkspaceDatabase): Promise<WorkspaceSnapshot> {
  return db.transaction('r', workspaceTables(db), async () => ({
    accounts: await db.accounts.toArray(),
    importSessions: await db.importSessions.toArray(),
    transactions: await db.transactions.toArray(),
    merchantRules: await db.merchantRules.toArray(),
    budgetPlans: await db.budgetPlans.toArray(),
    budgetCategoryTargets: await db.budgetCategoryTargets.toArray(),
    recurringSeries: await db.recurringSeries.toArray(),
    userEdits: await db.userEdits.toArray(),
    appSettings: await db.appSettings.toArray(),
    mappingPresets: await db.mappingPresets.toArray(),
  }));
}

/**
 * Replaces the entire workspace atomically.
 *
 * threat-model.md §10: restore either fully replaces the workspace or leaves it
 * entirely unchanged. Clearing and writing inside one Dexie transaction is what
 * makes a failure part-way through roll back rather than leave a half-restored
 * workspace.
 *
 * `schemaMigrations` is untouched: it records what *this database* has been
 * through, which a backup from another database must not overwrite.
 */
export async function replaceWorkspace(
  db: WorkspaceDatabase,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  await db.transaction('rw', workspaceTables(db), async () => {
    for (const name of TABLE_NAMES) {
      await db.table(name).clear();
    }

    await db.accounts.bulkAdd(snapshot.accounts);
    await db.importSessions.bulkAdd(snapshot.importSessions);
    await db.transactions.bulkAdd(snapshot.transactions);
    await db.merchantRules.bulkAdd(snapshot.merchantRules);
    await db.budgetPlans.bulkAdd(snapshot.budgetPlans);
    await db.budgetCategoryTargets.bulkAdd(snapshot.budgetCategoryTargets);
    await db.recurringSeries.bulkAdd(snapshot.recurringSeries);
    await db.userEdits.bulkAdd(snapshot.userEdits);
    await db.appSettings.bulkAdd(snapshot.appSettings);
    await db.mappingPresets.bulkAdd(snapshot.mappingPresets);
  });
}

/**
 * Clears transactions, budgets, merchant rules, recurring series, and settings
 * (privacy-model.md §5.3).
 *
 * Deletion is local only — there is nothing to delete on a server, and the
 * caller must not imply otherwise.
 */
export async function deleteAllData(db: WorkspaceDatabase): Promise<void> {
  await db.transaction('rw', workspaceTables(db), async () => {
    for (const name of TABLE_NAMES) {
      await db.table(name).clear();
    }
  });
}

export type WorkspaceCounts = Record<TableName, number>;

export async function countAll(db: WorkspaceDatabase): Promise<WorkspaceCounts> {
  const entries = await Promise.all(
    TABLE_NAMES.map(async (name) => [name, await db.table(name).count()] as const),
  );
  return Object.fromEntries(entries) as WorkspaceCounts;
}

export interface WorkspaceSummary {
  mode: WorkspaceMode;
  counts: WorkspaceCounts;
  /** The observed span of stored rows — not a statement range, not a period. */
  storedDateRange: { start: IsoDate; end: IsoDate } | null;
  accountLabels: string[];
  isEmpty: boolean;
}

/**
 * A description of what is stored, for the Settings and workspace screens.
 *
 * Deliberately contains no calculation-contract figure: no net spending, money
 * in, cash flow, savings rate, or budget remaining. Those belong to the shared
 * selector layer implemented in Phase 5.
 */
export async function summarizeWorkspace(db: WorkspaceDatabase): Promise<WorkspaceSummary> {
  const [mode, counts, storedDateRange, accounts] = await Promise.all([
    getWorkspaceMode(db),
    countAll(db),
    transactionDateRange(db),
    db.accounts.toArray(),
  ]);

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return {
    mode,
    counts,
    storedDateRange,
    accountLabels: accounts.map((account) => account.label).sort((a, b) => a.localeCompare(b)),
    isEmpty: total === 0,
  };
}
