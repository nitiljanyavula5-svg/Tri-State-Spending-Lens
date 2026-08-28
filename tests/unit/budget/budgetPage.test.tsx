import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { putAccounts } from '../../../src/db/repositories/accounts';
import { commitImportSession } from '../../../src/db/repositories/transactions';
import { saveValidatedBudgetPlan } from '../../../src/db/repositories/budgets';
import { BudgetPage } from '../../../src/pages/app/BudgetPage';
import { SummaryCards } from '../../../src/components/dashboard/SummaryCards';
import { selectDashboard, type DashboardSelection } from '../../../src/calculations';
import type { Account, ImportSession, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderWithProviders } from '../helpers/renderApp';

/**
 * The budget page and the Overview card that reads the same selector.
 *
 * Rendered against a real database, because the page's whole contract is that a
 * write shows up without a reload. The assertions concentrate on the two things
 * a screenshot cannot check: that an unavailable figure names its reason instead
 * of showing a zero, and that the progress semantics announce the exact numbers
 * rather than the clamped bar width.
 */

let db: WorkspaceDatabase;

const MAY = '2026-05';

const ACCOUNTS: Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
];

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

const seed = async () => {
  await putAccounts(db, ACCOUNTS);
  await commitImportSession(db, session, [txn('t1')]);
};

/**
 * Renders the page and moves it to the fixture month.
 *
 * The page defaults to the real current month, which is correct behaviour and
 * exactly why the fixtures cannot rely on it: a suite pinned to whatever month
 * it happens to run in would pass today and fail in September. Driving the
 * month control instead exercises the navigation the user would use.
 */
async function renderAtMay() {
  const result = renderWithProviders(<BudgetPage />, db);
  const input = await screen.findByLabelText(/budget month/i);
  fireEvent.change(input, { target: { value: MAY } });
  await waitFor(() => expect(screen.getByText(/Showing 2026-05./)).toBeInTheDocument());
  return result;
}

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

describe('the budget page', () => {
  it('shows the empty state for a workspace with nothing in it', async () => {
    renderWithProviders(<BudgetPage />, db);
    expect(
      await screen.findByRole('heading', { name: /no transactions in this workspace yet/i }),
    ).toBeInTheDocument();
    // No fabricated figures beside an empty workspace.
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });

  it('offers a plan editor and says no plan exists yet', async () => {
    await seed();
    await renderAtMay();

    expect(
      await screen.findByRole('heading', { name: /plan for this month/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no plan for this month yet/i)).toBeInTheDocument();
    // Spending is still shown, so the user can plan against what happened.
    expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
  });

  it('names the reason a plan-dependent figure is missing, never a zero', async () => {
    await seed();
    await renderAtMay();
    await screen.findByRole('heading', { name: /this month against the plan/i });

    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no budget plan exists for this month yet/i).length).toBeGreaterThan(
      0,
    );
  });

  it('saves a typed plan and shows the progress it produces', async () => {
    await seed();
    const user = userEvent.setup();
    await renderAtMay();
    await screen.findByRole('heading', { name: /plan for this month/i });

    await user.type(screen.getByLabelText(/monthly spending limit/i), '500');
    await user.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(screen.getByText('Plan saved.')).toBeInTheDocument());
    // $500.00 limit, $200.00 spent, $300.00 left.
    expect(await screen.findByText(/\$300\.00 left/)).toBeInTheDocument();
  });

  it('reports a bad amount inline and does not save it', async () => {
    await seed();
    const user = userEvent.setup();
    await renderAtMay();
    await screen.findByRole('heading', { name: /plan for this month/i });

    await user.type(screen.getByLabelText(/monthly spending limit/i), '10.005');
    expect(await screen.findByText(/at most two decimal places/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save plan/i }));
    await waitFor(() => expect(screen.getByText(/monthly spending limit:/i)).toBeInTheDocument());
    expect(await db.budgetPlans.count()).toBe(0);
  });

  it('announces exact figures on the progress bar, not the clamped width', async () => {
    await seed();
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 10_000, rolloverEnabled: false },
      [],
    );
    await renderAtMay();

    const bar = await screen.findByRole('progressbar', {
      name: /overall spending against the monthly limit/i,
    });
    // Spent $200.00 of a $100.00 limit: 200% used, bar pinned at 100.
    expect(bar).toHaveAttribute('aria-valuetext', '$200.00 of $100.00. 200.0% used.');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('claims no numeric progress value for a zero-dollar limit', async () => {
    await seed();
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 0, rolloverEnabled: false },
      [],
    );
    await renderAtMay();

    const bar = await screen.findByRole('progressbar', {
      name: /overall spending against the monthly limit/i,
    });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    // The exact announced string, not a loose match: this is what a screen
    // reader says, and it previously ended "zero.." because the fragment and
    // the sentence that interpolates it both supplied a period.
    expect(bar).toHaveAttribute(
      'aria-valuetext',
      '$200.00 of $0.00. No percentage: the limit is zero.',
    );
    expect(bar.getAttribute('aria-valuetext')).not.toMatch(/\.\./);
    // Neither NaN nor Infinity may reach the page for a zero denominator.
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('keeps a targeted category with no spending visible', async () => {
    await seed();
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 100_000, rolloverEnabled: false },
      [{ id: 'th', budgetPlanId: 'plan-may', categoryId: 'health', limitCents: 4_000 }],
    );
    await renderAtMay();

    const table = await screen.findByRole('table');
    const row = within(table)
      .getByRole('rowheader', { name: /health/i })
      .closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('$0.00')).toBeInTheDocument();
  });

  it('requires an explicit confirmation before deleting a plan', async () => {
    await seed();
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 50_000, rolloverEnabled: false },
      [],
    );
    const user = userEvent.setup();
    await renderAtMay();

    await user.click(await screen.findByRole('button', { name: /^delete plan$/i }));
    expect(screen.getByText(/delete this month’s plan\?/i)).toBeInTheDocument();
    // Still stored while the question is open.
    expect(await db.budgetPlans.count()).toBe(1);

    await user.click(screen.getByRole('button', { name: /keep plan/i }));
    expect(await db.budgetPlans.count()).toBe(1);
  });

  it('is operable by keyboard through the month controls', async () => {
    await seed();
    const user = userEvent.setup();
    await renderAtMay();

    const previous = await screen.findByRole('button', { name: /previous month/i });
    previous.focus();
    expect(previous).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText(/Showing 2026-04\./)).toBeInTheDocument());
  });

  it('puts no amount or month in the document title', async () => {
    await seed();
    await saveValidatedBudgetPlan(
      db,
      { id: 'plan-may', month: MAY, overallLimitCents: 50_000, rolloverEnabled: false },
      [],
    );
    await renderAtMay();
    await screen.findByRole('heading', { name: /this month against the plan/i });

    expect(document.title).not.toMatch(/\$|\d{4}-\d{2}|500/);
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toMatch(/500|2026-05|groceries/i);
  });
});

describe('the Overview Budget Remaining card', () => {
  const period = '2026-05-01 to 2026-05-31';

  function selection(): DashboardSelection {
    return selectDashboard({
      transactions: [
        {
          id: 't1',
          accountId: 'checking',
          postedDate: '2026-05-08',
          amountCents: 20_000,
          direction: 'debit',
          kind: 'purchase',
          categoryId: 'groceries',
          merchantNormalized: 'PINEBROOK MARKET',
          excludedFromSpending: false,
        },
      ],
      filters: { range: { start: '2026-05-01', end: '2026-05-31' } },
      incomeCompleteness: 'confirmed-complete',
      coverage: [{ start: '2026-05-01', end: '2026-05-31', accountIds: ['checking'] }],
      accounts: [{ id: 'checking', archived: false }],
      granularity: 'month',
    });
  }

  const renderCard = (budgetRemaining: Parameters<typeof SummaryCards>[0]['budgetRemaining']) =>
    render(
      <MemoryRouter>
        <SummaryCards selection={selection()} period={period} budgetRemaining={budgetRemaining} />
      </MemoryRouter>,
    );

  it('shows the remaining amount for a budgeted month', () => {
    renderCard({ available: true, value: 30_000 });
    expect(screen.getByText('Budget remaining')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
  });

  it('shows a negative remaining with its sign rather than clamping', () => {
    renderCard({ available: true, value: -12_500 });
    expect(screen.getByText('-$125.00')).toBeInTheDocument();
  });

  it('explains a non-monthly selection instead of showing zero', () => {
    renderCard({ available: false, reason: 'budget-period-not-one-month' });
    expect(screen.getByText(/budget remaining covers one calendar month/i)).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('uses the reserved reason when a month has a plan but no limit', () => {
    renderCard({ available: false, reason: 'no-budget-limit-set' });
    expect(screen.getByText(/no budget limit is set for this month/i)).toBeInTheDocument();
  });

  it('links to the budget page with nothing personal in the href', () => {
    renderCard({ available: true, value: 30_000 });
    const link = screen.getByRole('link', { name: /open the budget/i });
    expect(link).toHaveAttribute('href', '/app/budget');
  });

  it('keeps the Phase 5 cards intact alongside it', () => {
    renderCard({ available: false, reason: 'no-budget-plan' });
    for (const label of [
      'Net spending',
      'Money in',
      'Net cash flow',
      'Savings rate',
      'Largest spending category',
      'Transactions analyzed',
      'Budget remaining',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
