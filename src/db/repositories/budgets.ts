import type { WorkspaceDatabase } from '../database';
import type { BudgetCategoryTarget, BudgetPlan, IsoMonth } from '../../types/domain';

export async function listBudgetPlans(db: WorkspaceDatabase): Promise<BudgetPlan[]> {
  const plans = await db.budgetPlans.toArray();
  return plans.sort((a, b) => a.month.localeCompare(b.month));
}

export async function getBudgetPlanForMonth(
  db: WorkspaceDatabase,
  month: IsoMonth,
): Promise<BudgetPlan | undefined> {
  return db.budgetPlans.where('month').equals(month).first();
}

export async function putBudgetPlan(db: WorkspaceDatabase, plan: BudgetPlan): Promise<void> {
  await db.budgetPlans.put(plan);
}

export async function listCategoryTargets(
  db: WorkspaceDatabase,
  budgetPlanId: string,
): Promise<BudgetCategoryTarget[]> {
  return db.budgetCategoryTargets.where('budgetPlanId').equals(budgetPlanId).toArray();
}

export async function putCategoryTargets(
  db: WorkspaceDatabase,
  targets: BudgetCategoryTarget[],
): Promise<void> {
  await db.budgetCategoryTargets.bulkPut(targets);
}

/**
 * Replaces a plan and its category targets together.
 *
 * Copy-previous-month must not link the two plans (product-spec.md §10.3), so
 * this writes independent records; `copiedFromMonth` is provenance only and
 * carries no ongoing relationship.
 */
export async function saveBudgetPlanWithTargets(
  db: WorkspaceDatabase,
  plan: BudgetPlan,
  targets: BudgetCategoryTarget[],
): Promise<void> {
  await db.transaction('rw', db.budgetPlans, db.budgetCategoryTargets, async () => {
    await db.budgetPlans.put(plan);
    await db.budgetCategoryTargets.where('budgetPlanId').equals(plan.id).delete();
    if (targets.length > 0) {
      await db.budgetCategoryTargets.bulkPut(targets);
    }
  });
}

export async function countBudgetPlans(db: WorkspaceDatabase): Promise<number> {
  return db.budgetPlans.count();
}
