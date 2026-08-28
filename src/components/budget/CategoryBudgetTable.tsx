import type { BudgetSelection } from '../../calculations';
import { getCategory } from '../../domain/categories';
import { formatCurrency } from '../dashboard/format';
import { BudgetProgressBar } from './BudgetProgressBar';
import { CATEGORY_STATUS_LABEL, ratioText, remainingPhrase, spentOfLimit } from './budgetCopy';

/**
 * Every category target, with the same figures twice.
 *
 * The bars are the quick read and the table is the exact one, built from the
 * same `selection.categories` rows so they cannot disagree. The table is always
 * present rather than hidden behind a disclosure: at narrow widths the bars
 * carry almost no information, and Phase 5 already learned that a fallback
 * offered behind a control is not a fallback.
 *
 * Categories appear in the permanent domain order the selector sorted them
 * into. A targeted category with no spending stays visible at $0.00 spent —
 * hiding it would make an unmet plan look like an absent one.
 */

interface CategoryBudgetTableProps {
  readonly selection: BudgetSelection;
}

export function CategoryBudgetTable({ selection }: CategoryBudgetTableProps) {
  const { categories } = selection;

  return (
    <section aria-labelledby="category-budget-title" className="mt-10">
      <h2 id="category-budget-title" className="text-lg font-semibold tracking-tight text-ink">
        Category limits
      </h2>

      {categories.length === 0 ? (
        <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
          No category limits are set for this month. Spending is still counted against the overall
          limit.
        </p>
      ) : (
        <>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
            {categories.length === 1
              ? 'One category has a limit this month.'
              : `${categories.length} categories have limits this month.`}{' '}
            Category limits do not have to add up to the overall limit, and spending in a category
            without a limit still counts toward it.
          </p>

          <ul className="mt-4 space-y-3">
            {categories.map((category) => {
              const label = getCategory(category.categoryId)?.label ?? category.categoryId;
              return (
                <li
                  key={category.categoryId}
                  className="rounded-card border border-line bg-surface p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-medium text-ink">{label}</p>
                    <p className="text-sm text-ink-soft">
                      {CATEGORY_STATUS_LABEL[category.status]}
                    </p>
                  </div>
                  <BudgetProgressBar
                    usedRatio={category.usedRatio}
                    label={`${label} spending against its limit`}
                    valueText={`${spentOfLimit(category.spentCents, category.limitCents)}. ${ratioText(category.usedRatio)}.`}
                    over={category.status === 'over'}
                  />
                  <p className="money mt-2 text-sm text-ink">
                    {spentOfLimit(category.spentCents, category.limitCents)}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {remainingPhrase(category.remainingCents)} · {ratioText(category.usedRatio)}
                  </p>
                </li>
              );
            })}
          </ul>

          {/* The exact table, always shown. */}
          <div
            className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            tabIndex={0}
            role="region"
            aria-label={CATEGORY_TABLE_CAPTION}
          >
            <table className="w-full min-w-72 border-collapse">
              <caption className="pb-2 text-left text-sm text-ink-soft">
                {CATEGORY_TABLE_CAPTION}
              </caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={HEAD}>
                    Category
                  </th>
                  <th scope="col" className={`${HEAD} text-right`}>
                    Limit
                  </th>
                  <th scope="col" className={`${HEAD} text-right`}>
                    Spent
                  </th>
                  <th scope="col" className={`${HEAD} text-right`}>
                    Remaining
                  </th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => (
                  <tr key={category.categoryId} className="border-b border-line/60">
                    <th scope="row" className={`${CELL} text-left font-normal text-ink`}>
                      <span className="break-words">
                        {getCategory(category.categoryId)?.label ?? category.categoryId}
                      </span>
                    </th>
                    <td className={`money ${CELL} text-right text-ink`}>
                      {formatCurrency(category.limitCents)}
                    </td>
                    <td className={`money ${CELL} text-right text-ink`}>
                      {formatCurrency(category.spentCents)}
                    </td>
                    <td className={`money ${CELL} text-right text-ink`}>
                      {formatCurrency(category.remainingCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selection.untargetedSpendCents !== 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          {formatCurrency(selection.untargetedSpendCents)} of this month’s net spending is in
          categories with no limit. It is counted in the overall total above.
        </p>
      ) : null}
    </section>
  );
}

const CATEGORY_TABLE_CAPTION =
  'Each category limit, what has been spent against it, and what remains.';
const CELL = 'px-3 py-2 text-sm';
const HEAD = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-[0.08em] text-ink-muted';
