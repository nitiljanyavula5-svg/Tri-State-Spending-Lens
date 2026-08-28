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

/**
 * Every category target in the workspace, for the reactive boundary.
 *
 * The budget hook subscribes to plans and targets together so a plan and its
 * targets can never be published from two different moments. Reading targets
 * per plan would need one query per month and would reintroduce exactly that
 * split.
 */
export async function listAllCategoryTargets(
  db: WorkspaceDatabase,
): Promise<BudgetCategoryTarget[]> {
  return db.budgetCategoryTargets.toArray();
}

/** A cent value that may be persisted: a nonnegative safe integer. Zero is valid. */
export function isPersistableCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Every cent field on a plan and its targets, checked before anything is written.
 *
 * Validation lives here rather than only in the form because the repository is
 * the last place that can refuse. A negative or fractional limit that reached
 * IndexedDB would be read back by the selector as a real user decision, and
 * `assertIntegerCents` downstream would then throw on every render instead of
 * at the one moment someone could have corrected it.
 */
function assertPersistable(plan: BudgetPlan, targets: readonly BudgetCategoryTarget[]): void {
  for (const [field, value] of [
    ['overallLimitCents', plan.overallLimitCents],
    ['incomeTargetCents', plan.incomeTargetCents],
    ['savingsTargetCents', plan.savingsTargetCents],
  ] as const) {
    if (value !== undefined && !isPersistableCents(value)) {
      throw new RangeError(`${field} must be a nonnegative safe integer number of cents`);
    }
  }
  for (const target of targets) {
    if (!isPersistableCents(target.limitCents)) {
      throw new RangeError('limitCents must be a nonnegative safe integer number of cents');
    }
    if (target.budgetPlanId !== plan.id) {
      throw new RangeError('a category target must belong to the plan being saved');
    }
  }
}

/** True when a plan carries no limit, no targets, and no reason to exist (§10.2). */
export function isEmptyPlan(plan: BudgetPlan, targets: readonly BudgetCategoryTarget[]): boolean {
  return (
    plan.overallLimitCents === undefined &&
    plan.incomeTargetCents === undefined &&
    plan.savingsTargetCents === undefined &&
    targets.length === 0
  );
}

/**
 * Validates, then saves a plan and its targets atomically.
 *
 * A plan with nothing in it is deleted rather than stored: an empty row would
 * make "a plan exists for this month" true while every figure derived from it
 * stayed unavailable, and the interface would have to explain a distinction
 * with no consequence.
 */
export async function saveValidatedBudgetPlan(
  db: WorkspaceDatabase,
  plan: BudgetPlan,
  targets: readonly BudgetCategoryTarget[],
): Promise<'saved' | 'deleted-empty'> {
  assertPersistable(plan, targets);
  if (isEmptyPlan(plan, targets)) {
    await deleteBudgetPlanWithTargets(db, plan.id);
    return 'deleted-empty';
  }
  await saveBudgetPlanWithTargets(db, plan, [...targets]);
  return 'saved';
}

/**
 * Removes one plan and its targets together.
 *
 * Scoped by `budgetPlanId`, so a plan for another month cannot be caught by it —
 * and both deletions share one transaction, so a failure cannot leave targets
 * pointing at a plan that no longer exists.
 */
export async function deleteBudgetPlanWithTargets(
  db: WorkspaceDatabase,
  budgetPlanId: string,
): Promise<void> {
  await db.transaction('rw', db.budgetPlans, db.budgetCategoryTargets, async () => {
    await db.budgetCategoryTargets.where('budgetPlanId').equals(budgetPlanId).delete();
    await db.budgetPlans.delete(budgetPlanId);
  });
}

export type CopyPlanOutcome = 'copied' | 'no-source' | 'destination-exists';

/**
 * Copies one month's plan into another as independent records.
 *
 * product-spec.md §10.3: the copy is a starting point, not a link. Every row
 * gets a fresh id and the new targets point only at the new plan, so editing
 * either month afterwards cannot reach the other. `copiedFromMonth` records
 * where the numbers came from and nothing more.
 *
 * A destination that already has a plan is refused unless the caller passes
 * `overwrite`, because silently replacing a month someone already planned is
 * the one outcome that cannot be undone from the interface.
 */
export async function copyBudgetPlanToMonth(
  db: WorkspaceDatabase,
  options: {
    readonly fromMonth: IsoMonth;
    readonly toMonth: IsoMonth;
    readonly newPlanId: string;
    readonly newTargetId: (index: number) => string;
    readonly overwrite?: boolean;
  },
): Promise<CopyPlanOutcome> {
  return db.transaction('rw', db.budgetPlans, db.budgetCategoryTargets, async () => {
    const source = await db.budgetPlans.where('month').equals(options.fromMonth).first();
    if (!source) return 'no-source';

    const existing = await db.budgetPlans.where('month').equals(options.toMonth).first();
    if (existing && options.overwrite !== true) return 'destination-exists';

    if (existing) {
      await db.budgetCategoryTargets.where('budgetPlanId').equals(existing.id).delete();
      await db.budgetPlans.delete(existing.id);
    }

    const sourceTargets = await db.budgetCategoryTargets
      .where('budgetPlanId')
      .equals(source.id)
      .toArray();

    const plan: BudgetPlan = {
      id: options.newPlanId,
      month: options.toMonth,
      ...(source.overallLimitCents === undefined
        ? {}
        : { overallLimitCents: source.overallLimitCents }),
      ...(source.incomeTargetCents === undefined
        ? {}
        : { incomeTargetCents: source.incomeTargetCents }),
      ...(source.savingsTargetCents === undefined
        ? {}
        : { savingsTargetCents: source.savingsTargetCents }),
      copiedFromMonth: options.fromMonth,
      // Never inherited, never inferred: rollover is off in v1.0 (§4.4).
      rolloverEnabled: false,
    };

    const targets: BudgetCategoryTarget[] = sourceTargets
      .slice()
      .sort((a, b) => a.categoryId.localeCompare(b.categoryId))
      .map((target, index) => ({
        id: options.newTargetId(index),
        budgetPlanId: plan.id,
        categoryId: target.categoryId,
        limitCents: target.limitCents,
      }));

    assertPersistable(plan, targets);

    await db.budgetPlans.put(plan);
    if (targets.length > 0) await db.budgetCategoryTargets.bulkPut(targets);
    return 'copied';
  });
}
