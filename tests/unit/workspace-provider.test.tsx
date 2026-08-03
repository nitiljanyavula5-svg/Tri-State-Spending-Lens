import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../../src/app/providers/WorkspaceProvider';
import { useWorkspace } from '../../src/app/providers/workspaceContext';
import { WorkspaceDatabase } from '../../src/db/database';
import { createTestDatabase, destroyTestDatabase } from './helpers/testDatabase';

function StatusProbe() {
  const { status } = useWorkspace();
  return <span data-testid="status">{status}</span>;
}

let sequence = 0;
const owned: WorkspaceDatabase[] = [];

/** Builds a uniquely named database the provider will own and close. */
function ownedDatabaseFactory(): WorkspaceDatabase {
  sequence += 1;
  const db = new WorkspaceDatabase(`provider-owned-${sequence}`);
  owned.push(db);
  return db;
}

/**
 * A database whose `open()` blocks until the test releases it, so the window
 * where the effect is cancelled *while the open is still in flight* can be
 * entered deliberately instead of hoped for.
 */
function delayedOpenDatabase(name: string) {
  const db = new WorkspaceDatabase(name);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;

  const realOpen = db.open.bind(db);
  // Only awaited by `openWorkspace`, so a plain promise stands in fine for
  // Dexie's PromiseExtended here.
  db.open = (() => {
    started = true;
    return gate.then(() => realOpen());
  }) as unknown as typeof db.open;

  return { db, release: () => release(), hasStarted: () => started };
}

afterEach(async () => {
  cleanup();
  while (owned.length > 0) {
    const db = owned.pop();
    if (!db) continue;
    db.close();
    await db.delete();
  }
});

const openCount = () => owned.filter((db) => db.isOpen()).length;

describe('database ownership', () => {
  it('closes a database it created when the provider unmounts', async () => {
    const { unmount } = render(
      <WorkspaceProvider createDatabase={ownedDatabaseFactory}>
        <StatusProbe />
      </WorkspaceProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(openCount()).toBe(1);

    unmount();

    await waitFor(() => expect(openCount()).toBe(0));
  });

  it('leaves no abandoned connection after a StrictMode mount cycle', async () => {
    // StrictMode mounts, tears down, and remounts. Each pass builds its own
    // database, so without closing on cleanup every remount would leak a live
    // connection.
    const { unmount } = render(
      <StrictMode>
        <WorkspaceProvider createDatabase={ownedDatabaseFactory}>
          <StatusProbe />
        </WorkspaceProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    // However many instances StrictMode caused, at most the live one is open.
    await waitFor(() => expect(openCount()).toBeLessThanOrEqual(1));

    unmount();

    await waitFor(() => expect(openCount()).toBe(0));
  });

  it('closes a database whose open completes only after the effect was cancelled', async () => {
    sequence += 1;
    const delayed = delayedOpenDatabase(`provider-delayed-${sequence}`);
    owned.push(delayed.db);
    const closeSpy = vi.spyOn(delayed.db, 'close');

    const { unmount } = render(
      <WorkspaceProvider createDatabase={() => delayed.db}>
        <StatusProbe />
      </WorkspaceProvider>,
    );

    // The open has genuinely begun and is held open by the gate.
    await waitFor(() => expect(delayed.hasStarted()).toBe(true));
    expect(delayed.db.isOpen()).toBe(false);

    unmount();

    // Cleanup ran mid-open. It cannot have closed anything, because nothing is
    // open yet — which is precisely why the promise path has to do it.
    expect(closeSpy).not.toHaveBeenCalled();
    expect(delayed.db.isOpen()).toBe(false);

    delayed.release();

    // Now the connection really does open, and the cancelled branch must close
    // it rather than abandoning it.
    await waitFor(() => expect(closeSpy).toHaveBeenCalled());
    await waitFor(() => expect(delayed.db.isOpen()).toBe(false));
    expect(openCount()).toBe(0);
  });

  it('never closes an injected database, because the caller owns it', async () => {
    const injected = await createTestDatabase();

    const { unmount } = render(
      <WorkspaceProvider database={injected}>
        <StatusProbe />
      </WorkspaceProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    unmount();

    // Still usable by whoever supplied it.
    expect(injected.isOpen()).toBe(true);
    expect(await injected.transactions.count()).toBe(0);

    await destroyTestDatabase(injected);
  });
});
