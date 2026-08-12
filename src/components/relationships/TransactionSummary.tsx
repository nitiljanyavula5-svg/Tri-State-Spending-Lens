import { formatAmount } from '../../export/csvExport';
import { getCategory } from '../../domain/categories';
import type { Account, Transaction } from '../../types/domain';

/**
 * One side of a proposed or confirmed relationship.
 *
 * Everything a person needs to say "yes, those are the same movement" — date,
 * account, direction, amount, merchant, and the statement's own words — and
 * nothing they do not. Long merchants and descriptions are truncated visually
 * with the full value on `title`, so a hostile 8,000-character description
 * cannot push the page sideways while still remaining readable.
 *
 * Every value is rendered as text. Nothing here uses `dangerouslySetInnerHTML`.
 */

function accountLabelOf(accounts: readonly Account[], id: string): string {
  return accounts.find((account) => account.id === id)?.label ?? id;
}

interface TransactionSummaryProps {
  readonly transaction: Transaction;
  readonly accounts: readonly Account[];
  /** A short role label, e.g. "Money out" or "The refund". */
  readonly role: string;
}

export function TransactionSummary({ transaction, accounts, role }: TransactionSummaryProps) {
  return (
    <div className="min-w-0 rounded-card bg-canvas-sunk p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">{role}</p>

      <p className="mt-1.5 truncate font-medium text-ink" title={transaction.merchantNormalized}>
        {transaction.merchantNormalized}
      </p>
      <p className="truncate text-xs text-ink-muted" title={transaction.descriptionRaw}>
        {transaction.descriptionRaw}
      </p>

      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-muted">Date</dt>
          <dd className="money text-ink">{transaction.postedDate}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-muted">Account</dt>
          <dd
            className="min-w-0 truncate text-ink"
            title={accountLabelOf(accounts, transaction.accountId)}
          >
            {accountLabelOf(accounts, transaction.accountId)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-muted">Amount</dt>
          <dd className="money text-ink">
            {formatAmount(transaction.amountCents, transaction.direction)}{' '}
            {/* Direction is spelled out, never left to the sign alone. */}
            <span className="text-ink-muted">
              ({transaction.direction === 'debit' ? 'money out' : 'money in'})
            </span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-muted">Category</dt>
          <dd className="min-w-0 truncate text-ink">
            {getCategory(transaction.categoryId)?.label ?? transaction.categoryId}
          </dd>
        </div>
      </dl>
    </div>
  );
}
