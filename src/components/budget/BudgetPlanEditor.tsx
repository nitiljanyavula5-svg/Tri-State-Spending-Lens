import { useId, useState } from 'react';
import { CATEGORIES } from '../../domain/categories';
import type { BudgetApi } from '../../review/useBudget';
import { parseDollarsToCents } from '../../review/useBudget';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { TextField } from '../import/FormControls';

/**
 * The plan form.
 *
 * Every field is optional and blank means unset, which is a different thing
 * from zero: an unset limit hides the figures that depend on it, while a
 * zero-dollar limit is a real plan that any spending exceeds. The form never
 * turns one into the other.
 *
 * Parsing is strict and shared with the hook (`parseDollarsToCents`), so the
 * inline message a user sees and the value that would be written come from one
 * rule rather than two that agree today.
 *
 * Nothing here is persisted while it is being typed. Unsaved form state lives
 * in component state and dies with the page — privacy-model.md keeps an amount
 * out of the URL, storage, and logs, and the only way to guarantee that is
 * never to write it anywhere.
 */

interface BudgetPlanEditorProps {
  readonly budget: BudgetApi;
}

/** Inline validation for one field, using the same parser the save path uses. */
function fieldError(raw: string): string | undefined {
  const parsed = parseDollarsToCents(raw);
  return parsed.ok ? undefined : parsed.reason;
}

export function BudgetPlanEditor({ budget }: BudgetPlanEditorProps) {
  const { form, saveState } = budget;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);
  const statusId = useId();

  const busy = saveState.kind === 'saving';

  const copy = async () => {
    const outcome = await budget.copyPreviousMonth(false);
    // Only an existing destination plan needs a decision; everything else has
    // already resolved into a save state.
    setConfirmingOverwrite(outcome === 'destination-exists');
  };

  return (
    <section aria-labelledby="budget-plan-title" className="mt-10">
      <h2 id="budget-plan-title" className="text-lg font-semibold tracking-tight text-ink">
        Plan for this month
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
        Every field is optional. Leave one blank to leave it unset — a blank limit is not the same
        as a limit of zero.
      </p>

      <form
        className="mt-4 rounded-card border border-line bg-surface p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void budget.save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <TextField
            label="Monthly spending limit"
            value={form.overallLimit}
            onChange={budget.setOverallLimit}
            hint="Dollars, for example 1200 or 1200.00."
            placeholder="1200.00"
            {...(fieldError(form.overallLimit)
              ? { error: fieldError(form.overallLimit) as string }
              : {})}
          />
          <TextField
            label="Expected monthly income"
            value={form.incomeTarget}
            onChange={budget.setIncomeTarget}
            hint="A planning figure. It is never shown as income you actually received."
            placeholder="4000.00"
            {...(fieldError(form.incomeTarget)
              ? { error: fieldError(form.incomeTarget) as string }
              : {})}
          />
          <TextField
            label="Monthly savings target"
            value={form.savingsTarget}
            onChange={budget.setSavingsTarget}
            hint="Progress against this needs confirmed income data."
            placeholder="500.00"
            {...(fieldError(form.savingsTarget)
              ? { error: fieldError(form.savingsTarget) as string }
              : {})}
          />
        </div>

        <fieldset className="mt-6">
          <legend className="text-sm font-medium text-ink">Category limits</legend>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Optional, one per category. These do not have to add up to the overall limit.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {CATEGORIES.map((category) => {
              const value = form.categoryLimits[category.id] ?? '';
              const error = fieldError(value);
              return (
                <TextField
                  key={category.id}
                  label={category.label}
                  value={value}
                  onChange={(next) => budget.setCategoryLimit(category.id, next)}
                  placeholder="0.00"
                  {...(error ? { error } : {})}
                />
              );
            })}
          </div>
        </fieldset>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save plan'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={budget.resetForm}
            disabled={busy}
          >
            Discard changes
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void copy()}
            disabled={busy || !budget.previousMonthHasPlan}
          >
            Copy last month’s plan
          </Button>
          {budget.plan ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Delete plan
            </Button>
          ) : null}
          {!budget.previousMonthHasPlan ? (
            <p className="text-xs text-ink-muted">There is no plan for last month to copy.</p>
          ) : null}
        </div>

        {/* One polite region, so a screen reader hears the outcome once. */}
        <div id={statusId} role="status" aria-live="polite" className="mt-3">
          {saveState.kind === 'saved' ? (
            <p className="text-sm text-ink-soft">{saveState.message}</p>
          ) : null}
          {saveState.kind === 'invalid' ? (
            <p className="text-sm text-pa">{saveState.message}</p>
          ) : null}
          {saveState.kind === 'failed' ? (
            <p className="text-sm text-pa">{saveState.message}</p>
          ) : null}
        </div>
      </form>

      {confirmingDelete ? (
        <Callout tone="caution" title="Delete this month’s plan?" className="mt-4">
          <p>
            The limits and targets for this month will be removed. Your transactions are not
            touched, and other months keep their own plans.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirmingDelete(false);
                void budget.deletePlan();
              }}
            >
              Delete plan
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep plan
            </Button>
          </div>
        </Callout>
      ) : null}

      {confirmingOverwrite ? (
        <Callout tone="caution" title="Replace this month’s plan?" className="mt-4">
          <p>
            This month already has a plan. Copying last month’s plan over it replaces the limits and
            targets stored here. Last month is not changed, and the two months stay independent
            afterwards.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirmingOverwrite(false);
                void budget.copyPreviousMonth(true);
              }}
            >
              Replace with last month’s plan
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingOverwrite(false)}
            >
              Keep this month’s plan
            </Button>
          </div>
        </Callout>
      ) : null}
    </section>
  );
}
