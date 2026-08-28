import { useId } from 'react';
import type { BudgetApi } from '../../review/useBudget';
import { isIsoMonth } from '../../calculations';
import { Button } from '../ui/Button';

/**
 * Month selection.
 *
 * A `YYYY-MM` string is moved with the calculation layer's own `previousMonth`
 * and `nextMonth`, and the native control is `type="month"`, whose value is
 * already `YYYY-MM`. Nothing here constructs a `Date`: calculation-contract.md
 * §14.9 forbids treating a stored calendar string as an instant, and
 * `new Date('2026-03')` is exactly that mistake — it lands on UTC midnight and
 * reads as February in any negative-offset timezone.
 */

interface BudgetMonthNavProps {
  readonly budget: BudgetApi;
}

const POSITION_LABEL = {
  past: 'A month that has finished.',
  current: 'The current month.',
  future: 'A month that has not started yet.',
} as const;

export function BudgetMonthNav({ budget }: BudgetMonthNavProps) {
  const inputId = useId();

  return (
    <section aria-labelledby="budget-month-title" className="mt-8">
      <h2 id="budget-month-title" className="text-lg font-semibold tracking-tight text-ink">
        Month
      </h2>

      <div className="mt-4 rounded-card border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={budget.goToPreviousMonth}>
            Previous month
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={budget.goToNextMonth}>
            Next month
          </Button>

          <div className="min-w-0">
            <label htmlFor={inputId} className="block text-xs font-medium text-ink-muted">
              Budget month
            </label>
            <input
              id={inputId}
              type="month"
              value={budget.month}
              onChange={(event) => {
                const next = event.target.value;
                // An empty or half-typed value from the native control is
                // ignored rather than coerced into some nearby month.
                if (isIsoMonth(next)) budget.setMonth(next);
              }}
              className="mt-1 min-h-9 rounded-control border border-line-strong bg-canvas px-2 py-1 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
            />
          </div>
        </div>

        <p className="mt-3 text-sm text-ink-soft">
          <span className="font-medium text-ink">Showing {budget.month}.</span>{' '}
          {POSITION_LABEL[budget.monthPosition]}
        </p>
      </div>
    </section>
  );
}
