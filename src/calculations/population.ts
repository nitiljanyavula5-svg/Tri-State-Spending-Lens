import type { Transaction } from '../types/domain';
import {
  MAX_FILTER_VALUES,
  matchesFilters,
  type TransactionFilters,
} from '../db/transactionQueries';
import type { DashboardFilters, SelectableTransaction } from './types';
import { isIsoDate } from './period';

/**
 * The transactions a dashboard figure is computed from.
 *
 * The inclusion predicate is `matchesFilters`, imported from the review layer
 * rather than rewritten here. calculation-contract.md §1 rule 1 forbids a second
 * implementation of a shared rule, and "which rows are in the period" is exactly
 * such a rule: if the dashboard and the review grid disagreed about it, every
 * drill-through from a card would land on a different set than the card counted,
 * and no amount of internal reconciliation would catch it.
 *
 * The dashboard's filter surface is deliberately narrower than the grid's.
 * `TransactionFilters` also supports kind, tag, treatment, and search filters,
 * and none is exposed here: a "net spending" figure built with a kind filter
 * that admits transfers would be a number the contract has no definition for.
 */

/** Same ceiling the review layer applies, so neither side can be the looser one. */
export { MAX_FILTER_VALUES };

function boundedIds(values: readonly string[] | undefined): readonly string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const unique = [...new Set(values)].slice(0, MAX_FILTER_VALUES);
  return unique.length > 0 ? unique : undefined;
}

/**
 * Canonical filter state.
 *
 * Empty selections collapse to `undefined` rather than to an empty array,
 * because `matchesFilters` reads an empty list as "no filter" and a caller
 * reading it as "match nothing" would be a silent disagreement about an empty
 * multi-select. Duplicates are removed so a bounded list cannot be filled with
 * one repeated id.
 */
export function normalizeDashboardFilters(filters: DashboardFilters): DashboardFilters {
  const accountIds = boundedIds(filters.accountIds);
  const categoryIds = boundedIds(filters.categoryIds);
  return {
    range: filters.range,
    ...(accountIds ? { accountIds } : {}),
    ...(categoryIds ? { categoryIds } : {}),
  };
}

/**
 * The dashboard's filters expressed in the review layer's vocabulary.
 *
 * Only four keys are ever produced. That is what makes the adapter below safe:
 * `matchesFilters` reads `descriptionRaw` only under `search`, `tags` only under
 * `tags`, and `categorySource` only under `needsReview`, and none of those three
 * filters can be set from a `DashboardFilters`.
 */
export function toTransactionFilters(filters: DashboardFilters): TransactionFilters {
  const normalized = normalizeDashboardFilters(filters);
  return {
    dateFrom: normalized.range.start,
    dateTo: normalized.range.end,
    ...(normalized.accountIds ? { accountIds: normalized.accountIds } : {}),
    ...(normalized.categoryIds ? { categoryIds: normalized.categoryIds } : {}),
  };
}

/**
 * A `SelectableTransaction` seen as the row shape `matchesFilters` accepts.
 *
 * The calculation contract pins `SelectableTransaction` to the fields the
 * arithmetic depends on, which is a strict subset of `Transaction`. The absent
 * fields are filled with values that are never read under the four filters this
 * module can produce, and `toTransactionFilters` is the only producer.
 */
function asFilterRow(row: SelectableTransaction): Transaction {
  return {
    id: row.id,
    fingerprint: '',
    importSessionId: '',
    originalRow: 0,
    accountId: row.accountId,
    postedDate: row.postedDate,
    descriptionRaw: '',
    merchantNormalized: row.merchantNormalized,
    amountCents: row.amountCents,
    direction: row.direction,
    kind: row.kind,
    categoryId: row.categoryId,
    categorySource: 'user',
    classificationConfidence: 'none',
    tags: [],
    excludedFromSpending: row.excludedFromSpending,
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * Total ordering by posting date, then id.
 *
 * Every selector downstream is a sum, and a sum does not care about order — but
 * the *outputs* are compared for equality in tests and rendered as lists, so a
 * population that depended on input order would make reconciliation pass or fail
 * according to how Dexie happened to return rows. Sorting here is what makes
 * "shuffled input produces identical output" a property rather than a hope.
 */
function compareRows(a: SelectableTransaction, b: SelectableTransaction): number {
  if (a.postedDate !== b.postedDate) return a.postedDate < b.postedDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The filtered population, in a deterministic order.
 *
 * A row whose `postedDate` is not a real calendar date is dropped: it cannot be
 * placed in a time bucket, and silently bucketing it somewhere would break the
 * time-series reconciliation invariant. Import rejects such dates
 * (data-methodology.md §3.3), so this only fires for restored or hand-edited
 * records — and it is counted by the data-quality selector rather than hidden.
 */
export function selectPopulation(
  transactions: readonly SelectableTransaction[],
  filters: DashboardFilters,
): readonly SelectableTransaction[] {
  const transactionFilters = toTransactionFilters(filters);
  const matched = transactions.filter(
    (row) => isIsoDate(row.postedDate) && matchesFilters(asFilterRow(row), transactionFilters),
  );
  return [...matched].sort(compareRows);
}

/** Rows excluded from the population only because their posted date is unusable. */
export function countUnusableDates(transactions: readonly SelectableTransaction[]): number {
  return transactions.reduce((count, row) => (isIsoDate(row.postedDate) ? count : count + 1), 0);
}
