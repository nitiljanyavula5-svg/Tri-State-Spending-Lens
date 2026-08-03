import { openWorkspace, WorkspaceDatabase } from '../../../src/db/database';
import { fixedClock } from '../../../src/lib/clock';

export const TEST_CLOCK = fixedClock('2026-08-01T12:00:00.000Z');

let counter = 0;

/** A fresh, isolated database per test, so no test can observe another's rows. */
export async function createTestDatabase(): Promise<WorkspaceDatabase> {
  counter += 1;
  const db = new WorkspaceDatabase(`test-workspace-${counter}`);
  const result = await openWorkspace(db, TEST_CLOCK);
  if (result.status !== 'ready') {
    throw new Error(`Test database failed to open: ${result.reason}`);
  }
  return db;
}

export async function destroyTestDatabase(db: WorkspaceDatabase): Promise<void> {
  db.close();
  await db.delete();
}
