import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { openWorkspace, WorkspaceDatabase } from '../../db/database';
import { deleteAllData, summarizeWorkspace } from '../../db/workspace';
import {
  backupFilename,
  checkBackupFileSize,
  exportWorkspace,
  parseBackup,
  restoreBackup,
  serializeBackup,
} from '../../db/backup';
import { loadDemoWorkspace, resetDemoWorkspace } from '../../data/demo/seed';
import {
  WorkspaceContext,
  type RestoreReport,
  type StorageEstimate,
  type WorkspaceContextValue,
  type WorkspaceStatus,
} from './workspaceContext';

const EMPTY_STORAGE: StorageEstimate = { usageBytes: null, quotaBytes: null, persisted: null };

interface WorkspaceProviderProps {
  children: ReactNode;
  /**
   * A database owned by the caller. The provider will use it but never close
   * it — whoever supplied it is responsible for its lifetime.
   */
  database?: WorkspaceDatabase;
  /**
   * Builds a database the provider owns and is responsible for closing. Tests
   * override this to get a uniquely named database with the same ownership
   * semantics as production.
   */
  createDatabase?: () => WorkspaceDatabase;
  /**
   * Skips opening IndexedDB. Component tests that only render markup use this
   * so they neither need a database nor silently depend on one.
   */
  disabled?: boolean;
}

/**
 * Opens the local workspace and exposes it to the app.
 *
 * Every action here is local. Nothing in this provider makes a network request,
 * and nothing it handles — transactions, budgets, filenames — is ever put into
 * a URL, a page title, or a log (privacy-model.md §2, threat-model.md §8).
 */
export function WorkspaceProvider({
  children,
  database,
  createDatabase,
  disabled = false,
}: WorkspaceProviderProps) {
  const [status, setStatus] = useState<WorkspaceStatus>(disabled ? 'ready' : 'opening');
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [db, setDb] = useState<WorkspaceDatabase | null>(null);
  const [storage, setStorage] = useState<StorageEstimate>(EMPTY_STORAGE);

  useEffect(() => {
    if (disabled) return;

    let cancelled = false;

    // Ownership is decided once, here: an injected database belongs to the
    // caller, anything the provider builds belongs to the provider.
    const injected = database !== undefined;
    const instance = database ?? (createDatabase ? createDatabase() : new WorkspaceDatabase());

    const closeIfOwned = () => {
      if (!injected && instance.isOpen()) instance.close();
    };

    void openWorkspace(instance)
      .then((result) => {
        if (cancelled) {
          // The effect was torn down while the open was still in flight. Under
          // StrictMode that happens on every mount, so without this the app
          // would leak a live connection per remount.
          closeIfOwned();
          return;
        }
        if (result.status === 'ready') {
          setDb(result.db);
          setStatus('ready');
        } else {
          setBlockedMessage(result.message);
          setStatus('blocked');
        }
      })
      .catch(() => {
        closeIfOwned();
        // openWorkspace is written not to reject; this keeps an unexpected one
        // from becoming an unhandled rejection that leaves the UI mid-open.
        if (cancelled) return;
        setBlockedMessage(
          'The local workspace could not be opened. Nothing has been changed. Reloading the page may help.',
        );
        setStatus('blocked');
      });

    return () => {
      cancelled = true;
      setDb(null);
      // Closes on normal unmount too. If the open has not resolved yet the
      // database is not open, and the `cancelled` branch above closes it once
      // it is.
      closeIfOwned();
    };
  }, [database, createDatabase, disabled]);

  // `isOpen()` guards the window where the database has been closed but the
  // live subscription has not yet been torn down.
  const summary =
    useLiveQuery(() => (db?.isOpen() ? summarizeWorkspace(db) : undefined), [db]) ?? null;

  const refreshStorageEstimate = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      setStorage(EMPTY_STORAGE);
      return;
    }

    const estimate = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;

    setStorage({
      usageBytes: estimate.usage ?? null,
      quotaBytes: estimate.quota ?? null,
      persisted,
    });
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    void refreshStorageEstimate();
  }, [status, refreshStorageEstimate]);

  const requireDb = useCallback((): WorkspaceDatabase => {
    if (!db) throw new Error('The local workspace is not open.');
    return db;
  }, [db]);

  const downloadBackup = useCallback(async (): Promise<string> => {
    const document_ = await exportWorkspace(requireDb());
    const filename = backupFilename(document_.exportedAt);

    // Written straight to the user's device. Never uploaded anywhere
    // (privacy-model.md §5.1).
    const blob = new Blob([serializeBackup(document_)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    return filename;
  }, [requireDb]);

  const restoreFromText = useCallback(
    async (text: string): Promise<RestoreReport> => {
      const parsed = parseBackup(text);
      // Validation happens before anything is written, so a refusal leaves the
      // current workspace untouched (threat-model.md §10).
      if (!parsed.ok) return { outcome: 'rejected', rejection: parsed };

      const outcome = await restoreBackup(requireDb(), parsed.document);
      return {
        outcome: 'restored',
        counts: outcome.counts,
        ...(outcome.migratedFrom === undefined ? {} : { migratedFrom: outcome.migratedFrom }),
      };
    },
    [requireDb],
  );

  const restoreFromFile = useCallback(
    async (file: File): Promise<RestoreReport> => {
      // Size is checked against the file's metadata before a single byte is
      // read, so an oversized file never reaches memory (threat-model.md §6).
      const oversized = checkBackupFileSize(file.size);
      if (oversized) return { outcome: 'rejected', rejection: oversized };

      return restoreFromText(await file.text());
    },
    [restoreFromText],
  );

  const actions = useMemo(
    () => ({
      loadDemo: () => loadDemoWorkspace(requireDb()),
      resetDemo: () => resetDemoWorkspace(requireDb()),
      deleteEverything: () => deleteAllData(requireDb()),
      downloadBackup,
      restoreFromText,
      restoreFromFile,
      refreshStorageEstimate,
      requestPersistentStorage: async () => {
        if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
        const granted = await navigator.storage.persist();
        await refreshStorageEstimate();
        return granted;
      },
    }),
    [requireDb, downloadBackup, restoreFromText, restoreFromFile, refreshStorageEstimate],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({ status, blockedMessage, db, summary, storage, actions }),
    [status, blockedMessage, db, summary, storage, actions],
  );

  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}
