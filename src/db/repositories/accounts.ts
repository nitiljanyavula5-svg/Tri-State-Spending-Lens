import type { WorkspaceDatabase } from '../database';
import type { Account } from '../../types/domain';

export async function listAccounts(db: WorkspaceDatabase): Promise<Account[]> {
  const accounts = await db.accounts.toArray();
  return accounts.sort((a, b) => a.label.localeCompare(b.label));
}

export async function listActiveAccounts(db: WorkspaceDatabase): Promise<Account[]> {
  const accounts = await listAccounts(db);
  return accounts.filter((account) => !account.archived);
}

export async function getAccount(db: WorkspaceDatabase, id: string): Promise<Account | undefined> {
  return db.accounts.get(id);
}

export async function putAccount(db: WorkspaceDatabase, account: Account): Promise<void> {
  await db.accounts.put(account);
}

export async function putAccounts(db: WorkspaceDatabase, accounts: Account[]): Promise<void> {
  await db.accounts.bulkPut(accounts);
}

export async function countAccounts(db: WorkspaceDatabase): Promise<number> {
  return db.accounts.count();
}
