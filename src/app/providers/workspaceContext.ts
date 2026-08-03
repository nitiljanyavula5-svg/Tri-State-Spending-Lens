import { createContext, useContext } from 'react';
import type { WorkspaceDatabase } from '../../db/database';
import type { WorkspaceSummary } from '../../db/workspace';
import type { BackupParseResult } from '../../db/backup';
import type { DemoSeedOutcome } from '../../data/demo/seed';

export type WorkspaceStatus = 'opening' | 'ready' | 'blocked';

export interface StorageEstimate {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
}

export interface RestoreReport {
  outcome: 'restored' | 'rejected';
  /** Present when the restore succeeded. */
  counts?: Record<string, number>;
  migratedFrom?: number;
  /** Present when the restore was refused; safe to display. */
  rejection?: Extract<BackupParseResult, { ok: false }>;
}

export interface WorkspaceActions {
  loadDemo(): Promise<DemoSeedOutcome>;
  resetDemo(): Promise<DemoSeedOutcome>;
  deleteEverything(): Promise<void>;
  downloadBackup(): Promise<string>;
  restoreFromText(text: string): Promise<RestoreReport>;
  /** Checks the declared file size before reading any bytes. */
  restoreFromFile(file: File): Promise<RestoreReport>;
  refreshStorageEstimate(): Promise<void>;
  requestPersistentStorage(): Promise<boolean>;
}

export interface WorkspaceContextValue {
  status: WorkspaceStatus;
  /** Why the workspace is unusable. Safe to display; carries no field values. */
  blockedMessage: string | null;
  db: WorkspaceDatabase | null;
  summary: WorkspaceSummary | null;
  storage: StorageEstimate;
  actions: WorkspaceActions;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error('useWorkspace must be used inside a WorkspaceProvider.');
  }
  return value;
}

/** True once the local workspace holds at least one record. */
export function useHasWorkspaceData(): boolean {
  const { summary } = useWorkspace();
  return Boolean(summary && !summary.isEmpty);
}
