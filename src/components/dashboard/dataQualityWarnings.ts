import type { DataQualityFlags } from '../../calculations';
import type { CalloutTone } from '../ui/Callout';
import { formatCount, formatCurrency } from './format';

/**
 * Every condition that qualifies the figures below it.
 *
 * Placed above the cards so a caveat is read before a number. Each active
 * warning gets its own callout: data-methodology.md §6 lists materially
 * different conditions, and collapsing them into one "some data may be missing"
 * would leave the user unable to act on any of them.
 *
 * Two warnings are carefully scoped and must not be confused. Incomplete
 * coverage is **filter-scoped** — it names the accounts the *selected* period
 * lacks statements for. Ambiguous multi-account coverage is **workspace-wide**
 * import metadata that no filter changes (§14.11).
 */

export interface Warning {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tone: CalloutTone;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Account ids as names where known; an unknown id is shown as-is, never invented. */
function nameAccounts(ids: readonly string[], labels: ReadonlyMap<string, string>): string {
  return ids.map((id) => labels.get(id) ?? `Unnamed account (${id})`).join(', ');
}

export function buildWarnings(
  flags: DataQualityFlags,
  accountLabels: ReadonlyMap<string, string>,
): Warning[] {
  const warnings: Warning[] = [];

  if (flags.incomeCompletenessWarning === 'income-data-incomplete') {
    warnings.push({
      id: 'income-data-incomplete',
      title: 'Income data is marked incomplete',
      body: 'You confirmed that the imported income data is incomplete, so money in, net cash flow, and savings rate are not shown. Net spending is unaffected.',
      tone: 'caution',
    });
  } else if (flags.incomeCompletenessWarning === 'income-completeness-unconfirmed') {
    warnings.push({
      id: 'income-completeness-unconfirmed',
      title: 'Income completeness has not been confirmed',
      body: 'Nobody has confirmed whether the imported income is complete, so money in, net cash flow, and savings rate stay hidden rather than being reported from data that may be partial. You can confirm this in Settings.',
      tone: 'info',
    });
  }

  if (flags.accountsWithIncompleteCoverage.length > 0) {
    const names = nameAccounts(flags.accountsWithIncompleteCoverage, accountLabels);
    warnings.push({
      id: 'incomplete-coverage',
      title: 'The selected period is not fully covered by statements',
      body: `Imported statements do not cover every day of the selected period for ${names}. Month-over-month comparisons are withheld while that is true.`,
      tone: 'caution',
    });
  } else if (flags.partialMonth) {
    warnings.push({
      id: 'partial-period',
      title: 'The selected period is not fully covered by statements',
      body: 'The imported statement ranges do not establish complete coverage of this period, so comparisons are withheld and averages describe the selected range rather than a whole month.',
      tone: 'caution',
    });
  }

  if (flags.ambiguousMultiAccountStatementRangeCount > 0) {
    const count = flags.ambiguousMultiAccountStatementRangeCount;
    const names = nameAccounts(flags.accountsWithAmbiguousStatementCoverage, accountLabels);
    warnings.push({
      id: 'ambiguous-coverage',
      // Named as a workspace-wide import limitation so it is not mistaken for a
      // claim about the current filter.
      title: 'Workspace import coverage: one statement period covers several accounts',
      body: `${formatCount(count)} ${plural(count, 'import recorded', 'imports recorded')} a single statement period across more than one account (${names}), so per-account statement coverage cannot be established from ${plural(count, 'that import', 'those imports')}. This describes how the data was stored, not a mistake, and it applies to the whole workspace rather than to the current filters.`,
      tone: 'info',
    });
  }

  if (flags.sessionsMissingStatementRange > 0) {
    const count = flags.sessionsMissingStatementRange;
    warnings.push({
      id: 'missing-statement-range',
      title: 'Some imports have no confirmed statement period',
      body: `${formatCount(count)} ${plural(count, 'import does', 'imports do')} not record a statement start and end date, so ${plural(count, 'it', 'they')} cannot establish coverage. Month completeness is never guessed from transaction dates.`,
      tone: 'info',
    });
  }

  if (flags.sessionsWithMalformedStatementRange > 0) {
    const count = flags.sessionsWithMalformedStatementRange;
    warnings.push({
      id: 'malformed-statement-range',
      title: 'Some statement periods could not be read',
      body: `${formatCount(count)} ${plural(count, 'import has', 'imports have')} a statement period that is reversed or is not a real calendar date, so ${plural(count, 'it establishes', 'they establish')} no coverage.`,
      tone: 'caution',
    });
  }

  if (flags.sessionsWithUnattributedStatementRange > 0) {
    const count = flags.sessionsWithUnattributedStatementRange;
    warnings.push({
      id: 'unattributed-statement-range',
      title: 'Some statement periods name no account',
      body: `${formatCount(count)} ${plural(count, 'import records', 'imports record')} a statement period without naming an account, so ${plural(count, 'it establishes', 'they establish')} no coverage.`,
      tone: 'caution',
    });
  }

  if (flags.coverageGap) {
    warnings.push({
      id: 'coverage-gap',
      title: 'There is a gap between imported statements',
      body: 'At least one account has a stretch of time between statements with no imported coverage. Trends are broken across the gap rather than drawn through it.',
      tone: 'caution',
    });
  }

  if (flags.unreviewedCredits > 0) {
    const count = flags.unreviewedCredits;
    warnings.push({
      id: 'unreviewed-credits',
      title: `${formatCount(count)} unreviewed ${plural(count, 'credit', 'credits')}`,
      body: 'Money coming in that has not been identified yet is left out of both spending and income totals until you decide what it is. Income may be understated.',
      tone: 'info',
    });
  }

  if (flags.unreviewedDebits > 0) {
    const count = flags.unreviewedDebits;
    warnings.push({
      id: 'unreviewed-debits',
      title: `${formatCount(count)} unreviewed ${plural(count, 'debit', 'debits')}`,
      body: 'Money going out that has not been identified yet is left out of spending totals until you decide what it is. Spending may be understated.',
      tone: 'info',
    });
  }

  if (flags.excludedIncomeTransactionCount > 0) {
    const count = flags.excludedIncomeTransactionCount;
    warnings.push({
      id: 'excluded-income',
      title: `${formatCount(count)} income ${plural(count, 'transaction is', 'transactions are')} excluded`,
      body: `${plural(count, 'An income transaction is', 'Income transactions are')} flagged as excluded from spending totals, which also removes ${plural(count, 'it', 'them')} from money in. Review ${plural(count, 'it', 'them')} if that is not what you expect.`,
      tone: 'info',
    });
  }

  if (flags.uncategorizedIncludedCents > 0) {
    warnings.push({
      id: 'uncategorized-share',
      title: 'Some included spending is uncategorized',
      body: `${formatCurrency(flags.uncategorizedIncludedCents)} of included spending sits in the uncategorized bucket, so a large "Other" share reflects unreviewed rows rather than behaviour.`,
      tone: 'info',
    });
  }

  if (flags.singleAccountWithPayments) {
    warnings.push({
      id: 'single-account-payments',
      title: 'Only one account is imported, and it holds card payments',
      body: 'Card payments move money between your own accounts. With only one side imported, cash-flow figures describe part of the picture.',
      tone: 'info',
    });
  }

  if (flags.rejectedRowsPresent) {
    warnings.push({
      id: 'rejected-rows',
      title: 'An import rejected some rows',
      body: 'Some rows were not imported, so totals here may not reconcile against the original file. The Import Health Report lists what was rejected.',
      tone: 'info',
    });
  }

  if (flags.insufficientHistory) {
    warnings.push({
      id: 'insufficient-history',
      title: 'Fewer than two complete months are available',
      body: 'Month-over-month comparisons need two consecutive complete calendar months, so they are withheld for now.',
      tone: 'info',
    });
  }

  return warnings;
}
