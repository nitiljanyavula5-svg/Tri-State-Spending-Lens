import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../import/ConfirmDialog';
import { SelectField } from '../import/FormControls';
import { TransactionSummary } from './TransactionSummary';
import { MAX_REVIEW_SUGGESTIONS } from '../../domain/reviewLimits';
import { TRANSFER_WINDOW_DAYS } from '../../db/relationshipCommands';
import type { SuggestionCollection, TransferPairSuggestion } from '../../db/relationshipCommands';
import type { Account, TransactionKind } from '../../types/domain';

/**
 * Possible transfers and card payments, offered for confirmation.
 *
 * `category-rules.md` §7 is the reason this surface is shaped the way it is:
 * `transfer` and `payment` are **excluded from net spending**, so a wrong
 * confirmation silently hides money the user really spent. Three consequences,
 * all visible in the markup below:
 *
 *  - Nothing is pre-selected and nothing is confirmed by arriving here.
 *  - Every pair states *why* it was suggested and that a suggestion is not proof.
 *  - The transfer/card-payment choice is the user's, not an inference — the
 *    proposal is a default in a control they can change.
 */

type LinkKind = Extract<TransactionKind, 'transfer' | 'payment'>;

const KIND_OPTIONS: readonly { value: LinkKind; label: string }[] = [
  { value: 'transfer', label: 'A transfer between my own accounts' },
  { value: 'payment', label: 'A payment to my credit card' },
];

interface TransferSuggestionsProps {
  readonly collection: SuggestionCollection<TransferPairSuggestion> | null;
  readonly accounts: readonly Account[];
  readonly loading: boolean;
  readonly pendingId: string | null;
  readonly busy: boolean;
  readonly onConfirm: (outgoingId: string, incomingId: string, kind: LinkKind) => void;
}

export function TransferSuggestions({
  collection,
  accounts,
  loading,
  pendingId,
  busy,
  onConfirm,
}: TransferSuggestionsProps) {
  /** The user's kind choice per pair, defaulting to what was proposed. */
  const [chosenKind, setChosenKind] = useState<Record<string, LinkKind>>({});
  const [confirming, setConfirming] = useState<TransferPairSuggestion | null>(null);

  const keyOf = (pair: TransferPairSuggestion) => `${pair.outgoing.id}${pair.incoming.id}`;
  const kindFor = (pair: TransferPairSuggestion) => chosenKind[keyOf(pair)] ?? pair.proposedKind;

  return (
    <section aria-labelledby="transfer-suggestions-title" className="mt-10">
      <h2 id="transfer-suggestions-title" className="text-lg font-semibold tracking-tight text-ink">
        Possible transfers and card payments
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
        These are <strong>suggestions, not conclusions</strong>. Two unrelated payments of the same
        amount look identical to a computer, so nothing is linked and no kind is changed until you
        confirm a pair yourself.
      </p>

      {loading ? <p className="mt-4 text-sm text-ink-muted">Looking for possible pairs…</p> : null}

      {!loading && collection && collection.suggestions.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={ArrowLeftRight}
            title="No possible transfers found"
            description={`Nothing in this workspace looks like two sides of one movement — that means no pair of transactions in different accounts shares an amount, opposite directions, and dates within ${TRANSFER_WINDOW_DAYS} days. You can still set a transaction's kind by hand from the Transactions page.`}
          />
        </div>
      ) : null}

      {collection && collection.suggestions.length > 0 ? (
        <>
          <p className="mt-4 text-sm font-semibold text-ink">
            {`${collection.suggestions.length} possible pair${collection.suggestions.length === 1 ? '' : 's'}`}
          </p>
          {collection.truncated ? (
            <p className="mt-1 text-sm text-ink-muted">
              {`Only the first ${MAX_REVIEW_SUGGESTIONS} are shown so this page stays quick. Confirm or dismiss some and reload to see more.`}
            </p>
          ) : null}

          <ul className="mt-3 space-y-4">
            {collection.suggestions.map((pair) => {
              const key = keyOf(pair);
              const pending = pendingId === key;
              return (
                <li key={key} className="rounded-card border border-line bg-surface p-3 sm:p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="notice">Suggestion</Badge>
                    <span className="text-xs text-ink-muted">
                      {pair.daysApart === 0
                        ? 'Both posted on the same day'
                        : `${pair.daysApart} day${pair.daysApart === 1 ? '' : 's'} apart`}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <TransactionSummary
                      transaction={pair.outgoing}
                      accounts={accounts}
                      role="Money out"
                    />
                    <TransactionSummary
                      transaction={pair.incoming}
                      accounts={accounts}
                      role="Money in"
                    />
                  </div>

                  <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
                    {pair.reason}
                  </p>

                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="w-full sm:w-80">
                      <SelectField
                        label="If you link these, treat them as"
                        value={kindFor(pair)}
                        options={KIND_OPTIONS}
                        onChange={(value) =>
                          value && setChosenKind((current) => ({ ...current, [key]: value }))
                        }
                      />
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirming(pair)}
                    >
                      {pending ? 'Linking…' : 'Link these two'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title="Link these two transactions?"
          confirmLabel="Link them"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const pair = confirming;
            setConfirming(null);
            onConfirm(pair.outgoing.id, pair.incoming.id, kindFor(pair));
          }}
        >
          <p>
            {kindFor(confirming) === 'payment'
              ? 'Both rows will be recorded as a credit-card payment.'
              : 'Both rows will be recorded as a transfer between your own accounts.'}
          </p>
          <p>
            Money that moves between your own accounts is <strong>never counted as spending</strong>
            , so both sides will leave your spending totals together. That is the point of linking
            them: without it, the same money would be counted twice.
          </p>
          <p>This is one change and can be undone straight afterwards.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
