import type { ComparisonResult, Measured } from '../../calculations';
import { formatCurrency, formatRatio, unavailableCopy } from './format';

/**
 * This complete calendar month against the one immediately before it.
 *
 * Every figure shown here is already in `selection.comparison`. Nothing is
 * subtracted or divided in React — the selector computed the delta and its
 * ratio from the same population that produced the cards, and recomputing here
 * would be a second implementation of a shared figure (§1 rule 1).
 *
 * The wording is deliberately flat. Spending more is not a failure and spending
 * less is not a win; product-spec.md §8.5 asks for the observation without the
 * verdict, so the copy says "higher" and "lower" and stops there.
 */

interface MonthComparisonProps {
  readonly comparison: Measured<ComparisonResult>;
}

export function MonthComparison({ comparison }: MonthComparisonProps) {
  return (
    <section
      aria-labelledby="comparison-title"
      className="rounded-card border border-line bg-surface p-4 sm:p-5"
    >
      <h3 id="comparison-title" className="text-base font-semibold tracking-tight text-ink">
        Compared with the previous complete month
      </h3>

      {comparison.available ? (
        <ComparisonFigures value={comparison.value} />
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {/* The exact selector reason, never a zero and never silence. */}
          Not available. {unavailableCopy(comparison.reason)}
        </p>
      )}
    </section>
  );
}

function ComparisonFigures({ value }: { value: ComparisonResult }) {
  const direction =
    value.deltaCents === 0 ? 'the same as' : value.deltaCents > 0 ? 'higher than' : 'lower than';

  return (
    <>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Net spending in {value.currentMonth} was {direction} {value.priorMonth}.
      </p>

      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">
            {value.currentMonth}
          </dt>
          <dd className="money mt-1 text-lg font-semibold text-ink">
            {formatCurrency(value.currentNetCents)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">
            {value.priorMonth}
          </dt>
          <dd className="money mt-1 text-lg font-semibold text-ink">
            {formatCurrency(value.priorNetCents)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">
            Difference
          </dt>
          <dd className="money mt-1 text-lg font-semibold text-ink">
            {/* The sign carries the direction; colour is not used at all. */}
            {formatCurrency(value.deltaCents)}
          </dd>
          <dd className="mt-0.5 text-xs text-ink-muted">
            {value.deltaRatio.available
              ? formatRatio(value.deltaRatio.value)
              : 'No percentage: the previous month was zero.'}
          </dd>
        </div>
      </dl>
    </>
  );
}
