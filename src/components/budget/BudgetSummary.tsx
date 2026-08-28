import type { BudgetSelection } from '../../calculations';
import { Callout } from '../ui/Callout';
import { formatCount, formatCurrency, unavailableCopy } from '../dashboard/format';
import { BudgetProgressBar } from './BudgetProgressBar';
import {
  PLAN_WARNING_COPY,
  STATUS_LABEL,
  paceSentence,
  periodQualifier,
  projectionSentence,
  remainingPhrase,
  spentOfLimit,
  ratioText,
} from './budgetCopy';

/**
 * The month's headline figures.
 *
 * Everything here is read from `selection`. Nothing is summed, subtracted, or
 * divided in this file — calculation-contract.md §1 rule 1 makes a component
 * that computes its own total a defect, and the budget page has two places
 * (here and the Overview card) that would otherwise each need to agree with the
 * selector by hand.
 */

interface BudgetSummaryProps {
  readonly selection: BudgetSelection;
}

function Figure({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly note: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</p>
      {value === null ? (
        // Never 0, 0%, blank, or a dash for something that was not measured.
        <p className="mt-2 text-sm font-medium leading-relaxed text-ink-soft">Not available</p>
      ) : (
        <p className="money mt-2 break-words text-2xl font-semibold text-ink">{value}</p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{note}</p>
    </div>
  );
}

export function BudgetSummary({ selection }: BudgetSummaryProps) {
  const { limitCents, remainingCents, plannedMarginCents, savingsTargetProgress } = selection;
  const pace = paceSentence(selection);
  const projection = projectionSentence(selection);

  return (
    <section aria-labelledby="budget-summary-title" className="mt-10">
      <h2 id="budget-summary-title" className="text-lg font-semibold tracking-tight text-ink">
        This month against the plan
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{periodQualifier(selection)}</p>

      {selection.warnings.length > 0 ? (
        <div className="mt-4 space-y-3">
          {selection.warnings.map((warning) => (
            <Callout key={warning} tone="info" title={PLAN_WARNING_COPY[warning].title}>
              <p>{PLAN_WARNING_COPY[warning].body}</p>
            </Callout>
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Figure
          label="Monthly spending limit"
          value={limitCents.available ? formatCurrency(limitCents.value) : null}
          note={
            limitCents.available
              ? 'The overall limit you set for this month.'
              : unavailableCopy(limitCents.reason)
          }
        />
        <Figure
          label={selection.monthPosition === 'past' ? 'Net spending' : 'Net spending to date'}
          value={formatCurrency(selection.actualCents)}
          note={`Purchases, fees, and cash out, minus refunds, across ${formatCount(selection.scope.length)} active ${selection.scope.length === 1 ? 'account' : 'accounts'}. A negative figure means refunds exceeded outflows.`}
        />
        <Figure
          label="Remaining"
          value={remainingCents.available ? remainingPhrase(remainingCents.value) : null}
          note={
            remainingCents.available
              ? 'The limit, minus net spending. It can go below zero.'
              : unavailableCopy(remainingCents.reason)
          }
        />
        <Figure
          label="Planned margin"
          value={plannedMarginCents.available ? formatCurrency(plannedMarginCents.value) : null}
          note={
            plannedMarginCents.available
              ? 'Expected income minus the spending limit. A plan figure, not observed income.'
              : 'Set both an expected monthly income and a spending limit to see this.'
          }
        />
        <Figure
          label="Savings target"
          value={
            savingsTargetProgress.available
              ? `${formatCurrency(savingsTargetProgress.value.actualCents)} of ${formatCurrency(savingsTargetProgress.value.targetCents)}`
              : null
          }
          note={
            savingsTargetProgress.available
              ? savingsTargetProgress.value.meetsTarget
                ? 'Net cash flow is at or above the target.'
                : 'Net cash flow is below the target.'
              : unavailableCopy(savingsTargetProgress.reason)
          }
        />
        <Figure
          label="Transactions analyzed"
          value={formatCount(selection.populationCount)}
          note="Every transaction in this month on an active account, including transfers, card payments, excluded rows, and rows awaiting review."
        />
      </div>

      {limitCents.available ? (
        <div className="mt-4 rounded-card border border-line bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-ink">Overall</p>
            <p className="text-sm text-ink-soft">{STATUS_LABEL[selection.status]}</p>
          </div>
          <BudgetProgressBar
            usedRatio={selection.usedRatio}
            label="Overall spending against the monthly limit"
            valueText={`${spentOfLimit(selection.actualCents, limitCents.value)}. ${ratioText(selection.usedRatio)}.`}
            over={selection.status === 'over'}
          />
          <p className="money mt-2 text-sm text-ink">
            {spentOfLimit(selection.actualCents, limitCents.value)}
          </p>
          <p className="mt-1 text-xs text-ink-muted">{ratioText(selection.usedRatio)}</p>

          {pace ? <p className="mt-3 text-sm leading-relaxed text-ink-soft">{pace}</p> : null}
          {projection ? (
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              {projection}{' '}
              <span className="text-ink-muted">
                This is an estimate based only on transactions recorded so far.
              </span>
            </p>
          ) : null}
          {!selection.pace.available && selection.monthPosition === 'current' ? (
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              No pace is projected. {unavailableCopy(selection.pace.reason)}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
