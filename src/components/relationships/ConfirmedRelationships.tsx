import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../import/ConfirmDialog';
import { TransactionSummary } from './TransactionSummary';
import { spendingTreatment, TREATMENT_EXPLANATIONS } from '../../classification/spending';
import type { ConfirmedRelationship, SuggestionCollection } from '../../db/relationshipCommands';
import type { Account } from '../../types/domain';

/**
 * Relationships the user has already confirmed, and how to undo one.
 *
 * Unlinking removes the *pairing*, not the classification. That is deliberate
 * and stated on the confirmation: the user said a row was a transfer, and
 * silently reverting its kind would change spending totals as a side effect of
 * a bookkeeping correction. Changing the kind back is a separate, visible edit
 * on the Transactions page.
 */

interface ConfirmedRelationshipsProps {
  readonly collection: SuggestionCollection<ConfirmedRelationship> | null;
  readonly accounts: readonly Account[];
  readonly pendingId: string | null;
  readonly busy: boolean;
  readonly onUnlink: (linkId: string) => void;
}

export function ConfirmedRelationships({
  collection,
  accounts,
  pendingId,
  busy,
  onUnlink,
}: ConfirmedRelationshipsProps) {
  const [confirming, setConfirming] = useState<ConfirmedRelationship | null>(null);
  const links = collection?.suggestions ?? [];

  if (links.length === 0) return null;

  return (
    <section aria-labelledby="confirmed-links-title" className="mt-10">
      <h2 id="confirmed-links-title" className="text-lg font-semibold tracking-tight text-ink">
        Links you have confirmed
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
        {`${links.length} confirmed relationship${links.length === 1 ? '' : 's'}. Unlinking removes the pairing only — the kinds you chose stay exactly as they are.`}
      </p>

      <ul className="mt-3 space-y-4">
        {links.map((entry) => {
          const pending = pendingId === entry.link.id;
          const treatment = spendingTreatment(entry.from);
          return (
            <li
              key={entry.link.id}
              className="rounded-card border border-line bg-surface p-3 sm:p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="nj">
                  {entry.link.kind === 'refund' ? 'Confirmed refund' : 'Confirmed transfer'}
                </Badge>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <TransactionSummary
                  transaction={entry.from}
                  accounts={accounts}
                  role={entry.link.kind === 'refund' ? 'The refund' : 'Money out'}
                />
                <TransactionSummary
                  transaction={entry.to}
                  accounts={accounts}
                  role={entry.link.kind === 'refund' ? 'The purchase' : 'Money in'}
                />
              </div>

              <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
                {TREATMENT_EXPLANATIONS[treatment]}
              </p>

              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                disabled={busy}
                onClick={() => setConfirming(entry)}
              >
                {pending ? 'Unlinking…' : 'Unlink these'}
              </Button>
            </li>
          );
        })}
      </ul>

      {confirming ? (
        <ConfirmDialog
          title="Remove this link?"
          confirmLabel="Unlink"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const entry = confirming;
            setConfirming(null);
            onUnlink(entry.link.id);
          }}
        >
          <p>The two transactions will stop being treated as two sides of one movement.</p>
          <p>
            <strong>Their kinds are left as they are.</strong> You decided what these rows were;
            unlinking says the pairing was wrong, not the classification. To change a kind back,
            edit the transaction on the Transactions page.
          </p>
          <p>This is one change and can be undone straight afterwards.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
