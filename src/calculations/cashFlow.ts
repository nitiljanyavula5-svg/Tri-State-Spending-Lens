import type {
  CashFlowSummary,
  Cents,
  IncomeCompleteness,
  Measured,
  NetSpendingBreakdown,
  Ratio,
  SelectableTransaction,
  UnavailableReason,
} from './types';
import { ratioOf, subtractCents, sumBy } from './money';

/**
 * Money in, net cash flow, and savings rate.
 *
 * Two gates govern this file, and they are independent.
 *
 * The first is completeness (§14.1). `incomeDataComplete` is tri-state: a
 * missing setting is *not* a confirmed `true`. Publishing a savings rate the
 * user never vouched for is precisely the "misleading precision" §6 forbids, so
 * an unconfirmed workspace is as unavailable as a confirmed-incomplete one —
 * with a different reason, because one is a statement and the other is silence.
 *
 * The second is user exclusion (§14.10). §2 defines *Included* as
 * `excludedFromSpending === false` and an eligible kind, §3.3 says the flag
 * removes a row "regardless of kind", and §4.1 builds money in from *included*
 * credits. An income row carrying the flag is therefore not money in. The
 * product can barely produce such a row — `userExclusionApplies` is false for
 * income, so the control is never offered, and `reconcileExclusionForKind`
 * clears the flag on any change to income — but an imported or restored row can
 * carry it. Because the suppression is invisible in the total, the data-quality
 * selector counts it rather than letting it pass in silence.
 */

const UNAVAILABLE: Record<'incomplete' | 'unconfirmed', UnavailableReason> = {
  incomplete: 'income-data-incomplete',
  unconfirmed: 'income-completeness-unconfirmed',
};

/**
 * The authoritative completeness warning (§14.1).
 *
 * Shares its identifiers with `UnavailableReason`, so a warning banner and a
 * hidden card can never describe the same workspace in different words.
 */
export function incomeCompletenessWarning(
  completeness: IncomeCompleteness,
): 'income-data-incomplete' | 'income-completeness-unconfirmed' | null {
  if (completeness === 'confirmed-incomplete') return 'income-data-incomplete';
  if (completeness === 'unconfirmed') return 'income-completeness-unconfirmed';
  return null;
}

function unavailable<T>(reason: UnavailableReason): Measured<T> {
  return { available: false, reason };
}

function available<T>(value: T): Measured<T> {
  return { available: true, value };
}

/** Income rows that count toward money in (§4.1 read through §2 and §14.10). */
export function includedIncomeRows(
  population: readonly SelectableTransaction[],
): readonly SelectableTransaction[] {
  return population.filter((row) => row.kind === 'income' && !row.excludedFromSpending);
}

/**
 * Income rows suppressed from money in by the exclusion contract (§14.10).
 *
 * Counted, never silent. Not attributed to anyone: the flag can arrive through
 * import or restore, and the schema records no provenance for it.
 */
export function excludedIncomeRows(
  population: readonly SelectableTransaction[],
): readonly SelectableTransaction[] {
  return population.filter((row) => row.kind === 'income' && row.excludedFromSpending);
}

/**
 * The reason income figures cannot be shown, or `null` when they can.
 *
 * Order matters. A workspace with no income rows at all is reported as
 * `no-income-data` even when completeness is confirmed, because that is the
 * more specific and more actionable explanation.
 */
export function incomeUnavailableReason(
  population: readonly SelectableTransaction[],
  completeness: IncomeCompleteness,
): UnavailableReason | null {
  if (completeness === 'confirmed-incomplete') return UNAVAILABLE.incomplete;
  if (completeness === 'unconfirmed') return UNAVAILABLE.unconfirmed;
  if (includedIncomeRows(population).length === 0) return 'no-income-data';
  return null;
}

/**
 * Cash flow for a period.
 *
 * Net spending is passed in rather than recomputed, so the subtraction that
 * produces net cash flow uses the very same figure the net-spending card shows.
 *
 * The savings-rate rules are all §4.3: undefined at zero income, negative when
 * spending exceeds income, never clamped, and never rounded here — rounding
 * happens only at display (§9), and a rounded value fed back into a calculation
 * is exactly what §9 forbids.
 */
export function selectCashFlow(
  population: readonly SelectableTransaction[],
  netSpending: NetSpendingBreakdown,
  completeness: IncomeCompleteness,
): CashFlowSummary {
  const reason = incomeUnavailableReason(population, completeness);

  if (reason !== null) {
    return {
      netSpending,
      moneyInCents: unavailable<Cents>(reason),
      netCashFlowCents: unavailable<Cents>(reason),
      savingsRate: unavailable<Ratio>(reason),
    };
  }

  const moneyInCents = sumBy(includedIncomeRows(population), (row) => row.amountCents);
  const netCashFlowCents = subtractCents(moneyInCents, netSpending.netSpendingCents);
  const rate = ratioOf(netCashFlowCents, moneyInCents);

  return {
    netSpending,
    moneyInCents: available(moneyInCents),
    netCashFlowCents: available(netCashFlowCents),
    // `ratioOf` returns null only at zero income, which §4.3 calls undefined
    // rather than zero. A genuine 0 income total with income rows present means
    // every income row was zero-amount — still no ratio to state.
    savingsRate: rate === null ? unavailable<Ratio>('no-income-data') : available(rate),
  };
}

/**
 * Reads the stored setting as the tri-state it actually is.
 *
 * `undefined` means the question was never answered. Modeled explicitly so no
 * caller can collapse it with `Boolean(value)` and turn silence into consent.
 */
export function incomeCompletenessFrom(value: boolean | undefined): IncomeCompleteness {
  if (value === true) return 'confirmed-complete';
  if (value === false) return 'confirmed-incomplete';
  return 'unconfirmed';
}
