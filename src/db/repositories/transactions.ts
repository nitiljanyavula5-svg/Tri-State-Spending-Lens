import type { WorkspaceDatabase } from '../database';
import type { ImportSession, IsoDate, Transaction } from '../../types/domain';

export async function listTransactions(db: WorkspaceDatabase): Promise<Transaction[]> {
  return db.transactions.orderBy('postedDate').toArray();
}

export async function listTransactionsBySession(
  db: WorkspaceDatabase,
  importSessionId: string,
): Promise<Transaction[]> {
  return db.transactions.where('importSessionId').equals(importSessionId).toArray();
}

export async function listTransactionsByAccount(
  db: WorkspaceDatabase,
  accountId: string,
): Promise<Transaction[]> {
  return db.transactions.where('accountId').equals(accountId).toArray();
}

export async function getTransaction(
  db: WorkspaceDatabase,
  id: string,
): Promise<Transaction | undefined> {
  return db.transactions.get(id);
}

export async function countTransactions(db: WorkspaceDatabase): Promise<number> {
  return db.transactions.count();
}

/**
 * The observed span of stored transactions.
 *
 * This is a data-layer fact about what is stored, NOT the statement range that
 * determines month completeness — that comes from the import session
 * (data-methodology.md §6).
 */
export async function transactionDateRange(
  db: WorkspaceDatabase,
): Promise<{ start: IsoDate; end: IsoDate } | null> {
  const first = await db.transactions.orderBy('postedDate').first();
  const last = await db.transactions.orderBy('postedDate').last();
  if (!first || !last) return null;
  return { start: first.postedDate, end: last.postedDate };
}

/**
 * Writes an import session and its accepted rows in one IndexedDB transaction.
 *
 * data-methodology.md §2.2: the commit either completes fully or leaves the
 * workspace unchanged. Callers must have finished parsing, normalization,
 * classification, and duplicate analysis before calling this.
 */
export async function commitImportSession(
  db: WorkspaceDatabase,
  session: ImportSession,
  transactions: Transaction[],
): Promise<void> {
  await db.transaction('rw', db.importSessions, db.transactions, async () => {
    await db.importSessions.put(session);
    if (transactions.length > 0) {
      await db.transactions.bulkPut(transactions);
    }
  });
}

/**
 * Removes one session and only that session's transactions.
 *
 * This is the storage primitive behind rollback (data-methodology.md §2.2) and
 * behind "Reset demo". `rollbackImportSession` in `src/db/importHistory.ts`
 * wraps it with the reporting and existence checks the history UI needs; this
 * layer stays deliberately small.
 *
 * The delete is keyed on the `importSessionId` index, so it can only ever match
 * rows belonging to this session — another session's transactions are not
 * merely spared, they are unreachable from here. Accounts, budgets, merchant
 * rules, recurring series, and settings live in tables this transaction does
 * not even hold open.
 *
 * Returns the number of transactions removed so callers can report it. A
 * session id that is not present removes nothing and returns 0, which is the
 * truth rather than an error: rollback is safe to repeat.
 */
export async function deleteImportSession(
  db: WorkspaceDatabase,
  importSessionId: string,
): Promise<number> {
  // An empty id is a caller bug, not a session that happens not to exist.
  // Left unguarded it would quietly match any transaction whose session id was
  // also empty, so it fails loudly instead of deleting something arbitrary.
  if (importSessionId.length === 0) {
    throw new Error('deleteImportSession requires an import session id.');
  }

  return db.transaction('rw', db.importSessions, db.transactions, async () => {
    const removed = await db.transactions.where('importSessionId').equals(importSessionId).delete();
    await db.importSessions.delete(importSessionId);
    return removed;
  });
}

export async function listImportSessions(db: WorkspaceDatabase): Promise<ImportSession[]> {
  const sessions = await db.importSessions.toArray();
  return sessions.sort((a, b) => a.importedAt.localeCompare(b.importedAt));
}

export async function getImportSession(
  db: WorkspaceDatabase,
  id: string,
): Promise<ImportSession | undefined> {
  return db.importSessions.get(id);
}
