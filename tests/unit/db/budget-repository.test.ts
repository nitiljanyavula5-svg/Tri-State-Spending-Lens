import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  copyBudgetPlanToMonth,
  deleteBudgetPlanWithTargets,
  getBudgetPlanForMonth,
  isEmptyPlan,
  isPersistableCents,
  listAllCategoryTargets,
  listCategoryTargets,
  saveValidatedBudgetPlan,
} from '../../../src/db/repositories/budgets';
import { exportWorkspace } from '../../../src/db/backup';
import type { BudgetCategoryTarget, BudgetPlan } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase, TEST_CLOCK } from '../helpers/testDatabase';

/**
 * The budget repository.
 *
 * Two properties matter more than the rest and are asserted from several
 * angles: a save replaces a plan and its targets **together**, and a copy
 * produces records that share no identity with their source. A partial save
 * would leave targets pointing at a plan that no longer describes them, and a
 * shared id would make editing one month silently edit another.
 */

let db: WorkspaceDatabase;

const MAY = '2026-05';
const JUNE = '2026-06';

function plan(overrides: Partial<BudgetPlan> = {}): BudgetPlan {
  return {
    id: 'plan-may',
    month: MAY,
    overallLimitCents: 120_000,
    incomeTargetCents: 400_000,
    savingsTargetCents: 50_000,
    rolloverEnabled: false,
    ...overrides,
  };
}

function target(
  id: string,
  categoryId: string,
  limitCents: number,
  budgetPlanId = 'plan-may',
): BudgetCategoryTarget {
  return { id, budgetPlanId, categoryId, limitCents };
}

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

describe('saving a plan', () => {
  it('writes the plan and its targets together', async () => {
    await saveValidatedBudgetPlan(db, plan(), [
      target('t-groceries', 'groceries', 40_000),
      target('t-dining', 'dining', 15_000),
    ]);

    expect(await getBudgetPlanForMonth(db, MAY)).toMatchObject({ overallLimitCents: 120_000 });
    expect(await listCategoryTargets(db, 'plan-may')).toHaveLength(2);
  });

  it('replacement removes targets the new plan no longer has', async () => {
    await saveValidatedBudgetPlan(db, plan(), [
      target('t-groceries', 'groceries', 40_000),
      target('t-dining', 'dining', 15_000),
    ]);
    await saveValidatedBudgetPlan(db, plan(), [target('t-groceries', 'groceries', 30_000)]);

    const remaining = await listCategoryTargets(db, 'plan-may');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ categoryId: 'groceries', limitCents: 30_000 });
  });

  it('refuses a negative or fractional cent value before anything is written', async () => {
    await expect(
      saveValidatedBudgetPlan(db, plan({ overallLimitCents: -1 }), []),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      saveValidatedBudgetPlan(db, plan({ overallLimitCents: 10.5 }), []),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      saveValidatedBudgetPlan(db, plan(), [target('t-bad', 'groceries', -5)]),
    ).rejects.toBeInstanceOf(RangeError);

    // Nothing reached IndexedDB.
    expect(await getBudgetPlanForMonth(db, MAY)).toBeUndefined();
    expect(await listAllCategoryTargets(db)).toEqual([]);
  });

  it('accepts zero as a real limit', async () => {
    await saveValidatedBudgetPlan(db, plan({ overallLimitCents: 0 }), [
      target('t-travel', 'travel', 0),
    ]);
    expect(await getBudgetPlanForMonth(db, MAY)).toMatchObject({ overallLimitCents: 0 });
    expect(isPersistableCents(0)).toBe(true);
  });

  it('refuses a target that belongs to a different plan', async () => {
    await expect(
      saveValidatedBudgetPlan(db, plan(), [target('t-x', 'groceries', 100, 'someone-else')]),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('stores no plan at all when every field is blank', async () => {
    const empty: BudgetPlan = { id: 'plan-empty', month: MAY, rolloverEnabled: false };
    expect(isEmptyPlan(empty, [])).toBe(true);

    const outcome = await saveValidatedBudgetPlan(db, empty, []);
    expect(outcome).toBe('deleted-empty');
    expect(await getBudgetPlanForMonth(db, MAY)).toBeUndefined();
  });

  it('deletes an existing plan when it is emptied', async () => {
    await saveValidatedBudgetPlan(db, plan(), [target('t-groceries', 'groceries', 40_000)]);
    await saveValidatedBudgetPlan(db, { id: 'plan-may', month: MAY, rolloverEnabled: false }, []);

    expect(await getBudgetPlanForMonth(db, MAY)).toBeUndefined();
    expect(await listAllCategoryTargets(db)).toEqual([]);
  });
});

describe('deleting a plan', () => {
  it('removes only that plan and its own targets', async () => {
    await saveValidatedBudgetPlan(db, plan(), [target('t-may', 'groceries', 40_000)]);
    await saveValidatedBudgetPlan(db, plan({ id: 'plan-june', month: JUNE }), [
      target('t-june', 'dining', 20_000, 'plan-june'),
    ]);

    await deleteBudgetPlanWithTargets(db, 'plan-may');

    expect(await getBudgetPlanForMonth(db, MAY)).toBeUndefined();
    expect(await getBudgetPlanForMonth(db, JUNE)).toMatchObject({ month: JUNE });
    const survivors = await listAllCategoryTargets(db);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({ id: 't-june', budgetPlanId: 'plan-june' });
  });
});

describe('copying a previous month', () => {
  beforeEach(async () => {
    await saveValidatedBudgetPlan(db, plan(), [
      target('t-groceries', 'groceries', 40_000),
      target('t-dining', 'dining', 15_000),
    ]);
  });

  it('produces independent records with new ids and exact values', async () => {
    let counter = 0;
    const outcome = await copyBudgetPlanToMonth(db, {
      fromMonth: MAY,
      toMonth: JUNE,
      newPlanId: 'plan-june',
      newTargetId: () => `t-june-${(counter += 1)}`,
    });
    expect(outcome).toBe('copied');

    const copied = await getBudgetPlanForMonth(db, JUNE);
    expect(copied).toMatchObject({
      id: 'plan-june',
      month: JUNE,
      overallLimitCents: 120_000,
      incomeTargetCents: 400_000,
      savingsTargetCents: 50_000,
      copiedFromMonth: MAY,
      // Never inherited and never inferred.
      rolloverEnabled: false,
    });

    const copiedTargets = await listCategoryTargets(db, 'plan-june');
    expect(copiedTargets.map((entry) => entry.limitCents).sort((a, b) => a - b)).toEqual([
      15_000, 40_000,
    ]);
    // Fresh ids, all pointing at the new plan only.
    expect(copiedTargets.every((entry) => entry.id.startsWith('t-june-'))).toBe(true);
    expect(copiedTargets.every((entry) => entry.budgetPlanId === 'plan-june')).toBe(true);
  });

  it('leaves the two months independent afterwards', async () => {
    let counter = 0;
    await copyBudgetPlanToMonth(db, {
      fromMonth: MAY,
      toMonth: JUNE,
      newPlanId: 'plan-june',
      newTargetId: () => `t-june-${(counter += 1)}`,
    });

    // Edit June only.
    const juneTargets = await listCategoryTargets(db, 'plan-june');
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-june', month: JUNE, overallLimitCents: 1, rolloverEnabled: false },
      juneTargets.map((entry) => ({ ...entry, limitCents: 1 })),
    );

    // May is untouched.
    expect(await getBudgetPlanForMonth(db, MAY)).toMatchObject({ overallLimitCents: 120_000 });
    const mayTargets = await listCategoryTargets(db, 'plan-may');
    expect(mayTargets.map((entry) => entry.limitCents).sort((a, b) => a - b)).toEqual([
      15_000, 40_000,
    ]);
  });

  it('refuses an occupied destination unless the caller asks to overwrite', async () => {
    await saveValidatedBudgetPlan(db, plan({ id: 'plan-june', month: JUNE }), []);

    const refused = await copyBudgetPlanToMonth(db, {
      fromMonth: MAY,
      toMonth: JUNE,
      newPlanId: 'plan-june-2',
      newTargetId: (index) => `t-${index}`,
    });
    expect(refused).toBe('destination-exists');
    // The destination is exactly as it was.
    expect(await getBudgetPlanForMonth(db, JUNE)).toMatchObject({ id: 'plan-june' });

    const replaced = await copyBudgetPlanToMonth(db, {
      fromMonth: MAY,
      toMonth: JUNE,
      newPlanId: 'plan-june-2',
      newTargetId: (index) => `t-new-${index}`,
      overwrite: true,
    });
    expect(replaced).toBe('copied');
    expect(await getBudgetPlanForMonth(db, JUNE)).toMatchObject({ id: 'plan-june-2' });
    // The replaced plan's targets went with it.
    expect(await listCategoryTargets(db, 'plan-june')).toEqual([]);
  });

  it('reports a missing source without writing anything', async () => {
    const outcome = await copyBudgetPlanToMonth(db, {
      fromMonth: '2020-01',
      toMonth: JUNE,
      newPlanId: 'plan-june',
      newTargetId: (index) => `t-${index}`,
    });
    expect(outcome).toBe('no-source');
    expect(await getBudgetPlanForMonth(db, JUNE)).toBeUndefined();
  });
});

describe('backup', () => {
  it('carries budget plans and targets losslessly', async () => {
    await saveValidatedBudgetPlan(db, plan(), [
      target('t-groceries', 'groceries', 40_000),
      target('t-dining', 'dining', 15_000),
    ]);

    const parsed = await exportWorkspace(db, TEST_CLOCK);

    expect(parsed.data.budgetPlans).toHaveLength(1);
    expect(parsed.data.budgetCategoryTargets).toHaveLength(2);
    expect(parsed.counts.budgetPlans).toBe(1);
    expect(parsed.counts.budgetCategoryTargets).toBe(2);
    expect(parsed.data.budgetPlans[0]).toMatchObject({
      month: MAY,
      overallLimitCents: 120_000,
      rolloverEnabled: false,
    });
  });
});
