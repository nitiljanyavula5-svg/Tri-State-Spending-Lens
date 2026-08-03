import type { WorkspaceDatabase } from '../../db/database';
import { replaceWorkspace, type WorkspaceSnapshot } from '../../db/workspace';
import { getWorkspaceMode } from '../../db/repositories/settings';
import { buildDemoWorkspace } from './dataset';

export interface DemoSeedOutcome {
  transactionCount: number;
  accountCount: number;
  budgetPlanCount: number;
  recurringSeriesCount: number;
}

function summarize(snapshot: WorkspaceSnapshot): DemoSeedOutcome {
  return {
    transactionCount: snapshot.transactions.length,
    accountCount: snapshot.accounts.length,
    budgetPlanCount: snapshot.budgetPlans.length,
    recurringSeriesCount: snapshot.recurringSeries.length,
  };
}

/**
 * Replaces the workspace with the fictional demo dataset, in one transaction.
 *
 * This is a full replacement, not a merge. Mixing invented transactions into a
 * user's real workspace would make every figure untrustworthy and there would
 * be no reliable way to separate them again, so the caller must confirm before
 * calling this when real data is present.
 */
export async function loadDemoWorkspace(db: WorkspaceDatabase): Promise<DemoSeedOutcome> {
  const snapshot = buildDemoWorkspace();
  await replaceWorkspace(db, snapshot);
  return summarize(snapshot);
}

/**
 * Restores the original synthetic dataset (product-spec.md §8.1).
 *
 * The deterministic snapshot is built first and written through a single
 * `replaceWorkspace` transaction. An earlier version deleted the demo import
 * session first and then re-seeded, which left a window where a failure between
 * the two steps would have destroyed the workspace without restoring anything.
 * One transaction means a failed reset leaves the previous workspace exactly as
 * it was.
 *
 * Because the dataset is deterministic, the result is byte-identical to the
 * first load.
 */
export async function resetDemoWorkspace(db: WorkspaceDatabase): Promise<DemoSeedOutcome> {
  return loadDemoWorkspace(db);
}

/** True when this workspace holds the demo dataset rather than the user's own data. */
export async function isDemoWorkspace(db: WorkspaceDatabase): Promise<boolean> {
  return (await getWorkspaceMode(db)) === 'demo';
}
