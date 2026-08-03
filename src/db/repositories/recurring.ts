import type { WorkspaceDatabase } from '../database';
import type { RecurringSeries } from '../../types/domain';

export async function listRecurringSeries(db: WorkspaceDatabase): Promise<RecurringSeries[]> {
  const series = await db.recurringSeries.toArray();
  return series.sort((a, b) => a.merchantNormalized.localeCompare(b.merchantNormalized));
}

export async function getRecurringSeries(
  db: WorkspaceDatabase,
  id: string,
): Promise<RecurringSeries | undefined> {
  return db.recurringSeries.get(id);
}

export async function putRecurringSeries(
  db: WorkspaceDatabase,
  series: RecurringSeries,
): Promise<void> {
  await db.recurringSeries.put(series);
}

export async function putRecurringSeriesBulk(
  db: WorkspaceDatabase,
  series: RecurringSeries[],
): Promise<void> {
  await db.recurringSeries.bulkPut(series);
}

export async function deleteRecurringSeries(db: WorkspaceDatabase, id: string): Promise<void> {
  await db.recurringSeries.delete(id);
}

export async function countRecurringSeries(db: WorkspaceDatabase): Promise<number> {
  return db.recurringSeries.count();
}
