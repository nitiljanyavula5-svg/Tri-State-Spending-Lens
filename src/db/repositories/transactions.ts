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
 * behind "Reset demo". The Phase 3 import-history rollback flow — confirmation,
 * reporting what was removed, and the history UI — is built on top of it and is
 * deliberately not part of Phase 2.
 *
 * Returns the number of transactions removed so callers can report it.
 */
export async function deleteImportSession(
  db: WorkspaceDatabase,
  importSessionId: string,
): Promise<number> {
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
