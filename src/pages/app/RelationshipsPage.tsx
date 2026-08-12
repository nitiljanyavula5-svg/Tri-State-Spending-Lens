import { useState } from 'react';
import { PageContainer } from '../../app/layout/PageContainer';
import { useWorkspace } from '../../app/providers/workspaceContext';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { ConfirmedRelationships } from '../../components/relationships/ConfirmedRelationships';
import { RefundSuggestions } from '../../components/relationships/RefundSuggestions';
import { TransferSuggestions } from '../../components/relationships/TransferSuggestions';
import { TransactionEditor } from '../../components/transactions/TransactionEditor';
import { useRelationshipReview } from '../../review/useRelationshipReview';
import { Link2 } from 'lucide-react';
import type { Transaction } from '../../types/domain';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

/**
 * Reviewing possible relationships between transactions.
 *
 * Everything here goes through `useRelationshipReview`, which goes through the
 * Phase 4 services. There is no Dexie access in this file, and no merchant,
 * description, or amount reaches a URL, the document title, or storage — the
 * title is the constant "Linked transactions" for exactly that reason.
 *
 * **Opening this page changes nothing.** Suggestions are computed by reading
 * rows and comparing them; they are not written anywhere, and closing the page
 * without confirming leaves the workspace byte-identical.
 */
export function RelationshipsPage() {
  useDocumentTitle('Linked transactions');
  const { db, summary, actions, undo } = useWorkspace();

  const review = useRelationshipReview({
    db,
    undo,
    onWorkspaceChanged: () => {
      void actions.refreshStorageEstimate();
    },
  });

  const [linkError, setLinkError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const workspaceEmpty = summary?.counts.transactions === 0;
  const loading = review.status === 'loading' && review.transfers === null;
  const failed = review.status === 'failed';

  function handleOutcome(work: Promise<{ ok: boolean; message: string }>) {
    setLinkError(null);
    void work.then((outcome) => {
      if (!outcome.ok) setLinkError(outcome.message);
    });
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Linked transactions"
        lede="Money moving between your own accounts, card payments, and refunds. Nothing here is linked automatically — every relationship exists because you confirmed it."
        actions={
          <ButtonLink to="/app/transactions" variant="secondary" size="sm">
            Back to transactions
          </ButtonLink>
        }
      />

      {/* Announcements after every command, for screen-reader users. */}
      <p role="status" aria-live="polite" className="sr-only">
        {review.announcement}
      </p>

      {workspaceEmpty ? (
        <div className="mt-8">
          <EmptyState
            icon={Link2}
            title="Nothing to link yet"
            description="Once you import transactions, any that look like two sides of one movement — a transfer, a card payment, or a refund of an earlier purchase — will be offered here for you to confirm."
            actions={
              <ButtonLink to="/import" variant="primary" size="sm">
                Import a CSV
              </ButtonLink>
            }
          />
        </div>
      ) : (
        <>
          <Callout tone="privacy" title="Why this matters to your totals" className="mt-8">
            <p>
              Transfers and card payments are <strong>never counted as spending</strong> — the money
              did not leave your finances, it moved inside them. Linking the two sides keeps the
              same money from being counted twice. A refund reduces spending once, in the period it
              posted.
            </p>
            <p className="mt-2">
              Because a wrong link hides real spending, none of this happens on its own. Looking at
              a suggestion changes nothing at all.
            </p>
          </Callout>

          {/* One failure state for the whole page. Two sections each showing
              the same "could not be worked out" notice would read as two
              separate faults, and the read that failed served both. */}
          {failed ? (
            <Callout
              tone="caution"
              title="These suggestions could not be worked out"
              className="mt-6"
            >
              <p>
                Nothing was changed, and nothing was linked.{' '}
                <Button variant="secondary" size="sm" onClick={review.refresh}>
                  Try again
                </Button>
              </p>
            </Callout>
          ) : null}

          {/* One alert, for the same reason: a refusal belongs to the command
              the user just ran, not to every list on the page. */}
          {linkError ? (
            <p role="alert" className="mt-6 text-sm font-medium text-pa">
              {linkError}
            </p>
          ) : null}

          {/* ---------------------------------------------------- undo - */}
          {review.undo.canUndo() ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
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

          {/* Suppressed entirely while the read is failing: an empty list
              would claim there is nothing to review, which is not what a
              failed read means. */}
          {failed ? null : (
            <>
              <TransferSuggestions
                collection={review.transfers}
                accounts={review.accounts}
                loading={loading}
                pendingId={review.pendingId}
                busy={review.busy}
                onConfirm={(outgoingId, incomingId, kind) =>
                  handleOutcome(review.confirmTransfer(outgoingId, incomingId, kind))
                }
              />

              <RefundSuggestions
                collection={review.refunds}
                unmatched={review.unmatchedRefunds}
                accounts={review.accounts}
                loading={loading}
                pendingId={review.pendingId}
                busy={review.busy}
                onConfirm={(refundId, purchaseId) =>
                  handleOutcome(review.confirmRefund(refundId, purchaseId))
                }
                onEditUnmatched={(transaction) => {
                  setEditError(null);
                  setEditing(transaction);
                }}
              />
            </>
          )}

          <ConfirmedRelationships
            collection={review.confirmed}
            accounts={review.accounts}
            pendingId={review.pendingId}
            busy={review.busy}
            onUnlink={(linkId) => handleOutcome(review.unlink(linkId))}
          />
        </>
      )}

      {/* The same editor the Transactions page uses, so a credit nothing
          matched can still be classified by hand. */}
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
    </PageContainer>
  );
}
