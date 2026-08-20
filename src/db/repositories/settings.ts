import type { WorkspaceDatabase } from '../database';
import type { AppSetting } from '../../types/domain';
import { systemClock, type Clock } from '../../lib/clock';

/**
 * Known setting keys.
 *
 * Onboarding may only ask for information that improves the experience
 * (privacy-model.md §7): optional home state, preferred week start, and
 * whether credits represent income or refunds. There is no key here for
 * anything derived from location detection, because none is ever collected.
 */
export const SETTING_KEYS = {
  /** Whether this workspace holds the demo dataset, the user's own data, or nothing. */
  workspaceMode: 'workspaceMode',
  /** Which demo dataset revision was seeded, so "Reset demo" can detect staleness. */
  demoSeedVersion: 'demoSeedVersion',
  homeState: 'homeState',
  weekStart: 'weekStart',
  creditsRepresent: 'creditsRepresent',
  /**
   * The user's own statement that imported income is incomplete. Drives the
   * incomplete-income gate in calculation-contract.md §6.
   */
  incomeDataComplete: 'incomeDataComplete',
} as const;

export type WorkspaceMode = 'empty' | 'demo' | 'personal';
export type HomeState = 'NJ' | 'NY' | 'PA' | 'none';
export type WeekStart = 'sunday' | 'monday';

export async function getSetting<T>(db: WorkspaceDatabase, key: string): Promise<T | undefined> {
  const row = await db.appSettings.get(key);
  return row?.value as T | undefined;
}

export async function setSetting(
  db: WorkspaceDatabase,
  key: string,
  value: unknown,
  clock: Clock = systemClock,
): Promise<void> {
  await db.appSettings.put({ key, value, updatedAt: clock() });
}

/**
 * Removes one setting, leaving every other key untouched.
 *
 * Needed because some settings are genuinely tri-state: `incomeDataComplete`
 * distinguishes "confirmed complete", "confirmed incomplete", and "never
 * answered" (calculation-contract.md §14.1), and the third state is the *absence*
 * of the row. Writing a sentinel value instead would make silence indistinguish-
 * able from an answer, which is the distinction the contract exists to keep.
 */
export async function unsetSetting(db: WorkspaceDatabase, key: string): Promise<void> {
  await db.appSettings.delete(key);
}

export async function listSettings(db: WorkspaceDatabase): Promise<AppSetting[]> {
  const settings = await db.appSettings.toArray();
  return settings.sort((a, b) => a.key.localeCompare(b.key));
}

export async function getWorkspaceMode(db: WorkspaceDatabase): Promise<WorkspaceMode> {
  return (await getSetting<WorkspaceMode>(db, SETTING_KEYS.workspaceMode)) ?? 'empty';
}

export async function setWorkspaceMode(
  db: WorkspaceDatabase,
  mode: WorkspaceMode,
  clock: Clock = systemClock,
): Promise<void> {
  await setSetting(db, SETTING_KEYS.workspaceMode, mode, clock);
}
