import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { OverviewPage } from '../../../src/pages/app/OverviewPage';
import { useDashboard, type DashboardApi } from '../../../src/review/useDashboard';
import { putAccounts } from '../../../src/db/repositories/accounts';
import * as transactionsRepo from '../../../src/db/repositories/transactions';
import type { Account, ImportSession, Transaction } from '../../../src/types/domain';
import { reconcile } from '../../../src/calculations/reconciliation';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderWithProviders } from '../helpers/renderApp';

/**
 * The reconciliation module is the seam for the failing-report case.
 *
 * `selectors.ts` imports `reconcile` from this module directly, so the barrel
 * re-export is not the call site — mocking here is what actually intercepts it.
 * The real implementation is restored before every test, so only the one test
 * that asks for a failure gets one.
 */
vi.mock('../../../src/calculations/reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/calculations/reconciliation')>();
  return { ...actual, reconcile: vi.fn(actual.reconcile) };
});

const realReconciliation = await vi.importActual<
  typeof import('../../../src/calculations/reconciliation')
>('../../../src/calculations/reconciliation');

/**
 * Retry after a failed read, and withholding figures that do not reconcile.
 *
 * Both are about the same discipline: when the page cannot stand behind a
 * number, it says so instead of drawing one.
 */

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
    amountCents: 12_345,
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
  api = useDashboard({ db, today: () => '2026-05-14' });
  return <output data-testid="status">{api.status}</output>;
}

const seed = async () => {
  await putAccounts(db, ACCOUNTS);
  await transactionsRepo.commitImportSession(db, session, [txn('t1')]);
};

beforeEach(async () => {
  vi.mocked(reconcile).mockImplementation(realReconciliation.reconcile);
  db = await createTestDatabase();
  api = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyTestDatabase(db);
});

describe('retry after a failed read', () => {
  it('goes failure → retry → ready without a write or a remount', async () => {
    await seed();
    const spy = vi
      .spyOn(transactionsRepo, 'listTransactions')
      .mockRejectedValue(new Error('transient read failure'));
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('failed'));

    spy.mockRestore();
    await act(async () => api?.retry());

    await waitFor(() => expect(api?.status).toBe('ready'));
    expect(api?.selection?.netSpending.netSpendingCents).toBe(12_345);
    expect(api?.errorMessage).toBeNull();
  });

  it('goes failure → retry → failure while the read keeps failing', async () => {
    await seed();
    vi.spyOn(transactionsRepo, 'listTransactions').mockRejectedValue(new Error('still failing'));
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('failed'));

    await act(async () => api?.retry());

    await waitFor(() => expect(api?.status).toBe('failed'));
    // Still sanitized after a second failure; no accumulation of detail.
    expect(api?.errorMessage).toBe('This workspace could not be read. No figures are shown.');
    expect(api?.errorMessage).not.toMatch(/still failing/);
    expect(api?.selection).toBeNull();
  });

  it('publishes no partial figures across a retry', async () => {
    await seed();
    const spy = vi
      .spyOn(transactionsRepo, 'listTransactions')
      .mockRejectedValue(new Error('read failure'));
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('failed'));

    await act(async () => api?.retry());

    // Still failing, so nothing partial appears even though accounts and
    // sessions read fine.
    await waitFor(() => expect(api?.status).toBe('failed'));
    expect(api?.selection).toBeNull();
    expect(api?.accountChoices).toEqual([]);
    expect(api?.completeMonths.size).toBe(0);

    spy.mockRestore();
    await act(async () => api?.retry());
    await waitFor(() => expect(api?.status).toBe('ready'));
    expect(api?.accountChoices).toHaveLength(1);
  });

  it('settles correctly after rapid repeated activations', async () => {
    await seed();
    const spy = vi
      .spyOn(transactionsRepo, 'listTransactions')
      .mockRejectedValue(new Error('read failure'));
    render(<Probe />);
    await waitFor(() => expect(api?.status).toBe('failed'));

    // Several presses before anything resolves; each is a distinct token.
    await act(async () => {
      api?.retry();
      api?.retry();
      api?.retry();
    });
    await waitFor(() => expect(api?.status).toBe('failed'));

    spy.mockRestore();
    await act(async () => {
      api?.retry();
      api?.retry();
    });

    // The newest run wins; no stale failed result overwrites it.
    await waitFor(() => expect(api?.status).toBe('ready'));
    expect(api?.selection?.netSpending.netSpendingCents).toBe(12_345);
  });
});

describe('the Retry control on the page', () => {
  it('is a keyboard-operable button that recovers the dashboard', async () => {
    await seed();
    const user = userEvent.setup();
    const spy = vi
      .spyOn(transactionsRepo, 'listTransactions')
      .mockRejectedValue(new Error('read failure'));

    renderWithProviders(<OverviewPage />, db);
    await waitFor(() =>
      expect(screen.getAllByText(/this workspace could not be read/i).length).toBeGreaterThan(0),
    );

    const retry = screen.getByRole('button', { name: /retry/i });
    expect(retry).toBeEnabled();

    spy.mockRestore();
    await user.click(retry);

    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    expect(screen.queryByText(/this workspace could not be read/i)).not.toBeInTheDocument();
  });

  it('shows no figures while the failure persists', async () => {
    await seed();
    const user = userEvent.setup();
    vi.spyOn(transactionsRepo, 'listTransactions').mockRejectedValue(new Error('read failure'));

    renderWithProviders(<OverviewPage />, db);
    await waitFor(() =>
      expect(screen.getAllByText(/this workspace could not be read/i).length).toBeGreaterThan(0),
    );

    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() =>
      expect(screen.getAllByText(/this workspace could not be read/i).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
    expect(screen.queryByText('$123.45')).not.toBeInTheDocument();
  });
});

describe('figures are withheld when the invariants do not hold', () => {
  /**
   * A controlled failure, injected at the composition boundary.
   *
   * The selector itself is left alone: corrupting real arithmetic to produce a
   * failing report would test a defect nobody will ever ship. Mocking
   * `reconcile` makes the report fail while every other figure stays genuine,
   * which is exactly the situation the page must survive.
   */
  it('withholds cards, comparison, and charts but keeps the diagnosis', async () => {
    vi.mocked(reconcile).mockReturnValue({
      holds: false,
      checks: [
        { name: 'category totals equal net spending', holds: false, expected: 100, actual: 101 },
      ],
      failures: [
        { name: 'category totals equal net spending', holds: false, expected: 100, actual: 101 },
      ],
    });

    await seed();
    renderWithProviders(<OverviewPage />, db);
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());

    // The caution is shown and the totals are not.
    expect(screen.getAllByText(/these totals do not reconcile/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('$123.45')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /net spending over time/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /where the spending went/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /compared with the previous complete month/i }),
    ).not.toBeInTheDocument();

    // The diagnosis stays available.
    expect(
      screen.getByRole('heading', { name: /how these totals reconcile/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/category totals equal net spending/i)).toBeInTheDocument();
  });

  it('shows everything when the report holds', async () => {
    await seed();
    renderWithProviders(<OverviewPage />, db);
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    expect(
      await screen.findByRole('heading', { name: /net spending over time/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: /where the spending went/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Totals reconcile/i)).toBeInTheDocument();
  });
});
