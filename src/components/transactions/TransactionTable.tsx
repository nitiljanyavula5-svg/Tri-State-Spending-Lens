import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { getCategory } from '../../domain/categories';
import {
  spendingTreatment,
  TREATMENT_LABELS,
  type SpendingTreatment,
} from '../../classification/spending';
import { formatAmount } from '../../export/csvExport';
import { needsReview } from '../../db/transactionQueries';
import type { SortField, TransactionSort } from '../../db/transactionQueries';
import type { Account, Transaction } from '../../types/domain';

/**
 * The review grid.
 *
 * Desktop gets a real `<table>` so assistive technology reads rows and columns
 * as rows and columns; mobile gets cards, because a fifteen-column table at
 * 390px is a table nobody can use. Both render the same data through the same
 * helpers, so the two views cannot describe a row differently.
 *
 * Every value is text. Nothing here uses `dangerouslySetInnerHTML`, and long
 * descriptions are truncated visually with the full value available through
 * `title` and the editor.
 */

const TREATMENT_TONE: Record<SpendingTreatment, 'nj' | 'ny' | 'pa' | 'neutral' | 'notice'> = {
  'included-outflow': 'neutral',
  'included-refund': 'nj',
  'excluded-by-kind': 'ny',
  'excluded-by-user': 'ny',
  'needs-review': 'notice',
};

const KIND_LABELS: Readonly<Record<Transaction['kind'], string>> = {
  purchase: 'Purchase',
  refund: 'Refund',
  income: 'Income',
  transfer: 'Transfer',
  payment: 'Card payment',
  fee: 'Fee',
  cash_withdrawal: 'Cash',
  unknown: 'Unknown',
};

interface TransactionTableProps {
  readonly rows: readonly Transaction[];
  readonly accounts: readonly Account[];
  readonly selectedIds: ReadonlySet<string>;
  readonly linkedIds: ReadonlySet<string>;
  readonly sort: TransactionSort;
  readonly onSort: (field: SortField) => void;
  readonly onToggleSelected: (id: string) => void;
  readonly onSelectVisible: () => void;
  readonly onClearSelection: () => void;
  readonly onReview: (transaction: Transaction) => void;
}

function accountLabelOf(accounts: readonly Account[], id: string): string {
  return accounts.find((account) => account.id === id)?.label ?? id;
}

/** Sort direction announced as text, never by arrow glyph alone. */
function sortStateFor(
  sort: TransactionSort,
  field: SortField,
): 'ascending' | 'descending' | 'none' {
  if (sort.field !== field) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

function SortButton({
  label,
  field,
  sort,
  onSort,
}: {
  label: string;
  field: SortField;
  sort: TransactionSort;
  onSort: (field: SortField) => void;
}) {
  const state = sortStateFor(sort, field);
  const Icon = state === 'none' ? ArrowUpDown : state === 'ascending' ? ArrowUp : ArrowDown;

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className="inline-flex items-center gap-1 rounded-control px-1 py-0.5 font-semibold text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
    >
      {label}
      <Icon aria-hidden="true" className="size-3.5" />
      {/* The state is in the header cell's aria-sort; this names the action. */}
      <span className="sr-only">
        {state === 'none' ? ', not sorted, activate to sort' : `, sorted ${state}`}
      </span>
    </button>
  );
}

function TreatmentBadge({ transaction }: { transaction: Transaction }) {
  const treatment = spendingTreatment(transaction);
  return <Badge tone={TREATMENT_TONE[treatment]}>{TREATMENT_LABELS[treatment]}</Badge>;
}

export function TransactionTable({
  rows,
  accounts,
  selectedIds,
  linkedIds,
  sort,
  onSort,
  onToggleSelected,
  onSelectVisible,
  onClearSelection,
  onReview,
}: TransactionTableProps) {
  const allVisibleSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));

  return (
    <>
      {/* ------------------------------------------------------- desktop - */}
      <div
        role="region"
        aria-label="Transactions"
        tabIndex={0}
        // `relative` is load-bearing, not decoration. `overflow` only clips an
        // absolutely-positioned descendant when the scrolling box is that
        // descendant's containing block — and every `sr-only` element is
        // `position: absolute`. Without this, those hidden spans sit outside the
        // scroller's clip for layout-overflow purposes and the *root* element
        // reports horizontal overflow the page does not actually have.
        className="relative hidden overflow-x-auto rounded-card border border-line md:block"
      >
        <table className="w-full min-w-[60rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Your transactions, with the reviewed category, kind, and spending treatment for each.
          </caption>
          <thead>
            <tr className="border-b border-line bg-canvas-sunk">
              <th scope="col" className="px-3 py-2">
                {/* Padded label, not a bare 16px input: the label is what
                    receives the click, so this is the target a pointer has to
                    hit, and 24px is the minimum that is reliably hittable. */}
                <label className="-m-1 flex w-fit cursor-pointer items-center gap-2 p-1 text-xs font-semibold text-ink-muted">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={() => (allVisibleSelected ? onClearSelection() : onSelectVisible())}
                    className="size-4 accent-ink"
                  />
                  <span className="sr-only">
                    {allVisibleSelected
                      ? 'Clear selection'
                      : 'Select every transaction on this page'}
                  </span>
                </label>
              </th>
              <th scope="col" aria-sort={sortStateFor(sort, 'postedDate')} className="px-3 py-2">
                <SortButton label="Date" field="postedDate" sort={sort} onSort={onSort} />
              </th>
              <th scope="col" className="px-3 py-2 text-xs font-semibold text-ink-muted">
                Account
              </th>
              <th
                scope="col"
                aria-sort={sortStateFor(sort, 'merchantNormalized')}
                className="px-3 py-2"
              >
                <SortButton
                  label="Merchant"
                  field="merchantNormalized"
                  sort={sort}
                  onSort={onSort}
                />
              </th>
              <th scope="col" aria-sort={sortStateFor(sort, 'amountCents')} className="px-3 py-2">
                <SortButton label="Amount" field="amountCents" sort={sort} onSort={onSort} />
              </th>
              <th scope="col" aria-sort={sortStateFor(sort, 'categoryId')} className="px-3 py-2">
                <SortButton label="Category" field="categoryId" sort={sort} onSort={onSort} />
              </th>
              <th scope="col" className="px-3 py-2 text-xs font-semibold text-ink-muted">
                Kind
              </th>
              <th scope="col" className="px-3 py-2 text-xs font-semibold text-ink-muted">
                Spending
              </th>
              <th scope="col" className="px-3 py-2 text-xs font-semibold text-ink-muted">
                <span className="sr-only">Review</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = selectedIds.has(row.id);
              return (
                <tr
                  key={row.id}
                  className={`border-b border-line/60 last:border-0 ${selected ? 'bg-nj-wash' : ''}`}
                >
                  <td className="px-3 py-2">
                    <label className="-m-1 flex w-fit cursor-pointer p-1">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => onToggleSelected(row.id)}
                        aria-label={`Select transaction from ${row.postedDate}`}
                        className="size-4 accent-ink"
                      />
                    </label>
                  </td>
                  <td className="money px-3 py-2 whitespace-nowrap text-ink-soft">
                    {row.postedDate}
                  </td>
                  <td
                    className="max-w-[10rem] truncate px-3 py-2 text-ink-soft"
                    title={accountLabelOf(accounts, row.accountId)}
                  >
                    {accountLabelOf(accounts, row.accountId)}
                  </td>
                  <td className="max-w-[18rem] px-3 py-2">
                    <span
                      className="block truncate font-medium text-ink"
                      title={row.merchantNormalized}
                    >
                      {row.merchantNormalized}
                    </span>
                    {/* The statement's own words stay visible forever. */}
                    <span
                      className="block truncate text-xs text-ink-muted"
                      title={row.descriptionRaw}
                    >
                      {row.descriptionRaw}
                    </span>
                  </td>
                  <td className="money px-3 py-2 whitespace-nowrap text-ink">
                    {formatAmount(row.amountCents, row.direction)}
                  </td>
                  <td className="px-3 py-2 text-ink-soft">
                    {getCategory(row.categoryId)?.label ?? row.categoryId}
                  </td>
                  <td className="px-3 py-2 text-ink-soft">{KIND_LABELS[row.kind]}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <TreatmentBadge transaction={row} />
                      {needsReview(row) ? <Badge tone="notice">Needs review</Badge> : null}
                      {linkedIds.has(row.id) ? <Badge tone="ny">Linked</Badge> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/* Named with `aria-label` rather than a trailing
                        visually-hidden span. Two reasons: adjacent text nodes
                        are concatenated without a separator, so the name read
                        as "Reviewtransaction from ..."; and Tailwind's
                        `sr-only` is `position: absolute`, which escapes this
                        table's horizontal scroll container and made the root
                        element report layout overflow it does not really
                        have. */}
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Review transaction from ${row.postedDate}`}
                      onClick={() => onReview(row)}
                    >
                      Review
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* -------------------------------------------------------- mobile - */}
      {/* The select-all lives in the table header on wide screens, and there is
          no header here — without this, bulk selection is simply unreachable at
          phone width. Same accessible name as the desktop control, because it
          is the same action. */}
      <div className="mb-3 md:hidden">
        <label className="flex w-fit cursor-pointer items-center gap-2 py-1 text-sm font-medium text-ink">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={() => (allVisibleSelected ? onClearSelection() : onSelectVisible())}
            className="size-5 accent-ink"
          />
          {allVisibleSelected ? 'Clear selection' : 'Select every transaction on this page'}
        </label>
      </div>

      <ul className="space-y-3 md:hidden">
        {rows.map((row) => {
          const selected = selectedIds.has(row.id);
          return (
            <li
              key={row.id}
              className={`rounded-card border p-3 ${selected ? 'border-nj bg-nj-wash' : 'border-line'}`}
            >
              <div className="flex items-start gap-3">
                <label className="-m-1 flex shrink-0 cursor-pointer p-1">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleSelected(row.id)}
                    aria-label={`Select transaction from ${row.postedDate}`}
                    className="mt-1 size-5 accent-ink"
                  />
                </label>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p
                      className="min-w-0 truncate font-medium text-ink"
                      title={row.merchantNormalized}
                    >
                      {row.merchantNormalized}
                    </p>
                    <p className="money shrink-0 text-sm text-ink">
                      {formatAmount(row.amountCents, row.direction)}
                    </p>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-muted" title={row.descriptionRaw}>
                    {row.descriptionRaw}
                  </p>
                  <p className="money mt-1 text-xs text-ink-muted">
                    {row.postedDate} · {accountLabelOf(accounts, row.accountId)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge>{getCategory(row.categoryId)?.label ?? row.categoryId}</Badge>
                    <Badge>{KIND_LABELS[row.kind]}</Badge>
                    <TreatmentBadge transaction={row} />
                    {needsReview(row) ? <Badge tone="notice">Needs review</Badge> : null}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3 w-full"
                    aria-label={`Review transaction from ${row.postedDate}`}
                    onClick={() => onReview(row)}
                  >
                    Review
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
