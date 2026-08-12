import { useState } from 'react';
import { Table2 } from 'lucide-react';
import { PageContainer } from '../../app/layout/PageContainer';
import { useWorkspace } from '../../app/providers/workspaceContext';
import { ButtonLink, Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { SelectField, TextField } from '../../components/import/FormControls';
import { ConfirmDialog } from '../../components/import/ConfirmDialog';
import { TransactionTable } from '../../components/transactions/TransactionTable';
import { TransactionEditor } from '../../components/transactions/TransactionEditor';
import { useTransactionReview } from '../../review/useTransactionReview';
import { CATEGORIES, getCategory } from '../../domain/categories';
import { TREATMENT_LABELS, type SpendingTreatment } from '../../classification/spending';
import { PAGE_SIZE_OPTIONS } from '../../domain/reviewLimits';
import {
  buildCsvExport,
  browserDownloadPorts,
  downloadCsv,
  CSV_COLUMNS,
} from '../../export/csvExport';
import { queryTransactions, type SortField } from '../../db/transactionQueries';
import type { Transaction, TransactionKind } from '../../types/domain';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

/**
 * The transaction review page.
 *
 * Everything here goes through `useTransactionReview`, which goes through the
 * Phase 4 services. There is no Dexie access in this file, and no filter or
 * search term reaches a URL, the document title, or storage — the title is the
 * constant "Transactions" precisely so a merchant name can never end up in a
 * browser history entry.
 */

const KIND_OPTIONS: readonly { value: TransactionKind; label: string }[] = [
  { value: 'purchase', label: 'Purchase' },
  { value: 'refund', label: 'Refund' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'payment', label: 'Card payment' },
  { value: 'fee', label: 'Fee' },
  { value: 'cash_withdrawal', label: 'Cash withdrawal' },
  { value: 'unknown', label: 'Not yet decided' },
];

const TREATMENT_OPTIONS: readonly { value: SpendingTreatment; label: string }[] = (
  [
    'included-outflow',
    'included-refund',
    'excluded-by-kind',
    'excluded-by-user',
    'needs-review',
  ] as const
).map((value) => ({ value, label: TREATMENT_LABELS[value] }));

export function TransactionsPage() {
  useDocumentTitle('Transactions');
  const { db, summary, actions, undo } = useWorkspace();

  const review = useTransactionReview({
    db,
    undo,
    onWorkspaceChanged: () => {
      void actions.refreshStorageEstimate();
    },
  });

  const [editing, setEditing] = useState<Transaction | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<{ label: string; run: () => void } | null>(null);
  const [exportScope, setExportScope] = useState<'all' | 'filtered' | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const workspaceEmpty = summary?.counts.transactions === 0;
  const rows = review.page?.rows ?? [];
  const total = review.page?.totalCount ?? 0;
  const activeFilters = Object.entries(review.filters).filter(
    ([, value]) =>
      value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0),
  );

  /* --------------------------------------------------------- export - */

  async function runExport(scope: 'all' | 'filtered') {
    if (!db?.isOpen() || exportBusy) return;
    setExportBusy(true);
    setExportError(null);

    try {
      // The full result set for the scope, not just the visible page.
      const answer = await queryTransactions(db, {
        ...(scope === 'filtered' ? { filters: review.filters } : {}),
        pageSize: 100,
        page: 0,
      });
      const all: Transaction[] = [];
      for (let page = 0; page < answer.pageCount; page += 1) {
        const chunk = await queryTransactions(db, {
          ...(scope === 'filtered' ? { filters: review.filters } : {}),
          pageSize: 100,
          page,
        });
        all.push(...chunk.rows);
      }

      const built = buildCsvExport(
        { transactions: all, accounts: review.accounts },
        new Date().toISOString(),
      );
      if (!built.ok) {
        setExportError(built.message);
        return;
      }

      downloadCsv(built.csv, built.filename, browserDownloadPorts());
      setExportScope(null);
    } catch {
      setExportError('The export could not be produced. Nothing was changed or saved.');
    } finally {
      setExportBusy(false);
    }
  }

  /* ---------------------------------------------------------- render - */

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Transactions"
        lede="Search, review, categorize, and exclude individual transactions. Your corrections are permanent decisions that survive re-categorization and future imports."
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink to="/app/transactions/relationships" variant="secondary" size="sm">
              Review links
            </ButtonLink>
            <Button variant="secondary" size="sm" onClick={() => setExportScope('all')}>
              Export CSV
            </Button>
            <ButtonLink to="/import" variant="primary" size="sm">
              Import a CSV
            </ButtonLink>
          </div>
        }
      />

      {/* Announcements after every command, for screen-reader users. */}
      <p role="status" aria-live="polite" className="sr-only">
        {review.announcement}
      </p>

      {workspaceEmpty ? (
        <div className="mt-8">
          <EmptyState
            icon={Table2}
            title="Nothing to review yet"
            description="Import a bank CSV and every row will appear here, with the original description kept alongside whatever you rename it to."
            actions={
              <ButtonLink to="/import" variant="primary" size="sm">
                Import a CSV
              </ButtonLink>
            }
          />
        </div>
      ) : (
        <>
          {/* ------------------------------------------------- filters - */}
          <section aria-labelledby="filters-title" className="mt-8">
            <h2 id="filters-title" className="sr-only">
              Filters
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <TextField
                label="Search"
                value={review.filters.search ?? ''}
                onChange={(value) => review.setFilters({ ...review.filters, search: value })}
                hint="Matches the original description and the merchant."
              />
              <TextField
                label="From date"
                type="date"
                value={review.filters.dateFrom ?? ''}
                onChange={(value) => review.setFilters({ ...review.filters, dateFrom: value })}
              />
              <TextField
                label="To date"
                type="date"
                value={review.filters.dateTo ?? ''}
                onChange={(value) => review.setFilters({ ...review.filters, dateTo: value })}
              />
              <SelectField
                label="Account"
                value={review.filters.accountIds?.[0] ?? null}
                options={review.accounts.map((account) => ({
                  value: account.id,
                  label: account.label,
                }))}
                placeholder="Any account"
                onChange={(value) =>
                  review.setFilters({
                    ...review.filters,
                    ...(value ? { accountIds: [value] } : { accountIds: [] }),
                  })
                }
              />
              <SelectField
                label="Category"
                value={review.filters.categoryIds?.[0] ?? null}
                options={CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
                placeholder="Any category"
                onChange={(value) =>
                  review.setFilters({
                    ...review.filters,
                    ...(value ? { categoryIds: [value] } : { categoryIds: [] }),
                  })
                }
              />
              <SelectField
                label="Kind"
                value={review.filters.kinds?.[0] ?? null}
                options={KIND_OPTIONS}
                placeholder="Any kind"
                onChange={(value) =>
                  review.setFilters({
                    ...review.filters,
                    ...(value ? { kinds: [value as TransactionKind] } : { kinds: [] }),
                  })
                }
              />
              <SelectField
                label="Spending treatment"
                value={review.filters.treatments?.[0] ?? null}
                options={TREATMENT_OPTIONS}
                placeholder="Any treatment"
                onChange={(value) =>
                  review.setFilters({
                    ...review.filters,
                    ...(value ? { treatments: [value as SpendingTreatment] } : { treatments: [] }),
                  })
                }
              />
              <SelectField
                label="Tag"
                value={review.filters.tags?.[0] ?? null}
                options={review.tags.map((tag) => ({ value: tag, label: tag }))}
                placeholder="Any tag"
                onChange={(value) =>
                  review.setFilters({
                    ...review.filters,
                    ...(value ? { tags: [value] } : { tags: [] }),
                  })
                }
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              {/* `py-1` so the clickable label clears 24px; the bare
                  checkbox-plus-text row is only 20px tall. */}
              <label className="flex w-fit cursor-pointer items-center gap-2 py-1 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={review.filters.needsReview === true}
                  onChange={(event) =>
                    review.setFilters({
                      ...review.filters,
                      ...(event.target.checked
                        ? { needsReview: true }
                        : { needsReview: undefined }),
                    })
                  }
                  className="size-4 accent-ink"
                />
                Only rows that need review
              </label>

              {activeFilters.length > 0 ? (
                <Button variant="quiet" size="sm" onClick={review.clearFilters}>
                  {`Clear all filters (${activeFilters.length})`}
                </Button>
              ) : null}
            </div>
          </section>

          {/* --------------------------------------------------- state - */}
          {review.status === 'failed' ? (
            <Callout tone="caution" title="Your transactions could not be read" className="mt-6">
              <p>
                Nothing was changed. Reloading the page may help.{' '}
                <Button variant="secondary" size="sm" onClick={review.refresh}>
                  Try again
                </Button>
              </p>
            </Callout>
          ) : null}

          {/* ------------------------------------------------ bulk bar - */}
          {review.selectedIds.size > 0 ? (
            <section
              aria-label="Bulk actions"
              className="mt-6 rounded-card border border-nj/40 bg-nj-wash p-3"
            >
              <p className="text-sm font-semibold text-ink">
                {`${review.selectedIds.size} selected on this page`}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                Only the rows you ticked are affected — never every filtered result.
              </p>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <SelectField
                  label="Set category for selected"
                  value={null}
                  options={CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
                  placeholder="Choose a category"
                  onChange={(value) => {
                    if (!value) return;
                    setBulkConfirm({
                      label: `Set ${review.selectedIds.size} transactions to ${getCategory(value)?.label}?`,
                      run: () => void review.bulkEdit({ categoryId: value }, 'bulk category'),
                    });
                  }}
                />
                <SelectField
                  label="Set kind for selected"
                  value={null}
                  options={KIND_OPTIONS}
                  placeholder="Choose a kind"
                  onChange={(value) => {
                    if (!value) return;
                    setBulkConfirm({
                      label: `Change the kind of ${review.selectedIds.size} transactions?`,
                      run: () =>
                        void review.bulkEdit({ kind: value as TransactionKind }, 'bulk kind'),
                    });
                  }}
                />
                <Button variant="quiet" size="sm" onClick={review.clearSelection}>
                  Clear selection
                </Button>
              </div>
            </section>
          ) : null}

          {/* ---------------------------------------------------- undo - */}
          {review.undo.canUndo() ? (
            <div className="mt-4 flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={review.busy}
                onClick={() => void review.runUndo()}
              >
                {`Undo last change (${review.undo.peek()?.label})`}
              </Button>
              <span className="text-xs text-ink-muted">
                Undo is available until you reload this page. Your changes themselves are saved.
              </span>
            </div>
          ) : null}

          {/* --------------------------------------------------- rows - */}
          {/* Hidden entirely while the read is failing. Leaving the previous
              answer on screen under a "could not be read" notice tells the user
              two contradictory things at once, and the count beside it would
              describe a result set that is no longer known. */}
          <section
            aria-labelledby="results-title"
            className="mt-6"
            hidden={review.status === 'failed'}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="results-title" className="text-sm font-semibold text-ink">
                {review.status === 'loading' && !review.page
                  ? 'Loading transactions…'
                  : `${total.toLocaleString('en-US')} transaction${total === 1 ? '' : 's'}`}
              </h2>
              {review.page && total > 0 ? (
                <div className="flex flex-wrap items-baseline gap-3">
                  <p className="money text-xs text-ink-muted">
                    {`Showing ${review.page.page * review.page.pageSize + 1}–${Math.min(
                      (review.page.page + 1) * review.page.pageSize,
                      total,
                    )}`}
                  </p>
                  {/* The filtered export is only offered when a filter is
                      actually narrowing something; otherwise it would be a
                      second button that does exactly what "Export CSV" does. */}
                  {activeFilters.length > 0 ? (
                    <Button variant="quiet" size="sm" onClick={() => setExportScope('filtered')}>
                      {total === 1
                        ? 'Export this 1 result'
                        : `Export these ${total.toLocaleString('en-US')} results`}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {review.status === 'ready' && rows.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  icon={Table2}
                  title="No transactions match these filters"
                  description="Try widening the date range, or clear the filters to see everything again."
                  actions={
                    <Button variant="secondary" size="sm" onClick={review.clearFilters}>
                      Clear all filters
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="mt-4">
                <TransactionTable
                  rows={rows}
                  accounts={review.accounts}
                  selectedIds={review.selectedIds}
                  linkedIds={review.linkedIds}
                  sort={review.sort}
                  onSort={(field: SortField) =>
                    review.setSort({
                      field,
                      direction:
                        review.sort.field === field && review.sort.direction === 'desc'
                          ? 'asc'
                          : 'desc',
                    })
                  }
                  onToggleSelected={review.toggleSelected}
                  onSelectVisible={review.selectVisiblePage}
                  onClearSelection={review.clearSelection}
                  onReview={(transaction) => {
                    setEditError(null);
                    setEditing(transaction);
                  }}
                />
              </div>
            )}

            {/* ---------------------------------------------- paging - */}
            {review.page && review.page.pageCount > 1 ? (
              <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={review.page.page === 0}
                  onClick={() => review.setPage(review.page!.page - 1)}
                >
                  Previous
                </Button>
                <span className="money text-sm text-ink-soft">
                  {`Page ${review.page.page + 1} of ${review.page.pageCount}`}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={review.page.page >= review.page.pageCount - 1}
                  onClick={() => review.setPage(review.page!.page + 1)}
                >
                  Next
                </Button>
                <div className="ml-auto w-40">
                  <SelectField
                    label="Rows per page"
                    numeric
                    value={review.pageSize}
                    options={PAGE_SIZE_OPTIONS.map((size) => ({
                      value: size,
                      label: String(size),
                    }))}
                    onChange={(value) => value !== null && review.setPageSize(Number(value))}
                  />
                </div>
              </nav>
            ) : null}
          </section>
        </>
      )}

      {editing ? (
        <TransactionEditor
          transaction={editing}
          accounts={review.accounts}
          busy={review.busy}
          errorMessage={editError}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            void review.saveTransaction(editing.id, patch).then((result) => {
              if (result.ok) setEditing(null);
              else setEditError(result.message);
            });
          }}
          onSaveWithRule={(patch, rule) => {
            void review.saveTransactionWithRule(editing.id, patch, rule).then((result) => {
              if (result.ok) setEditing(null);
              else setEditError(result.message);
            });
          }}
        />
      ) : null}

      {bulkConfirm ? (
        <ConfirmDialog
          title="Apply this change to the selected transactions?"
          confirmLabel="Apply change"
          busy={review.busy}
          onCancel={() => setBulkConfirm(null)}
          onConfirm={() => {
            bulkConfirm.run();
            setBulkConfirm(null);
          }}
        >
          <p>{bulkConfirm.label}</p>
          <p>This is one change and can be undone straight afterwards.</p>
        </ConfirmDialog>
      ) : null}

      {exportScope ? (
        <ConfirmDialog
          title={
            exportScope === 'all'
              ? 'Export every transaction as a cleaned CSV'
              : 'Export the filtered transactions as a cleaned CSV'
          }
          confirmLabel={exportBusy ? 'Preparing…' : 'Download CSV'}
          busy={exportBusy}
          onCancel={() => {
            setExportScope(null);
            setExportError(null);
          }}
          onConfirm={() => void runExport(exportScope)}
        >
          <p>
            {exportScope === 'all'
              ? `Every transaction in this workspace${summary ? ` (${summary.counts.transactions.toLocaleString('en-US')})` : ''}.`
              : `The ${total.toLocaleString('en-US')} transactions matching your current filters.`}
          </p>
          <p>
            {`Columns: ${CSV_COLUMNS.join(', ')}.`} Excluded transactions are included, with a
            column saying how each one is treated.
          </p>
          <p>
            The file is produced in your browser and saved straight to your device. Nothing is
            uploaded.
          </p>
          {exportError ? (
            <p role="alert" className="font-medium text-pa">
              {exportError}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </PageContainer>
  );
}
