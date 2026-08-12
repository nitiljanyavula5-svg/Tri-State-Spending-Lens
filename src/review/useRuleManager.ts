import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceDatabase } from '../db/database';
import {
  applyRuleToTransactions,
  collectMatchingTransactionIds,
  countMatchingTransactions,
  createUserRule,
  deleteUserRule,
  listUserRules,
  updateUserRule,
  type RuleCommandResult,
  type RuleDraft,
  type RulePage,
  type RuleRejection,
} from '../db/ruleCommands';
import type { CommandResult } from '../db/transactionCommands';
import type { UndoManager } from '../db/undoManager';
import { RULES_PAGE_SIZE } from '../domain/reviewLimits';
import type { MerchantRule } from '../types/domain';

/**
 * Everything the rule manager needs, in one place.
 *
 * The same shape as `useTransactionReview` and for the same reason: the
 * component calls services through here and never touches Dexie. Three things
 * this owns that a component should not have to get right on its own — the
 * in-flight guard, the reload after a mutation, and the fact that a failure is
 * a state to render rather than an exception to swallow.
 */

export type RuleManagerStatus = 'loading' | 'ready' | 'failed';

export type DeleteRuleResult = { ok: true; deleted: boolean } | RuleRejection;

export interface RuleManagerApi {
  readonly status: RuleManagerStatus;
  readonly page: RulePage | null;
  readonly busy: boolean;
  /** Fixed, sanitized text for the live region. Never a pattern or a merchant. */
  readonly announcement: string;

  setPage(page: number): void;
  refresh(): void;

  create(draft: RuleDraft): Promise<RuleCommandResult>;
  update(id: string, draft: RuleDraft): Promise<RuleCommandResult>;
  remove(rule: MerchantRule): Promise<DeleteRuleResult>;
  /**
   * Applies a rule to transactions already stored.
   *
   * `category-rules.md` §5.3 requires this to exist and to be explicit and
   * undoable: creating a rule never rewrites history, so changing history is a
   * deliberate second action. One atomic command, one undo entry.
   */
  applyToExisting(rule: MerchantRule): Promise<CommandResult>;
  /** The ids a rule would change, bounded. Reads only. */
  previewMatches(rule: MerchantRule): Promise<{ ids: readonly string[]; truncated: boolean }>;
  /** Bounded count of stored rows a draft would match. Reads only. */
  countMatches(rule: Pick<MerchantRule, 'matchType' | 'pattern'>): Promise<{
    count: number;
    truncated: boolean;
  }>;
}

export interface UseRuleManagerOptions {
  readonly db: WorkspaceDatabase | null;
  /** The session's undo stack, owned by the workspace provider. */
  readonly undo: UndoManager;
  readonly pageSize?: number;
  /**
   * Where outcomes are announced.
   *
   * The host page owns the live region, because a page with two polite regions
   * announces two things at once and a screen-reader user hears neither
   * cleanly. Called on every settled command, not on a state change, so the
   * same message twice in a row is still announced twice.
   */
  readonly onAnnounce?: (message: string) => void;
}

const UNAVAILABLE: RuleRejection = {
  ok: false,
  reason: 'workspace-write-failed',
  message:
    'That rule could not be saved. Nothing was changed — your workspace is exactly as it was.',
  problemPaths: [],
};

export function useRuleManager(options: UseRuleManagerOptions): RuleManagerApi {
  const { db, undo, pageSize = RULES_PAGE_SIZE, onAnnounce } = options;

  const [page, setPageState] = useState(0);
  const [result, setResult] = useState<RulePage | null>(null);
  const [status, setStatus] = useState<RuleManagerStatus>('loading');
  const [busy, setBusy] = useState(false);
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

    // Kept at `ready` across a reload so the list does not blink back to a
    // skeleton every time a rule is saved.
    setStatus((current) => (current === 'ready' ? current : 'loading'));

    void (async () => {
      try {
        const answer = await listUserRules(db, page, pageSize);
        if (cancelled || !mountedRef.current) return;
        setResult(answer);
        setStatus('ready');
      } catch {
        if (cancelled || !mountedRef.current) return;
        // Never carries a Dexie detail or a stored value.
        setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, page, pageSize, reloadToken]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /** Guards the window between a click and the awaited result. */
  const inFlightRef = useRef(false);

  const run = useCallback(
    async <T extends { ok: boolean }>(
      work: () => Promise<T>,
      unavailable: T,
      describe: (outcome: T) => string,
    ): Promise<T> => {
      if (inFlightRef.current || !db?.isOpen()) return unavailable;

      inFlightRef.current = true;
      setBusy(true);
      try {
        const outcome = await work();
        const message = describe(outcome);
        setAnnouncement(message);
        onAnnounce?.(message);
        // Only rule data is re-read. Nothing here changes transactions, so a
        // full workspace reload would be work the user waits for and no
        // interface consumes.
        if (outcome.ok) refresh();
        return outcome;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [db, refresh, onAnnounce],
  );

  const create = useCallback(
    (draft: RuleDraft) =>
      run<RuleCommandResult>(
        () => createUserRule(db!, draft),
        UNAVAILABLE,
        (outcome) =>
          outcome.ok
            ? 'Rule saved. It applies to future imports; nothing already stored was changed.'
            : outcome.message,
      ),
    [db, run],
  );

  const update = useCallback(
    (id: string, draft: RuleDraft) =>
      run<RuleCommandResult>(
        () => updateUserRule(db!, id, draft),
        UNAVAILABLE,
        (outcome) =>
          outcome.ok
            ? 'Rule updated. It applies to future imports; nothing already stored was changed.'
            : outcome.message,
      ),
    [db, run],
  );

  const remove = useCallback(
    (rule: MerchantRule) =>
      run<DeleteRuleResult>(
        () => deleteUserRule(db!, rule.id),
        { ...UNAVAILABLE, message: 'That rule could not be removed. Nothing was changed.' },
        (outcome) =>
          outcome.ok
            ? 'Rule deleted. Your transactions were not changed, deleted, or recategorized.'
            : outcome.message,
      ),
    [db, run],
  );

  const previewMatches = useCallback(
    async (rule: MerchantRule) => {
      if (!db?.isOpen()) return { ids: [] as readonly string[], truncated: false };
      try {
        return await collectMatchingTransactionIds(db, rule);
      } catch {
        return { ids: [] as readonly string[], truncated: false };
      }
    },
    [db],
  );

  const applyToExisting = useCallback(
    (rule: MerchantRule) =>
      run<CommandResult>(
        async () => {
          const { ids } = await collectMatchingTransactionIds(db!, rule);
          return applyRuleToTransactions(db!, rule, ids);
        },
        {
          ok: false,
          reason: 'workspace-write-failed',
          message: 'Those transactions could not be changed. Nothing was changed.',
          problemPaths: [],
        },
        (outcome) =>
          outcome.ok
            ? `${outcome.changedCount.toLocaleString('en-US')} transactions updated by this rule. This can be undone.`
            : outcome.message,
      ).then((outcome) => {
        // A rule application is a bulk edit, so it joins the same session undo
        // history as every other command.
        if (outcome.ok) undo.push(outcome.undo);
        return outcome;
      }),
    [db, run, undo],
  );

  const countMatches = useCallback(
    async (rule: Pick<MerchantRule, 'matchType' | 'pattern'>) => {
      if (!db?.isOpen()) return { count: 0, truncated: false };
      try {
        return await countMatchingTransactions(db, rule);
      } catch {
        return { count: 0, truncated: false };
      }
    },
    [db],
  );

  return {
    status,
    page: result,
    busy,
    announcement,
    setPage: setPageState,
    refresh,
    create,
    update,
    remove,
    applyToExisting,
    previewMatches,
    countMatches,
  };
}
