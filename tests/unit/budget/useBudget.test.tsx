import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { putAccounts } from '../../../src/db/repositories/accounts';
import * as transactionsRepo from '../../../src/db/repositories/transactions';
import { saveValidatedBudgetPlan } from '../../../src/db/repositories/budgets';
import { setSetting, SETTING_KEYS } from '../../../src/db/repositories/settings';
import {
  centsToDollarInput,
  parseDollarsToCents,
  useBudget,
  type BudgetApi,
} from '../../../src/review/useBudget';
import type { Account, ImportSession, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase, TEST_CLOCK } from '../helpers/testDatabase';

/**
 * The budget hook against a real database.
 *
 * The reactive claims are the ones worth proving here: editing a transaction, a
 * plan, an account's archived flag, or the income-completeness setting must all
 * reach the page without a reload, because `useLiveQuery` is subscribed to the
 * tables those writes touch. A test that stubbed the database would prove only
 * that the hook reads its own mock.
 */

let db: WorkspaceDatabase;
let api: BudgetApi | null = null;

const MAY = '2026-05';
const TODAY = '2026-05-15';

const ACCOUNTS: Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  { id: 'card', label: 'Rewards Card', type: 'credit_card', currency: 'USD', archived: false },
];

function txn(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'checking',
    postedDate: '2026-05-08',
    descriptionRaw: 'PINEBROOK MARKET',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 20_000,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'groceries',
    categorySource: 'user',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

const session: ImportSession = {
  id: 'session-1',
  importedAt: '2026-08-01T12:00:00.000Z',
  sourceFileNames: ['statement.csv'],
  accountIds: ['checking'],
  mappingVersion: 1,
  rowCount: 1,
  acceptedCount: 1,
  rejectedCount: 0,
  duplicateCandidateCount: 0,
  warnings: [],
  statementRangeStart: '2026-05-01',
  statementRangeEnd: '2026-05-31',
};

function Probe() {
  api = useBudget({ db, month: MAY, today: () => TODAY });
  return <output data-testid="status">{api.status}</output>;
}

const seed = async () => {
  await putAccounts(db, ACCOUNTS);
  await transactionsRepo.commitImportSession(db, session, [txn('t1')]);
};

beforeEach(async () => {
  db = await createTestDatabase();
  api = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyTestDatabase(db);
});

describe('parsing dollars', () => {
  it('reads plain and two-decimal amounts as exact cents', () => {
    expect(parseDollarsToCents('1200')).toEqual({ ok: true, cents: 120_000 });
    expect(parseDollarsToCents('19.99')).toEqual({ ok: true, cents: 1_999 });
    expect(parseDollarsToCents('0.05')).toEqual({ ok: true, cents: 5 });
    expect(parseDollarsToCents('0')).toEqual({ ok: true, cents: 0 });
    expect(parseDollarsToCents('  12.30  ')).toEqual({ ok: true, cents: 1_230 });
  });

  it('reads blank as unset rather than zero', () => {
    expect(parseDollarsToCents('')).toEqual({ ok: true, cents: undefined });
    expect(parseDollarsToCents('   ')).toEqual({ ok: true, cents: undefined });
  });

  it('refuses negatives, exponents, extra decimals, and junk', () => {
    for (const bad of ['-1', '-0.01', '1e3', '1E3', '10.005', '12abc', '1,200', '.5', '1.']) {
      expect(parseDollarsToCents(bad).ok, bad).toBe(false);
    }
  });

  it('does not drift on values a float would round wrongly', () => {
    // 19.99 * 100 is 1998.9999999999998 in binary floating point.
    expect(parseDollarsToCents('19.99')).toEqual({ ok: true, cents: 1_999 });
    expect(parseDollarsToCents('1.1')).toEqual({ ok: true, cents: 110 });
    expect(parseDollarsToCents('8.29')).toEqual({ ok: true, cents: 829 });
  });

  it('round-trips through the editable string form', () => {
    expect(centsToDollarInput(1_999)).toBe('19.99');
    expect(centsToDollarInput(0)).toBe('0.00');
    expect(centsToDollarInput(undefined)).toBe('');
  });
});

describe('states', () => {
  it('reports empty for an untouched workspace', async () => {
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('empty'));
    expect(api?.selection).toBeNull();
  });

  it('reports ready and computes against the plan', async () => {
    await seed();
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 50_000, rolloverEnabled: false },
      [{ id: 'tg', budgetPlanId: 'plan-may', categoryId: 'groceries', limitCents: 30_000 }],
    );

    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('ready'));
    expect(api?.selection?.actualCents).toBe(20_000);
    expect(api?.selection?.remainingCents).toEqual({ available: true, value: 30_000 });
    expect(api?.selection?.categories[0]).toMatchObject({
      categoryId: 'groceries',
      spentCents: 20_000,
    });
  });

  it('reports a sanitized failure and nothing else', async () => {
    await seed();
    vi.spyOn(transactionsRepo, 'listTransactions').mockRejectedValue(
      new Error('PINEBROOK MARKET row 4 exploded'),
    );

    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('failed'));

    expect(api?.errorMessage).toBe('This workspace could not be read. No figures are shown.');
    expect(api?.errorMessage).not.toMatch(/PINEBROOK|exploded|row 4|Dexie|IndexedDB/i);
    expect(api?.selection).toBeNull();
  });

  it('recovers on retry once the read succeeds', async () => {
    await seed();
    const spy = vi
      .spyOn(transactionsRepo, 'listTransactions')
      .mockRejectedValue(new Error('transient'));
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('failed'));

    spy.mockRestore();
    await act(async () => api?.retry());
    await waitFor(() => expect(api?.status).toBe('ready'));
    expect(api?.selection?.actualCents).toBe(20_000);
  });
});

describe('reactivity', () => {
  beforeEach(async () => {
    await seed();
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 50_000, rolloverEnabled: false },
      [],
    );
  });

  it('follows a transaction edit without a reload', async () => {
    render(<Probe />);
    await waitFor(() => expect(api?.selection?.actualCents).toBe(20_000));

    await act(async () => {
      await db.transactions.update('t1', { amountCents: 45_000 });
    });

    await waitFor(() => expect(api?.selection?.actualCents).toBe(45_000));
    expect(api?.selection?.remainingCents).toEqual({ available: true, value: 5_000 });
  });

  it('follows a plan edit without a reload', async () => {
    render(<Probe />);
    await waitFor(() =>
      expect(api?.selection?.limitCents).toEqual({ available: true, value: 50_000 }),
    );

    await act(async () => {
      await saveValidatedBudgetPlan(
        db,
        { id: 'plan-may', month: MAY, overallLimitCents: 15_000, rolloverEnabled: false },
        [],
      );
    });

    await waitFor(() =>
      expect(api?.selection?.remainingCents).toEqual({ available: true, value: -5_000 }),
    );
    expect(api?.selection?.status).toBe('over');
  });

  it('follows archiving an account without a reload', async () => {
    render(<Probe />);
    await waitFor(() => expect(api?.selection?.actualCents).toBe(20_000));

    await act(async () => {
      await db.accounts.update('checking', { archived: true });
    });

    await waitFor(() => expect(api?.selection?.actualCents).toBe(0));
    expect(api?.selection?.scope).toEqual(['card']);
  });

  it('follows an income-completeness change without a reload', async () => {
    render(<Probe />);
    await waitFor(() =>
      expect(api?.selection?.observedIncomeCents).toEqual({
        available: false,
        reason: 'income-completeness-unconfirmed',
      }),
    );

    await act(async () => {
      await setSetting(db, SETTING_KEYS.incomeDataComplete, true, TEST_CLOCK);
    });

    await waitFor(() => expect(api?.selection?.observedIncomeCents.available === false).toBe(true));
    // Confirmed complete, but this month has no income rows — a different,
    // equally honest reason rather than a fabricated zero.
    expect(api?.selection?.observedIncomeCents).toEqual({
      available: false,
      reason: 'no-income-data',
    });
  });
});

describe('writes', () => {
  beforeEach(seed);

  it('saves a typed plan and reflects it immediately', async () => {
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('ready'));

    await act(async () => api?.setOverallLimit('500.00'));
    await act(async () => {
      await api?.save();
    });

    await waitFor(() =>
      expect(api?.selection?.limitCents).toEqual({ available: true, value: 50_000 }),
    );
    expect(api?.saveState).toEqual({ kind: 'saved', message: 'Plan saved.' });
  });

  it('refuses an invalid amount without writing', async () => {
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('ready'));

    await act(async () => api?.setOverallLimit('-5'));
    await act(async () => {
      await api?.save();
    });

    expect(api?.saveState.kind).toBe('invalid');
    expect(api?.plan).toBeNull();
  });

  it('deletes a plan and returns to the no-plan state', async () => {
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 50_000, rolloverEnabled: false },
      [],
    );
    render(<Probe />);
    await waitFor(() => expect(api?.selection?.hasPlan).toBe(true));

    await act(async () => {
      await api?.deletePlan();
    });

    await waitFor(() => expect(api?.selection?.hasPlan).toBe(false));
    expect(api?.selection?.limitCents).toEqual({ available: false, reason: 'no-budget-plan' });
  });

  it('copies the previous month, then keeps the two independent', async () => {
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-april', month: '2026-04', overallLimitCents: 77_000, rolloverEnabled: false },
      [{ id: 'ta', budgetPlanId: 'plan-april', categoryId: 'dining', limitCents: 9_000 }],
    );

    render(<Probe />);
    await waitFor(() => expect(api?.previousMonthHasPlan).toBe(true));

    await act(async () => {
      await api?.copyPreviousMonth(false);
    });
    await waitFor(() =>
      expect(api?.selection?.limitCents).toEqual({ available: true, value: 77_000 }),
    );
    expect(api?.plan?.copiedFromMonth).toBe('2026-04');
    expect(api?.plan?.rolloverEnabled).toBe(false);

    // Editing May leaves April alone.
    await act(async () => api?.setOverallLimit('10.00'));
    await act(async () => {
      await api?.save();
    });
    await waitFor(() =>
      expect(api?.selection?.limitCents).toEqual({ available: true, value: 1_000 }),
    );

    const april = await db.budgetPlans.where('month').equals('2026-04').first();
    expect(april?.overallLimitCents).toBe(77_000);
  });

  it('reports an occupied destination instead of overwriting silently', async () => {
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-april', month: '2026-04', overallLimitCents: 77_000, rolloverEnabled: false },
      [],
    );
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 5_000, rolloverEnabled: false },
      [],
    );

    render(<Probe />);
    await waitFor(() => expect(api?.selection?.hasPlan).toBe(true));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await api?.copyPreviousMonth(false);
    });
    expect(outcome).toBe('destination-exists');
    expect(api?.selection?.limitCents).toEqual({ available: true, value: 5_000 });

    await act(async () => {
      await api?.copyPreviousMonth(true);
    });
    await waitFor(() =>
      expect(api?.selection?.limitCents).toEqual({ available: true, value: 77_000 }),
    );
  });
});

describe('month navigation', () => {
  it('moves month without parsing a calendar string into an instant', async () => {
    await seed();
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('ready'));

    await act(async () => api?.goToPreviousMonth());
    expect(api?.month).toBe('2026-04');
    await act(async () => api?.goToNextMonth());
    await act(async () => api?.goToNextMonth());
    expect(api?.month).toBe('2026-06');
    expect(api?.monthPosition).toBe('future');
  });

  it('drops an unsaved draft when the month changes', async () => {
    await seed();
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('ready'));

    await act(async () => api?.setOverallLimit('999.00'));
    expect(api?.form.overallLimit).toBe('999.00');

    await act(async () => api?.goToPreviousMonth());
    expect(api?.form.overallLimit).toBe('');
  });
});
