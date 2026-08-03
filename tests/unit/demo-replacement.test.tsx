import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../src/db/database';
import { replaceWorkspace, type WorkspaceSnapshot } from '../../src/db/workspace';
import { emptySnapshot } from '../../src/db/workspace';
import { getWorkspaceMode } from '../../src/db/repositories/settings';
import { WorkspaceProvider } from '../../src/app/providers/WorkspaceProvider';
import { useDemoLoader } from '../../src/components/demo/useDemoLoader';
import { loadDemoWorkspace } from '../../src/data/demo/seed';
import { createTestDatabase, destroyTestDatabase, TEST_CLOCK } from './helpers/testDatabase';
import { renderApp } from './helpers/renderApp';

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  cleanup();
  await destroyTestDatabase(db);
});

const PERSONAL_TRANSACTION_ID = 'personal-txn-0001';

/** A workspace holding the user's own data, not the demo. */
function personalWorkspace(): WorkspaceSnapshot {
  return {
    ...emptySnapshot(),
    accounts: [
      {
        id: 'personal-account',
        label: 'My Real Checking',
        type: 'checking',
        currency: 'USD',
        archived: false,
      },
    ],
    importSessions: [
      {
        id: 'personal-session',
        importedAt: TEST_CLOCK(),
        sourceFileNames: ['statement.csv'],
        accountIds: ['personal-account'],
        mappingVersion: 1,
        rowCount: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        duplicateCandidateCount: 0,
        warnings: [],
      },
    ],
    transactions: [
      {
        id: PERSONAL_TRANSACTION_ID,
        fingerprint: 'personal-fp',
        importSessionId: 'personal-session',
        originalRow: 2,
        accountId: 'personal-account',
        postedDate: '2026-05-04',
        descriptionRaw: 'A REAL PURCHASE',
        merchantNormalized: 'A REAL PURCHASE',
        amountCents: 4567,
        direction: 'debit',
        kind: 'purchase',
        categoryId: 'groceries',
        categorySource: 'user',
        classificationConfidence: 'high',
        tags: [],
        excludedFromSpending: false,
        createdAt: TEST_CLOCK(),
        updatedAt: TEST_CLOCK(),
      },
    ],
    appSettings: [{ key: 'workspaceMode', value: 'personal', updatedAt: TEST_CLOCK() }],
  };
}

async function personalDataSurvives(): Promise<boolean> {
  return (await db.transactions.get(PERSONAL_TRANSACTION_ID)) !== undefined;
}

async function renderSettings() {
  renderApp('/app/settings', { database: db });
  await screen.findByRole('heading', { level: 1, name: /^settings$/i });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /load demo workspace/i })).toBeEnabled(),
  );
}

describe('Settings will not replace personal data without confirmation', () => {
  it('asks first — a single click leaves personal data in place', async () => {
    const user = userEvent.setup();
    await replaceWorkspace(db, personalWorkspace());
    await renderSettings();

    await user.click(screen.getByRole('button', { name: /load demo workspace/i }));

    expect(screen.getByText(/this will replace what is already stored/i)).toBeInTheDocument();
    expect(await personalDataSurvives()).toBe(true);
    expect(await db.transactions.count()).toBe(1);
  });

  it('Cancel abandons the replacement and keeps personal data', async () => {
    const user = userEvent.setup();
    await replaceWorkspace(db, personalWorkspace());
    await renderSettings();

    await user.click(screen.getByRole('button', { name: /load demo workspace/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByText(/this will replace what is already stored/i)).not.toBeInTheDocument();
    expect(await personalDataSurvives()).toBe(true);
    expect(await db.transactions.count()).toBe(1);
  });

  it('replaces the workspace only after an explicit confirmation', async () => {
    const user = userEvent.setup();
    await replaceWorkspace(db, personalWorkspace());
    await renderSettings();

    await user.click(screen.getByRole('button', { name: /load demo workspace/i }));
    await user.click(screen.getByRole('button', { name: /replace with the demo/i }));

    await waitFor(async () => expect(await personalDataSurvives()).toBe(false));
    expect(await db.transactions.count()).toBeGreaterThan(1);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/demo workspace loaded/i),
    );
  });

  it('does not ask when the workspace is empty', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.click(screen.getByRole('button', { name: /load demo workspace/i }));

    // Nothing to lose, so no confirmation step.
    expect(screen.queryByText(/this will replace what is already stored/i)).not.toBeInTheDocument();
    await waitFor(async () => expect(await db.transactions.count()).toBeGreaterThan(0));
  });

  it('does not ask when the workspace already holds the demo', async () => {
    const user = userEvent.setup();
    await loadDemoWorkspace(db);
    await renderSettings();

    await user.click(screen.getByRole('button', { name: /reload demo workspace/i }));

    expect(screen.queryByText(/this will replace what is already stored/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/demo workspace loaded/i),
    );
  });
});

function DemoHarness({ onLoaded }: { onLoaded: () => Promise<void> }) {
  const demo = useDemoLoader({ onLoaded });
  return (
    <>
      <button type="button" onClick={demo.request} disabled={!demo.ready || demo.busy}>
        run demo
      </button>
      <p data-testid="demo-error">{demo.error ?? ''}</p>
    </>
  );
}

describe('failure reporting distinguishes the two failure modes', () => {
  it('does not claim data was unchanged when only the follow-up step failed', async () => {
    const user = userEvent.setup();
    // The replacement succeeds; the post-load callback (navigation, in the real
    // app) is what fails. The workspace has already been rewritten by then.
    const onLoaded = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('navigation failed'));

    render(
      <WorkspaceProvider database={db}>
        <DemoHarness onLoaded={onLoaded} />
      </WorkspaceProvider>,
    );

    const button = await screen.findByRole('button', { name: 'run demo' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(onLoaded).toHaveBeenCalled());

    // The demo really did load, and stayed loaded.
    await waitFor(async () => expect(await db.transactions.count()).toBeGreaterThan(0));
    expect(await getWorkspaceMode(db)).toBe('demo');

    const message = await screen.findByTestId('demo-error');
    expect(message).toHaveTextContent(/loaded, but the next step did not finish/i);
    // The old wording would have been a lie here.
    expect(message.textContent ?? '').not.toMatch(/left unchanged/i);
  });

  it('reports success cleanly when the follow-up step also succeeds', async () => {
    const user = userEvent.setup();
    const onLoaded = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    render(
      <WorkspaceProvider database={db}>
        <DemoHarness onLoaded={onLoaded} />
      </WorkspaceProvider>,
    );

    const button = await screen.findByRole('button', { name: 'run demo' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
    expect(screen.getByTestId('demo-error')).toHaveTextContent('');
  });
});

describe('the landing page uses the same confirmation', () => {
  it('asks before replacing personal data and keeps it on Cancel', async () => {
    const user = userEvent.setup();
    await replaceWorkspace(db, personalWorkspace());

    renderApp('/', { database: db });
    const tryDemo = await screen.findAllByRole('button', { name: /try the demo/i });
    await waitFor(() => expect(tryDemo[0]).toBeEnabled());

    await user.click(tryDemo[0]!);

    expect(screen.getAllByText(/this will replace what is already stored/i).length).toBeGreaterThan(
      0,
    );
    expect(await personalDataSurvives()).toBe(true);

    await user.click(screen.getAllByRole('button', { name: /^cancel$/i })[0]!);
    expect(await personalDataSurvives()).toBe(true);
  });
});
