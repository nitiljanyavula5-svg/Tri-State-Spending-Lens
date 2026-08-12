import 'fake-indexeddb/auto';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { TransactionsPage } from '../../../src/pages/app/TransactionsPage';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import type { Account, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderWithProviders } from '../helpers/renderApp';

/**
 * The failure paths of the transaction review page.
 *
 * The happy paths are covered in `review-page.test.tsx`. What is asserted here
 * is what happens when something goes wrong — a rejected write, a slow query
 * answering out of order, a second click on a control that is already working.
 * These are the behaviours a user only notices when they are missing, and each
 * one is checked against the *stored* rows rather than the rendered text.
 */

/**
 * Queries answer out of order, shortest search term slowest.
 *
 * A real user types faster than IndexedDB answers, so a response for "PIN" can
 * arrive after the one for "PINEBROOK". This mock makes that inversion happen
 * every time instead of occasionally, which is the only way to prove the
 * request-id guard actually discards the stale answer.
 */
vi.mock('../../../src/db/transactionQueries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/transactionQueries')>();
  return {
    ...actual,
    queryTransactions: async (
      db: WorkspaceDatabase,
      query: Parameters<typeof actual.queryTransactions>[1] = {},
    ) => {
      const search = query.filters?.search ?? '';
      if (search.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 120 - search.length * 10)));
      }
      return actual.queryTransactions(db, query);
    },
  };
});

let db: WorkspaceDatabase;

const ACCOUNTS: readonly Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
];

function transaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'checking',
    postedDate: '2026-04-08',
    descriptionRaw: 'PINEBROOK MARKET #114',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1_234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'other',
    categorySource: 'uncategorized',
    classificationConfidence: 'none',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.accounts.bulkAdd([...ACCOUNTS]);
  await db.importSessions.add({
    id: 'session-1',
    importedAt: '2026-08-01T12:00:00.000Z',
    sourceFileNames: ['statement.csv'],
    accountIds: ['checking'],
    mappingVersion: 1,
    rowCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
  });
  await setWorkspaceMode(db, 'personal');
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

function renderPage() {
  return renderWithProviders(<TransactionsPage />, db);
}

/** The desktop table; jsdom sees the mobile cards too, so queries are scoped. */
const grid = () => within(screen.getByRole('region', { name: 'Transactions' }));
const user = () => userEvent.setup();

async function openEditor(u: ReturnType<typeof user>) {
  await u.click(grid().getAllByRole('button', { name: /^Review/ })[0]!);
  return screen.findByRole('dialog');
}

describe('a rejected individual save', () => {
  it('leaves the row exactly as it was and keeps the dialog open', async () => {
    const u = user();
    await db.transactions.add(transaction('a'));
    renderPage();
    await screen.findByText('1 transaction');

    const dialog = await openEditor(u);
    // The write fails after validation, inside the transaction.
    vi.spyOn(db.transactions, 'bulkPut').mockRejectedValue(new Error('quota exceeded on disk 3'));

    await u.selectOptions(within(dialog).getByLabelText(/^Category$/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /save this transaction/i }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/nothing was changed/i);
    // Still open, so the work the user did is not thrown away.
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const stored = await db.transactions.get('a');
    expect(stored?.categoryId).toBe('other');
    expect(stored?.categorySource).toBe('uncategorized');
    expect(stored?.updatedAt).toBe('2026-08-01T12:00:00.000Z');
    // No audit entry for a write that never happened.
    expect(await db.userEdits.count()).toBe(0);
    // The Dexie detail never reaches the interface.
    expect(document.body.textContent).not.toMatch(/disk 3/);
  });
});

describe('double submission', () => {
  it('writes once when the save button is clicked twice', async () => {
    const u = user();
    await db.transactions.add(transaction('a'));
    renderPage();
    await screen.findByText('1 transaction');

    const dialog = await openEditor(u);
    await u.selectOptions(within(dialog).getByLabelText(/^Category$/i), 'groceries');

    const bulkPut = vi.spyOn(db.transactions, 'bulkPut');
    const save = within(dialog).getByRole('button', { name: /save this transaction/i });

    // Two clicks before the first await settles.
    save.click();
    save.click();

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The in-flight guard means the second click never reached the service.
    expect(bulkPut).toHaveBeenCalledTimes(1);
    expect((await db.transactions.get('a'))?.categoryId).toBe('groceries');
  });
});

describe('rapid filter changes', () => {
  it('renders the newest answer even when an older query resolves later', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('a', { merchantNormalized: 'PINEBROOK MARKET' }),
      transaction('b', {
        merchantNormalized: 'PINE RIDGE HARDWARE',
        descriptionRaw: 'PINE RIDGE HARDWARE',
        postedDate: '2026-04-09',
      }),
    ]);
    renderPage();
    await screen.findByText('2 transactions');

    // "PINE" matches both and is answered slowly; "PINEBROOK" matches one and
    // is answered quickly, so the stale response lands last.
    await u.type(screen.getByLabelText(/^Search$/i), 'PINEBROOK');

    await screen.findByText('1 transaction');
    // Held for longer than the slow query's delay: if the stale answer were
    // rendered, the count would flip back to 2.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByText('1 transaction')).toBeInTheDocument();
  });
});

describe('selection reconciliation', () => {
  it('drops selected rows that a filter change removed from view', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('a', { merchantNormalized: 'PINEBROOK MARKET', categoryId: 'groceries' }),
      transaction('b', {
        merchantNormalized: 'HARBOR BEAN COFFEE',
        descriptionRaw: 'HARBOR BEAN COFFEE',
        categoryId: 'dining',
        postedDate: '2026-04-09',
      }),
    ]);
    renderPage();
    await screen.findByText('2 transactions');

    // Named by date rather than taken by position: the default sort is newest
    // first, so index 0 is the 04-09 row, not the one this test means.
    await u.click(grid().getByRole('checkbox', { name: /select transaction from 2026-04-08/i }));
    expect(await screen.findByText('1 selected on this page')).toBeInTheDocument();

    // Filter to the row that was *not* selected.
    await u.selectOptions(screen.getByLabelText(/^Category$/i), 'dining');
    await screen.findByText('1 transaction');

    // A selection the user can no longer see must not survive as a target for
    // a bulk action.
    await waitFor(() =>
      expect(screen.queryByText(/selected on this page/i)).not.toBeInTheDocument(),
    );
  });

  it('drops selected rows that a page change removed from view', async () => {
    const u = user();
    // One row above the default page size of 50: the smallest workspace that
    // produces a second page, so the jsdom render stays as cheap as it can.
    const rows: Transaction[] = [];
    for (let index = 0; index < 51; index += 1) {
      rows.push(
        transaction(`row-${String(index).padStart(2, '0')}`, {
          postedDate: `2026-04-${String((index % 28) + 1).padStart(2, '0')}`,
        }),
      );
    }
    await db.transactions.bulkAdd(rows);
    renderPage();
    await screen.findByText('51 transactions');
    await screen.findByText(/page 1 of 2/i);

    await u.click(grid().getAllByRole('checkbox', { name: /^Select transaction/ })[0]!);
    expect(await screen.findByText('1 selected on this page')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: /^next$/i }));

    await waitFor(() =>
      expect(screen.queryByText(/selected on this page/i)).not.toBeInTheDocument(),
    );
  });
});

describe('a rejected bulk command', () => {
  it('changes none of the selected rows', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('a'),
      transaction('b', { postedDate: '2026-04-09' }),
      transaction('c', { postedDate: '2026-04-10' }),
    ]);
    renderPage();
    await screen.findByText('3 transactions');

    await u.click(grid().getByRole('checkbox', { name: /select every transaction on this page/i }));
    await screen.findByText('3 selected on this page');

    vi.spyOn(db.transactions, 'bulkPut').mockRejectedValue(new Error('disk on fire'));

    await u.selectOptions(screen.getByLabelText(/set category for selected/i), 'dining');
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /apply change/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/nothing was changed/i),
    );

    // Either every row changes or none does. None did.
    const stored = await db.transactions.toArray();
    expect(stored.every((row) => row.categoryId === 'other')).toBe(true);
    expect(await db.userEdits.count()).toBe(0);
    // Nothing to undo, because nothing happened.
    expect(screen.queryByRole('button', { name: /undo last change/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/disk on fire/);
  });
});

describe('export', () => {
  it('revokes the object URL after handing the file to the browser', async () => {
    const u = user();
    await db.transactions.add(transaction('a'));

    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:test-${created.length}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url);
    });
    // jsdom refuses to navigate; the anchor click is the only browser step.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderPage();
    await screen.findByText('1 transaction');

    await u.click(screen.getByRole('button', { name: /export csv/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /download csv/i }),
    );

    await waitFor(() => expect(revoked).toHaveLength(1));
    // A leaked blob URL keeps every exported transaction alive in memory for
    // the lifetime of the document.
    expect(revoked).toEqual(created);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('offers a filtered export that carries only the matching rows', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('a', { merchantNormalized: 'PINEBROOK MARKET', categoryId: 'groceries' }),
      transaction('b', {
        merchantNormalized: 'HARBOR BEAN COFFEE',
        descriptionRaw: 'HARBOR BEAN COFFEE',
        categoryId: 'dining',
        postedDate: '2026-04-09',
      }),
    ]);

    const blobs: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      void (obj as Blob).text().then((text) => blobs.push(text));
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderPage();
    await screen.findByText('2 transactions');

    // No filter yet, so no filtered-export control is offered.
    expect(
      screen.queryByRole('button', { name: /export these .* results/i }),
    ).not.toBeInTheDocument();

    await u.selectOptions(screen.getByLabelText(/^Category$/i), 'dining');
    await screen.findByText('1 transaction');

    await u.click(screen.getByRole('button', { name: /export this 1 result/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/matching your current filters/i)).toBeInTheDocument();

    await u.click(within(dialog).getByRole('button', { name: /download csv/i }));

    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(blobs[0]).toContain('HARBOR BEAN COFFEE');
    // The filtered-out row is genuinely absent from the file.
    expect(blobs[0]).not.toContain('PINEBROOK MARKET');
  });

  it('reports a sanitized failure and downloads nothing when the read fails', async () => {
    const u = user();
    await db.transactions.add(transaction('a'));

    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderPage();
    await screen.findByText('1 transaction');

    vi.spyOn(db.transactions, 'toCollection').mockImplementation(() => {
      throw new Error('idb exploded at offset 44');
    });

    await u.click(screen.getByRole('button', { name: /export csv/i }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: /download csv/i }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /could not be produced.*nothing was changed or saved/i,
    );
    // No blob was ever created, so nothing was written to the user's device.
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/offset 44/);
  });
});
