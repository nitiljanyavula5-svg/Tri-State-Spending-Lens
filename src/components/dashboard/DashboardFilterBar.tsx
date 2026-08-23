import { X } from 'lucide-react';
import type { DashboardApi } from '../../review/useDashboard';
import { CUSTOM_RANGE_MESSAGES, PERIOD_PRESETS } from '../../review/dashboardPeriod';
import { Button } from '../ui/Button';
import { TextField } from '../import/FormControls';

/**
 * Period, account, and category filters.
 *
 * Deliberately narrower than the review grid's filters: kind, tag, treatment,
 * and search are absent, because a "net spending" figure computed with transfers
 * filtered in has no definition in the calculation contract.
 *
 * Nothing here is persisted. Filter state lives in component state and dies with
 * the page — privacy-model.md keeps a selected account or date range out of the
 * URL, the document title, storage, and logs, and the only way to guarantee that
 * is never to write it anywhere.
 */

interface DashboardFilterBarProps {
  readonly dashboard: DashboardApi;
}

interface Chip {
  readonly id: string;
  readonly label: string;
  readonly onRemove: () => void;
}

export function DashboardFilterBar({ dashboard }: DashboardFilterBarProps) {
  const {
    preset,
    customStart,
    customEnd,
    customError,
    accountChoices,
    categoryChoices,
    filters,
    latestCompleteMonthAvailable,
  } = dashboard;

  const selectedAccounts = filters.accountIds ?? [];
  const selectedCategories = filters.categoryIds ?? [];

  const chips: Chip[] = [
    ...selectedAccounts.map((id) => ({
      id: `account-${id}`,
      label: accountChoices.find((choice) => choice.id === id)?.label ?? id,
      onRemove: () => dashboard.toggleAccount(id),
    })),
    ...selectedCategories.map((id) => ({
      id: `category-${id}`,
      label: categoryChoices.find((choice) => choice.id === id)?.label ?? id,
      onRemove: () => dashboard.toggleCategory(id),
    })),
  ];

  const hasSelections = preset !== 'all-data' || chips.length > 0;

  return (
    <section aria-labelledby="dashboard-filters-title" className="mt-8">
      <h2 id="dashboard-filters-title" className="text-lg font-semibold tracking-tight text-ink">
        Filters
      </h2>

      <div className="mt-4 rounded-card border border-line bg-surface p-4 sm:p-5">
        <div className="grid gap-4 lg:grid-cols-3">
          <fieldset className="min-w-0">
            <legend className="text-xs font-medium text-ink-muted">Period</legend>
            <div className="mt-1.5 space-y-1.5">
              {PERIOD_PRESETS.map((option) => {
                const disabled =
                  option.value === 'latest-complete-month' && !latestCompleteMonthAvailable;
                return (
                  <div key={option.value} className="flex items-start gap-2">
                    <input
                      id={`period-${option.value}`}
                      type="radio"
                      name="dashboard-period"
                      value={option.value}
                      checked={preset === option.value}
                      disabled={disabled}
                      onChange={() => dashboard.setPreset(option.value)}
                      className="mt-0.5 size-4 shrink-0 accent-ink"
                    />
                    <label
                      htmlFor={`period-${option.value}`}
                      className="min-w-0 cursor-pointer py-1 text-sm text-ink"
                    >
                      {option.label}
                      {disabled ? (
                        <span className="block text-xs text-ink-muted">
                          No complete month is available yet
                        </span>
                      ) : null}
                    </label>
                  </div>
                );
              })}
            </div>

            {preset === 'custom' ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <TextField
                  label="Start date"
                  type="date"
                  value={customStart}
                  onChange={dashboard.setCustomStart}
                  {...(customError === 'start-invalid' || customError === 'reversed'
                    ? { error: CUSTOM_RANGE_MESSAGES[customError] }
                    : {})}
                />
                <TextField
                  label="End date"
                  type="date"
                  value={customEnd}
                  onChange={dashboard.setCustomEnd}
                  {...(customError === 'end-invalid'
                    ? { error: CUSTOM_RANGE_MESSAGES['end-invalid'] }
                    : {})}
                />
              </div>
            ) : null}
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-xs font-medium text-ink-muted">Accounts</legend>
            <div className="mt-1.5 space-y-1.5">
              {accountChoices.length === 0 ? (
                <p className="text-sm text-ink-muted">No accounts yet.</p>
              ) : (
                accountChoices.map((choice) => (
                  <div key={choice.id} className="flex items-start gap-2">
                    <input
                      id={`account-${choice.id}`}
                      type="checkbox"
                      checked={selectedAccounts.includes(choice.id)}
                      onChange={() => dashboard.toggleAccount(choice.id)}
                      className="mt-0.5 size-4 shrink-0 accent-ink"
                    />
                    <label
                      htmlFor={`account-${choice.id}`}
                      className="min-w-0 cursor-pointer break-words py-1 text-sm text-ink"
                    >
                      {choice.label}
                    </label>
                  </div>
                ))
              )}
            </div>
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-xs font-medium text-ink-muted">Categories</legend>
            <div className="mt-1.5 max-h-64 space-y-1.5 overflow-y-auto">
              {categoryChoices.map((choice) => (
                <div key={choice.id} className="flex items-start gap-2">
                  <input
                    id={`category-${choice.id}`}
                    type="checkbox"
                    checked={selectedCategories.includes(choice.id)}
                    onChange={() => dashboard.toggleCategory(choice.id)}
                    className="mt-0.5 size-4 shrink-0 accent-ink"
                  />
                  <label
                    htmlFor={`category-${choice.id}`}
                    className="min-w-0 cursor-pointer break-words py-1 text-sm text-ink"
                  >
                    {choice.label}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-ink-muted">Active filters</p>
            {chips.length === 0 ? (
              <p className="text-xs text-ink-muted">None beyond the period.</p>
            ) : (
              chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={chip.onRemove}
                  className="inline-flex min-h-6 items-center gap-1 rounded-control border border-line-strong bg-canvas px-2 py-1 text-xs text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
                >
                  <span className="max-w-40 truncate">{chip.label}</span>
                  <X aria-hidden="true" className="size-3 shrink-0" />
                  <span className="sr-only">Remove filter</span>
                </button>
              ))
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={dashboard.resetAll}
              disabled={!hasSelections}
            >
              Reset all
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
