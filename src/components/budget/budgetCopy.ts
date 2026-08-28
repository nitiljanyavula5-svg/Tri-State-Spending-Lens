import type {
  BudgetPlanWarning,
  BudgetSelection,
  BudgetStatus,
  CategoryBudgetStatus,
  Measured,
  Ratio,
} from '../../calculations';
import { formatCurrency, formatRatio } from '../dashboard/format';

/**
 * Every sentence the budget surfaces say, in one place.
 *
 * product-spec.md §10.5 asks for observation without verdict. Spending more than
 * planned is not a failure and spending less is not a win, so the wording here
 * says "over" and "under" and stops: no "blown", no "great job", no warning
 * tone attached to a number the user may have chosen deliberately.
 *
 * Pure string builders, kept out of the components so the wording can be
 * asserted directly and cannot drift between the page and the Overview card.
 */

export const STATUS_LABEL: Readonly<Record<BudgetStatus, string>> = {
  'no-limit': 'No limit set',
  under: 'Under plan',
  at: 'At plan',
  over: 'Over plan',
};

export const CATEGORY_STATUS_LABEL: Readonly<Record<CategoryBudgetStatus, string>> = {
  under: 'Under plan',
  at: 'At plan',
  over: 'Over plan',
};

export const PLAN_WARNING_COPY: Readonly<
  Record<BudgetPlanWarning, { title: string; body: string }>
> = {
  'category-targets-exceed-overall-limit': {
    title: 'Category limits add up to more than the overall limit',
    body: 'That is allowed and nothing has been changed. It only means the category limits cannot all be met inside the overall limit, so one of the two will be exceeded first.',
  },
  'savings-target-exceeds-planned-margin': {
    title: 'The savings target is larger than the planned margin',
    body: 'Expected income minus the spending limit leaves less than the savings target. Both numbers are kept exactly as entered; this only says the plan does not add up on its own terms.',
  },
};

/**
 * The exact percentage as text, or the reason there is none.
 *
 * Lives beside the other copy rather than in the bar component so a bar and its
 * label cannot describe the same ratio differently — and so the bar module
 * exports only a component.
 */
export function ratioText(usedRatio: Measured<Ratio>): string {
  // No trailing period in either branch. This is a fragment, not a sentence:
  // it is rendered bare as a caption and also interpolated into a progress
  // bar's `aria-valuetext`, which supplies its own punctuation. Ending it with
  // a period produced ".." in the announced string for a zero-dollar limit.
  return usedRatio.available
    ? `${formatRatio(usedRatio.value)} used`
    : 'No percentage: the limit is zero';
}

/** "Spent $420.00 of $500.00" — the exact pair, never a bar on its own. */
export function spentOfLimit(spentCents: number, limitCents: number): string {
  return `${formatCurrency(spentCents)} of ${formatCurrency(limitCents)}`;
}

/**
 * Remaining, or the amount over, in words rather than by sign alone.
 *
 * A minus sign is easy to miss at a glance and impossible to hear, so the
 * direction is named. The figure still carries its own sign.
 */
export function remainingPhrase(remainingCents: number): string {
  if (remainingCents < 0) return `${formatCurrency(remainingCents)} — over plan`;
  if (remainingCents === 0) return `${formatCurrency(0)} — exactly at plan`;
  return `${formatCurrency(remainingCents)} left`;
}

/** The neutral pace sentence from §10.6, or null when no ratio applies. */
export function paceSentence(selection: BudgetSelection): string | null {
  if (!selection.pace.available || !selection.usedRatio.available) return null;
  const used = formatRatio(selection.usedRatio.value);
  const elapsed = formatRatio(selection.pace.value.elapsedRatio);
  return `You have used ${used} of this limit with ${elapsed} of the month elapsed.`;
}

/** "At the current recorded pace, this plan may exceed …", or the under-plan form. */
export function projectionSentence(selection: BudgetSelection): string | null {
  if (!selection.pace.available) return null;
  const { projectedOverUnderCents, projectedSpendCents } = selection.pace.value;
  if (!projectedOverUnderCents.available) {
    return `At the current recorded pace, this month is on track for about ${formatCurrency(projectedSpendCents)} of net spending.`;
  }
  const difference = projectedOverUnderCents.value;
  if (difference < 0) {
    return `At the current recorded pace, this plan may be exceeded by about ${formatCurrency(Math.abs(difference))}.`;
  }
  return `At the current recorded pace, this month may finish about ${formatCurrency(difference)} under the plan.`;
}

/**
 * Whether the figures describe a finished month or a month still running.
 *
 * §10.5 forbids presenting a partial month as final, and the distinction is not
 * cosmetic: the same number means "this is what it cost" in one case and "this
 * is what it has cost so far" in the other.
 */
export function periodQualifier(selection: BudgetSelection): string {
  if (selection.monthPosition === 'future') {
    return 'This month has not started, so nothing has been recorded against the plan yet.';
  }
  if (selection.monthPosition === 'current') {
    return 'Spending so far this month. The month is still running, so these are figures to date, not final.';
  }
  return selection.monthComplete
    ? 'Final figures. Imported statements cover every day of this month.'
    : 'Figures to date. Imported statements do not cover every day of this month, so these are not final.';
}
