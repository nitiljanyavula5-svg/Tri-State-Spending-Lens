import 'fake-indexeddb/auto';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceDatabase } from '../../src/db/database';
import { countAll } from '../../src/db/workspace';
import { loadDemoWorkspace } from '../../src/data/demo/seed';
import { createTestDatabase, destroyTestDatabase } from './helpers/testDatabase';
import { renderApp } from './helpers/renderApp';

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  // Unmount first. Vitest runs afterEach hooks in reverse registration order,
  // so this file's teardown runs before Testing Library's global cleanup —
  // deleting the database while a live query is still subscribed would reject
  // asynchronously with DatabaseClosedError.
  cleanup();
  await destroyTestDatabase(db);
});

async function renderSettings() {
  renderApp('/app/settings', { database: db });
  // Wait for the provider to finish opening the workspace.
  await screen.findByRole('heading', { level: 1, name: /^settings$/i });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /load demo workspace/i })).toBeEnabled(),
  );
}

describe('Settings, wired to a real local workspace', () => {
  it('loads the fictional demo workspace and reports what it wrote', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.click(screen.getByRole('button', { name: /load demo workspace/i }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/demo workspace loaded/i));
    await waitFor(() => expect(status).toHaveTextContent(/fictional transactions/i));

    expect((await countAll(db)).transactions).toBeGreaterThan(0);
  });

  it('shows the fictional-data badge once the demo is loaded', async () => {
    await loadDemoWorkspace(db);
    await renderSettings();

    expect(await screen.findByText(/fictional demo data loaded/i)).toBeInTheDocument();
  });

  it('requires an explicit confirmation before deleting everything', async () => {
    const user = userEvent.setup();
    await loadDemoWorkspace(db);
    await renderSettings();

    await user.click(await screen.findByRole('button', { name: /^delete all data$/i }));

    // A single click must not destroy anything (privacy-model.md §5.3).
    expect((await countAll(db)).transactions).toBeGreaterThan(0);
    expect(screen.getByText(/delete everything stored in this browser\?/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /yes, delete everything/i }));

    await waitFor(async () => expect((await countAll(db)).transactions).toBe(0));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/all local data has been deleted/i),
    );
  });

  it('lets the user cancel a deletion without changing anything', async () => {
    const user = userEvent.setup();
    await loadDemoWorkspace(db);
    const before = (await countAll(db)).transactions;
    await renderSettings();

    await user.click(await screen.findByRole('button', { name: /^delete all data$/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(
      screen.queryByText(/delete everything stored in this browser\?/i),
    ).not.toBeInTheDocument();
    expect((await countAll(db)).transactions).toBe(before);
  });

  it('disables the delete control when there is nothing stored', async () => {
    await renderSettings();

    expect(screen.getByRole('button', { name: /^delete all data$/i })).toBeDisabled();
    expect(screen.getByText(/nothing stored in this browser to delete/i)).toBeInTheDocument();
  });

  it('states plainly that local storage is not a vault', async () => {
    await renderSettings();

    // threat-model.md §12 requires this honesty in Settings, not only on /privacy.
    expect(
      screen.getByText(/local browser storage, not encrypted vault storage/i),
    ).toBeInTheDocument();
  });
});

describe('workspace panels reflect stored records', () => {
  it('shows record counts on Overview once the demo is loaded', async () => {
    await loadDemoWorkspace(db);
    renderApp('/app/overview', { database: db });

    expect(await screen.findByText(/fictional demo workspace loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/transactions stored/i)).toBeInTheDocument();

    // Record counts only — no calculation-contract figure may appear yet.
    expect(screen.getByText(/these are record counts, not financial totals/i)).toBeInTheDocument();
  });

  it('keeps the empty state when nothing is stored', async () => {
    renderApp('/app/overview', { database: db });

    expect(
      await screen.findByRole('heading', { name: /no transactions in this workspace yet/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/fictional demo workspace loaded/i)).not.toBeInTheDocument();
  });
});
