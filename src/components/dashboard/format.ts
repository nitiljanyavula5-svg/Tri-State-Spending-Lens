import type { Cents, Ratio, UnavailableReason } from '../../calculations';

/**
 * The presentation boundary.
 *
 * calculation-contract.md §9 permits rounding **only** here, and forbids feeding
 * a rounded value back into a calculation. Nothing in this file is imported by
 * the calculation layer, and nothing here returns a number — every export
 * produces a string bound for the DOM, which makes an accidental round-trip
 * impossible rather than merely discouraged.
 */

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const COUNT = new Intl.NumberFormat('en-US');

/**
 * Integer cents as currency.
 *
 * The division happens once, at the last possible moment, on a value that has
 * been an exact integer through every aggregation that produced it.
 */
export function formatCurrency(cents: Cents): string {
  return CURRENCY.format(cents / 100);
}

/** A percentage to one decimal place (§9). Never clamped: a rate may be negative. */
export function formatRatio(ratio: Ratio): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatCount(value: number): string {
  return COUNT.format(value);
}

/**
 * Why a figure is not shown, in the user's words.
 *
 * Every reason the contract defines has an entry, so an unavailable card always
 * explains itself. §1 rule 5 forbids substituting `0`, `0%`, blank text, or a
 * bare em dash for a value that was never measured.
 */
export const UNAVAILABLE_COPY: Readonly<Record<UnavailableReason, string>> = {
  'no-income-data': 'No income transactions in this period, so there is nothing to total.',
  'income-data-incomplete': 'You marked imported income as incomplete, so this stays hidden.',
  'income-completeness-unconfirmed':
    'Income completeness has not been confirmed yet. Confirm it in Settings to show this.',
  'no-budget-limit-set': 'No budget limit is set for this month.',
  'partial-month': 'This period is not fully covered by imported statements.',
  'insufficient-history': 'Fewer than two complete months are available to compare.',
  'no-included-transactions': 'No transactions in this period contribute to this figure.',
  'period-not-complete-month': 'Select a single whole calendar month to compare.',
  'prior-month-incomplete': 'The month before this one is not fully covered by statements.',
  'not-applicable': 'This figure does not apply to the current selection.',
  'no-budget-plan': 'No budget plan exists for this month yet. Create one on the Budget page.',
  'budget-period-not-one-month':
    'Budget Remaining covers one calendar month. Choose a single month to see it.',
  // States the evidence, not the conclusion: the budget page prefixes this with
  // "No pace is projected." and restating that here read as a stutter.
  'budget-coverage-incomplete': 'Imported statements do not cover every day of this month so far.',
};

export function unavailableCopy(reason: UnavailableReason): string {
  return UNAVAILABLE_COPY[reason];
}
