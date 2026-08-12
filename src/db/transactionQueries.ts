import type { WorkspaceDatabase } from './database';
import type { Transaction, TransactionKind } from '../types/domain';
import { spendingTreatment, type SpendingTreatment } from '../classification/spending';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../domain/reviewLimits';
import { canonicalizeText } from '../import/canonical';

/**
 * Reading transactions for the review interface.
 *
 * The boundary exists so components never query Dexie. That is not tidiness:
 * filters, sorting, and paging have to produce a *deterministic* page, and
 * "deterministic" is a property of one implementation, not of several
 * components that each build a slightly different query.
 *
 * Filter state is transient by construction. Nothing here writes, persists,
 * or serializes a filter — a search term lives in component state, is passed
 * in, and is gone. It never reaches IndexedDB, a URL, or a backup.
 */

/** Longest accepted search string. Bounded like every other user input. */
export const MAX_SEARCH_LENGTH = 200;

/** A page may never exceed this, whatever a caller asks for. */
export const MAX_PAGE_SIZE = Math.max(...PAGE_SIZE_OPTIONS);

/** Filter values a caller may not exceed, so one query cannot be unbounded. */
export const MAX_FILTER_VALUES = 100;

/**
 * Open-ended bounds for an index range query.
 *
 * Written as real ISO dates rather than sentinel characters: stored dates are
 * `YYYY-MM-DD` strings compared lexically, so these genuinely bracket every
 * possible value, and neither one can smuggle a control byte into this file.
 */
const MIN_ISO_DATE = '0000-01-01';
const MAX_ISO_DATE = '9999-12-31';

export interface TransactionFilters {
  /** Matched against the raw description *and* the normalized merchant. */
  readonly search?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly accountIds?: readonly string[];
  readonly kinds?: readonly TransactionKind[];
  readonly categoryIds?: readonly string[];
  readonly tags?: readonly string[];
  /** Spending treatment, as the review interface labels it. */
  readonly treatments?: readonly SpendingTreatment[];
  /** Rows awaiting a decision: uncategorized, or an unreviewed kind. */
  readonly needsReview?: boolean;
}

export type SortField = 'postedDate' | 'amountCents' | 'merchantNormalized' | 'categoryId';
export type SortDirection = 'asc' | 'desc';

export interface TransactionSort {
  readonly field: SortField;
  readonly direction: SortDirection;
}

/** Posting date, newest first — with id as the tie-break that makes it total. */
export const DEFAULT_SORT: TransactionSort = { field: 'postedDate', direction: 'desc' };

export interface TransactionQuery {
  readonly filters?: TransactionFilters;
  readonly sort?: TransactionSort;
  /** Zero-based. */
  readonly page?: number;
  readonly pageSize?: number;
  /**
   * Echoed back on the result.
   *
   * Queries are asynchronous and a user types faster than IndexedDB answers, so
   * the caller compares this against the request it is still waiting for and
   * drops anything older. Without it, a slow response for "PIN" can overwrite
   * the results for "PINEBROOK".
   */
  readonly requestId?: string;
}

export interface TransactionPage {
  readonly rows: readonly Transaction[];
  /** Rows matching the filters, before paging. */
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly sort: TransactionSort;
  readonly requestId: string | undefined;
}

/* --------------------------------------------------------------- filtering - */

function boundedList(values: readonly string[] | undefined): ReadonlySet<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.slice(0, MAX_FILTER_VALUES));
}

/**
 * Whether a row is awaiting a decision.
 *
 * Two independent reasons, both of which the review queue cares about: it was
 * never categorized, or its kind is still `unknown`. A row can be one without
 * being the other.
 */
export function needsReview(row: Transaction): boolean {
  return row.categorySource === 'uncategorized' || row.kind === 'unknown';
}

/**
 * The filter predicate, exported so it can be tested without a database.
 *
 * Search is matched against the canonicalized form of both the raw description
 * and the normalized merchant, so a user who types what they see on the
 * statement finds the row even after it has been renamed — and vice versa.
 */
export function matchesFilters(row: Transaction, filters: TransactionFilters): boolean {
  const search = filters.search?.slice(0, MAX_SEARCH_LENGTH).trim();
  if (search) {
    const needle = canonicalizeText(search);
    if (needle.length > 0) {
      const haystack = `${canonicalizeText(row.descriptionRaw)} ${canonicalizeText(row.merchantNormalized)}`;
      if (!haystack.includes(needle)) return false;
    }
  }

  // ISO dates compare correctly as strings, which is why they are stored that
  // way (data-methodology.md §3.3).
  if (filters.dateFrom && row.postedDate < filters.dateFrom) return false;
  if (filters.dateTo && row.postedDate > filters.dateTo) return false;

  const accounts = boundedList(filters.accountIds);
  if (accounts && !accounts.has(row.accountId)) return false;

  const kinds = boundedList(filters.kinds);
  if (kinds && !kinds.has(row.kind)) return false;

  const categories = boundedList(filters.categoryIds);
  if (categories && !categories.has(row.categoryId)) return false;

  const tags = boundedList(filters.tags);
  if (tags && !row.tags.some((tag) => tags.has(tag))) return false;

  const treatments = boundedList(filters.treatments);
  if (treatments) {
    const treatment = spendingTreatment({
      kind: row.kind,
      direction: row.direction,
      excludedFromSpending: row.excludedFromSpending,
    });
    if (!treatments.has(treatment)) return false;
  }

  if (filters.needsReview === true && !needsReview(row)) return false;
  if (filters.needsReview === false && needsReview(row)) return false;

  return true;
}

/* ----------------------------------------------------------------- sorting - */

function compareBy(field: SortField, a: Transaction, b: Transaction): number {
  switch (field) {
    case 'postedDate':
      return a.postedDate.localeCompare(b.postedDate);
    case 'amountCents':
      return a.amountCents - b.amountCents;
    case 'merchantNormalized':
      return a.merchantNormalized.localeCompare(b.merchantNormalized);
    case 'categoryId':
      return a.categoryId.localeCompare(b.categoryId);
    default:
      return 0;
  }
}

/**
 * Total ordering.
 *
 * The id tie-break is what makes paging trustworthy: without it, two rows on
 * the same date could swap places between page 1 and page 2 and the user would
 * see one row twice and another not at all. The tie-break is always ascending
 * by id regardless of the primary direction, so the order is one sequence.
 */
export function sortTransactions(
  rows: readonly Transaction[],
  sort: TransactionSort = DEFAULT_SORT,
): Transaction[] {
  const factor = sort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const primary = compareBy(sort.field, a, b) * factor;
    return primary !== 0 ? primary : a.id.localeCompare(b.id);
  });
}

/* ---------------------------------------------------------------- querying - */

function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
}

/**
 * One page of transactions.
 *
 * The filtered set is materialized before sorting because a total order over an
 * arbitrary filter cannot be expressed as a single IndexedDB index, and paging
 * on a partial order is what produces duplicated and skipped rows. The set is
 * bounded by the workspace itself, which the import limits cap at 100,000 rows;
 * what leaves this function is never more than one page.
 *
 * A date range narrows the read through the `postedDate` index first, so the
 * common case does not walk the whole table.
 */
export async function queryTransactions(
  db: WorkspaceDatabase,
  query: TransactionQuery = {},
): Promise<TransactionPage> {
  const filters = query.filters ?? {};
  const sort = query.sort ?? DEFAULT_SORT;
  const pageSize = clampPageSize(query.pageSize);

  const source =
    filters.dateFrom || filters.dateTo
      ? db.transactions
          .where('postedDate')
          .between(filters.dateFrom ?? MIN_ISO_DATE, filters.dateTo ?? MAX_ISO_DATE, true, true)
      : db.transactions.toCollection();

  const matched: Transaction[] = [];
  await source.each((row) => {
    if (matchesFilters(row, filters)) matched.push(row);
  });

  const sorted = sortTransactions(matched, sort);
  const totalCount = sorted.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  // A filter change can leave the caller on a page that no longer exists.
  const page = Math.min(Math.max(0, Math.floor(query.page ?? 0)), pageCount - 1);

  return {
    rows: sorted.slice(page * pageSize, page * pageSize + pageSize),
    totalCount,
    page,
    pageSize,
    pageCount,
    sort,
    requestId: query.requestId,
  };
}

/** Distinct tags in the workspace, for the tag filter. Bounded. */
export async function listTransactionTags(db: WorkspaceDatabase): Promise<string[]> {
  const tags = new Set<string>();
  await db.transactions.each((row) => {
    for (const tag of row.tags) {
      if (tags.size < MAX_FILTER_VALUES) tags.add(tag);
    }
  });
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** True when a response belongs to the request the caller is still awaiting. */
export function isCurrentResponse(
  page: TransactionPage,
  awaitingRequestId: string | undefined,
): boolean {
  return page.requestId === awaitingRequestId;
}
