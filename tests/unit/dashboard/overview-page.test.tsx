import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { OverviewPage } from '../../../src/pages/app/OverviewPage';
import { putAccounts } from '../../../src/db/repositories/accounts';
import { commitImportSession, listTransactions } from '../../../src/db/repositories/transactions';

/**
 * The repository is the seam for the failure case.
 *
 * Spying on Dexie's own `toArray` disturbs `liveQuery`'s read tracking, so the
 * failure is injected one layer up — where the hook actually calls — leaving the
 * database itself behaving normally.
 */
vi.mock('../../../src/db/repositories/transactions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/repositories/transactions')>();
  return { ...actual, listTransactions: vi.fn(actual.listTransactions) };
});

/** The genuine implementation, restored before every test so only one test fails. */
const realRepository = await vi.importActual<
  typeof import('../../../src/db/repositories/transactions')
>('../../../src/db/repositories/transactions');
import { setSetting, SETTING_KEYS } from '../../../src/db/repositories/settings';
import type { Account, ImportSession, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderWithProviders } from '../helpers/renderApp';

/**
 * The Overview page end to end, against a real database.
 *
 * The question each test answers is whether what the page *shows* matches what
 * the selector *computed* — a page that rendered its own totals would still look
 * right here, so the assertions target the states where the two could diverge:
 * unavailable figures, negative results, and coverage warnings.
 */

let db: WorkspaceDatabase;

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

const seedBoth = async () => {
  await putAccounts(db, ACCOUNTS);
  await commitImportSession(db, session('session-1'), [txn('t1')]);
  await commitImportSession(db, session('session-2', { accountIds: ['card'] }), [
    txn('t2', { accountId: 'card', importSessionId: 'session-2', amountCents: 5_000 }),
  ]);
};

const render = () => renderWithProviders(<OverviewPage />, db);

/**
 * Scoped to the summary cards.
 *
 * A figure now appears in its card *and* in the chart fallback table below —
 * which is the point, since both read the same selector output. Scoping keeps
 * these assertions about the card specifically rather than about the page
 * happening to contain the string somewhere.
 */
const summaryRegion = () => within(screen.getByRole('region', { name: 'Summary' }));
const summaryText = (text: string) => summaryRegion().getByText(text);
const summaryQuery = (text: string) => summaryRegion().queryByText(text);

beforeEach(async () => {
  vi.mocked(listTransactions).mockImplementation(realRepository.listTransactions);
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

describe('page states', () => {
  it('shows a loading state, and no figures, before the workspace resolves', () => {
    // Rendered without a database, which is the deterministic loading case: the
    // provider has nothing to open yet.
    renderWithProviders(<OverviewPage />);
    // Announced to a screen reader and shown visually, so both are present.
    expect(screen.getAllByText(/loading your workspace/i)).toHaveLength(2);
    // Crucially, no zeroed stand-in while waiting.
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('reserves the card region while loading so arriving data does not shove the page', () => {
    const { container } = renderWithProviders(<OverviewPage />);
    expect(container.querySelector('.min-h-40')).not.toBeNull();
  });

  it('shows an empty workspace without inventing a date range or a zero', async () => {
    render();
    await waitFor(() =>
      expect(screen.getByText(/no transactions in this workspace yet/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/no date range is assumed and no total is invented/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  });

  it('renders the populated dashboard', async () => {
    await seedBoth();
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    // 12_345 + 5_000 across the whole domain.
    expect(summaryText('$173.45')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
  });

  it('explains a filter combination that matches nothing', async () => {
    await seedBoth();
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: /travel/i }));

    await waitFor(() =>
      expect(screen.getByText(/no transactions match these filters/i)).toBeInTheDocument(),
    );
    // No fabricated zero card in place of the figures.
    expect(screen.queryByText('Net spending')).not.toBeInTheDocument();
  });

  it('sanitizes a read failure without exposing a database message', async () => {
    await seedBoth();
    // A genuine mid-read rejection. Closing the database instead would only look
    // like "not ready yet", which is a different state with a different meaning.
    vi.mocked(listTransactions).mockRejectedValue(
      new Error('IndexedDB: NotReadableError on object store transactions'),
    );
    render();
    // Titled callout plus its sanitized body.
    await waitFor(() =>
      expect(screen.getAllByText(/this workspace could not be read/i).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/No figures are shown/i)).toBeInTheDocument();
    // The underlying message never reaches the page.
    expect(screen.queryByText(/indexeddb|notreadable|object store/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  });
});

describe('measured versus unavailable', () => {
  it('hides income figures while completeness is unconfirmed', async () => {
    await seedBoth();
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    // The same reason on money in, net cash flow, and savings rate...
    expect(screen.getAllByText(/Income completeness has not been confirmed yet/i).length).toBe(3);
    // ...and the matching warning above the cards, so the caveat is read first.
    const region = screen.getByRole('region', { name: /before you read these figures/i });
    expect(
      within(region).getByText(/Income completeness has not been confirmed/i),
    ).toBeInTheDocument();
  });

  it('reports money in once completeness is confirmed', async () => {
    await putAccounts(db, ACCOUNTS);
    await setSetting(db, SETTING_KEYS.incomeDataComplete, true);
    await commitImportSession(db, session('session-1'), [
      txn('t1'),
      txn('t2', { kind: 'income', direction: 'credit', amountCents: 500_000 }),
    ]);
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    expect(screen.getByText('$5,000.00')).toBeInTheDocument();
  });

  it('shows negative net spending when refunds exceed outflows', async () => {
    await putAccounts(db, [ACCOUNTS[0] as Account]);
    await commitImportSession(db, session('session-1'), [
      txn('t1', { amountCents: 1_000 }),
      txn('t2', { kind: 'refund', direction: 'credit', amountCents: 4_000 }),
    ]);
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    expect(summaryText('-$30.00')).toBeInTheDocument();
  });
});

describe('data-quality warnings', () => {
  it('warns that the period is not fully covered, naming the account', async () => {
    await putAccounts(db, ACCOUNTS);
    // Only checking has a statement; the card is in scope and has none.
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    await commitImportSession(
      db,
      session('session-2', {
        accountIds: ['card'],
        statementRangeStart: undefined,
        statementRangeEnd: undefined,
      }),
      [txn('t2', { accountId: 'card', importSessionId: 'session-2' })],
    );
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    const region = screen.getByRole('region', { name: /before you read these figures/i });
    expect(within(region).getByText(/Rewards Card/)).toBeInTheDocument();
  });

  it('labels an ambiguous multi-account statement as a workspace limitation', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1', { accountIds: ['checking', 'card'] }), [
      txn('t1'),
      txn('t2', { accountId: 'card' }),
    ]);
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    expect(screen.getByText(/Workspace import coverage/i)).toBeInTheDocument();
    expect(
      screen.getByText(/applies to the whole workspace rather than to the current filters/i),
    ).toBeInTheDocument();
  });
});

describe('filters reconcile with the selector', () => {
  it('narrows the figures by account', async () => {
    await seedBoth();
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(summaryText('$173.45')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: /rewards card/i }));

    await waitFor(() => expect(summaryText('$50.00')).toBeInTheDocument());
    expect(summaryQuery('$173.45')).not.toBeInTheDocument();
  });

  it('offers a removable chip per active filter and a working reset', async () => {
    await seedBoth();
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: /rewards card/i }));
    await waitFor(() => expect(summaryText('$50.00')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /remove filter/i }));
    await waitFor(() => expect(summaryText('$173.45')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: /rewards card/i }));
    await waitFor(() => expect(summaryText('$50.00')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /reset all/i }));
    await waitFor(() => expect(summaryText('$173.45')).toBeInTheDocument());
  });

  it('disables Latest complete month when no month is complete', async () => {
    await putAccounts(db, [ACCOUNTS[0] as Account]);
    await commitImportSession(
      db,
      session('session-1', { statementRangeStart: undefined, statementRangeEnd: undefined }),
      [txn('t1')],
    );
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: /latest complete month/i })).toBeDisabled();
  });

  it('validates a reversed custom range without swapping the dates', async () => {
    await seedBoth();
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());

    await user.click(screen.getByRole('radio', { name: /^custom/i }));
    const start = await screen.findByLabelText(/start date/i);
    const end = screen.getByLabelText(/end date/i);
    await user.type(start, '2026-05-31');
    await user.type(end, '2026-05-01');

    await waitFor(() =>
      expect(screen.getByText(/start date is after the end date/i)).toBeInTheDocument(),
    );
    expect(start).toHaveValue('2026-05-31');
    expect(end).toHaveValue('2026-05-01');
  });
});

describe('privacy', () => {
  it('keeps the document title free of period and account details', async () => {
    await seedBoth();
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    await user.click(screen.getByRole('checkbox', { name: /rewards card/i }));
    await waitFor(() => expect(summaryText('$50.00')).toBeInTheDocument());

    expect(document.title).toMatch(/Overview/);
    expect(document.title).not.toMatch(/Rewards Card|2026|\$/);
  });

  it('writes no filter state to storage', async () => {
    await seedBoth();
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(screen.getByText('Summary')).toBeInTheDocument());
    await user.click(screen.getByRole('checkbox', { name: /rewards card/i }));
    await waitFor(() => expect(summaryText('$50.00')).toBeInTheDocument());

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
