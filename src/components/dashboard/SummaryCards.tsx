import { Link } from 'react-router';
import type { Cents, DashboardSelection, Measured } from '../../calculations';
import { getCategory } from '../../domain/categories';
import { cn } from '../../lib/cn';
import { formatCount, formatCurrency, formatRatio, unavailableCopy } from './format';

/**
 * The Overview summary cards.
 *
 * Every figure comes from one `DashboardSelection`. No card filters
 * transactions, sums an amount, or divides anything — calculation-contract.md §1
 * rule 1 makes a component that computes its own total a defect, and the only
 * arithmetic here is the cents-to-dollars division inside the formatter.
 *
 * Budget Remaining arrived in Phase 6A and reads `budgetRemaining`, which the
 * dashboard boundary took from the canonical budget selector — this file does
 * not know what a limit is, only how to print one. Possible Recurring Monthly
 * Cost is still absent: recurring detection is Phase 6B, and a card showing it
 * as zero would be exactly the fabricated result §1 rule 5 forbids.
 */

interface CardShellProps {
  readonly label: string;
  readonly value: string | null;
  readonly unavailableNote: string | null;
  readonly note: string;
  readonly period: string;
  readonly to?: string;
  readonly linkLabel?: string;
  readonly negative?: boolean;
}

function CardShell({
  label,
  value,
  unavailableNote,
  note,
  period,
  to,
  linkLabel,
  negative,
}: CardShellProps) {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</p>

      {value === null ? (
        <p className="mt-2 text-sm font-medium leading-relaxed text-ink-soft">
          {/* Not shown, and why — never 0, 0%, blank, or a bare dash. */}
          Not available
        </p>
      ) : (
        <p
          className={cn(
            'money mt-2 break-words text-2xl font-semibold',
            negative ? 'text-pa' : 'text-ink',
          )}
        >
          {/* A leading minus carries the meaning; colour only reinforces it. */}
          {value}
        </p>
      )}

      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{unavailableNote ?? note}</p>
      <p className="mt-1 text-xs text-ink-muted">{period}</p>

      {to ? (
        <Link
          to={to}
          className="mt-3 self-start rounded-control text-xs font-medium text-ny underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {linkLabel ?? 'Review transactions'}
        </Link>
      ) : null}
    </div>
  );
}

interface SummaryCardsProps {
  readonly selection: DashboardSelection;
  readonly period: string;
  /** From the budget selector, never recomputed here (§1 rule 1). */
  readonly budgetRemaining: Measured<Cents>;
}

/** Reads a `Measured` without letting an unavailable value become a number. */
function measured<T>(value: Measured<T>): { value: T | null; note: string | null } {
  return value.available
    ? { value: value.value, note: null }
    : { value: null, note: unavailableCopy(value.reason) };
}

export function SummaryCards({ selection, period, budgetRemaining }: SummaryCardsProps) {
  const { netSpending, cashFlow, byCategory } = selection;

  const moneyIn = measured(cashFlow.moneyInCents);
  const netCashFlow = measured(cashFlow.netCashFlowCents);
  const savingsRate = measured(cashFlow.savingsRate);

  // The first canonical breakdown entry. The selector already sorted by net
  // descending with a documented tie-break; picking `[0]` is a read, not a
  // calculation.
  const budget = measured(budgetRemaining);
  const largest = byCategory[0];
  const largestLabel = largest ? (getCategory(largest.key)?.label ?? largest.key) : null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <CardShell
        label="Net spending"
        value={formatCurrency(netSpending.netSpendingCents)}
        unavailableNote={null}
        note="Purchases, fees, and cash out, minus refunds. A negative figure means refunds exceeded outflows."
        period={period}
        negative={netSpending.netSpendingCents < 0}
        to="/app/transactions"
      />

      <CardShell
        label="Money in"
        value={moneyIn.value === null ? null : formatCurrency(moneyIn.value)}
        unavailableNote={moneyIn.note}
        note="Income only. Refunds and transfers are not income."
        period={period}
        to="/app/transactions"
      />

      <CardShell
        label="Net cash flow"
        value={netCashFlow.value === null ? null : formatCurrency(netCashFlow.value)}
        unavailableNote={netCashFlow.note}
        note="Money in, minus net spending."
        period={period}
        negative={netCashFlow.value !== null && netCashFlow.value < 0}
        to="/app/transactions"
      />

      <CardShell
        label="Savings rate"
        value={savingsRate.value === null ? null : formatRatio(savingsRate.value)}
        unavailableNote={savingsRate.note}
        note="Net cash flow as a share of money in. A negative rate is a real result."
        period={period}
        negative={savingsRate.value !== null && savingsRate.value < 0}
      />

      <CardShell
        label="Largest spending category"
        value={
          largest && largestLabel ? `${largestLabel} — ${formatCurrency(largest.netCents)}` : null
        }
        unavailableNote={largest ? null : 'No included spending in this period.'}
        note="The category with the greatest net spending."
        period={period}
        negative={Boolean(largest && largest.netCents < 0)}
        to="/app/transactions"
      />

      <CardShell
        label="Budget remaining"
        value={budget.value === null ? null : formatCurrency(budget.value)}
        unavailableNote={budget.note}
        note="Your monthly limit, minus net spending for that month. A negative figure means you are over the plan."
        period={period}
        negative={budget.value !== null && budget.value < 0}
        to="/app/budget"
        linkLabel="Open the budget"
      />

      <CardShell
        label="Transactions analyzed"
        // The whole filtered population, not only the rows that moved a total.
        // A transfer, a card payment, a row you excluded, and a row awaiting
        // review were all read and assigned a treatment — they were analyzed.
        // `includedTransactionCount` answers a narrower question and belongs to
        // reconciliation, where it ties the breakdowns to net spending.
        value={formatCount(selection.partition.populationCount)}
        unavailableNote={null}
        note="Every transaction matching these filters, including transfers, card payments, excluded rows, and rows awaiting review."
        period={period}
        to="/app/transactions"
      />
    </div>
  );
}
