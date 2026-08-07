import type { WorkspaceDatabase } from './database';
import type { IsoDate, IsoTimestamp } from '../types/domain';
import { sanitizeSourceFileName } from '../import/fileValidation';
import { MAX_WARNINGS } from '../import/limits';

/**
 * Import history and complete-session rollback.
 *
 * data-methodology.md §2.2: a session can be rolled back later from import
 * history, **removing only that session's transactions** — never rows created
 * by a different session, and never user-created merchant rules, budgets, or
 * settings. Rollback must report what it removed.
 *
 * The history entry below is a *view* of a stored `ImportSession`, not a second
 * copy of it. It exists so the eventual history page renders bounded,
 * neutralized text without each component re-deriving what is safe to show.
 * Nothing here reads a transaction's description or amount: history summarizes
 * an import, it does not re-display its contents.
 */

/** A stored import session, prepared for display. */
export interface ImportHistoryEntry {
  readonly sessionId: string;
  readonly importedAt: IsoTimestamp;
  /** Neutralized on the way in and re-neutralized here; never a path. */
  readonly sourceFileNames: readonly string[];
  readonly accountIds: readonly string[];
  /** Account labels, resolved for display. Absent accounts are simply omitted. */
  readonly accountLabels: readonly string[];
  readonly rowCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly duplicateCandidateCount: number;
  /** Rows still stored from this session. Diverges from `acceptedCount` only
   *  if something outside import has since removed rows. */
  readonly storedTransactionCount: number;
  readonly statementRangeStart?: IsoDate;
  readonly statementRangeEnd?: IsoDate;
  readonly warnings: readonly string[];
  /**
   * Whether this session's own counts still reconcile.
   *
   * `rowCount = acceptedCount + rejectedCount` is enforced at commit, so a
   * stored session that fails it was not written by this build. Surfacing it as
   * a flag lets history say so plainly instead of rendering numbers that do not
   * add up as though they did.
   */
  readonly countsReconcile: boolean;
}

/**
 * Import history, newest first.
 *
 * Account labels are resolved once for the whole list rather than per session,
 * because a workspace has a handful of accounts and many sessions.
 */
export async function listImportHistory(db: WorkspaceDatabase): Promise<ImportHistoryEntry[]> {
  const [sessions, accounts] = await Promise.all([
    db.importSessions.toArray(),
    db.accounts.toArray(),
  ]);

  const labelById = new Map(accounts.map((account) => [account.id, account.label]));

  const entries = await Promise.all(
    sessions.map(async (session) => {
      const storedTransactionCount = await db.transactions
        .where('importSessionId')
        .equals(session.id)
        .count();

      const entry: ImportHistoryEntry = {
        sessionId: session.id,
        importedAt: session.importedAt,
        sourceFileNames: session.sourceFileNames.map((name) => sanitizeSourceFileName(name)),
        accountIds: [...session.accountIds],
        accountLabels: session.accountIds
          .map((id) => labelById.get(id))
          .filter((label): label is string => label !== undefined),
        rowCount: session.rowCount,
        acceptedCount: session.acceptedCount,
        rejectedCount: session.rejectedCount,
        duplicateCandidateCount: session.duplicateCandidateCount,
        storedTransactionCount,
        ...(session.statementRangeStart === undefined
          ? {}
          : { statementRangeStart: session.statementRangeStart }),
        ...(session.statementRangeEnd === undefined
          ? {}
          : { statementRangeEnd: session.statementRangeEnd }),
        // Bounded again on read. A session restored from a backup written by
        // another build is not guaranteed to have honoured this build's cap.
        warnings: session.warnings.slice(0, MAX_WARNINGS),
        countsReconcile: session.rowCount === session.acceptedCount + session.rejectedCount,
      };

      return entry;
    }),
  );

  return entries.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

/* ------------------------------------------------------------- rollback - */

export type RollbackRejectionReason = 'session-not-found' | 'workspace-write-failed';

export interface RollbackRejection {
  readonly ok: false;
  readonly reason: RollbackRejectionReason;
  readonly message: string;
}

export interface RollbackSuccess {
  readonly ok: true;
  readonly sessionId: string;
  /** Exactly how many transactions were deleted. */
  readonly removedTransactionCount: number;
  /**
   * Accounts this session wrote to that now hold no transactions at all.
   *
   * Reported, never deleted — see the note on `rollbackImportSession`.
   */
  readonly emptiedAccountIds: readonly string[];
}

export type RollbackResult = RollbackSuccess | RollbackRejection;

const ROLLBACK_MESSAGES: Record<RollbackRejectionReason, string> = {
  'session-not-found':
    'That import is no longer in your history, so nothing was removed. It may have been rolled back already.',
  'workspace-write-failed':
    'The import could not be rolled back. Nothing was changed — your workspace is exactly as it was.',
};

/**
 * Removes one import session and every transaction it created.
 *
 * Everything happens in a single transaction, so a failure at any point leaves
 * the workspace exactly as it was. The session must exist: rolling back an id
 * that is not there reports `session-not-found` rather than claiming a success
 * that removed nothing. Repeating the call is therefore safe and honest — the
 * second attempt says the session is gone.
 *
 * **Accounts are never deleted.** An account left empty by a rollback may just
 * as easily be one the user created themselves and imported into as one this
 * import brought into existence, and `ImportSession` records only the accounts
 * a session *wrote to*, not the ones it *created* — the shape is pinned by
 * data-methodology.md §2.1, so there is no field that could tell them apart.
 * Deleting the wrong one is unrecoverable, while leaving an empty account
 * behind costs the user one click in Settings. Emptied accounts are reported so
 * the interface can offer that click; the decision stays with the user.
 */
export async function rollbackImportSession(
  db: WorkspaceDatabase,
  sessionId: string,
): Promise<RollbackResult> {
  if (sessionId.length === 0) {
    return {
      ok: false,
      reason: 'session-not-found',
      message: ROLLBACK_MESSAGES['session-not-found'],
    };
  }

  try {
    return await db.transaction(
      'rw',
      db.importSessions,
      db.transactions,
      db.accounts,
      async (): Promise<RollbackResult> => {
        const session = await db.importSessions.get(sessionId);
        if (!session) {
          return {
            ok: false,
            reason: 'session-not-found',
            message: ROLLBACK_MESSAGES['session-not-found'],
          };
        }

        // Keyed on the `importSessionId` index, so no other session's rows are
        // reachable from this query — they are not merely skipped.
        const removedTransactionCount = await db.transactions
          .where('importSessionId')
          .equals(sessionId)
          .delete();

        await db.importSessions.delete(sessionId);

        // Counted after the delete, inside the same transaction, so the answer
        // reflects the workspace this rollback is producing rather than the one
        // it started from.
        const emptiedAccountIds: string[] = [];
        for (const accountId of session.accountIds) {
          const remaining = await db.transactions.where('accountId').equals(accountId).count();
          if (remaining === 0 && (await db.accounts.get(accountId))) {
            emptiedAccountIds.push(accountId);
          }
        }

        return { ok: true, sessionId, removedTransactionCount, emptiedAccountIds };
      },
    );
  } catch {
    // A Dexie error can name a primary key, and a key here is a transaction id.
    return {
      ok: false,
      reason: 'workspace-write-failed',
      message: ROLLBACK_MESSAGES['workspace-write-failed'],
    };
  }
}
