import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  buildDemoWorkspace,
  DEMO_IMPORT_SESSION_ID,
  DEMO_MONTHS,
  DEMO_RANGE,
} from '../../../src/data/demo/dataset';
import {
  loadDemoWorkspace,
  resetDemoWorkspace,
  isDemoWorkspace,
} from '../../../src/data/demo/seed';
import { countAll, readSnapshot, summarizeWorkspace } from '../../../src/db/workspace';
import { CATEGORY_IDS } from '../../../src/domain/categories';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

describe('the demo dataset is deterministic', () => {
  it('produces byte-identical output on every build', () => {
    const first = JSON.stringify(buildDemoWorkspace());
    const second = JSON.stringify(buildDemoWorkspace());

    // "Reset demo" restores *the original* dataset, which is only meaningful
    // if the dataset is reproducible (product-spec.md §8.1).
    expect(first).toBe(second);
  });

  it('uses no wall-clock time, so record timestamps never drift between builds', () => {
    const timestamps = new Set(buildDemoWorkspace().transactions.map((t) => t.createdAt));
    expect(timestamps.size).toBe(1);
  });
});

describe('the demo dataset is obviously fictional', () => {
  it('labels every account as demo data', () => {
    for (const account of buildDemoWorkspace().accounts) {
      expect(account.label).toMatch(/\(demo\)/i);
    }
  });

  it('marks the workspace mode as demo', () => {
    const setting = buildDemoWorkspace().appSettings.find((s) => s.key === 'workspaceMode');
    expect(setting?.value).toBe('demo');
  });

  it('attributes every row to the demo import session', () => {
    const snapshot = buildDemoWorkspace();
    for (const transaction of snapshot.transactions) {
      expect(transaction.importSessionId).toBe(DEMO_IMPORT_SESSION_ID);
    }
    expect(snapshot.importSessions.map((s) => s.id)).toEqual([DEMO_IMPORT_SESSION_ID]);
  });
});

describe('the demo dataset satisfies the specification', () => {
  const snapshot = buildDemoWorkspace();

  it('spans at least four complete months', () => {
    expect(DEMO_MONTHS.length).toBeGreaterThanOrEqual(4);

    const months = new Set(snapshot.transactions.map((t) => t.postedDate.slice(0, 7)));
    for (const month of DEMO_MONTHS) {
      expect(months.has(month)).toBe(true);
    }
  });

  it('records a statement range, which is what makes a month complete', () => {
    // Month completeness comes from the confirmed statement range, not from
    // observed transaction dates (data-methodology.md §6).
    const session = snapshot.importSessions[0]!;
    expect(session.statementRangeStart).toBe(DEMO_RANGE.start);
    expect(session.statementRangeEnd).toBe(DEMO_RANGE.end);
  });

  it('keeps every transaction inside the statement range', () => {
    for (const transaction of snapshot.transactions) {
      expect(transaction.postedDate >= DEMO_RANGE.start).toBe(true);
      expect(transaction.postedDate <= DEMO_RANGE.end).toBe(true);
    }
  });

  it('stores money as unsigned integer cents, with the sign in direction', () => {
    for (const transaction of snapshot.transactions) {
      expect(Number.isInteger(transaction.amountCents)).toBe(true);
      expect(transaction.amountCents).toBeGreaterThanOrEqual(0);
      expect(['debit', 'credit']).toContain(transaction.direction);
    }
  });

  it('only uses categories from the closed v1.0 set', () => {
    for (const transaction of snapshot.transactions) {
      expect(CATEGORY_IDS).toContain(transaction.categoryId);
    }
  });

  it('includes every kind the calculation contract distinguishes', () => {
    const kinds = new Set(snapshot.transactions.map((t) => t.kind));
    // Present so Phase 5 has real cases for inclusion, exclusion, and refunds.
    for (const kind of [
      'purchase',
      'income',
      'transfer',
      'payment',
      'fee',
      'cash_withdrawal',
      'refund',
      'unknown',
    ]) {
      expect(kinds.has(kind as never), `expected a ${kind} transaction`).toBe(true);
    }
  });

  it('pairs each card payment across two accounts so double counting is testable', () => {
    const payments = snapshot.transactions.filter((t) => t.kind === 'payment');
    expect(payments.length).toBe(DEMO_MONTHS.length * 2);

    const debits = payments.filter((t) => t.direction === 'debit');
    const credits = payments.filter((t) => t.direction === 'credit');
    expect(debits).toHaveLength(credits.length);

    for (const debit of debits) {
      const match = credits.find(
        (c) => c.postedDate === debit.postedDate && c.amountCents === debit.amountCents,
      );
      expect(match, 'every payment debit needs its matching card-side credit').toBeDefined();
      expect(match?.accountId).not.toBe(debit.accountId);
    }
  });

  it('leaves at least one credit unreviewed, so that data-quality state is reachable', () => {
    const unknownCredits = snapshot.transactions.filter(
      (t) => t.kind === 'unknown' && t.direction === 'credit',
    );
    expect(unknownCredits.length).toBeGreaterThan(0);
  });

  it('includes a recurring price change for the Phase 6 flag to find', () => {
    const withPriceChange = snapshot.recurringSeries.filter((s) => s.priceChange);
    expect(withPriceChange.length).toBeGreaterThan(0);
    const change = withPriceChange[0]!.priceChange!;
    expect(change.currentAmountCents).toBeGreaterThan(change.previousAmountCents);
  });

  it('gives every recurring series its evidence, never a bare score', () => {
    for (const series of snapshot.recurringSeries) {
      expect(['high', 'medium', 'low']).toContain(series.confidence);
      expect(series.confidenceReasons.length).toBeGreaterThan(0);
      expect(series.transactionIds.length).toBeGreaterThan(0);
    }
  });

  it('creates one budget plan per month with rollover off', () => {
    expect(snapshot.budgetPlans).toHaveLength(DEMO_MONTHS.length);
    for (const plan of snapshot.budgetPlans) {
      expect(plan.rolloverEnabled).toBe(false);
      expect(DEMO_MONTHS).toContain(plan.month);
    }
  });

  it('gives every category target a plan that exists', () => {
    const planIds = new Set(snapshot.budgetPlans.map((p) => p.id));
    for (const target of snapshot.budgetCategoryTargets) {
      expect(planIds.has(target.budgetPlanId)).toBe(true);
    }
  });

  it('gives every transaction an account that exists', () => {
    const accountIds = new Set(snapshot.accounts.map((a) => a.id));
    for (const transaction of snapshot.transactions) {
      expect(accountIds.has(transaction.accountId)).toBe(true);
    }
  });

  it('uses unique transaction ids', () => {
    const ids = snapshot.transactions.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('seeding and resetting', () => {
  let db: WorkspaceDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await destroyTestDatabase(db);
  });

  it('loads the demo into an empty workspace', async () => {
    const outcome = await loadDemoWorkspace(db);

    expect(outcome.transactionCount).toBeGreaterThan(0);
    expect(await isDemoWorkspace(db)).toBe(true);

    const summary = await summarizeWorkspace(db);
    expect(summary.mode).toBe('demo');
    expect(summary.isEmpty).toBe(false);
    expect(summary.counts.transactions).toBe(outcome.transactionCount);
  });

  it('replaces existing data rather than merging into it', async () => {
    await loadDemoWorkspace(db);
    const first = await countAll(db);

    await loadDemoWorkspace(db);
    const second = await countAll(db);

    expect(second).toEqual(first);
  });

  it('reset restores the original dataset exactly', async () => {
    await loadDemoWorkspace(db);

    // Simulate the user having edited the demo.
    await db.transactions.where('id').equals('demo-txn-0001').modify({ categoryId: 'travel' });
    await db.transactions.where('id').equals('demo-txn-0002').delete();
    expect((await countAll(db)).transactions).toBe(buildDemoWorkspace().transactions.length - 1);

    await resetDemoWorkspace(db);

    // IndexedDB returns rows in primary-key order, which is not the order the
    // builder emits them in, so compare content rather than ordering.
    const restored = await readSnapshot(db);
    const expected = buildDemoWorkspace();
    const key = (row: Record<string, unknown>) => String(row.id ?? row.key);
    const sorted = (rows: unknown[]) =>
      [...(rows as Record<string, unknown>[])].sort((a, b) => key(a).localeCompare(key(b)));

    for (const table of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(sorted(restored[table]), `table ${table} should be restored exactly`).toEqual(
        sorted(expected[table]),
      );
    }
  });
});
