// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  completeMonthsInRange,
  isUncategorizedShareMaterial,
  selectDataQuality,
  MIN_COMPLETE_MONTHS_FOR_HISTORY,
} from '../../../src/calculations/dataQuality';
import { partitionByTreatment } from '../../../src/calculations/netSpending';
import {
  buildAccountCoverage,
  completeMonthsForScope,
} from '../../../src/calculations/completeness';
import type { DataQualityInput } from '../../../src/calculations/dataQuality';
import type {
  IncomeCompleteness,
  SelectableTransaction,
  StatementRange,
} from '../../../src/calculations/types';
import {
  ACCOUNTS,
  cardPayment,
  COVERAGE_MALFORMED,
  COVERAGE_MISSING,
  COVERAGE_PARTIAL_MAY,
  COVERAGE_TWO_MONTHS,
  income,
  MAY,
  purchase,
  range,
  resetIds,
  unknownCredit,
  unknownDebit,
} from './fixtures';

/** Every account the fixtures transact on, which is the default scope. */
const SCOPE = ACCOUNTS.map((account) => account.id).sort();

/**
 * Data-quality warnings, against data-methodology.md §6 and
 * calculation-contract.md §14.4, §14.7, and §14.10.
 *
 * Two conditions here are Phase 5 additions and are asserted hardest: unknown
 * debits are counted separately from unknown credits because they bias a total
 * the opposite way, and income suppressed by the user-exclusion flag is counted
 * because nothing else on the page would reveal it.
 */

function flagsFor(
  transactions: readonly SelectableTransaction[],
  options: {
    coverage?: readonly StatementRange[];
    incomeCompleteness?: IncomeCompleteness;
    accountCount?: number;
    rejectedRowsPresent?: boolean;
  } = {},
) {
  const ranges = options.coverage ?? COVERAGE_TWO_MONTHS;
  const coverage = buildAccountCoverage(ranges);
  const input: DataQualityInput = {
    population: transactions,
    partition: partitionByTreatment(transactions),
    filters: { range: MAY },
    coverage,
    scope: SCOPE,
    completeMonths: completeMonthsForScope(coverage, SCOPE),
    incomeCompleteness: options.incomeCompleteness ?? 'confirmed-complete',
    accountCount: options.accountCount ?? 2,
    rejectedRowsPresent: options.rejectedRowsPresent ?? false,
  };
  return selectDataQuality(input);
}

describe('unreviewed rows', () => {
  it('counts unknown credits and unknown debits separately', () => {
    resetIds();
    const flags = flagsFor([unknownCredit(1_000), unknownCredit(2_000), unknownDebit(500)]);
    expect(flags.unreviewedCredits).toBe(2);
    expect(flags.unreviewedDebits).toBe(1);
  });

  it('reports zero for both when everything is reviewed', () => {
    resetIds();
    const flags = flagsFor([purchase(1_000), income(2_000)]);
    expect(flags.unreviewedCredits).toBe(0);
    expect(flags.unreviewedDebits).toBe(0);
  });

  it('does not fold an unknown debit into the credit count', () => {
    resetIds();
    const flags = flagsFor([unknownDebit(9_000)]);
    // An unknown debit understates spending; an unknown credit understates
    // income. A single number could not say which way a total is wrong.
    expect(flags.unreviewedCredits).toBe(0);
    expect(flags.unreviewedDebits).toBe(1);
  });
});

describe('income completeness', () => {
  it('flags incomplete income unless completeness is confirmed', () => {
    resetIds();
    expect(
      flagsFor([income(1)], { incomeCompleteness: 'confirmed-complete' }).incompleteIncome,
    ).toBe(false);
    expect(
      flagsFor([income(1)], { incomeCompleteness: 'confirmed-incomplete' }).incompleteIncome,
    ).toBe(true);
    expect(flagsFor([income(1)], { incomeCompleteness: 'unconfirmed' }).incompleteIncome).toBe(
      true,
    );
  });

  it('counts income rows suppressed by the user-exclusion flag', () => {
    resetIds();
    const flags = flagsFor([
      income(400_000, { excludedFromSpending: true }),
      income(50_000),
      purchase(1_000),
    ]);
    expect(flags.excludedIncomeTransactionCount).toBe(1);
  });

  it('reports zero when no income row is flagged', () => {
    resetIds();
    expect(flagsFor([income(50_000)]).excludedIncomeTransactionCount).toBe(0);
  });
});

describe('coverage warnings', () => {
  it('flags a partial month', () => {
    resetIds();
    expect(flagsFor([purchase(1)], { coverage: COVERAGE_PARTIAL_MAY }).partialMonth).toBe(true);
    expect(flagsFor([purchase(1)], { coverage: COVERAGE_TWO_MONTHS }).partialMonth).toBe(false);
  });

  it('flags a partial month when range metadata is missing', () => {
    resetIds();
    // Unknown completeness is never promoted to complete (§14.2).
    expect(flagsFor([purchase(1)], { coverage: COVERAGE_MISSING }).partialMonth).toBe(true);
  });

  it('counts sessions missing an endpoint', () => {
    resetIds();
    expect(
      flagsFor([purchase(1)], { coverage: COVERAGE_MISSING }).sessionsMissingStatementRange,
    ).toBe(2);
  });

  it('counts sessions with a malformed range', () => {
    resetIds();
    const flags = flagsFor([purchase(1)], { coverage: COVERAGE_MALFORMED });
    expect(flags.sessionsWithMalformedStatementRange).toBe(2);
  });

  it('flags a discontinuous coverage gap', () => {
    resetIds();
    const gapped: StatementRange[] = [
      range('2026-05-01', '2026-05-10'),
      range('2026-05-20', '2026-05-31'),
    ];
    expect(flagsFor([purchase(1)], { coverage: gapped }).coverageGap).toBe(true);
    expect(flagsFor([purchase(1)], { coverage: COVERAGE_TWO_MONTHS }).coverageGap).toBe(false);
  });

  it('flags insufficient history below two complete months', () => {
    resetIds();
    const oneMonth: StatementRange[] = [range('2026-05-01', '2026-05-31')];
    expect(flagsFor([purchase(1)], { coverage: oneMonth }).insufficientHistory).toBe(true);
    expect(flagsFor([purchase(1)], { coverage: COVERAGE_TWO_MONTHS }).insufficientHistory).toBe(
      false,
    );
    expect(MIN_COMPLETE_MONTHS_FOR_HISTORY).toBe(2);
  });
});

describe('account and category warnings', () => {
  it('flags a single account holding card payments', () => {
    resetIds();
    expect(flagsFor([cardPayment(9_000)], { accountCount: 1 }).singleAccountWithPayments).toBe(
      true,
    );
    expect(flagsFor([cardPayment(9_000)], { accountCount: 2 }).singleAccountWithPayments).toBe(
      false,
    );
  });

  it('does not flag a single account without payments', () => {
    resetIds();
    expect(flagsFor([purchase(1_000)], { accountCount: 1 }).singleAccountWithPayments).toBe(false);
  });

  it('totals uncategorized included spending', () => {
    resetIds();
    const flags = flagsFor([
      purchase(3_000, { categoryId: 'other' }),
      purchase(7_000, { categoryId: 'groceries' }),
    ]);
    expect(flags.uncategorizedIncludedCents).toBe(3_000);
  });

  it('passes through the rejected-rows signal', () => {
    resetIds();
    expect(flagsFor([purchase(1)], { rejectedRowsPresent: true }).rejectedRowsPresent).toBe(true);
  });
});

describe('uncategorized share', () => {
  it('is material at or above a tenth of gross outflow', () => {
    expect(isUncategorizedShareMaterial(1_000, 10_000)).toBe(true);
    expect(isUncategorizedShareMaterial(999, 10_000)).toBe(false);
  });

  it('is not material when there is no spending to divide by', () => {
    // Zero spending means no share, which is a different claim from "0%".
    expect(isUncategorizedShareMaterial(0, 0)).toBe(false);
  });
});

describe('complete months inside a range', () => {
  it('lists only the complete months the range touches', () => {
    const set = completeMonthsForScope(buildAccountCoverage(COVERAGE_TWO_MONTHS), SCOPE);
    expect(
      completeMonthsInRange({ range: { start: '2026-04-01', end: '2026-06-30' } }, set),
    ).toEqual(['2026-04', '2026-05']);
  });

  it('is empty when no month is complete', () => {
    const set = completeMonthsForScope(buildAccountCoverage(COVERAGE_MISSING), SCOPE);
    expect(completeMonthsInRange({ range: MAY }, set)).toEqual([]);
  });
});
