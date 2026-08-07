import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { ImportHistoryPanel } from '../../../src/components/import/ImportHistoryPanel';
import { buildStagedImport, commitImport } from '../../../src/db/importCommit';
import { putAccount } from '../../../src/db/repositories/accounts';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { readSnapshot } from '../../../src/db/workspace';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../../unit/helpers/testDatabase';
import { renderWithProviders } from '../../unit/helpers/renderApp';
import type { FingerprintedRow } from '../../../src/import/normalizeFile';

let db: WorkspaceDatabase;
let seed = 0;

beforeEach(async () => {
  db = await createTestDatabase();
  seed = 0;
  await putAccount(db, {
    id: 'account-checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  });
  await setWorkspaceMode(db, 'personal');
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

function row(): FingerprintedRow {
  seed += 1;
  return {
    fileName: 'statement.csv',
    originalRow: seed,
    postedDate: '2026-04-08',
    descriptionRaw: `PINEBROOK MARKET ${seed}`,
    merchantNormalized: `PINEBROOK MARKET ${seed}`,
    descriptionCanonical: `PINEBROOK MARKET ${seed}`,
    amountCents: 1234,
    direction: 'debit',
    questions: [],
    fingerprint: seed.toString(16).padStart(64, '0'),
    occurrenceIndex: 0,
    accountId: 'account-checking',
  };
}

async function commitSession(options: {
  sessionId: string;
  rows: number;
  importedAt: string;
  fileName?: string;
}) {
  const acceptedRows = Array.from({ length: options.rows }, () => ({
    ...row(),
    fileName: options.fileName ?? 'statement.csv',
  }));

  let n = 0;
  const result = await commitImport(
    db,
    buildStagedImport({
      rowCount: options.rows,
      acceptedRows,
      excludedRows: [],
      rejections: [],
      duplicateCandidates: [],
      warnings: [],
      sourceFileNames: [options.fileName ?? 'statement.csv'],
      newAccounts: [],
      sessionId: options.sessionId,
      newId: () => {
        n += 1;
        return `${options.sessionId}-txn-${n}`;
      },
      clock: fixedClock(options.importedAt),
    }),
  );

  expect(result.ok).toBe(true);
}

describe('the import history panel', () => {
  it('explains the empty state without claiming import is unavailable', async () => {
    renderWithProviders(<ImportHistoryPanel />, db);

    // Rendered only after the workspace has actually been read.
    await screen.findByText(/no imports yet/i);
    expect(screen.queryByText(/not implemented/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/arrives in phase/i)).not.toBeInTheDocument();
  });

  it('shows each import with its counts and sanitized file name, newest first', async () => {
    await commitSession({
      sessionId: 'session-a',
      rows: 2,
      importedAt: '2026-05-01T10:00:00.000Z',
      fileName: '../../private/april.csv',
    });
    await commitSession({
      sessionId: 'session-b',
      rows: 3,
      importedAt: '2026-06-01T10:00:00.000Z',
    });

    renderWithProviders(<ImportHistoryPanel />, db);

    const items = await screen.findAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(2);

    // Newest first. Compared by file name rather than a formatted date, which
    // would depend on the runner's time zone.
    expect(within(items[0]!).getByText('statement.csv')).toBeInTheDocument();

    // The stored name carries no path component at all.
    expect(screen.getByText('private-april.csv')).toBeInTheDocument();
    expect(screen.queryByText(/\.\.\//)).not.toBeInTheDocument();
  });
});

describe('rolling back from the history panel', () => {
  beforeEach(async () => {
    await commitSession({
      sessionId: 'session-a',
      rows: 3,
      importedAt: '2026-05-01T10:00:00.000Z',
    });
    await commitSession({
      sessionId: 'session-b',
      rows: 2,
      importedAt: '2026-06-01T10:00:00.000Z',
    });
  });

  it('does nothing until the confirmation is accepted', async () => {
    const before = await readSnapshot(db);
    const user = userEvent.setup();
    renderWithProviders(<ImportHistoryPanel />, db);

    await screen.findAllByRole('button', { name: /roll back/i });
    await user.click(screen.getAllByRole('button', { name: /roll back/i })[0]!);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('removes only the chosen session and reports the exact count', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportHistoryPanel />, db);

    await screen.findAllByRole('button', { name: /roll back/i });
    // The newest entry is session-b, with two transactions.
    await user.click(screen.getAllByRole('button', { name: /roll back/i })[0]!);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /remove 2 transactions/i }));

    await screen.findByText(/removed 2 transactions/i);

    const snapshot = await readSnapshot(db);
    expect(snapshot.transactions).toHaveLength(3);
    expect(snapshot.transactions.every((t) => t.importSessionId === 'session-a')).toBe(true);
    expect(snapshot.importSessions.map((s) => s.id)).toEqual(['session-a']);
    // No account is ever deleted by a rollback.
    expect(snapshot.accounts).toHaveLength(1);
  });

  it('reports an emptied account without deleting it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportHistoryPanel />, db);

    // Roll back both sessions, leaving the shared account with nothing.
    for (const _ of [0, 1]) {
      await screen.findAllByRole('button', { name: /roll back/i });
      await user.click(screen.getAllByRole('button', { name: /roll back/i })[0]!);
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /remove \d+ transaction/i }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }

    await waitFor(async () => {
      expect(await db.transactions.count()).toBe(0);
    });
    await screen.findByText(/hold no transactions/i);
    // Reported, never removed.
    expect(await db.accounts.count()).toBe(1);
  });

  it('cannot be rolled back twice into an inconsistent state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportHistoryPanel />, db);

    await screen.findAllByRole('button', { name: /roll back/i });
    await user.click(screen.getAllByRole('button', { name: /roll back/i })[0]!);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /remove 2 transactions/i });

    // Two clicks before the first settles.
    await Promise.all([user.click(confirm), user.click(confirm)]);
    await screen.findByText(/removed 2 transactions/i);

    // The second click must not have removed anything else.
    expect(await db.transactions.count()).toBe(3);
    expect(await db.importSessions.count()).toBe(1);
  });
});
