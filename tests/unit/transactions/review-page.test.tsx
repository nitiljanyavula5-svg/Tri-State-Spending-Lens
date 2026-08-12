import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { TransactionsPage } from '../../../src/pages/app/TransactionsPage';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { buildCleanedCsv } from '../../../src/export/csvExport';
import type { Account, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderWithProviders } from '../helpers/renderApp';

/**
 * The transaction review page, against a real database.
 *
 * These assert what is *stored* after an interaction, not merely what appears.
 * The page is the only thing standing between a user and the Phase 4 services,
 * so the question each test answers is "did the service actually run, and did
 * the row actually change".
 */

let db: WorkspaceDatabase;

const ACCOUNTS: readonly Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  { id: 'card', label: 'Rewards Card', type: 'credit_card', currency: 'USD', archived: false },
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
    amountCents: 1234,
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
    accountIds: ['checking', 'card'],
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

async function seed(...rows: Transaction[]) {
  await db.transactions.bulkAdd(rows);
}

function renderPage() {
  return renderWithProviders(<TransactionsPage />, db);
}

/**
 * The desktop table.
 *
 * The page renders a table *and* a mobile card list, switched by CSS. jsdom
 * runs with `css: false`, so both are in the DOM here and every control appears
 * twice; in a real browser `display: none` removes one from the accessibility
 * tree entirely. Queries are scoped to the table so a test asserts one view
 * rather than accidentally matching both.
 */
function grid() {
  return within(screen.getByRole('region', { name: 'Transactions' }));
}

const user = () => userEvent.setup();

describe('empty workspace', () => {
  it('offers import rather than an empty grid', async () => {
    renderPage();
    expect(await screen.findByText(/nothing to review yet/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /import a csv/i }).length).toBeGreaterThan(0);
  });
});

describe('a populated workspace', () => {
  beforeEach(async () => {
    await seed(
      transaction('a', { merchantNormalized: 'PINEBROOK MARKET', categoryId: 'groceries' }),
      transaction('b', {
        merchantNormalized: 'HARBOR BEAN COFFEE',
        descriptionRaw: 'SQ *HARBOR BEAN 0413',
        categoryId: 'dining',
        postedDate: '2026-04-09',
      }),
      transaction('c', {
        merchantNormalized: 'GARDEN STATE FUEL',
        descriptionRaw: 'GARDEN STATE FUEL',
        kind: 'transfer',
        postedDate: '2026-04-10',
      }),
    );
  });

  it('lists the rows with their reviewed interpretation', async () => {
    renderPage();
    await screen.findByText('3 transactions');

    const table = grid();
    expect(table.getByText('PINEBROOK MARKET')).toBeInTheDocument();
    // The statement's own words stay visible next to the merchant.
    expect(table.getByText('SQ *HARBOR BEAN 0413')).toBeInTheDocument();
    // Treatment is stated, not implied by colour.
    expect(table.getAllByText('Counts as spending').length).toBeGreaterThan(0);
    expect(table.getByText('Not spending')).toBeInTheDocument();
  });

  it('searches the raw description and the merchant', async () => {
    const u = user();
    renderPage();
    await screen.findByText('3 transactions');

    await u.type(screen.getByLabelText(/^Search$/i), 'SQ *HARBOR');
    await screen.findByText('1 transaction');

    await u.clear(screen.getByLabelText(/^Search$/i));
    await u.type(screen.getByLabelText(/^Search$/i), 'harbor bean coffee');
    await screen.findByText('1 transaction');
  });

  it('filters by category and clears filters again', async () => {
    const u = user();
    renderPage();
    await screen.findByText('3 transactions');

    await u.selectOptions(screen.getByLabelText(/^Category$/i), 'groceries');
    await screen.findByText('1 transaction');

    await u.click(screen.getByRole('button', { name: /clear all filters/i }));
    await screen.findByText('3 transactions');
  });

  it('shows a no-results state rather than an empty table', async () => {
    const u = user();
    renderPage();
    await screen.findByText('3 transactions');

    await u.type(screen.getByLabelText(/^Search$/i), 'ZZZ-NOTHING-MATCHES');
    expect(await screen.findByText(/no transactions match these filters/i)).toBeInTheDocument();
  });

  it('sorts by a column and announces the state', async () => {
    const u = user();
    renderPage();
    await screen.findByText('3 transactions');

    await u.click(grid().getByRole('button', { name: /^Amount/ }));
    const header = grid().getByRole('columnheader', { name: /Amount/ });
    // The sort state is on the header, not conveyed by an icon alone.
    expect(header).toHaveAttribute('aria-sort');
  });
});

describe('editing a transaction', () => {
  beforeEach(async () => {
    await seed(transaction('a'));
  });

  it('persists the change and leaves the source fields alone', async () => {
    const u = user();
    renderPage();
    await screen.findByText('1 transaction');

    await u.click(grid().getAllByRole('button', { name: /^Review/ })[0]!);
    const dialog = await screen.findByRole('dialog');

    await u.selectOptions(within(dialog).getByLabelText(/^Category$/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /save this transaction/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const stored = await db.transactions.get('a');
    expect(stored?.categoryId).toBe('groceries');
    // A manual change is a tier-1 decision.
    expect(stored?.categorySource).toBe('user');
    // Source information is untouched.
    expect(stored?.descriptionRaw).toBe('PINEBROOK MARKET #114');
    expect(stored?.amountCents).toBe(1234);
    expect(stored?.direction).toBe('debit');
    expect(stored?.postedDate).toBe('2026-04-08');
    expect(stored?.fingerprint).toBe('a'.padEnd(64, '0'));
  });

  it('shows the source as facts, with no control to change them', async () => {
    const u = user();
    renderPage();
    await screen.findByText('1 transaction');
    await u.click(grid().getAllByRole('button', { name: /^Review/ })[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/never changed/i)).toBeInTheDocument();
    expect(within(dialog).getByText('PINEBROOK MARKET #114')).toBeInTheDocument();
    // No editable control carries the raw description or the amount.
    expect(within(dialog).queryByLabelText(/description/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/amount/i)).not.toBeInTheDocument();
  });

  it('closes on Escape without saving', async () => {
    const u = user();
    renderPage();
    await screen.findByText('1 transaction');
    await u.click(grid().getAllByRole('button', { name: /^Review/ })[0]!);

    const dialog = await screen.findByRole('dialog');
    await u.selectOptions(within(dialog).getByLabelText(/^Category$/i), 'travel');
    await u.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Escape cancels. It never confirms.
    expect((await db.transactions.get('a'))?.categoryId).toBe('other');
  });

  it('refuses to save an empty merchant and keeps the dialog open', async () => {
    const u = user();
    renderPage();
    await screen.findByText('1 transaction');
    await u.click(grid().getAllByRole('button', { name: /^Review/ })[0]!);

    const dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText(/^Merchant$/i));

    expect(within(dialog).getByText(/merchant name is required/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /save this transaction/i })).toBeDisabled();
    expect((await db.transactions.get('a'))?.merchantNormalized).toBe('PINEBROOK MARKET');
  });

  it('hides the include control for a kind that is never spending', async () => {
    const u = user();
    renderPage();
    await screen.findByText('1 transaction');
    await u.click(grid().getAllByRole('button', { name: /^Review/ })[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/leave this out of spending totals/i)).toBeInTheDocument();

    await u.selectOptions(within(dialog).getByLabelText(/^Kind$/i), 'transfer');

    // §13: no control that pretends to override a contract-level exclusion.
    expect(
      within(dialog).queryByLabelText(/leave this out of spending totals/i),
    ).not.toBeInTheDocument();
    // Distinctive wording: the fallback tells the user what to do instead of
    // offering a control that cannot work.
    expect(within(dialog).getByText(/change the kind above/i)).toBeInTheDocument();
  });
});

describe('this transaction versus a future rule', () => {
  beforeEach(async () => {
    await seed(transaction('a'), transaction('b', { postedDate: '2026-04-09' }));
  });

  it('creates the rule atomically without rewriting the other matching row', async () => {
    const u = user();
    renderPage();
    await screen.findByText('2 transactions');

    await u.click(grid().getAllByRole('button', { name: /^Review/ })[0]!);
    const dialog = await screen.findByRole('dialog');

    await u.selectOptions(within(dialog).getByLabelText(/^Category$/i), 'groceries');
    await u.click(within(dialog).getByLabelText(/also create a rule/i));
    expect(within(dialog).getByText(/future imports only/i)).toBeInTheDocument();

    await u.click(within(dialog).getByRole('button', { name: /save and create rule/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(await db.merchantRules.count()).toBe(1);

    const rows = await db.transactions.toArray();
    const edited = rows.filter((row) => row.categoryId === 'groceries');
    const untouched = rows.filter((row) => row.categoryId === 'other');
    // Exactly one row changed; the rule is for the future.
    expect(edited).toHaveLength(1);
    expect(untouched).toHaveLength(1);
    expect(untouched[0]?.categorySource).toBe('uncategorized');
  });
});

describe('bulk operations', () => {
  beforeEach(async () => {
    await seed(
      transaction('a'),
      transaction('b', { postedDate: '2026-04-09' }),
      transaction('c', { postedDate: '2026-04-10' }),
    );
  });

  it('selects only what is on the page and updates exactly those rows', async () => {
    const u = user();
    renderPage();
    await screen.findByText('3 transactions');

    await u.click(grid().getAllByRole('checkbox', { name: /^Select transaction/ })[0]!);
    await u.click(grid().getAllByRole('checkbox', { name: /^Select transaction/ })[1]!);

    expect(await screen.findByText('2 selected on this page')).toBeInTheDocument();

    await u.selectOptions(screen.getByLabelText(/set category for selected/i), 'dining');
    const confirm = await screen.findByRole('dialog');
    await u.click(within(confirm).getByRole('button', { name: /apply change/i }));

    await waitFor(async () => {
      const changed = (await db.transactions.toArray()).filter(
        (row) => row.categoryId === 'dining',
      );
      expect(changed).toHaveLength(2);
    });

    // The third row was never selected and never touched.
    const untouched = (await db.transactions.toArray()).filter((row) => row.categoryId === 'other');
    expect(untouched).toHaveLength(1);
  });

  it('is one undo unit', async () => {
    const u = user();
    renderPage();
    await screen.findByText('3 transactions');

    await u.click(grid().getByRole('checkbox', { name: /select every transaction on this page/i }));
    await u.selectOptions(screen.getByLabelText(/set category for selected/i), 'dining');
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /apply change/i }),
    );

    const undo = await screen.findByRole('button', { name: /undo last change/i });
    await u.click(undo);

    await waitFor(async () => {
      const reverted = (await db.transactions.toArray()).every((row) => row.categoryId === 'other');
      expect(reverted).toBe(true);
    });
  });

  it('warns that undo does not survive a reload', async () => {
    const u = user();
    renderPage();
    await screen.findByText('3 transactions');

    await u.click(grid().getAllByRole('checkbox', { name: /^Select transaction/ })[0]!);
    await u.selectOptions(screen.getByLabelText(/set category for selected/i), 'dining');
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /apply change/i }),
    );

    expect(await screen.findByText(/until you reload this page/i)).toBeInTheDocument();
  });
});

describe('export', () => {
  beforeEach(async () => {
    await seed(
      transaction('a', { descriptionRaw: '=cmd|calc', merchantNormalized: 'PINEBROOK MARKET' }),
    );
  });

  it('describes the scope, columns, and privacy before downloading', async () => {
    const u = user();
    renderPage();
    await screen.findByText('1 transaction');

    await u.click(screen.getByRole('button', { name: /export csv/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/Posted date, Account, Raw description/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is uploaded/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Excluded transactions are included/i)).toBeInTheDocument();
  });

  it('produces CSV whose hostile cell is neutralized', async () => {
    // The page delegates to the shared builder, so the bytes it would download
    // are the bytes this asserts.
    const csv = buildCleanedCsv({
      transactions: await db.transactions.toArray(),
      accounts: [...ACCOUNTS],
    });

    expect(csv).toContain("'=cmd|calc");
    expect(csv).not.toContain(',=cmd|calc');
  });
});

describe('privacy', () => {
  it('keeps the document title constant regardless of what is searched', async () => {
    const u = user();
    await seed(transaction('a'));
    renderPage();
    await screen.findByText('1 transaction');

    await u.type(screen.getByLabelText(/^Search$/i), 'PINEBROOK');
    await screen.findByText('1 transaction');

    // A merchant name must never reach a browser history entry.
    expect(document.title).not.toMatch(/PINEBROOK/);
  });
});
