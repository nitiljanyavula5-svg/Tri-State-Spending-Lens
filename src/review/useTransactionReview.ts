import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceDatabase } from '../db/database';
import {
  DEFAULT_SORT,
  queryTransactions,
  listTransactionTags,
  type TransactionFilters,
  type TransactionPage,
  type TransactionSort,
} from '../db/transactionQueries';
import {
  editTransaction,
  editTransactions,
  type CommandResult,
  type TransactionPatch,
} from '../db/transactionCommands';
import { editTransactionAndCreateRule, type RuleDraft } from '../db/ruleCommands';
import {
  confirmRefundLink,
  confirmTransferPair,
  unlinkTransactions,
  linkedTransactionIds,
} from '../db/relationshipCommands';
import type { UndoManager } from '../db/undoManager';
import { DEFAULT_PAGE_SIZE } from '../domain/reviewLimits';
import type { Account, Transaction, TransactionKind } from '../types/domain';
import { newId } from '../lib/ids';

/**
 * Everything the review page needs, in one place.
 *
 * The page never touches Dexie: it calls the Phase 4 services through here, and
 * this hook owns the three things a component should not have to get right on
 * its own — query staleness, selection reconciliation, and the undo stack.
 */

export type ReviewStatus = 'loading' | 'ready' | 'failed';

export interface TransactionReviewApi {
  readonly status: ReviewStatus;
  readonly page: TransactionPage | null;
  readonly accounts: readonly Account[];
  readonly tags: readonly string[];
  readonly filters: TransactionFilters;
  readonly sort: TransactionSort;
  readonly pageSize: number;
  readonly selectedIds: ReadonlySet<string>;
  readonly linkedIds: ReadonlySet<string>;
  readonly busy: boolean;
  readonly undo: UndoManager;
  /** Fixed, sanitized text for the live region. Never a field value. */
  readonly announcement: string;

  setFilters(next: TransactionFilters): void;
  clearFilters(): void;
  setSort(next: TransactionSort): void;
  setPage(page: number): void;
  setPageSize(size: number): void;
  refresh(): void;

  toggleSelected(id: string): void;
  selectVisiblePage(): void;
  clearSelection(): void;

  saveTransaction(id: string, patch: TransactionPatch): Promise<CommandResult>;
  saveTransactionWithRule(
    id: string,
    patch: TransactionPatch,
    rule: RuleDraft,
  ): Promise<CommandResult>;
  bulkEdit(patch: TransactionPatch, label: string): Promise<CommandResult>;
  linkTransfer(
    outgoingId: string,
    incomingId: string,
    kind: Extract<TransactionKind, 'transfer' | 'payment'>,
  ): Promise<unknown>;
  linkRefund(refundId: string, purchaseId: string): Promise<unknown>;
  unlink(linkId: string): Promise<unknown>;
  runUndo(): Promise<void>;
}

export interface UseTransactionReviewOptions {
  readonly db: WorkspaceDatabase | null;
  /**
   * The session's undo stack, owned by the workspace provider.
   *
   * Passed in rather than created here: a stack created inside this hook would
   * die with the page, and the contract makes a reload the only boundary.
   */
  readonly undo: UndoManager;
  /** The provider's refresh, called once after a successful write. */
  readonly onWorkspaceChanged?: () => void;
  readonly generateId?: () => string;
}

export function useTransactionReview(options: UseTransactionReviewOptions): TransactionReviewApi {
  const { db, undo, onWorkspaceChanged, generateId = newId } = options;

  const [filters, setFiltersState] = useState<TransactionFilters>({});
  const [sort, setSortState] = useState<TransactionSort>(DEFAULT_SORT);
  const [page, setPageState] = useState(0);
  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_PAGE_SIZE);

  const [result, setResult] = useState<TransactionPage | null>(null);
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [linkedIds, setLinkedIds] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<ReviewStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * The request the hook is currently waiting for.
   *
   * A user types faster than IndexedDB answers, so a response for `PIN` can
   * arrive after the one for `PINEBROOK`. Anything whose id is not this one is
   * discarded rather than rendered.
   */
  const awaitingRef = useRef<string>('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ------------------------------------------------------------- reading - */

  useEffect(() => {
    if (!db?.isOpen()) return;

    const requestId = generateId();
    awaitingRef.current = requestId;
    setStatus((current) => (current === 'ready' ? current : 'loading'));

    void (async () => {
      try {
        const [answer, accountRows, tagList, linked] = await Promise.all([
          queryTransactions(db, { filters, sort, page, pageSize, requestId }),
          db.accounts.toArray(),
          listTransactionTags(db),
          linkedTransactionIds(db),
        ]);

        if (!mountedRef.current || awaitingRef.current !== requestId) return;

        setResult(answer);
        setAccounts(accountRows);
        setTags(tagList);
        setLinkedIds(linked);
        setStatus('ready');
      } catch {
        // A read failure is a state to render, not an exception to swallow.
        // The message never carries a Dexie detail or a stored value.
        if (!mountedRef.current || awaitingRef.current !== requestId) return;
        setStatus('failed');
      }
    })();
  }, [db, filters, sort, page, pageSize, reloadToken, generateId]);

  /**
   * Selection is reconciled against whatever the latest page can actually see.
   *
   * A selection is a list of ids, and ids outlive the rows they name. Keeping
   * one for a transaction that a filter change, an undo, or a rollback removed
   * would let a bulk action target rows the user can no longer see.
   */
  useEffect(() => {
    if (!result) return;
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const visible = new Set(result.rows.map((row) => row.id));
      const kept = new Set([...current].filter((id) => visible.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [result]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /* ------------------------------------------------------------ commands - */

  /** Guards the window between a click and the awaited result. */
  const inFlightRef = useRef(false);

  const runCommand = useCallback(
    async (
      work: () => Promise<CommandResult>,
      successMessage: (result: Extract<CommandResult, { ok: true }>) => string,
    ): Promise<CommandResult> => {
      if (inFlightRef.current || !db?.isOpen()) {
        return {
          ok: false,
          reason: 'workspace-write-failed',
          message: 'That change could not be saved. Nothing was changed.',
          problemPaths: [],
        };
      }

      inFlightRef.current = true;
      setBusy(true);

      try {
        const outcome = await work();
        if (outcome.ok) {
          undo.push(outcome.undo);
          setAnnouncement(successMessage(outcome));
          refresh();
          // The provider is told once, after the write settled.
          onWorkspaceChanged?.();
        } else {
          setAnnouncement(outcome.message);
        }
        return outcome;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [db, undo, refresh, onWorkspaceChanged],
  );

  const saveTransaction = useCallback(
    (id: string, patch: TransactionPatch) =>
      runCommand(
        () => editTransaction(db!, id, patch),
        () => 'Transaction saved.',
      ),
    [db, runCommand],
  );

  const saveTransactionWithRule = useCallback(
    (id: string, patch: TransactionPatch, rule: RuleDraft) =>
      runCommand(
        async () => (await editTransactionAndCreateRule(db!, id, patch, rule)).command,
        () => 'Transaction saved and rule created for future imports.',
      ),
    [db, runCommand],
  );

  const bulkEdit = useCallback(
    (patch: TransactionPatch, label: string) =>
      runCommand(
        () => editTransactions(db!, [...selectedIds], patch, { label }),
        (result) => `${result.changedCount} transactions updated.`,
      ),
    [db, runCommand, selectedIds],
  );

  const linkTransfer = useCallback(
    (
      outgoingId: string,
      incomingId: string,
      kind: Extract<TransactionKind, 'transfer' | 'payment'>,
    ) =>
      runCommand(
        async () => (await confirmTransferPair(db!, outgoingId, incomingId, kind)) as CommandResult,
        () => (kind === 'payment' ? 'Card payment linked.' : 'Transfer linked.'),
      ),
    [db, runCommand],
  );

  const linkRefund = useCallback(
    (refundId: string, purchaseId: string) =>
      runCommand(
        async () => (await confirmRefundLink(db!, refundId, purchaseId)) as CommandResult,
        () => 'Refund linked to its purchase.',
      ),
    [db, runCommand],
  );

  const unlink = useCallback(
    (linkId: string) =>
      runCommand(
        async () => (await unlinkTransactions(db!, linkId)) as CommandResult,
        () => 'Relationship removed.',
      ),
    [db, runCommand],
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

  /* ------------------------------------------------------------ controls - */

  const setFilters = useCallback((next: TransactionFilters) => {
    setFiltersState(next);
    // A filter change invalidates the page number: page 4 of the old result set
    // is not page 4 of the new one.
    setPageState(0);
  }, []);

  const clearFilters = useCallback(() => {
    setFiltersState({});
    setPageState(0);
  }, []);

  return {
    status,
    page: result,
    accounts,
    tags,
    filters,
    sort,
    pageSize,
    selectedIds,
    linkedIds,
    busy,
    undo,
    announcement,

    setFilters,
    clearFilters,
    setSort: (next) => {
      setSortState(next);
      setPageState(0);
    },
    setPage: setPageState,
    setPageSize: (size) => {
      setPageSizeState(size);
      setPageState(0);
    },
    refresh,

    toggleSelected: (id) =>
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    // Only what is on screen. §7 forbids silently selecting every filtered row.
    selectVisiblePage: () => setSelectedIds(new Set((result?.rows ?? []).map((row) => row.id))),
    clearSelection: () => setSelectedIds(new Set()),

    saveTransaction,
    saveTransactionWithRule,
    bulkEdit,
    linkTransfer,
    linkRefund,
    unlink,
    runUndo,
  };
}

export type { Transaction };
