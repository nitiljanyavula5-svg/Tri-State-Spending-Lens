// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildAccountCoverage,
  completeMonthsForScope,
  coverageForAccount,
  hasCoverageGapForScope,
  isMonthCompleteForScope,
  isRangeCoveredForScope,
} from '../../../src/calculations/completeness';
import {
  ACCOUNTS,
  CHECKING,
  COVERAGE_ADJACENT,
  COVERAGE_CROSS_YEAR,
  COVERAGE_LEAP,
  COVERAGE_LEAP_SHORT,
  COVERAGE_MALFORMED,
  COVERAGE_MISSING,
  COVERAGE_OVERLAPPING,
  COVERAGE_PARTIAL_MAY,
  COVERAGE_SPANNING,
  COVERAGE_TWO_MONTHS,
  range,
  rangesForAll,
} from './fixtures';

/**
 * Statement coverage, against calculation-contract.md §14.2, §14.3, and §14.11.
 *
 * The rule under test is that completeness comes from confirmed statement
 * ranges and never from transaction dates. Not one case here supplies a
 * transaction, which is the point.
 *
 * Coverage is stored per account. These tests use the default fixture scope
 * (every account), so they exercise the merge and validation rules;
 * `accountCoverage.test.ts` exercises the account-scoping rules themselves.
 */

const SCOPE = ACCOUNTS.map((account) => account.id).sort();

/** Spans as recorded for one account — the shape merging actually produces. */
const spansFor = (ranges: Parameters<typeof buildAccountCoverage>[0], accountId = CHECKING) =>
  coverageForAccount(buildAccountCoverage(ranges), accountId).spans;

describe('validating statement ranges', () => {
  it('accepts a well-formed range', () => {
    const coverage = buildAccountCoverage([range('2026-05-01', '2026-05-31')]);
    expect(coverageForAccount(coverage, CHECKING).spans).toEqual([
      { start: '2026-05-01', end: '2026-05-31' },
    ]);
    expect(coverage.missingEndpoints).toBe(0);
    expect(coverage.malformed).toBe(0);
  });

  it('contributes nothing when an endpoint is absent', () => {
    const coverage = buildAccountCoverage(COVERAGE_MISSING);
    expect(coverage.byAccount.size).toBe(0);
    expect(coverage.missingEndpoints).toBe(2);
  });

  it('treats an empty-string endpoint as absent', () => {
    const coverage = buildAccountCoverage([range('', '2026-05-31')]);
    expect(coverage.byAccount.size).toBe(0);
    expect(coverage.missingEndpoints).toBe(1);
  });

  it('rejects reversed and non-calendar ranges without establishing coverage', () => {
    const coverage = buildAccountCoverage(COVERAGE_MALFORMED);
    expect(coverage.byAccount.size).toBe(0);
    expect(coverage.malformed).toBe(2);
  });

  it('accepts a single-day range', () => {
    expect(spansFor([range('2026-05-04', '2026-05-04')])).toHaveLength(1);
  });
});

describe('merging coverage', () => {
  it('merges overlapping ranges without double-counting the intersection', () => {
    expect(spansFor(COVERAGE_OVERLAPPING)).toEqual([{ start: '2026-05-01', end: '2026-05-31' }]);
  });

  it('merges adjacent ranges that touch without overlapping', () => {
    expect(spansFor(COVERAGE_ADJACENT)).toEqual([{ start: '2026-05-01', end: '2026-05-31' }]);
  });

  it('merges across a month boundary', () => {
    expect(spansFor(COVERAGE_TWO_MONTHS)).toEqual([{ start: '2026-04-01', end: '2026-05-31' }]);
  });

  it('merges across a year boundary', () => {
    expect(spansFor(COVERAGE_CROSS_YEAR)).toEqual([{ start: '2026-12-01', end: '2027-01-31' }]);
  });

  it('keeps a genuine gap as two spans', () => {
    const ranges = [range('2026-05-01', '2026-05-10'), range('2026-05-20', '2026-05-31')];
    expect(spansFor(ranges)).toHaveLength(2);
    expect(hasCoverageGapForScope(buildAccountCoverage(ranges), SCOPE)).toBe(true);
  });

  it('reports no gap for continuous coverage', () => {
    expect(hasCoverageGapForScope(buildAccountCoverage(COVERAGE_ADJACENT), SCOPE)).toBe(false);
  });

  it('is unaffected by the order ranges arrive in', () => {
    expect(spansFor([...COVERAGE_TWO_MONTHS].reverse())).toEqual(spansFor(COVERAGE_TWO_MONTHS));
  });

  it('swallows a range fully contained in another', () => {
    expect(
      spansFor([range('2026-05-01', '2026-05-31'), range('2026-05-10', '2026-05-12')]),
    ).toEqual([{ start: '2026-05-01', end: '2026-05-31' }]);
  });
});

describe('month completeness', () => {
  it('is complete when the whole month is covered', () => {
    const coverage = buildAccountCoverage(COVERAGE_TWO_MONTHS);
    expect(isMonthCompleteForScope('2026-05', coverage, SCOPE)).toBe(true);
    expect(isMonthCompleteForScope('2026-04', coverage, SCOPE)).toBe(true);
  });

  it('is incomplete when the statement starts mid-month', () => {
    expect(
      isMonthCompleteForScope('2026-05', buildAccountCoverage(COVERAGE_PARTIAL_MAY), SCOPE),
    ).toBe(false);
  });

  it('is incomplete when range metadata is missing, never complete', () => {
    expect(isMonthCompleteForScope('2026-05', buildAccountCoverage(COVERAGE_MISSING), SCOPE)).toBe(
      false,
    );
  });

  it('is incomplete when the range is malformed', () => {
    expect(
      isMonthCompleteForScope('2026-05', buildAccountCoverage(COVERAGE_MALFORMED), SCOPE),
    ).toBe(false);
  });

  it('requires February 29 in a leap year', () => {
    expect(isMonthCompleteForScope('2028-02', buildAccountCoverage(COVERAGE_LEAP), SCOPE)).toBe(
      true,
    );
    expect(
      isMonthCompleteForScope('2028-02', buildAccountCoverage(COVERAGE_LEAP_SHORT), SCOPE),
    ).toBe(false);
  });

  it('accepts adjacent statements as one complete month', () => {
    expect(isMonthCompleteForScope('2026-05', buildAccountCoverage(COVERAGE_ADJACENT), SCOPE)).toBe(
      true,
    );
  });
});

describe('complete month sets', () => {
  const monthsFor = (ranges: Parameters<typeof buildAccountCoverage>[0]) =>
    [...completeMonthsForScope(buildAccountCoverage(ranges), SCOPE)].sort();

  it('lists both months of a spanning statement', () => {
    expect(monthsFor(COVERAGE_SPANNING)).toEqual(['2026-04', '2026-05']);
  });

  it('lists both months given separately', () => {
    expect(monthsFor(COVERAGE_TWO_MONTHS)).toEqual(['2026-04', '2026-05']);
  });

  it('omits a month the statement only partly covers', () => {
    expect(monthsFor(rangesForAll('2026-04-01', '2026-05-15'))).toEqual(['2026-04']);
  });

  it('is empty when no range is usable', () => {
    expect(monthsFor(COVERAGE_MISSING)).toEqual([]);
    expect(monthsFor(COVERAGE_MALFORMED)).toEqual([]);
    expect(monthsFor([])).toEqual([]);
  });

  it('spans a year boundary', () => {
    expect(monthsFor(COVERAGE_CROSS_YEAR)).toEqual(['2026-12', '2027-01']);
  });

  it('includes a leap February only when the 29th is covered', () => {
    expect(monthsFor(COVERAGE_LEAP)).toEqual(['2028-02']);
    expect(monthsFor(COVERAGE_LEAP_SHORT)).toEqual([]);
  });
});

describe('arbitrary range coverage', () => {
  it('covers a range inside a span', () => {
    const coverage = buildAccountCoverage(COVERAGE_TWO_MONTHS);
    expect(
      isRangeCoveredForScope({ start: '2026-04-15', end: '2026-05-15' }, coverage, SCOPE),
    ).toBe(true);
  });

  it('does not cover a range extending past the span', () => {
    const coverage = buildAccountCoverage(COVERAGE_TWO_MONTHS);
    expect(
      isRangeCoveredForScope({ start: '2026-05-15', end: '2026-06-15' }, coverage, SCOPE),
    ).toBe(false);
  });

  it('does not cover a range straddling a gap', () => {
    const coverage = buildAccountCoverage([
      range('2026-05-01', '2026-05-10'),
      range('2026-05-20', '2026-05-31'),
    ]);
    expect(
      isRangeCoveredForScope({ start: '2026-05-05', end: '2026-05-25' }, coverage, SCOPE),
    ).toBe(false);
  });

  it('rejects an inverted range', () => {
    const coverage = buildAccountCoverage(COVERAGE_TWO_MONTHS);
    expect(
      isRangeCoveredForScope({ start: '2026-05-31', end: '2026-05-01' }, coverage, SCOPE),
    ).toBe(false);
  });
});
