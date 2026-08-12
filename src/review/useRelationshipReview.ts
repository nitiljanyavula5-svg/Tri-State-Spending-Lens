import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceDatabase } from '../db/database';
import {
  collectRefundSuggestions,
  collectTransferSuggestions,
  collectUnmatchedRefunds,
  confirmRefundLink,
  confirmTransferPair,
  listConfirmedRelationships,
  unlinkTransactions,
  type ConfirmedRelationship,
  type RefundSuggestionGroup,
  type SuggestionCollection,
  type TransferPairSuggestion,
} from '../db/relationshipCommands';
import {
  editTransaction,
  type CommandResult,
  type TransactionPatch,
} from '../db/transactionCommands';
import { editTransactionAndCreateRule, type RuleDraft } from '../db/ruleCommands';
import type { UndoManager } from '../db/undoManager';
import { MAX_REVIEW_SUGGESTIONS } from '../domain/reviewLimits';
import type { Account, Transaction, TransactionKind } from '../types/domain';

/**
 * Everything the relationship-review page needs.
 *
 * The same boundary as `useTransactionReview`: components call services through
 * here and never touch Dexie. The undo stack is not created here — it belongs
 * to the workspace provider, so one twenty-entry history spans the whole
 * session and every route in it, which is what `docs/phase-4-services.md` §5
 * specifies.
 *
 * Loading suggestions writes nothing. That is the whole contract of §7 and it
 * is worth restating here because this hook is the only thing between a
 * suggestion and a command: opening this page must leave the workspace exactly
 * as it was.
 */

export type RelationshipStatus = 'loading' | 'ready' | 'failed';

/** A refusal shape both the command and the link layer can produce. */
export interface RelationshipOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export interface RelationshipReviewApi {
  readonly status: RelationshipStatus;
  readonly transfers: SuggestionCollection<TransferPairSuggestion> | null;
  readonly refunds: SuggestionCollection<RefundSuggestionGroup> | null;
  readonly unmatchedRefunds: SuggestionCollection<Transaction> | null;
  readonly confirmed: SuggestionCollection<ConfirmedRelationship> | null;
  readonly accounts: readonly Account[];
  readonly busy: boolean;
  /**
   * Which suggestion is mid-command.
   *
   * Per-item rather than global so a pending row can say so where the user
   * clicked, instead of every button in the list turning into "Working…".
   */
  readonly pendingId: string | null;
  readonly announcement: string;
  readonly undo: UndoManager;

  refresh(): void;
  confirmTransfer(
    outgoingId: string,
    incomingId: string,
    kind: Extract<TransactionKind, 'transfer' | 'payment'>,
  ): Promise<RelationshipOutcome>;
  confirmRefund(refundId: string, purchaseId: string): Promise<RelationshipOutcome>;
  unlink(linkId: string): Promise<RelationshipOutcome>;
  saveTransaction(id: string, patch: TransactionPatch): Promise<CommandResult>;
  saveTransactionWithRule(
    id: string,
    patch: TransactionPatch,
    rule: RuleDraft,
  ): Promise<CommandResult>;
  runUndo(): Promise<void>;
}

export interface UseRelationshipReviewOptions {
  readonly db: WorkspaceDatabase | null;
  /** The session's undo stack, owned by the workspace provider. */
  readonly undo: UndoManager;
  /** The provider's refresh, called once after a successful write. */
  readonly onWorkspaceChanged?: () => void;
}

const UNAVAILABLE: RelationshipOutcome = {
  ok: false,
  message: 'That change could not be saved. Nothing was changed.',
};

export function useRelationshipReview(
  options: UseRelationshipReviewOptions,
): RelationshipReviewApi {
  const { db, undo, onWorkspaceChanged } = options;

  const [transfers, setTransfers] = useState<SuggestionCollection<TransferPairSuggestion> | null>(
    null,
  );
  const [refunds, setRefunds] = useState<SuggestionCollection<RefundSuggestionGroup> | null>(null);
  const [unmatchedRefunds, setUnmatchedRefunds] =
    useState<SuggestionCollection<Transaction> | null>(null);
  const [confirmed, setConfirmed] = useState<SuggestionCollection<ConfirmedRelationship> | null>(
    null,
  );
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [status, setStatus] = useState<RelationshipStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!db?.isOpen()) return;
    let cancelled = false;

    setStatus((current) => (current === 'ready' ? current : 'loading'));

    void (async () => {
      try {
        // Every one of these reads only. Nothing here can change a row.
        const [pairs, refundGroups, links, accountRows] = await Promise.all([
          collectTransferSuggestions(db),
          collectRefundSuggestions(db),
          listConfirmedRelationships(db),
          db.accounts.toArray(),
        ]);

        // Composed here rather than inside the collector: a credit that is one
        // side of a suggested transfer already has an offer on this page, and
        // listing it again under "no matching purchase" would describe the same
        // row two contradictory ways.
        const spokenFor = new Set(
          pairs.suggestions.flatMap((pair) => [pair.outgoing.id, pair.incoming.id]),
        );
        const unmatched = await collectUnmatchedRefunds(db, MAX_REVIEW_SUGGESTIONS, {
          matched: refundGroups,
          exclude: spokenFor,
        });

        if (cancelled || !mountedRef.current) return;

        setTransfers(pairs);
        setRefunds(refundGroups);
        setUnmatchedRefunds(unmatched);
        setConfirmed(links);
        setAccounts(accountRows);
        setStatus('ready');
      } catch {
        if (cancelled || !mountedRef.current) return;
        // A read failure is a state to render. The message never carries a
        // Dexie detail or a stored value.
        setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, reloadToken]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /** Guards the window between a click and the awaited result. */
  const inFlightRef = useRef(false);

  const run = useCallback(
    async (
      id: string,
      work: () => Promise<{ ok: boolean; message?: string }>,
      success: string,
    ): Promise<RelationshipOutcome> => {
      if (inFlightRef.current || !db?.isOpen()) return UNAVAILABLE;

      inFlightRef.current = true;
      setPendingId(id);
      setBusy(true);

      try {
        const outcome = await work();
        if (outcome.ok) {
          const command = outcome as Extract<CommandResult, { ok: true }>;
          if (command.undo) undo.push(command.undo);
          setAnnouncement(success);
          refresh();
          onWorkspaceChanged?.();
          return { ok: true, message: success };
        }
        const message = outcome.message ?? UNAVAILABLE.message;
        setAnnouncement(message);
        return { ok: false, message };
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setPendingId(null);
          setBusy(false);
        }
      }
    },
    [db, undo, refresh, onWorkspaceChanged],
  );

  const confirmTransfer = useCallback(
    (
      outgoingId: string,
      incomingId: string,
      kind: Extract<TransactionKind, 'transfer' | 'payment'>,
    ) =>
      run(
        `${outgoingId}${incomingId}`,
        () => confirmTransferPair(db!, outgoingId, incomingId, kind),
        kind === 'payment'
          ? 'Card payment linked. Both sides are now left out of spending totals.'
          : 'Transfer linked. Both sides are now left out of spending totals.',
      ),
    [db, run],
  );

  const confirmRefund = useCallback(
    (refundId: string, purchaseId: string) =>
      run(
        `${refundId}${purchaseId}`,
        () => confirmRefundLink(db!, refundId, purchaseId),
        'Refund linked to its purchase. It stays a refund and reduces spending once.',
      ),
    [db, run],
  );

  const unlink = useCallback(
    (linkId: string) =>
      run(
        linkId,
        () => unlinkTransactions(db!, linkId),
        'Relationship removed. The kinds you confirmed were left as they are.',
      ),
    [db, run],
  );

  const runEdit = useCallback(
    async (
      id: string,
      work: () => Promise<CommandResult>,
      success: string,
    ): Promise<CommandResult> => {
      if (inFlightRef.current || !db?.isOpen()) {
        return {
          ok: false,
          reason: 'workspace-write-failed',
          message: UNAVAILABLE.message,
          problemPaths: [],
        };
      }

      inFlightRef.current = true;
      setPendingId(id);
      setBusy(true);
      try {
        const outcome = await work();
        if (outcome.ok) {
          undo.push(outcome.undo);
          setAnnouncement(success);
          refresh();
          onWorkspaceChanged?.();
        } else {
          setAnnouncement(outcome.message);
        }
        return outcome;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setPendingId(null);
          setBusy(false);
        }
      }
    },
    [db, undo, refresh, onWorkspaceChanged],
  );

  const saveTransaction = useCallback(
    (id: string, patch: TransactionPatch) =>
      runEdit(id, () => editTransaction(db!, id, patch), 'Transaction saved.'),
    [db, runEdit],
  );

  /**
   * The same one-atomic-action service the Transactions page uses.
   *
   * Wired through rather than quietly dropped: the editor offers to create a
   * rule, and an editor that showed the offer and then ignored it would be
   * worse than one that never offered.
   */
  const saveTransactionWithRule = useCallback(
    (id: string, patch: TransactionPatch, rule: RuleDraft) =>
      runEdit(
        id,
        async () => (await editTransactionAndCreateRule(db!, id, patch, rule)).command,
        'Transaction saved and rule created for future imports.',
      ),
    [db, runEdit],
  );

  const runUndo = useCallback(async () => {
    if (!db?.isOpen()) return;
    setBusy(true);
    try {
      const outcome = await undo.undo(db);
      if (outcome === null) return;
      setAnnouncement(outcome.ok ? 'Change undone.' : outcome.message);
      refresh();
      onWorkspaceChanged?.();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [db, undo, refresh, onWorkspaceChanged]);

  return {
    status,
    transfers,
    refunds,
    unmatchedRefunds,
    confirmed,
    accounts,
    busy,
    pendingId,
    announcement,
    undo,
    refresh,
    confirmTransfer,
    confirmRefund,
    unlink,
    saveTransaction,
    saveTransactionWithRule,
    runUndo,
  };
}
