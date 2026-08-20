// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  accountsInScope,
  accountsMissingCoverage,
  buildAccountCoverage,
  completeMonthsForScope,
  coverageForAccount,
  isMonthCompleteForScope,
  normalizeRangeAccountIds,
} from '../../../src/calculations/completeness';
import { selectDashboard } from '../../../src/calculations/selectors';
import type { AccountScope, DashboardInput } from '../../../src/calculations/types';
import {
  ACCOUNTS,
  CARD,
  CHECKING,
  COVERAGE_AMBIGUOUS_CANNOT_FILL,
  COVERAGE_AMBIGUOUS_PAIR,
  COVERAGE_BOTH_COMPLETE_PIECEWISE,
  COVERAGE_BOTH_COMPLETE_SEPARATELY,
  COVERAGE_DUPLICATE_ID,
  COVERAGE_MALFORMED,
  COVERAGE_MALFORMED_MULTI,
  COVERAGE_MISSING,
  COVERAGE_ONE_COMPLETE_ONE_PARTIAL,
  COVERAGE_PARTIAL_MAY,
  COVERAGE_PRIOR_INCOMPLETE_ONE_ACCOUNT,
  COVERAGE_SPLIT_HALVES,
  COVERAGE_UNATTRIBUTED,
  MAY,
  purchase,
  range,
  rangesForAll,
  resetIds,
  SAVINGS,
  shuffle,
} from './fixtures';

/**
 * Account-scoped statement coverage, against calculation-contract.md §14.11.
 *
 * The defect this file exists to prevent is coverage stitching. Merging every
 * account's statement ranges into one union lets
 *
 *   Account A: January 1–15
 *   Account B: January 16–31
 *
 * report a complete January that neither account has — and a figure spanning
 * both accounts would then hide half of each account's activity behind a
 * "complete" label. Every test below is a variation on that failure.
 */

const TWO_ACCOUNTS: AccountScope[] = [
  { id: CHECKING, archived: false },
  { id: CARD, archived: false },
];

function dashboard(overrides: Partial<DashboardInput> = {}) {
  resetIds();
  const input: DashboardInput = {
    transactions: [purchase(1_000, { postedDate: '2026-05-10', accountId: CHECKING })],
    filters: { range: MAY },
    incomeCompleteness: 'confirmed-complete',
    coverage: COVERAGE_BOTH_COMPLETE_SEPARATELY,
    accounts: TWO_ACCOUNTS,
    granularity: 'month',
    ...overrides,
  };
  return selectDashboard(input);
}

describe('1. one account with full-month coverage', () => {
  it('is complete', () => {
    const coverage = buildAccountCoverage([range('2026-05-01', '2026-05-31', [CHECKING])]);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(true);
  });
});

describe('2. one account with partial coverage', () => {
  it('is incomplete', () => {
    const coverage = buildAccountCoverage([range('2026-05-12', '2026-05-31', [CHECKING])]);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(false);
  });
});

describe('3. two accounts covering opposite halves', () => {
  const coverage = buildAccountCoverage(COVERAGE_SPLIT_HALVES);

  it('is incomplete for the combined scope, even though the union spans the month', () => {
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING, CARD])).toBe(false);
  });

  it('is incomplete for each account individually', () => {
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(false);
    expect(isMonthCompleteForScope('2026-05', coverage, [CARD])).toBe(false);
  });

  it('names both accounts as missing coverage', () => {
    expect(accountsMissingCoverage(MAY, coverage, [CHECKING, CARD]).sort()).toEqual(
      [CARD, CHECKING].sort(),
    );
  });

  it('does not let one account fill the other half', () => {
    // Checking holds 1–15 only; the card's 16–31 must not complete it.
    expect(coverageForAccount(coverage, CHECKING).spans).toEqual([
      { start: '2026-05-01', end: '2026-05-15' },
    ]);
  });
});

describe('4. account A complete, account B partial, no account filter', () => {
  it('is incomplete', () => {
    const selection = dashboard({ coverage: COVERAGE_ONE_COMPLETE_ONE_PARTIAL });
    expect(selection.dataQuality.partialMonth).toBe(true);
    expect(selection.dataQuality.accountsWithIncompleteCoverage).toEqual([CARD]);
  });
});

describe('5. the same fixture filtered to account A', () => {
  it('is complete', () => {
    const selection = dashboard({
      coverage: COVERAGE_ONE_COMPLETE_ONE_PARTIAL,
      filters: { range: MAY, accountIds: [CHECKING] },
    });
    expect(selection.dataQuality.partialMonth).toBe(false);
    expect(selection.dataQuality.accountsWithIncompleteCoverage).toEqual([]);
  });
});

describe('6. the same fixture filtered to account B', () => {
  it('is incomplete', () => {
    const selection = dashboard({
      coverage: COVERAGE_ONE_COMPLETE_ONE_PARTIAL,
      filters: { range: MAY, accountIds: [CARD] },
    });
    expect(selection.dataQuality.partialMonth).toBe(true);
    expect(selection.dataQuality.accountsWithIncompleteCoverage).toEqual([CARD]);
  });
});

describe('7. two accounts each independently complete', () => {
  it('is complete when reached through separate sessions', () => {
    const coverage = buildAccountCoverage(COVERAGE_BOTH_COMPLETE_SEPARATELY);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING, CARD])).toBe(true);
  });

  it('is complete when reached piecewise through overlapping and adjacent sessions', () => {
    const coverage = buildAccountCoverage(COVERAGE_BOTH_COMPLETE_PIECEWISE);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING, CARD])).toBe(true);
    // Each account merged to exactly one span, so neither reports a gap.
    expect(coverageForAccount(coverage, CHECKING).spans).toHaveLength(1);
    expect(coverageForAccount(coverage, CARD).spans).toHaveLength(1);
  });
});

describe('8. current month complete for all, prior month incomplete for one', () => {
  it('withholds the comparison', () => {
    const selection = dashboard({ coverage: COVERAGE_PRIOR_INCOMPLETE_ONE_ACCOUNT });
    expect(selection.dataQuality.partialMonth).toBe(false);
    expect(selection.comparison).toEqual({ available: false, reason: 'prior-month-incomplete' });
  });

  it('offers the comparison when filtered to the account whose April is complete', () => {
    const selection = dashboard({
      coverage: COVERAGE_PRIOR_INCOMPLETE_ONE_ACCOUNT,
      filters: { range: MAY, accountIds: [CHECKING] },
    });
    expect(selection.comparison.available).toBe(true);
  });
});

describe('9. coverage from an unselected account cannot complete the selected one', () => {
  it('leaves the selected account incomplete', () => {
    const coverage = buildAccountCoverage([
      range('2026-05-01', '2026-05-31', [CHECKING]),
      range('2026-05-12', '2026-05-31', [CARD]),
    ]);
    // Checking's complete May is irrelevant to a card-only question.
    expect(isMonthCompleteForScope('2026-05', coverage, [CARD])).toBe(false);
  });

  it('does not admit a third account never named by any session', () => {
    const coverage = buildAccountCoverage([range('2026-05-01', '2026-05-31', [CHECKING, CARD])]);
    expect(isMonthCompleteForScope('2026-05', coverage, [SAVINGS])).toBe(false);
    expect(coverageForAccount(coverage, SAVINGS).spans).toEqual([]);
  });
});

describe('10. category filters never change account coverage', () => {
  it('does not manufacture coverage', () => {
    const withoutCategory = dashboard({ coverage: COVERAGE_ONE_COMPLETE_ONE_PARTIAL });
    const withCategory = dashboard({
      coverage: COVERAGE_ONE_COMPLETE_ONE_PARTIAL,
      filters: { range: MAY, categoryIds: ['groceries'] },
    });
    expect(withCategory.dataQuality.partialMonth).toBe(withoutCategory.dataQuality.partialMonth);
    expect(withCategory.dataQuality.accountsWithIncompleteCoverage).toEqual(
      withoutCategory.dataQuality.accountsWithIncompleteCoverage,
    );
  });

  it('does not remove coverage', () => {
    const plain = dashboard({ coverage: COVERAGE_BOTH_COMPLETE_SEPARATELY });
    const filtered = dashboard({
      coverage: COVERAGE_BOTH_COMPLETE_SEPARATELY,
      filters: { range: MAY, categoryIds: ['dining'] },
    });
    expect(plain.dataQuality.partialMonth).toBe(false);
    expect(filtered.dataQuality.partialMonth).toBe(false);
  });

  it('leaves the account scope identical', () => {
    expect(accountsInScope(TWO_ACCOUNTS, { range: MAY, categoryIds: ['dining'] })).toEqual(
      accountsInScope(TWO_ACCOUNTS, { range: MAY }),
    );
  });
});

describe('11. shuffled session and transaction input', () => {
  it('produces deeply equal output', () => {
    const base: DashboardInput = {
      transactions: [
        purchase(1_000, { postedDate: '2026-05-02', accountId: CHECKING }),
        purchase(2_000, { postedDate: '2026-05-09', accountId: CARD }),
        purchase(3_000, { postedDate: '2026-05-16', accountId: CHECKING }),
      ],
      filters: { range: MAY },
      incomeCompleteness: 'confirmed-complete',
      coverage: COVERAGE_BOTH_COMPLETE_PIECEWISE,
      accounts: TWO_ACCOUNTS,
      granularity: 'week',
    };
    resetIds();
    const forward = selectDashboard(base);
    const shuffled = selectDashboard({
      ...base,
      transactions: shuffle(base.transactions),
      coverage: shuffle(base.coverage),
      accounts: [...base.accounts].reverse(),
    });
    expect(shuffled).toEqual(forward);
  });
});

describe('12. missing and malformed ranges stay attributable to their scope', () => {
  it('counts a missing endpoint without granting coverage to its accounts', () => {
    const coverage = buildAccountCoverage(COVERAGE_MISSING);
    expect(coverage.missingEndpoints).toBe(2);
    expect(coverage.byAccount.size).toBe(0);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(false);
  });

  it('counts a malformed range without granting coverage to its accounts', () => {
    const coverage = buildAccountCoverage(COVERAGE_MALFORMED);
    expect(coverage.malformed).toBe(2);
    expect(coverage.byAccount.size).toBe(0);
  });

  it('leaves other accounts unaffected by one accountial malformed range', () => {
    const coverage = buildAccountCoverage([
      range('2026-05-01', '2026-05-31', [CHECKING]),
      range('2026-05-31', '2026-05-01', [CARD]),
    ]);
    expect(coverage.malformed).toBe(1);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(true);
    expect(isMonthCompleteForScope('2026-05', coverage, [CARD])).toBe(false);
  });

  it('surfaces the counts through data quality', () => {
    const selection = dashboard({ coverage: COVERAGE_MISSING });
    expect(selection.dataQuality.sessionsMissingStatementRange).toBe(2);
    expect(selection.dataQuality.partialMonth).toBe(true);
  });
});

describe('scope definition', () => {
  it('excludes archived accounts when no filter is applied', () => {
    const accounts: AccountScope[] = [
      { id: CHECKING, archived: false },
      { id: CARD, archived: true },
    ];
    expect(accountsInScope(accounts, { range: MAY })).toEqual([CHECKING]);
  });

  it('respects an explicit filter even for an archived account', () => {
    const accounts: AccountScope[] = [
      { id: CHECKING, archived: false },
      { id: CARD, archived: true },
    ];
    // The user asked for it by name; the archived flag is a default, not a veto.
    expect(accountsInScope(accounts, { range: MAY, accountIds: [CARD] })).toEqual([CARD]);
  });

  it('is deterministically ordered', () => {
    expect(accountsInScope(ACCOUNTS, { range: MAY })).toEqual(
      accountsInScope([...ACCOUNTS].reverse(), { range: MAY }),
    );
  });

  it('treats an empty scope as never complete', () => {
    const coverage = buildAccountCoverage([range('2026-05-01', '2026-05-31', [CHECKING])]);
    // Vacuous truth must not be reported as a measured month.
    expect(isMonthCompleteForScope('2026-05', coverage, [])).toBe(false);
    expect(completeMonthsForScope(coverage, []).size).toBe(0);
  });

  it('reports a partial month when every account is archived', () => {
    const selection = dashboard({
      accounts: [
        { id: CHECKING, archived: true },
        { id: CARD, archived: true },
      ],
    });
    expect(selection.dataQuality.partialMonth).toBe(true);
  });
});

describe('complete month sets are scope-wide', () => {
  it('lists only months every scoped account covers', () => {
    const coverage = buildAccountCoverage([
      range('2026-04-01', '2026-05-31', [CHECKING]),
      range('2026-05-01', '2026-05-31', [CARD]),
    ]);
    expect([...completeMonthsForScope(coverage, [CHECKING, CARD])]).toEqual(['2026-05']);
    expect([...completeMonthsForScope(coverage, [CHECKING])].sort()).toEqual([
      '2026-04',
      '2026-05',
    ]);
  });

  it('is empty when the halves are split across accounts', () => {
    const coverage = buildAccountCoverage(COVERAGE_SPLIT_HALVES);
    expect(completeMonthsForScope(coverage, [CHECKING, CARD]).size).toBe(0);
  });

  it('drives the insufficient-history warning from the scoped set', () => {
    const selection = dashboard({ coverage: COVERAGE_PARTIAL_MAY });
    expect(selection.dataQuality.insufficientHistory).toBe(true);
  });
});

/**
 * Ambiguous multi-account statement ranges, against §14.11.
 *
 * `ImportSession.accountIds` is lossless for *identity* but a session stores one
 * range however many accounts it names, so a multi-account range cannot say what
 * period any individual statement covered. Crediting it to every account is how
 * a January checking statement comes to vouch for a card statement that began on
 * the 12th. These tests hold the conservative line: such a range completes
 * nothing, fills nothing, enables no comparison, and is reported rather than
 * silently dropped.
 */
describe('ambiguous multi-account statement ranges', () => {
  it('1. a single-account full-month range completes that account', () => {
    const coverage = buildAccountCoverage([range('2026-05-01', '2026-05-31', [CHECKING])]);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(true);
    expect(coverage.ambiguousMultiAccount).toBe(0);
  });

  it('2. a full-month range naming two accounts completes neither', () => {
    const coverage = buildAccountCoverage(COVERAGE_AMBIGUOUS_PAIR);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(false);
    expect(isMonthCompleteForScope('2026-05', coverage, [CARD])).toBe(false);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING, CARD])).toBe(false);
    // It establishes no coverage at all, so neither account is even recorded.
    expect(coverage.byAccount.size).toBe(0);
  });

  it('3. an ambiguous range cannot fill a partial single-account range', () => {
    const coverage = buildAccountCoverage(COVERAGE_AMBIGUOUS_CANNOT_FILL);
    // Checking legitimately holds 12–31; the ambiguous 1–11 must not extend it.
    expect(coverageForAccount(coverage, CHECKING).spans).toEqual([
      { start: '2026-05-12', end: '2026-05-31' },
    ]);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(false);
  });

  it('4. two independent single-account ranges complete two accounts', () => {
    const coverage = buildAccountCoverage([
      range('2026-05-01', '2026-05-31', [CHECKING]),
      range('2026-05-01', '2026-05-31', [CARD]),
    ]);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING, CARD])).toBe(true);
    expect(coverage.ambiguousMultiAccount).toBe(0);
  });

  it('5. a duplicated account id normalizes to one usable account', () => {
    expect(normalizeRangeAccountIds([CHECKING, CHECKING])).toEqual([CHECKING]);
    const coverage = buildAccountCoverage(COVERAGE_DUPLICATE_ID);
    expect(coverage.ambiguousMultiAccount).toBe(0);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(true);
  });

  it('6. the ambiguous range count is exact', () => {
    const coverage = buildAccountCoverage([
      range('2026-05-01', '2026-05-31', [CHECKING]),
      range('2026-05-01', '2026-05-31', [CHECKING, CARD]),
      range('2026-04-01', '2026-04-30', [CARD, SAVINGS]),
    ]);
    expect(coverage.ambiguousMultiAccount).toBe(2);
  });

  it('7. ambiguous account ids are deduplicated and deterministically ordered', () => {
    const forward = buildAccountCoverage([
      range('2026-05-01', '2026-05-31', [SAVINGS, CHECKING]),
      range('2026-04-01', '2026-04-30', [CARD, CHECKING]),
    ]);
    expect(forward.ambiguousAccountIds).toEqual([CARD, CHECKING, SAVINGS].sort());
    // Same ids however the ranges and their members arrive.
    const reversed = buildAccountCoverage([
      range('2026-04-01', '2026-04-30', [CHECKING, CARD]),
      range('2026-05-01', '2026-05-31', [CHECKING, SAVINGS]),
    ]);
    expect(reversed.ambiguousAccountIds).toEqual(forward.ambiguousAccountIds);
  });

  it('8. filtering to one account does not let an ambiguous range complete it', () => {
    const selection = dashboard({
      coverage: COVERAGE_AMBIGUOUS_PAIR,
      filters: { range: MAY, accountIds: [CHECKING] },
    });
    expect(selection.dataQuality.partialMonth).toBe(true);
    expect(selection.dataQuality.accountsWithIncompleteCoverage).toEqual([CHECKING]);
  });

  it('9. category filtering changes neither ambiguity nor coverage', () => {
    const plain = dashboard({ coverage: COVERAGE_AMBIGUOUS_PAIR });
    const filtered = dashboard({
      coverage: COVERAGE_AMBIGUOUS_PAIR,
      filters: { range: MAY, categoryIds: ['groceries'] },
    });
    expect(filtered.dataQuality.ambiguousMultiAccountStatementRangeCount).toBe(
      plain.dataQuality.ambiguousMultiAccountStatementRangeCount,
    );
    expect(filtered.dataQuality.accountsWithAmbiguousStatementCoverage).toEqual(
      plain.dataQuality.accountsWithAmbiguousStatementCoverage,
    );
    expect(filtered.dataQuality.partialMonth).toBe(plain.dataQuality.partialMonth);
  });

  it('10. an ambiguous current month leaves the comparison unavailable', () => {
    const selection = dashboard({
      coverage: [
        ...rangesForAll('2026-04-01', '2026-04-30', [CHECKING, CARD]),
        range('2026-05-01', '2026-05-31', [CHECKING, CARD]),
      ],
    });
    expect(selection.comparison).toEqual({ available: false, reason: 'partial-month' });
  });

  it('11. an ambiguous prior month leaves the comparison unavailable', () => {
    const selection = dashboard({
      coverage: [
        range('2026-04-01', '2026-04-30', [CHECKING, CARD]),
        ...rangesForAll('2026-05-01', '2026-05-31', [CHECKING, CARD]),
      ],
    });
    expect(selection.comparison).toEqual({ available: false, reason: 'prior-month-incomplete' });
  });

  it('12. reversed and shuffled input produce deeply equal output', () => {
    const base: DashboardInput = {
      transactions: [
        purchase(1_000, { postedDate: '2026-05-02', accountId: CHECKING }),
        purchase(2_000, { postedDate: '2026-05-19', accountId: CARD }),
      ],
      filters: { range: MAY },
      incomeCompleteness: 'confirmed-complete',
      coverage: [
        range('2026-05-01', '2026-05-31', [CHECKING]),
        range('2026-05-01', '2026-05-31', [CARD, SAVINGS]),
        range('2026-04-01', '2026-04-30', [CHECKING]),
      ],
      accounts: TWO_ACCOUNTS,
      granularity: 'week',
    };
    resetIds();
    const forward = selectDashboard(base);
    const reversed = selectDashboard({ ...base, coverage: [...base.coverage].reverse() });
    const shuffled = selectDashboard({ ...base, coverage: shuffle(base.coverage, 5) });
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('13. an unattributed range fails safely', () => {
    const coverage = buildAccountCoverage(COVERAGE_UNATTRIBUTED);
    expect(coverage.unattributed).toBe(1);
    expect(coverage.ambiguousMultiAccount).toBe(0);
    expect(coverage.byAccount.size).toBe(0);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(false);
    const selection = dashboard({ coverage: COVERAGE_UNATTRIBUTED });
    expect(selection.dataQuality.sessionsWithUnattributedStatementRange).toBe(1);
  });

  it('14. malformed dates take precedence over ambiguity, without double-counting', () => {
    const coverage = buildAccountCoverage(COVERAGE_MALFORMED_MULTI);
    // A range with unusable dates carries no period, so its attribution is moot.
    expect(coverage.malformed).toBe(1);
    expect(coverage.ambiguousMultiAccount).toBe(0);
    expect(coverage.ambiguousAccountIds).toEqual([]);
    expect(coverage.byAccount.size).toBe(0);
  });

  it('14b. a missing endpoint also takes precedence over ambiguity', () => {
    const coverage = buildAccountCoverage([range('2026-05-01', undefined, [CHECKING, CARD])]);
    expect(coverage.missingEndpoints).toBe(1);
    expect(coverage.ambiguousMultiAccount).toBe(0);
  });

  it('15. valid single-account coverage survives an unrelated ambiguous session', () => {
    const coverage = buildAccountCoverage([
      range('2026-05-01', '2026-05-31', [CHECKING]),
      range('2026-05-01', '2026-05-31', [CARD, SAVINGS]),
    ]);
    expect(isMonthCompleteForScope('2026-05', coverage, [CHECKING])).toBe(true);
    expect(isMonthCompleteForScope('2026-05', coverage, [CARD])).toBe(false);
    expect(coverage.ambiguousMultiAccount).toBe(1);
    expect(coverage.ambiguousAccountIds).toEqual([CARD, SAVINGS].sort());
  });

  it('reports zero and empty when nothing is ambiguous', () => {
    const selection = dashboard({ coverage: COVERAGE_BOTH_COMPLETE_SEPARATELY });
    expect(selection.dataQuality.ambiguousMultiAccountStatementRangeCount).toBe(0);
    expect(selection.dataQuality.accountsWithAmbiguousStatementCoverage).toEqual([]);
    expect(selection.dataQuality.sessionsWithUnattributedStatementRange).toBe(0);
  });

  it('surfaces ambiguity through data quality without blaming anyone', () => {
    const selection = dashboard({ coverage: COVERAGE_AMBIGUOUS_PAIR });
    expect(selection.dataQuality.ambiguousMultiAccountStatementRangeCount).toBe(1);
    expect(selection.dataQuality.accountsWithAmbiguousStatementCoverage).toEqual(
      [CARD, CHECKING].sort(),
    );
    // The month reads incomplete, and the metadata says why.
    expect(selection.dataQuality.partialMonth).toBe(true);
  });
});
