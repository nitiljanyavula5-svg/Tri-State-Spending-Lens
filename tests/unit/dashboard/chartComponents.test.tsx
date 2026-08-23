import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetSpendingTrendChart } from '../../../src/components/dashboard/NetSpendingTrendChart';
import { SpendingBreakdownChart } from '../../../src/components/dashboard/SpendingBreakdownChart';
import { MonthComparison } from '../../../src/components/dashboard/MonthComparison';
import { ReconciliationDisclosure } from '../../../src/components/dashboard/ReconciliationDisclosure';
import { buildBreakdownRows, buildTrendRows } from '../../../src/components/dashboard/chartData';
import { selectDashboard } from '../../../src/calculations';
import type {
  AccountScope,
  ComparisonResult,
  DashboardSelection,
  Measured,
  ReconciliationReport,
  SelectableTransaction,
  TimeBucket,
} from '../../../src/calculations';
import { getCategory } from '../../../src/domain/categories';
import {
  ACCOUNTS,
  COVERAGE_TWO_MONTHS,
  MAY,
  purchase,
  refund,
  resetIds,
} from '../calculations/fixtures';

/**
 * The chart regions and their fallback tables.
 *
 * jsdom gives Recharts no layout, so the SVG itself renders little — which is
 * precisely why the *table* is the thing under test here. Every figure a sighted
 * user reads from a bar is asserted in the table built from the same adapter
 * rows, and the equality between the two is asserted directly.
 */

const ACCOUNT_LABELS = new Map([
  ['acct-checking', 'Everyday Checking'],
  ['acct-card', 'Rewards Card'],
  ['acct-savings', 'Rainy Day Savings'],
]);

function selectionFor(
  transactions: readonly SelectableTransaction[],
  granularity: 'day' | 'week' | 'month' = 'month',
): DashboardSelection {
  return selectDashboard({
    transactions,
    filters: { range: MAY },
    incomeCompleteness: 'confirmed-complete',
    coverage: COVERAGE_TWO_MONTHS,
    accounts: ACCOUNTS as readonly AccountScope[],
    granularity,
  });
}

const bucket = (key: string, netCents: number, isComplete: boolean): TimeBucket => ({
  key,
  start: `${key}-01`,
  end: `${key}-28`,
  grossOutflowCents: netCents > 0 ? netCents : 0,
  refundsCents: netCents < 0 ? -netCents : 0,
  netCents,
  transactionCount: 1,
  isComplete,
});

describe('the trend region', () => {
  it('lists every bucket in its table, complete and partial alike', () => {
    render(
      <NetSpendingTrendChart
        buckets={[bucket('2026-04', 10_000, true), bucket('2026-05', 4_000, false)]}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('2026-04')).toBeInTheDocument();
    expect(within(table).getByText('$100.00')).toBeInTheDocument();
    expect(within(table).getByText('2026-05')).toBeInTheDocument();
    expect(within(table).getByText('$40.00')).toBeInTheDocument();
  });

  it('states completeness in words, not colour', () => {
    render(
      <NetSpendingTrendChart
        buckets={[bucket('2026-04', 10_000, true), bucket('2026-05', 4_000, false)]}
      />,
    );
    expect(screen.getByText('Fully covered by statements')).toBeInTheDocument();
    expect(screen.getByText('Not fully covered by statements')).toBeInTheDocument();
  });

  it('says how many buckets are partial in its summary', () => {
    render(
      <NetSpendingTrendChart
        buckets={[bucket('2026-04', 10_000, true), bucket('2026-05', 4_000, false)]}
      />,
    );
    expect(screen.getByText(/1 of them is not fully covered/i)).toBeInTheDocument();
  });

  it('renders negative and zero amounts honestly', () => {
    render(
      <NetSpendingTrendChart
        buckets={[bucket('2026-04', -13_000, true), bucket('2026-05', 0, true)]}
      />,
    );
    expect(screen.getByText('-$130.00')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('is honest about a single bucket rather than drawing a trend', () => {
    render(<NetSpendingTrendChart buckets={[bucket('2026-05', 1_000, true)]} />);
    expect(screen.getByText(/a trend needs more than one period/i)).toBeInTheDocument();
  });

  it('says there is nothing to draw when there are no buckets', () => {
    render(<NetSpendingTrendChart buckets={[]} />);
    expect(screen.getByText(/no periods fall inside the current filters/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('has a captioned table with column headers', () => {
    render(<NetSpendingTrendChart buckets={[bucket('2026-05', 1_000, true)]} />);
    expect(screen.getByRole('columnheader', { name: /period/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /net spending/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /statement coverage/i })).toBeInTheDocument();
  });

  it('shows exactly the adapter rows', () => {
    const buckets = [bucket('2026-04', 10_000, true), bucket('2026-05', -4_000, false)];
    render(<NetSpendingTrendChart buckets={buckets} />);
    for (const row of buildTrendRows(buckets)) {
      expect(screen.getByText(row.label)).toBeInTheDocument();
      expect(screen.getByText(row.amount)).toBeInTheDocument();
      expect(screen.getByText(row.completenessLabel)).toBeInTheDocument();
    }
  });
});

describe('the breakdown region', () => {
  const manyCategories = () => {
    resetIds();
    return selectionFor(
      Array.from({ length: 9 }, (_, i) =>
        purchase(1_000 + i * 10, { postedDate: '2026-05-02', categoryId: `cat-${i}` }),
      ),
    );
  };

  it('switches between category and account without recalculating', async () => {
    resetIds();
    const user = userEvent.setup();
    const selection = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02', accountId: 'acct-checking' }),
      purchase(2_000, { postedDate: '2026-05-03', accountId: 'acct-card' }),
    ]);
    render(<SpendingBreakdownChart selection={selection} accountLabels={ACCOUNT_LABELS} />);

    expect(screen.getByRole('columnheader', { name: 'Category' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Account' }));

    expect(screen.getByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Rewards Card')).toBeInTheDocument();
    expect(within(table).getByText('Everyday Checking')).toBeInTheDocument();
    // The same totals, read from a different selector output.
    expect(within(table).getByText('$20.00')).toBeInTheDocument();
    expect(within(table).getByText('$10.00')).toBeInTheDocument();
  });

  it('shows an Other row that explains what it combines', () => {
    render(<SpendingBreakdownChart selection={manyCategories()} accountLabels={ACCOUNT_LABELS} />);
    expect(screen.getByText(/Other \(3 more\)/)).toBeInTheDocument();
    expect(screen.getByText(/Combines 3 smaller entries/i)).toBeInTheDocument();
  });

  it('shows no Other row when six or fewer entries exist', () => {
    resetIds();
    const selection = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02', categoryId: 'groceries' }),
      purchase(2_000, { postedDate: '2026-05-03', categoryId: 'dining' }),
    ]);
    render(<SpendingBreakdownChart selection={selection} accountLabels={ACCOUNT_LABELS} />);
    expect(screen.queryByText(/Combines \d+ smaller entries/i)).not.toBeInTheDocument();
  });

  it('shows exactly the adapter rows, Other included', () => {
    const selection = manyCategories();
    render(<SpendingBreakdownChart selection={selection} accountLabels={ACCOUNT_LABELS} />);
    const rows = buildBreakdownRows(selection.byCategory, (key) => getCategory(key)?.label ?? key);
    const table = screen.getByRole('table');
    for (const row of rows) {
      expect(within(table).getByText(row.label)).toBeInTheDocument();
      expect(within(table).getByText(row.amount)).toBeInTheDocument();
    }
  });

  it('renders a negative net for a refund-heavy category', () => {
    resetIds();
    const selection = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02', categoryId: 'groceries' }),
      refund(4_000, { postedDate: '2026-05-20', categoryId: 'shopping' }),
    ]);
    render(<SpendingBreakdownChart selection={selection} accountLabels={ACCOUNT_LABELS} />);
    expect(screen.getByText('-$40.00')).toBeInTheDocument();
  });

  it('keeps a long account label readable rather than truncating the value', async () => {
    resetIds();
    const user = userEvent.setup();
    const labels = new Map([
      ['acct-checking', 'Everyday Checking Account At A Bank With A Very Long Name Indeed'],
    ]);
    const selection = selectionFor([
      purchase(1_000, { postedDate: '2026-05-02', accountId: 'acct-checking' }),
    ]);
    render(<SpendingBreakdownChart selection={selection} accountLabels={labels} />);
    await user.click(screen.getByRole('radio', { name: 'Account' }));
    expect(
      screen.getByText('Everyday Checking Account At A Bank With A Very Long Name Indeed'),
    ).toBeInTheDocument();
  });

  it('says there is nothing to break down when nothing was spent', () => {
    resetIds();
    render(<SpendingBreakdownChart selection={selectionFor([])} accountLabels={ACCOUNT_LABELS} />);
    expect(screen.getByText(/nothing to break down/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('labels its dimension switch as a group', () => {
    resetIds();
    render(
      <SpendingBreakdownChart
        selection={selectionFor([purchase(1_000, { postedDate: '2026-05-02' })])}
        accountLabels={ACCOUNT_LABELS}
      />,
    );
    expect(screen.getByRole('group', { name: /break down by/i })).toBeInTheDocument();
  });
});

describe('the month comparison', () => {
  const available = (overrides: Partial<ComparisonResult> = {}): Measured<ComparisonResult> => ({
    available: true,
    value: {
      currentMonth: '2026-05',
      priorMonth: '2026-04',
      currentNetCents: 15_000,
      priorNetCents: 10_000,
      deltaCents: 5_000,
      deltaRatio: { available: true, value: 0.5 },
      ...overrides,
    },
  });

  it('shows both months, the delta, and the ratio from the selector', () => {
    render(<MonthComparison comparison={available()} />);
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('uses neutral wording rather than praise or blame', () => {
    render(<MonthComparison comparison={available()} />);
    const text = screen.getByText(/net spending in 2026-05 was/i).textContent ?? '';
    expect(text).toMatch(/higher than/);
    expect(text).not.toMatch(/good|bad|worse|better|well done|overspent/i);
  });

  it('says lower when spending fell', () => {
    render(
      <MonthComparison comparison={available({ currentNetCents: 5_000, deltaCents: -5_000 })} />,
    );
    expect(screen.getByText(/was lower than/i)).toBeInTheDocument();
    expect(screen.getByText('-$50.00')).toBeInTheDocument();
  });

  it('withholds the percentage when the prior month was zero', () => {
    render(
      <MonthComparison
        comparison={available({
          priorNetCents: 0,
          deltaRatio: { available: false, reason: 'not-applicable' },
        })}
      />,
    );
    expect(screen.getByText(/no percentage: the previous month was zero/i)).toBeInTheDocument();
  });

  it.each([
    ['period-not-complete-month', /select a single whole calendar month/i],
    ['partial-month', /not fully covered by imported statements/i],
    ['prior-month-incomplete', /the month before this one is not fully covered/i],
    ['insufficient-history', /fewer than two complete months/i],
  ] as const)('explains the %s reason exactly', (reason, copy) => {
    render(<MonthComparison comparison={{ available: false, reason }} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    // Never a zero standing in for an unavailable comparison.
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});

describe('the reconciliation disclosure', () => {
  const passing: ReconciliationReport = {
    holds: true,
    checks: [
      { name: 'category totals equal net spending', holds: true, expected: 100, actual: 100 },
      { name: 'account totals equal net spending', holds: true, expected: 100, actual: 100 },
    ],
    failures: [],
  };

  const failing: ReconciliationReport = {
    holds: false,
    checks: [
      { name: 'category totals equal net spending', holds: false, expected: 100, actual: 101 },
      { name: 'account totals equal net spending', holds: true, expected: 100, actual: 100 },
    ],
    failures: [
      { name: 'category totals equal net spending', holds: false, expected: 100, actual: 101 },
    ],
  };

  it('states that totals reconcile when every check holds', () => {
    render(<ReconciliationDisclosure report={passing} />);
    expect(screen.getByText(/^Totals reconcile\. All 2 checks pass/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not reconcile/i)).not.toBeInTheDocument();
  });

  it('raises a caution and does not claim reconciliation when a check fails', () => {
    render(<ReconciliationDisclosure report={failing} />);
    expect(screen.getByText(/these totals do not reconcile/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Totals reconcile/i)).not.toBeInTheDocument();
  });

  it('lists every check with a text status, not only a colour', () => {
    render(<ReconciliationDisclosure report={failing} />);
    expect(screen.getByText('Does not hold')).toBeInTheDocument();
    expect(screen.getByText('Passes')).toBeInTheDocument();
  });

  it('shows the compared aggregates without exposing records', () => {
    render(<ReconciliationDisclosure report={failing} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('101')).toBeInTheDocument();
    // Aggregates only: no merchant, no transaction id.
    expect(within(table).queryByText(/PINEBROOK|txn-|fingerprint/i)).not.toBeInTheDocument();
  });
});

/**
 * Regression: the tables that replace the charts must be scrollable by keyboard.
 *
 * Each sits in an `overflow-x: auto` box and carries a `min-width`, so on a
 * narrow screen the box genuinely scrolls. A scrolling box with no tab stop
 * cannot be reached at all without a pointer — axe reports it as
 * `scrollable-region-focusable`, and it matters more here than elsewhere,
 * because these tables *are* the accessible alternative to a chart.
 *
 * It went unseen because three things have to coincide: the table rendered, its
 * disclosure open, and a viewport narrow enough for the content to overflow. The
 * trend disclosure opens by default only for a single bucket — which is what
 * selecting one complete month produces, a state no browser fixture could reach
 * until statement coverage existed in one.
 */
describe('the scroll regions around the fallback tables', () => {
  const named = (name: RegExp) => screen.getByRole('region', { name });

  it('makes the trend table a focusable region named by its caption', () => {
    render(<NetSpendingTrendChart buckets={[bucket('2026-05', 1_000, true)]} />);
    const region = named(/net spending for each period in the selected range/i);
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toBeInTheDocument();
  });

  it('makes the breakdown table a focusable region named by its caption', () => {
    resetIds();
    render(
      <SpendingBreakdownChart
        selection={selectionFor([purchase(1_000, { categoryId: 'groceries' })])}
        accountLabels={ACCOUNT_LABELS}
      />,
    );
    const region = named(/net spending by category, largest first/i);
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toBeInTheDocument();
  });

  it('makes the reconciliation table a focusable region named by its caption', () => {
    render(<ReconciliationDisclosure report={passingReport()} />);
    const region = named(/each invariant, whether it holds/i);
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toBeInTheDocument();
  });
});

function passingReport(): ReconciliationReport {
  return {
    holds: true,
    checks: [{ name: 'category totals equal net spending', holds: true, expected: 1, actual: 1 }],
    failures: [],
  };
}

/**
 * Regression: below 360px the table has to be *shown*, not merely offered.
 *
 * The chart disappears there in CSS because a chart that narrow is unreadable,
 * which leaves the exact table as the only presentation of the figures. It was
 * still inside a collapsed disclosure, so at 320px the page showed a heading, a
 * sentence, and nothing else — the picture hidden as illegible and the numbers
 * hidden behind a control.
 *
 * The breakpoint is asserted through behaviour rather than by reading a class:
 * a stubbed `matchMedia` reports the narrow viewport, and the disclosure must
 * come up open.
 */
describe('chart-to-table substitution below 360px', () => {
  function withViewport<T>(narrow: boolean, body: () => T): T {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: narrow && query.includes('max-width'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      return body();
    } finally {
      window.matchMedia = real;
    }
  }

  const twoBuckets = () => [bucket('2026-04', 10_000, true), bucket('2026-05', 4_000, true)];

  const breakdown = () => {
    resetIds();
    return selectionFor([
      purchase(9_000, { categoryId: 'groceries' }),
      purchase(3_000, { categoryId: 'dining' }),
    ]);
  };

  it('opens the trend table when the chart cannot be drawn', () => {
    const { container } = withViewport(true, () =>
      render(<NetSpendingTrendChart buckets={twoBuckets()} />),
    );
    expect(container.querySelector('details')).toHaveAttribute('open');
  });

  it('opens the breakdown table when the chart cannot be drawn', () => {
    const { container } = withViewport(true, () =>
      render(<SpendingBreakdownChart selection={breakdown()} accountLabels={ACCOUNT_LABELS} />),
    );
    expect(container.querySelector('details')).toHaveAttribute('open');
  });

  it('leaves both tables collapsed once the chart is drawable', () => {
    const trend = withViewport(false, () =>
      render(<NetSpendingTrendChart buckets={twoBuckets()} />),
    );
    expect(trend.container.querySelector('details')).not.toHaveAttribute('open');

    const bars = withViewport(false, () =>
      render(<SpendingBreakdownChart selection={breakdown()} accountLabels={ACCOUNT_LABELS} />),
    );
    expect(bars.container.querySelector('details')).not.toHaveAttribute('open');
  });

  it('still opens the trend table for a single period at any width', () => {
    // A lone period is not a trend, so the table leads there regardless.
    const { container } = withViewport(false, () =>
      render(<NetSpendingTrendChart buckets={[bucket('2026-05', 1_000, true)]} />),
    );
    expect(container.querySelector('details')).toHaveAttribute('open');
  });
});
