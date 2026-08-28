import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { useDashboard, type DashboardApi } from '../../../src/review/useDashboard';
import { SummaryCards } from '../../../src/components/dashboard/SummaryCards';
import { selectDashboard } from '../../../src/calculations';
import type { AccountScope, DashboardSelection } from '../../../src/calculations';
import { putAccounts } from '../../../src/db/repositories/accounts';
import * as accountsRepo from '../../../src/db/repositories/accounts';
import * as transactionsRepo from '../../../src/db/repositories/transactions';
import * as settingsRepo from '../../../src/db/repositories/settings';
import { SETTING_KEYS } from '../../../src/db/repositories/settings';
import type { Account, ImportSession, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import {
  ACCOUNTS as FIXTURE_ACCOUNTS,
  cardPayment,
  COVERAGE_TWO_MONTHS,
  MAY,
  purchase,
  refund,
  resetIds,
  transfer,
  unknownDebit,
} from '../calculations/fixtures';

/**
 * Three audits, against the Phase 5B-2 corrections.
 *
 * 1. "Transactions analyzed" counts everything that was analyzed, not only the
 *    rows that moved a total.
 * 2. A failed repository read yields no dashboard at all — never a partial one
 *    assembled from whichever reads happened to succeed.
 * 3. "Latest complete month" cannot keep dates it can no longer justify.
 */

/* ------------------------------------------------ 1. population semantics - */

function selectionFor(transactions: Parameters<typeof selectDashboard>[0]['transactions']) {
  return selectDashboard({
    transactions,
    filters: { range: MAY },
    incomeCompleteness: 'confirmed-complete',
    coverage: COVERAGE_TWO_MONTHS,
    accounts: FIXTURE_ACCOUNTS as readonly AccountScope[],
    granularity: 'month',
  });
}

const renderCards = (selection: DashboardSelection) =>
  render(
    <MemoryRouter>
      <SummaryCards
        selection={selection}
        period="2026-05-01 to 2026-05-31"
        // Phase 6A added this required prop. These suites are about the
        // Phase 5 cards, so they pass the no-plan case and assert nothing
        // new; budget behaviour is covered in its own files.
        budgetRemaining={{ available: false, reason: 'no-budget-plan' }}
      />
    </MemoryRouter>,
  );

describe('Transactions analyzed counts the whole filtered population', () => {
  it('counts rows from every treatment, not only included spending', () => {
    resetIds();
    const selection = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02' }),
      refund(200, { postedDate: '2026-05-03' }),
      transfer(9_000, { postedDate: '2026-05-04' }),
      cardPayment(7_000, { postedDate: '2026-05-05' }),
      purchase(500, { postedDate: '2026-05-06', excludedFromSpending: true }),
      unknownDebit(300, { postedDate: '2026-05-07' }),
    ]);

    // Two rows move net spending; six were read and assigned a treatment.
    expect(selection.netSpending.includedTransactionCount).toBe(2);
    expect(selection.partition.populationCount).toBe(6);

    renderCards(selection);
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('rises for an excluded-by-kind row while included spending does not', () => {
    resetIds();
    const before = selectionFor([purchase(1_000, { postedDate: '2026-05-02' })]);
    resetIds();
    const after = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02' }),
      transfer(9_000, { postedDate: '2026-05-04' }),
    ]);
    expect(after.partition.populationCount).toBe(before.partition.populationCount + 1);
    expect(after.netSpending.includedTransactionCount).toBe(
      before.netSpending.includedTransactionCount,
    );
  });

  it('rises for a user-excluded row while included spending does not', () => {
    resetIds();
    const before = selectionFor([purchase(1_000, { postedDate: '2026-05-02' })]);
    resetIds();
    const after = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02' }),
      purchase(500, { postedDate: '2026-05-06', excludedFromSpending: true }),
    ]);
    expect(after.partition.populationCount).toBe(before.partition.populationCount + 1);
    expect(after.netSpending.includedTransactionCount).toBe(
      before.netSpending.includedTransactionCount,
    );
  });

  it('rises for a needs-review row while included spending does not', () => {
    resetIds();
    const before = selectionFor([purchase(1_000, { postedDate: '2026-05-02' })]);
    resetIds();
    const after = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02' }),
      unknownDebit(300, { postedDate: '2026-05-07' }),
    ]);
    expect(after.partition.populationCount).toBe(before.partition.populationCount + 1);
    expect(after.netSpending.includedTransactionCount).toBe(
      before.netSpending.includedTransactionCount,
    );
  });

  it('equals the sum of the mutually exclusive treatment buckets', () => {
    resetIds();
    const { partition } = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02' }),
      refund(200, { postedDate: '2026-05-03' }),
      transfer(9_000, { postedDate: '2026-05-04' }),
      purchase(500, { postedDate: '2026-05-06', excludedFromSpending: true }),
      unknownDebit(300, { postedDate: '2026-05-07' }),
    ]);
    const summed =
      partition.includedOutflow.length +
      partition.includedRefund.length +
      partition.excludedByKind.length +
      partition.excludedByUser.length +
      partition.needsReview.length;
    expect(partition.populationCount).toBe(summed);
    expect(partition.populationCount).toBe(5);
  });

  it('shows a genuine zero when the filters match nothing', () => {
    resetIds();
    const selection = selectionFor([]);
    expect(selection.partition.populationCount).toBe(0);
    renderCards(selection);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('is proven by the reconciliation report on every render', () => {
    resetIds();
    const selection = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02' }),
      transfer(9_000, { postedDate: '2026-05-04' }),
    ]);
    const partitionCheck = selection.reconciliation.checks.find((check) =>
      check.name.includes('treatment partition covers the population'),
    );
    expect(partitionCheck?.holds).toBe(true);
    expect(selection.reconciliation.holds).toBe(true);
  });
});

/* --------------------------------------------------- 2. failure atomicity - */

let db: WorkspaceDatabase;
let api: DashboardApi | null = null;

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
    amountCents: 1_234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'groceries',
    categorySource: 'merchant_rule',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

function session(id: string, overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    id,
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
    ...overrides,
  };
}

function Probe({ database }: { database: WorkspaceDatabase | null }) {
  api = useDashboard({ db: database, today: () => '2026-05-14' });
  return <output data-testid="status">{api.status}</output>;
}

const renderProbe = () => render(<Probe database={db} />);

beforeEach(async () => {
  db = await createTestDatabase();
  api = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyTestDatabase(db);
});

const seed = async () => {
  await putAccounts(db, ACCOUNTS);
  await transactionsRepo.commitImportSession(db, session('session-1'), [txn('t1')]);
  await transactionsRepo.commitImportSession(db, session('session-2', { accountIds: ['card'] }), [
    txn('t2', { accountId: 'card', importSessionId: 'session-2' }),
  ]);
};

/**
 * Every read the hook performs, each able to fail on its own.
 *
 * Written as explicit typed factories rather than a keyed loop so each spy keeps
 * its real signature — a `never`-cast index would let a wrong mock through.
 */
const READS: readonly { name: string; fail: (message: string) => void }[] = [
  {
    name: 'listTransactions',
    fail: (message) =>
      void vi.spyOn(transactionsRepo, 'listTransactions').mockRejectedValue(new Error(message)),
  },
  {
    name: 'listAccounts',
    fail: (message) =>
      void vi.spyOn(accountsRepo, 'listAccounts').mockRejectedValue(new Error(message)),
  },
  {
    name: 'listImportSessions',
    fail: (message) =>
      void vi.spyOn(transactionsRepo, 'listImportSessions').mockRejectedValue(new Error(message)),
  },
  {
    name: 'getSetting',
    fail: (message) =>
      void vi.spyOn(settingsRepo, 'getSetting').mockRejectedValue(new Error(message)),
  },
];

describe('a failed read emits no dashboard at all', () => {
  for (const read of READS) {
    it(`fails closed when ${read.name} rejects`, async () => {
      await seed();
      read.fail(`IndexedDB NotReadableError reading ${read.name} from object store`);

      renderProbe();

      await waitFor(() => expect(api?.status).toBe('failed'));

      // Nothing partial survives: no selection, and no fulfilled subset shown
      // as though the dashboard had loaded.
      expect(api?.selection).toBeNull();
      expect(api?.accountChoices).toEqual([]);
      expect(api?.domain).toBeNull();
      expect(api?.completeMonths.size).toBe(0);
      expect(api?.accountLabels.size).toBe(0);
      expect(api?.latestCompleteMonthAvailable).toBe(false);
    });

    it(`sanitizes the ${read.name} failure message`, async () => {
      await seed();
      read.fail('IndexedDB NotReadableError on table transactions: value 1234');

      renderProbe();
      await waitFor(() => expect(api?.status).toBe('failed'));

      expect(api?.errorMessage).toBe('This workspace could not be read. No figures are shown.');
      // No database name, no table name, no exception text, no stored value.
      expect(api?.errorMessage).not.toMatch(/dexie|indexeddb|notreadable|table|object store/i);
      expect(api?.errorMessage).not.toMatch(/1234/);
    });
  }

  it('never substitutes an unconfirmed setting for a failed settings read', async () => {
    await seed();
    await settingsRepo.setSetting(db, SETTING_KEYS.incomeDataComplete, true);
    vi.spyOn(settingsRepo, 'getSetting').mockRejectedValue(new Error('read failed'));

    renderProbe();
    await waitFor(() => expect(api?.status).toBe('failed'));

    // A confirmed workspace must not be reported as unconfirmed just because the
    // read failed — it reports nothing at all.
    expect(api?.selection).toBeNull();
  });

  it('recovers on the next successful read without a manual refresh', async () => {
    await seed();
    const spy = vi
      .spyOn(transactionsRepo, 'listTransactions')
      .mockRejectedValue(new Error('transient read failure'));

    renderProbe();
    await waitFor(() => expect(api?.status).toBe('failed'));

    // The read starts working again, and a write re-triggers the subscription.
    //
    // The write goes to `accounts` rather than `transactions` on purpose: while
    // `listTransactions` is mocked the querier never touches the transactions
    // table, so `liveQuery` holds no dependency on it and a transaction write
    // could not re-trigger anything. In production that dependency exists,
    // because the real read does touch the table.
    spy.mockRestore();
    await act(async () => {
      await putAccounts(db, [
        ...ACCOUNTS,
        { id: 'savings', label: 'Rainy Day', type: 'savings', currency: 'USD', archived: false },
      ]);
    });

    await waitFor(() => expect(api?.status).toBe('ready'));
    expect(api?.selection).not.toBeNull();
    expect(api?.errorMessage).toBeNull();
    // The full figures are back, computed from the reads that now succeed.
    expect(api?.selection?.netSpending.netSpendingCents).toBe(1_234 + 1_234);
    expect(api?.accountChoices).toHaveLength(3);
  });
});

/* ------------------------------------- 3. latest-complete-month invalidation - */

describe('Latest complete month cannot keep dates it cannot justify', () => {
  it('resolves to the complete month while one exists', async () => {
    await seed();
    renderProbe();
    await waitFor(() => expect(api?.status).toBe('ready'));

    await act(async () => api?.setPreset('latest-complete-month'));

    await waitFor(() => expect(api?.preset).toBe('latest-complete-month'));
    expect(api?.filters.range).toEqual({ start: '2026-05-01', end: '2026-05-31' });
  });

  it('falls back to All data when a scope change leaves no complete month', async () => {
    await putAccounts(db, ACCOUNTS);
    // Only checking has a statement; the card has none.
    await transactionsRepo.commitImportSession(db, session('session-1'), [txn('t1')]);
    await transactionsRepo.commitImportSession(
      db,
      session('session-2', {
        accountIds: ['card'],
        statementRangeStart: undefined,
        statementRangeEnd: undefined,
      }),
      [txn('t2', { accountId: 'card', importSessionId: 'session-2' })],
    );
    renderProbe();
    await waitFor(() => expect(api?.status).toBe('ready'));

    // Filtered to checking, May is complete and the preset holds.
    await act(async () => {
      api?.toggleAccount('checking');
      api?.setPreset('latest-complete-month');
    });
    await waitFor(() => expect(api?.preset).toBe('latest-complete-month'));

    // Widening the scope back to both accounts makes no month complete.
    await act(async () => api?.toggleAccount('checking'));

    await waitFor(() => expect(api?.preset).toBe('all-data'));
    expect(api?.latestCompleteMonthAvailable).toBe(false);
    // The dates are All-data bounds, not the stale May range.
    expect(api?.filters.range).not.toEqual({ start: '2026-05-01', end: '2026-05-31' });
  });

  it('falls back to All data when coverage disappears entirely', async () => {
    await seed();
    renderProbe();
    await waitFor(() => expect(api?.status).toBe('ready'));
    await act(async () => api?.setPreset('latest-complete-month'));
    await waitFor(() => expect(api?.preset).toBe('latest-complete-month'));

    await act(async () => {
      await transactionsRepo.deleteImportSession(db, 'session-2');
    });

    await waitFor(() => expect(api?.preset).toBe('all-data'));
    expect(api?.latestCompleteMonthAvailable).toBe(false);
  });

  it('advances to a newer complete month while the preset stays active', async () => {
    await seed();
    renderProbe();
    await waitFor(() => expect(api?.status).toBe('ready'));
    await act(async () => api?.setPreset('latest-complete-month'));
    await waitFor(() => expect(api?.filters.range.start).toBe('2026-05-01'));

    // June statements arrive for both accounts.
    await act(async () => {
      await transactionsRepo.commitImportSession(
        db,
        session('session-3', {
          statementRangeStart: '2026-06-01',
          statementRangeEnd: '2026-06-30',
        }),
        [txn('t3', { postedDate: '2026-06-10', importSessionId: 'session-3' })],
      );
      await transactionsRepo.commitImportSession(
        db,
        session('session-4', {
          accountIds: ['card'],
          statementRangeStart: '2026-06-01',
          statementRangeEnd: '2026-06-30',
        }),
        [txn('t4', { accountId: 'card', postedDate: '2026-06-11', importSessionId: 'session-4' })],
      );
    });

    await waitFor(() =>
      expect(api?.filters.range).toEqual({ start: '2026-06-01', end: '2026-06-30' }),
    );
    expect(api?.preset).toBe('latest-complete-month');
  });

  it('is unaffected by a category-only filter change', async () => {
    await seed();
    renderProbe();
    await waitFor(() => expect(api?.status).toBe('ready'));
    await act(async () => api?.setPreset('latest-complete-month'));
    await waitFor(() => expect(api?.preset).toBe('latest-complete-month'));
    const before = api?.filters.range;

    await act(async () => api?.toggleCategory('groceries'));

    await waitFor(() => expect(api?.filters.categoryIds).toEqual(['groceries']));
    // Category filtering never narrows which accounts must be covered.
    expect(api?.preset).toBe('latest-complete-month');
    expect(api?.filters.range).toEqual(before);
  });

  it('writes no filter state to URL or storage across these transitions', async () => {
    await seed();
    renderProbe();
    await waitFor(() => expect(api?.status).toBe('ready'));

    await act(async () => {
      api?.setPreset('latest-complete-month');
      api?.toggleAccount('card');
    });
    await waitFor(() => expect(api?.filters.accountIds).toEqual(['card']));

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });
});
