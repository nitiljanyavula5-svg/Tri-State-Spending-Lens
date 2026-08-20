// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  countUnusableDates,
  normalizeDashboardFilters,
  selectPopulation,
  toTransactionFilters,
} from '../../../src/calculations/population';
import { MAX_FILTER_VALUES } from '../../../src/db/transactionQueries';
import { MAY, purchase, resetIds, shuffle, tx } from './fixtures';

/**
 * The filtered population, against calculation-contract.md §1 rule 1.
 *
 * The inclusion predicate is the review layer's `matchesFilters`. These tests
 * assert the behaviour that reuse buys — inclusive bounds, bounded lists — and
 * one thing reuse must *not* buy: the dashboard cannot express a kind, tag,
 * treatment, or search filter, because a net-spending figure computed with
 * transfers filtered in has no contract definition.
 */

describe('normalizing filters', () => {
  it('collapses an empty selection to undefined rather than to "match nothing"', () => {
    const normalized = normalizeDashboardFilters({ range: MAY, accountIds: [], categoryIds: [] });
    expect(normalized.accountIds).toBeUndefined();
    expect(normalized.categoryIds).toBeUndefined();
  });

  it('removes duplicate ids', () => {
    const normalized = normalizeDashboardFilters({ range: MAY, accountIds: ['a', 'a', 'b'] });
    expect(normalized.accountIds).toEqual(['a', 'b']);
  });

  it('bounds a list at the same ceiling the review layer applies', () => {
    const many = Array.from({ length: MAX_FILTER_VALUES + 25 }, (_, i) => `acct-${i}`);
    const normalized = normalizeDashboardFilters({ range: MAY, accountIds: many });
    expect(normalized.accountIds).toHaveLength(MAX_FILTER_VALUES);
  });

  it('preserves the range untouched', () => {
    expect(normalizeDashboardFilters({ range: MAY }).range).toEqual(MAY);
  });
});

describe('translating to review-layer filters', () => {
  it('produces only date, account, and category keys', () => {
    const filters = toTransactionFilters({
      range: MAY,
      accountIds: ['acct-checking'],
      categoryIds: ['dining'],
    });
    expect(Object.keys(filters).sort()).toEqual([
      'accountIds',
      'categoryIds',
      'dateFrom',
      'dateTo',
    ]);
  });

  it('never sets search, kinds, tags, treatments, or needsReview', () => {
    const filters = toTransactionFilters({ range: MAY }) as Record<string, unknown>;
    expect(filters.search).toBeUndefined();
    expect(filters.kinds).toBeUndefined();
    expect(filters.tags).toBeUndefined();
    expect(filters.treatments).toBeUndefined();
    expect(filters.needsReview).toBeUndefined();
  });

  it('maps the range to inclusive date bounds', () => {
    const filters = toTransactionFilters({ range: MAY });
    expect(filters.dateFrom).toBe('2026-05-01');
    expect(filters.dateTo).toBe('2026-05-31');
  });
});

describe('selecting the population', () => {
  it('includes both endpoint dates', () => {
    resetIds();
    const rows = [
      purchase(100, { postedDate: '2026-05-01' }),
      purchase(200, { postedDate: '2026-05-31' }),
      purchase(300, { postedDate: '2026-04-30' }),
      purchase(400, { postedDate: '2026-06-01' }),
    ];
    const population = selectPopulation(rows, { range: MAY });
    expect(population.map((row) => row.amountCents)).toEqual([100, 200]);
  });

  it('filters by account', () => {
    resetIds();
    const rows = [
      purchase(100, { accountId: 'acct-checking' }),
      purchase(200, { accountId: 'acct-card' }),
    ];
    const population = selectPopulation(rows, { range: MAY, accountIds: ['acct-card'] });
    expect(population.map((row) => row.amountCents)).toEqual([200]);
  });

  it('filters by category', () => {
    resetIds();
    const rows = [
      purchase(100, { categoryId: 'groceries' }),
      purchase(200, { categoryId: 'dining' }),
    ];
    const population = selectPopulation(rows, { range: MAY, categoryIds: ['dining'] });
    expect(population.map((row) => row.amountCents)).toEqual([200]);
  });

  it('applies account and category filters together', () => {
    resetIds();
    const rows = [
      purchase(100, { accountId: 'acct-checking', categoryId: 'dining' }),
      purchase(200, { accountId: 'acct-card', categoryId: 'dining' }),
      purchase(300, { accountId: 'acct-checking', categoryId: 'groceries' }),
    ];
    const population = selectPopulation(rows, {
      range: MAY,
      accountIds: ['acct-checking'],
      categoryIds: ['dining'],
    });
    expect(population.map((row) => row.amountCents)).toEqual([100]);
  });

  it('treats an empty filter list as no filter', () => {
    resetIds();
    const rows = [purchase(100), purchase(200)];
    expect(selectPopulation(rows, { range: MAY, accountIds: [] })).toHaveLength(2);
  });

  it('returns an empty population when nothing matches', () => {
    resetIds();
    expect(selectPopulation([purchase(100)], { range: MAY, accountIds: ['nope'] })).toEqual([]);
  });

  it('drops a row whose posted date is not a real calendar date', () => {
    resetIds();
    const rows = [
      purchase(100, { postedDate: '2026-05-10' }),
      purchase(200, { postedDate: '2026-02-30' }),
    ];
    const population = selectPopulation(rows, {
      range: { start: '2026-01-01', end: '2026-12-31' },
    });
    expect(population.map((row) => row.amountCents)).toEqual([100]);
    expect(countUnusableDates(rows)).toBe(1);
  });

  it('orders by posted date then id, whatever order the input arrives in', () => {
    resetIds();
    const rows = [
      tx({ id: 'c', postedDate: '2026-05-20' }),
      tx({ id: 'a', postedDate: '2026-05-02' }),
      tx({ id: 'b', postedDate: '2026-05-02' }),
    ];
    const forward = selectPopulation(rows, { range: MAY }).map((row) => row.id);
    const shuffled = selectPopulation(shuffle(rows), { range: MAY }).map((row) => row.id);
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(shuffled).toEqual(forward);
  });

  it('includes rows regardless of kind, because the dashboard cannot filter by kind', () => {
    resetIds();
    const rows = [
      tx({ kind: 'purchase' }),
      tx({ kind: 'transfer' }),
      tx({ kind: 'income', direction: 'credit' }),
      tx({ kind: 'unknown', direction: 'credit' }),
    ];
    // All four are in the population; exclusion happens at the treatment
    // partition, not by dropping rows from the period.
    expect(selectPopulation(rows, { range: MAY })).toHaveLength(4);
  });
});
