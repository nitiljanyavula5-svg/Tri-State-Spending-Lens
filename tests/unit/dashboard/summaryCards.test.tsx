import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SummaryCards } from '../../../src/components/dashboard/SummaryCards';
import { selectDashboard } from '../../../src/calculations';
import type {
  AccountScope,
  DashboardSelection,
  IncomeCompleteness,
  SelectableTransaction,
  StatementRange,
} from '../../../src/calculations';
import {
  ACCOUNTS,
  COVERAGE_TWO_MONTHS,
  income,
  MAY,
  purchase,
  refund,
  resetIds,
} from '../calculations/fixtures';

/**
 * Summary cards, against calculation-contract.md §1 rule 5.
 *
 * Every expectation is asserted against a real `selectDashboard` result built
 * from the approved fixtures, never against a number computed in the test. A
 * test that re-derived the arithmetic would pass even if the card and the
 * selector disagreed, which is the one failure these cards exist to prevent.
 */

function selectionFor(
  transactions: readonly SelectableTransaction[],
  completeness: IncomeCompleteness = 'confirmed-complete',
  coverage: readonly StatementRange[] = COVERAGE_TWO_MONTHS,
): DashboardSelection {
  return selectDashboard({
    transactions,
    filters: { range: MAY },
    incomeCompleteness: completeness,
    coverage,
    accounts: ACCOUNTS as readonly AccountScope[],
    granularity: 'month',
  });
}

function renderCards(selection: DashboardSelection) {
  return render(
    <MemoryRouter>
      <SummaryCards selection={selection} period="2026-05-01 to 2026-05-31" />
    </MemoryRouter>,
  );
}

describe('genuine zero versus unavailable', () => {
  it('shows a measured zero as a real figure', () => {
    resetIds();
    renderCards(selectionFor([]));
    // Net spending of zero is measured, not missing.
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('shows an unmeasured figure as unavailable with a reason, never as zero', () => {
    resetIds();
    renderCards(selectionFor([purchase(1_000, { postedDate: '2026-05-05' })]));
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
    // The same reason on all three income-derived cards, stated on each.
    expect(screen.getAllByText(/No income transactions in this period/i)).toHaveLength(3);
  });

  it('never renders a bare em dash in place of a value', () => {
    resetIds();
    const { container } = renderCards(selectionFor([]));
    expect(container.textContent).not.toMatch(/^\s*—\s*$/m);
  });
});

describe('unavailable reasons are exact', () => {
  it('names unconfirmed completeness distinctly', () => {
    resetIds();
    renderCards(selectionFor([income(500_000, { postedDate: '2026-05-01' })], 'unconfirmed'));
    expect(screen.getAllByText(/Income completeness has not been confirmed yet/i).length).toBe(3);
  });

  it('names confirmed-incomplete income distinctly', () => {
    resetIds();
    renderCards(
      selectionFor([income(500_000, { postedDate: '2026-05-01' })], 'confirmed-incomplete'),
    );
    expect(screen.getAllByText(/You marked imported income as incomplete/i).length).toBe(3);
  });

  it('withholds savings rate at zero income while money in stays measured', () => {
    resetIds();
    renderCards(
      selectionFor([
        income(0, { postedDate: '2026-05-01' }),
        purchase(1_000, { postedDate: '2026-05-05' }),
      ]),
    );
    // Money in is a measured zero; the rate over it has no value to state.
    expect(screen.getAllByText(/No income transactions in this period/i).length).toBeGreaterThan(0);
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });
});

describe('negative results are shown honestly', () => {
  it('renders negative net spending when refunds exceed outflows', () => {
    resetIds();
    const selection = selectionFor([
      purchase(5_000, { postedDate: '2026-05-03', categoryId: 'shopping' }),
      refund(18_000, { postedDate: '2026-05-21', categoryId: 'shopping' }),
    ]);
    renderCards(selection);
    expect(selection.netSpending.netSpendingCents).toBe(-13_000);
    expect(screen.getByText('-$130.00')).toBeInTheDocument();
  });

  it('renders a negative cash flow and a negative savings rate', () => {
    resetIds();
    renderCards(
      selectionFor([
        income(100_000, { postedDate: '2026-05-01' }),
        purchase(250_000, { postedDate: '2026-05-12' }),
      ]),
    );
    expect(screen.getByText('-$1,500.00')).toBeInTheDocument();
    expect(screen.getByText('-150.0%')).toBeInTheDocument();
  });

  it('carries the sign in the text, not only in colour', () => {
    resetIds();
    renderCards(
      selectionFor([
        purchase(1_000, { postedDate: '2026-05-03' }),
        refund(4_000, { postedDate: '2026-05-04' }),
      ]),
    );
    expect(screen.getByText(/^-\$/)).toBeInTheDocument();
  });
});

describe('largest category', () => {
  it('names the selector top entry without recomputing an amount', () => {
    resetIds();
    const selection = selectionFor([
      purchase(2_000, { postedDate: '2026-05-03', categoryId: 'dining' }),
      purchase(9_000, { postedDate: '2026-05-04', categoryId: 'groceries' }),
    ]);
    renderCards(selection);
    const top = selection.byCategory[0];
    expect(top?.key).toBe('groceries');
    expect(screen.getByText(/Groceries — \$90\.00/)).toBeInTheDocument();
  });

  it('is unavailable when nothing was spent', () => {
    resetIds();
    renderCards(selectionFor([]));
    expect(screen.getByText(/No included spending in this period/i)).toBeInTheDocument();
  });
});

describe('transactions analyzed', () => {
  it('reports the whole filtered population, not only included spending', () => {
    resetIds();
    const selection = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02' }),
      refund(200, { postedDate: '2026-05-03' }),
      income(9_000, { postedDate: '2026-05-04' }),
    ]);
    renderCards(selection);

    // The income row contributes to neither side of net spending...
    expect(selection.netSpending.includedTransactionCount).toBe(2);
    // ...but it was read and assigned a treatment, so it was analyzed.
    expect(selection.partition.populationCount).toBe(3);
    expect(screen.getByText('3')).toBeInTheDocument();
    // The narrower count must not be what the card shows.
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it('takes the count from the selector rather than filtering again', () => {
    resetIds();
    const selection = selectionFor([purchase(1_000, { postedDate: '2026-05-02' })]);
    renderCards(selection);
    expect(screen.getByText(String(selection.partition.populationCount))).toBeInTheDocument();
  });
});

describe('review links carry no financial values', () => {
  it('links to the transactions page with no amounts in the href', () => {
    resetIds();
    renderCards(selectionFor([purchase(123_456, { postedDate: '2026-05-02' })]));
    const links = screen.getAllByRole('link', { name: /review transactions/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      expect(href).toBe('/app/transactions');
      expect(href).not.toMatch(/\d{3,}/);
    }
  });
});

describe('period context', () => {
  it('states the period every card describes', () => {
    resetIds();
    renderCards(selectionFor([purchase(1_000, { postedDate: '2026-05-02' })]));
    expect(screen.getAllByText('2026-05-01 to 2026-05-31').length).toBeGreaterThan(0);
  });
});
