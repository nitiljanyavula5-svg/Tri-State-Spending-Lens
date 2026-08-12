import { createContext, useContext } from 'react';
import type { WorkspaceDatabase } from '../../db/database';
import type { WorkspaceSummary } from '../../db/workspace';
import type { BackupParseResult } from '../../db/backup';
import type { UndoManager } from '../../db/undoManager';
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
  /**
   * The session's one undo stack.
   *
   * Held here rather than inside a review page because the contract
   * (`docs/phase-4-services.md` §5) names exactly one boundary: a reload. A
   * stack created per page would also be destroyed by moving between the
   * transactions grid and the relationship review, which is not a reload — and
   * transaction, bulk, rule, and relationship commands are specified to share
   * one chronological history of twenty, which separate stacks cannot express.
   *
   * Still memory only. Nothing here is written to IndexedDB or any other
   * durable store.
   */
  undo: UndoManager;
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
