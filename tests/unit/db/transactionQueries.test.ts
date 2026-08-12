import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import {
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  isCurrentResponse,
  listTransactionTags,
  matchesFilters,
  needsReview,
  queryTransactions,
  sortTransactions,
} from '../../../src/db/transactionQueries';
import type { Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * Reading transactions for review.
 *
 * The properties that matter are ordering totality and output boundedness. A
 * partial order makes paging lie — a row appears on two pages while another
 * appears on none — and an unbounded page is what turns a 100,000-row workspace
 * into a frozen tab.
 */

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn-1',
    fingerprint: '0'.repeat(64),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'account-1',
    postedDate: '2026-04-08',
    descriptionRaw: 'PINEBROOK MARKET #114',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1000,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'groceries',
    categorySource: 'user',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('the filter predicate', () => {
  it('searches the raw description and the normalized merchant', () => {
    const row = transaction({
      descriptionRaw: 'SQ *HARBOR BEAN 0413',
      merchantNormalized: 'HARBOR BEAN COFFEE',
    });

    // What the statement said...
    expect(matchesFilters(row, { search: 'SQ *HARBOR' })).toBe(true);
    // ...and what it was renamed to.
    expect(matchesFilters(row, { search: 'coffee' })).toBe(true);
    expect(matchesFilters(row, { search: 'PINEBROOK' })).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    const row = transaction();
    expect(matchesFilters(row, { search: '  pinebrook   market ' })).toBe(true);
  });

  it('filters by date range inclusively', () => {
    const row = transaction({ postedDate: '2026-04-08' });
    expect(matchesFilters(row, { dateFrom: '2026-04-08', dateTo: '2026-04-08' })).toBe(true);
    expect(matchesFilters(row, { dateFrom: '2026-04-09' })).toBe(false);
    expect(matchesFilters(row, { dateTo: '2026-04-07' })).toBe(false);
  });

  it('filters by account, kind, category, and tag', () => {
    const row = transaction({ tags: ['SHARED', 'WEEKLY'] });

    expect(matchesFilters(row, { accountIds: ['account-1'] })).toBe(true);
    expect(matchesFilters(row, { accountIds: ['other'] })).toBe(false);
    expect(matchesFilters(row, { kinds: ['purchase'] })).toBe(true);
    expect(matchesFilters(row, { kinds: ['refund'] })).toBe(false);
    expect(matchesFilters(row, { categoryIds: ['groceries'] })).toBe(true);
    expect(matchesFilters(row, { categoryIds: ['dining'] })).toBe(false);
    expect(matchesFilters(row, { tags: ['WEEKLY'] })).toBe(true);
    expect(matchesFilters(row, { tags: ['MISSING'] })).toBe(false);
  });

  it('filters by spending treatment', () => {
    expect(matchesFilters(transaction(), { treatments: ['included-outflow'] })).toBe(true);
    expect(
      matchesFilters(transaction({ excludedFromSpending: true }), {
        treatments: ['excluded-by-user'],
      }),
    ).toBe(true);
    expect(
      matchesFilters(transaction({ kind: 'transfer' }), { treatments: ['excluded-by-kind'] }),
    ).toBe(true);
    expect(matchesFilters(transaction({ kind: 'unknown' }), { treatments: ['needs-review'] })).toBe(
      true,
    );
  });

  it('identifies rows awaiting a decision by either reason', () => {
    // Never categorized...
    expect(needsReview(transaction({ categorySource: 'uncategorized' }))).toBe(true);
    // ...or an undetermined kind, which is a separate reason.
    expect(needsReview(transaction({ kind: 'unknown' }))).toBe(true);
    expect(needsReview(transaction())).toBe(false);

    expect(matchesFilters(transaction({ kind: 'unknown' }), { needsReview: true })).toBe(true);
    expect(matchesFilters(transaction(), { needsReview: true })).toBe(false);
    expect(matchesFilters(transaction(), { needsReview: false })).toBe(true);
  });

  it('combines filters as an AND', () => {
    const row = transaction({ categoryId: 'dining', accountId: 'account-2' });
    expect(matchesFilters(row, { categoryIds: ['dining'], accountIds: ['account-2'] })).toBe(true);
    expect(matchesFilters(row, { categoryIds: ['dining'], accountIds: ['account-1'] })).toBe(false);
  });
});

describe('ordering is total', () => {
  it('defaults to newest first, with id as the tie-break', () => {
    const rows = [
      transaction({ id: 'b', postedDate: '2026-04-08' }),
      transaction({ id: 'a', postedDate: '2026-04-08' }),
      transaction({ id: 'c', postedDate: '2026-04-09' }),
    ];

    expect(sortTransactions(rows, DEFAULT_SORT).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the id tie-break ascending even when the primary sort is descending', () => {
    const rows = [
      transaction({ id: 'b', postedDate: '2026-04-08' }),
      transaction({ id: 'a', postedDate: '2026-04-08' }),
    ];

    // One sequence, not two competing directions.
    expect(
      sortTransactions(rows, { field: 'postedDate', direction: 'desc' }).map((r) => r.id),
    ).toEqual(['a', 'b']);
    expect(
      sortTransactions(rows, { field: 'postedDate', direction: 'asc' }).map((r) => r.id),
    ).toEqual(['a', 'b']);
  });

  it('does not depend on input order', () => {
    const build = (ids: readonly string[]) =>
      ids.map((id) => transaction({ id, postedDate: '2026-04-08', amountCents: 500 }));

    const forward = sortTransactions(build(['a', 'b', 'c']), DEFAULT_SORT).map((r) => r.id);
    const reversed = sortTransactions(build(['c', 'b', 'a']), DEFAULT_SORT).map((r) => r.id);
    expect(forward).toEqual(reversed);
  });

  it('sorts by every supported field', () => {
    const rows = [
      transaction({ id: 'a', amountCents: 300, merchantNormalized: 'ZED', categoryId: 'travel' }),
      transaction({ id: 'b', amountCents: 100, merchantNormalized: 'ALPHA', categoryId: 'dining' }),
    ];

    expect(
      sortTransactions(rows, { field: 'amountCents', direction: 'asc' }).map((r) => r.id),
    ).toEqual(['b', 'a']);
    expect(
      sortTransactions(rows, { field: 'merchantNormalized', direction: 'asc' }).map((r) => r.id),
    ).toEqual(['b', 'a']);
    expect(
      sortTransactions(rows, { field: 'categoryId', direction: 'asc' }).map((r) => r.id),
    ).toEqual(['b', 'a']);
  });
});

describe('paging', () => {
  beforeEach(async () => {
    await db.transactions.bulkAdd(
      Array.from({ length: 25 }, (_, index) =>
        transaction({
          id: `txn-${String(index).padStart(3, '0')}`,
          postedDate: `2026-04-${String((index % 28) + 1).padStart(2, '0')}`,
        }),
      ),
    );
  });

  it('reports the true total alongside a bounded page', async () => {
    const page = await queryTransactions(db, { pageSize: 10, page: 0 });

    expect(page.totalCount).toBe(25);
    expect(page.rows).toHaveLength(10);
    expect(page.pageCount).toBe(3);
  });

  it('covers every row exactly once across pages', async () => {
    const seen: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = await queryTransactions(db, { pageSize: 10, page });
      seen.push(...result.rows.map((row) => row.id));
    }

    // No row appears twice and none is skipped — the property a partial order
    // would break.
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('clamps an out-of-range page rather than returning nothing', async () => {
    const page = await queryTransactions(db, { pageSize: 10, page: 99 });
    expect(page.page).toBe(2);
    expect(page.rows).toHaveLength(5);
  });

  it('clamps an oversized page size', async () => {
    const page = await queryTransactions(db, { pageSize: 100_000 });
    expect(page.pageSize).toBe(MAX_PAGE_SIZE);
    expect(page.rows.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it('clamps a nonsensical page size', async () => {
    expect((await queryTransactions(db, { pageSize: 0 })).pageSize).toBe(1);
    expect((await queryTransactions(db, { pageSize: Number.NaN })).pageSize).toBeGreaterThan(0);
  });
});

describe('stale-response protection', () => {
  it('echoes the request id so an older answer can be dropped', async () => {
    await db.transactions.add(transaction());

    const page = await queryTransactions(db, { requestId: 'req-2' });

    expect(page.requestId).toBe('req-2');
    expect(isCurrentResponse(page, 'req-2')).toBe(true);
    // A response for "PIN" must not overwrite the results for "PINEBROOK".
    expect(isCurrentResponse(page, 'req-3')).toBe(false);
  });
});

describe('tags available for filtering', () => {
  it('lists them distinctly and in a stable order', async () => {
    await db.transactions.bulkAdd([
      transaction({ id: 'a', tags: ['WEEKLY', 'SHARED'] }),
      transaction({ id: 'b', tags: ['SHARED'] }),
      transaction({ id: 'c', tags: [] }),
    ]);

    expect(await listTransactionTags(db)).toEqual(['SHARED', 'WEEKLY']);
  });
});

describe('a realistic large workspace', () => {
  const ROWS = 20_000;

  beforeEach(async () => {
    const rows = Array.from({ length: ROWS }, (_, index) =>
      transaction({
        id: `txn-${String(index).padStart(6, '0')}`,
        postedDate: `2026-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
        amountCents: (index % 500) * 7 + 100,
        merchantNormalized: index % 3 === 0 ? 'PINEBROOK MARKET' : 'HARBOR BEAN COFFEE',
        descriptionRaw: index % 3 === 0 ? 'PINEBROOK MARKET' : 'HARBOR BEAN COFFEE',
        categoryId: index % 3 === 0 ? 'groceries' : 'dining',
      }),
    );
    await db.transactions.bulkAdd(rows);
  });

  it('returns one bounded page, never the whole workspace', async () => {
    const page = await queryTransactions(db, { pageSize: 50 });

    expect(page.totalCount).toBe(ROWS);
    // The count is honest about the workspace; the payload is not the workspace.
    expect(page.rows).toHaveLength(50);
    expect(page.pageCount).toBe(ROWS / 50);
  });

  it('filters a large workspace down correctly', async () => {
    const page = await queryTransactions(db, {
      filters: { categoryIds: ['groceries'] },
      pageSize: 25,
    });

    expect(page.totalCount).toBe(Math.ceil(ROWS / 3));
    expect(page.rows).toHaveLength(25);
    expect(page.rows.every((row) => row.categoryId === 'groceries')).toBe(true);
  });

  it('keeps ordering stable across two identical queries', async () => {
    const first = await queryTransactions(db, { pageSize: 40, page: 3 });
    const second = await queryTransactions(db, { pageSize: 40, page: 3 });

    expect(first.rows.map((row) => row.id)).toEqual(second.rows.map((row) => row.id));
  });

  it('narrows through the date index without returning more than a page', async () => {
    const page = await queryTransactions(db, {
      filters: { dateFrom: '2026-03-01', dateTo: '2026-03-28' },
      pageSize: 20,
    });

    expect(page.rows).toHaveLength(20);
    expect(page.rows.every((row) => row.postedDate >= '2026-03-01')).toBe(true);
    expect(page.rows.every((row) => row.postedDate <= '2026-03-28')).toBe(true);
    expect(page.totalCount).toBeGreaterThan(0);
  });
});
