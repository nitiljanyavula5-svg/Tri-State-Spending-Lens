import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../import/ConfirmDialog';
import { TransactionSummary } from './TransactionSummary';
import { MAX_REVIEW_SUGGESTIONS } from '../../domain/reviewLimits';
import { REFUND_LOOKBACK_DAYS } from '../../db/relationshipCommands';
import type { RefundSuggestionGroup, SuggestionCollection } from '../../db/relationshipCommands';
import type { Account, Transaction } from '../../types/domain';

/**
 * Credits that may be refunds of an earlier purchase.
 *
 * Linking a refund makes it inherit the purchase's reviewed merchant and
 * category, which is the whole point: a refund filed under a different category
 * than the purchase it reverses leaves both figures wrong. It stays
 * `kind: refund` and remains visibly a refund, so the row never disappears into
 * the purchase it cancels.
 *
 * **Ambiguity is shown, not resolved.** When a merchant was used repeatedly at
 * the same price, more than one purchase fits exactly. Picking the nearest one
 * and presenting it as the answer would be a guess with a confirmation button
 * on it, so every candidate is listed and the group is labelled ambiguous.
 */

interface RefundSuggestionsProps {
  readonly collection: SuggestionCollection<RefundSuggestionGroup> | null;
  readonly unmatched: SuggestionCollection<Transaction> | null;
  readonly accounts: readonly Account[];
  readonly loading: boolean;
  readonly pendingId: string | null;
  readonly busy: boolean;
  readonly onConfirm: (refundId: string, purchaseId: string) => void;
  /** Opens the shared transaction editor for a credit nothing matched. */
  readonly onEditUnmatched: (transaction: Transaction) => void;
}

export function RefundSuggestions({
  collection,
  unmatched,
  accounts,
  loading,
  pendingId,
  busy,
  onConfirm,
  onEditUnmatched,
}: RefundSuggestionsProps) {
  const [confirming, setConfirming] = useState<{
    refund: Transaction;
    purchase: Transaction;
  } | null>(null);

  const groups = collection?.suggestions ?? [];
  const orphans = unmatched?.suggestions ?? [];

  return (
    <section aria-labelledby="refund-suggestions-title" className="mt-10">
      <h2 id="refund-suggestions-title" className="text-lg font-semibold tracking-tight text-ink">
        Possible refunds
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
        A credit that exactly matches an earlier purchase — same account, same merchant, same amount
        — is usually that purchase coming back. These are{' '}
        <strong>suggestions, not conclusions</strong>: nothing is linked and no category is copied
        across until you confirm.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-ink-muted">Looking for matching purchases…</p>
      ) : null}

      {!loading && groups.length === 0 && orphans.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Undo2}
            title="No refunds are waiting to be matched"
            description={`Nothing in this workspace is a credit awaiting review. A refund is only matched to a purchase in the same account, with the same merchant and exactly the same amount, posted within ${REFUND_LOOKBACK_DAYS} days beforehand.`}
          />
        </div>
      ) : null}

      {groups.length > 0 ? (
        <>
          <p className="mt-4 text-sm font-semibold text-ink">
            {`${groups.length} refund${groups.length === 1 ? '' : 's'} with a matching purchase`}
          </p>
          {collection?.truncated ? (
            <p className="mt-1 text-sm text-ink-muted">
              {`Only the first ${MAX_REVIEW_SUGGESTIONS} are shown so this page stays quick.`}
            </p>
          ) : null}

          <ul className="mt-3 space-y-4">
            {groups.map((group) => (
              <li
                key={group.refund.id}
                className="rounded-card border border-line bg-surface p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="notice">Suggestion</Badge>
                  {group.ambiguous ? <Badge tone="pa">More than one purchase fits</Badge> : null}
                </div>

                <div className="mt-3">
                  <TransactionSummary
                    transaction={group.refund}
                    accounts={accounts}
                    role="The refund"
                  />
                </div>

                {group.ambiguous ? (
                  <Callout
                    tone="caution"
                    title="Several purchases match this refund exactly"
                    className="mt-3"
                  >
                    <p>
                      You used this merchant more than once for the same amount, so the product
                      cannot tell which purchase this refund reverses. Choose the one you recognise
                      — or leave it unlinked, which is a perfectly good answer.
                    </p>
                  </Callout>
                ) : null}

                <p className="mt-3 text-sm font-semibold text-ink">
                  {group.ambiguous
                    ? `${group.candidates.length} possible purchases`
                    : 'The matching purchase'}
                </p>

                <ul className="mt-2 space-y-3">
                  {group.candidates.map((candidate) => {
                    const key = `${group.refund.id}${candidate.purchase.id}`;
                    const pending = pendingId === key;
                    return (
                      <li
                        key={candidate.purchase.id}
                        className="rounded-card border border-line p-3"
                      >
                        <TransactionSummary
                          transaction={candidate.purchase}
                          accounts={accounts}
                          role="The purchase"
                        />
                        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
                          {candidate.reason}
                        </p>
                        <p className="mt-1 text-xs text-ink-muted">
                          {candidate.daysApart === 0
                            ? 'Posted on the same day as the refund.'
                            : `Posted ${candidate.daysApart} day${candidate.daysApart === 1 ? '' : 's'} before the refund.`}
                        </p>
                        <Button
                          variant="primary"
                          size="sm"
                          className="mt-3"
                          disabled={busy}
                          onClick={() =>
                            setConfirming({ refund: group.refund, purchase: candidate.purchase })
                          }
                        >
                          {pending ? 'Linking…' : 'This is the purchase'}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* ------------------------------------------------------- unmatched - */}
      {orphans.length > 0 ? (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-ink">
            {`${orphans.length} credit${orphans.length === 1 ? '' : 's'} with no matching purchase`}
          </h3>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
            Nothing in this workspace matches these exactly, so there is nothing to link. That is a
            real answer, not a failure — decide what each one is by hand instead.
          </p>
          <ul className="mt-3 space-y-3">
            {orphans.map((row) => (
              <li key={row.id} className="rounded-card border border-line bg-surface p-3">
                <TransactionSummary
                  transaction={row}
                  accounts={accounts}
                  role="Awaiting a decision"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  disabled={busy}
                  aria-label={`Review this transaction from ${row.postedDate}`}
                  onClick={() => onEditUnmatched(row)}
                >
                  Review this transaction
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title="Link this refund to that purchase?"
          confirmLabel="Link them"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const pair = confirming;
            setConfirming(null);
            onConfirm(pair.refund.id, pair.purchase.id);
          }}
        >
          <p>
            The refund will take on the purchase&rsquo;s merchant and category, so both sit in the
            same place in your figures.
          </p>
          <p>
            It <strong>stays a refund</strong>. Refunds reduce spending in the period they posted,
            and linking one does not make it count twice.
          </p>
          <p>This is one change and can be undone straight afterwards.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
