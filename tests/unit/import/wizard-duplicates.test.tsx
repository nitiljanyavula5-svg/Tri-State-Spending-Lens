import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { ImportWizard } from '../../../src/components/import/ImportWizard';
import { putAccount } from '../../../src/db/repositories/accounts';
import { readSnapshot } from '../../../src/db/workspace';
import { createTestDatabase, destroyTestDatabase } from '../../unit/helpers/testDatabase';
import { renderWithProviders } from '../../unit/helpers/renderApp';
import { createInProcessWorkerClient } from './helpers/inProcessWorkerClient';

/**
 * Within-file duplicate decisions, and decision identity, through the wizard.
 *
 * Every assertion is about **persisted rows**. The question these answer is not
 * "did the UI say the right thing" but "did exactly the intended row end up in
 * IndexedDB, and did no other row move because of it".
 */

/** Two identical coffees, then an unrelated row. */
const REPEATED_CSV = [
  'Date,Description,Amount',
  '2026-04-08,HARBOR BEAN COFFEE,-4.75',
  '2026-04-08,HARBOR BEAN COFFEE,-4.75',
  '2026-04-09,PINEBROOK MARKET,-33.12',
].join('\n');

/** A different file that also repeats internally, for the same-name case. */
const OTHER_REPEATED_CSV = [
  'Date,Description,Amount',
  '2026-05-01,RIVERLINE TRANSIT,-2.90',
  '2026-05-01,RIVERLINE TRANSIT,-2.90',
].join('\n');

const PLAIN_CSV = ['Date,Description,Amount', '2026-06-01,GARDEN STATE FUEL,-40.00'].join('\n');

function csvFile(contents: string, name = 'statement.csv'): File {
  return new File([contents], name, { type: 'text/csv' });
}

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

async function account(id: string, label: string) {
  await putAccount(db, { id, label, type: 'checking', currency: 'USD', archived: false });
}

async function renderWizard() {
  const view = renderWithProviders(
    <ImportWizard createClient={() => createInProcessWorkerClient()} />,
    db,
  );
  await screen.findByRole('heading', { name: /Step 1 of 6/i });
  return view;
}

type User = ReturnType<typeof userEvent.setup>;

async function clickContinue(user: User) {
  const button = await screen.findByRole('button', { name: 'Continue' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

/** Stages the files, accepts detection, maps every file, assigns accounts. */
async function setUp(user: User, files: readonly File[], accountIds: readonly string[]) {
  for (const file of files) {
    await user.upload(screen.getByLabelText(/choose csv files/i), file);
  }
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: /^Remove /i })).toHaveLength(files.length),
  );
  await clickContinue(user);

  await screen.findByRole('heading', { name: /Step 2 of 6/i });
  await waitFor(() => expect(screen.getAllByLabelText(/^Delimiter$/i)).toHaveLength(files.length));
  await clickContinue(user);

  await screen.findByRole('heading', { name: /Step 3 of 6/i });
  const dates = screen.getAllByLabelText(/^Date column$/i);
  const descriptions = screen.getAllByLabelText(/^Description column$/i);
  const amounts = screen.getAllByLabelText(/^Amount column$/i);
  for (let index = 0; index < files.length; index += 1) {
    await user.selectOptions(dates[index]!, '0');
    await user.selectOptions(descriptions[index]!, '1');
    await user.selectOptions(amounts[index]!, '2');
  }
  await clickContinue(user);

  await screen.findByRole('heading', { name: /Step 4 of 6/i });
  const accountSelects = screen.getAllByLabelText(/which account/i);
  for (let index = 0; index < files.length; index += 1) {
    await user.selectOptions(accountSelects[index]!, accountIds[index]!);
  }
  for (const radio of screen.getAllByLabelText(/Year first/i)) {
    await user.click(radio);
  }
  await clickContinue(user);

  await screen.findByRole('heading', { name: /Step 5 of 6/i });
  await screen.findByText(/Rows read/i);
}

async function commit(user: User, expectedCount: number) {
  await clickContinue(user);
  await screen.findByRole('heading', { name: /Step 6 of 6/i });
  await user.click(
    await screen.findByRole('button', { name: new RegExp(`Import ${expectedCount} transaction`) }),
  );
  await screen.findByText(/Import complete/i);
}

describe('a repeat inside one file', () => {
  it('is offered as a candidate and kept by default', async () => {
    await account('account-a', 'Everyday Checking');
    const user = userEvent.setup();
    await renderWizard();

    await setUp(user, [csvFile(REPEATED_CSV)], ['account-a']);

    // Surfaced, scoped correctly, and pointing at the row it repeats.
    await screen.findByText(/repeated inside one file/i);
    expect(screen.getByText(/Row 2/)).toBeInTheDocument();
    expect(screen.getByText(/matches row 1/i)).toBeInTheDocument();
    // Nothing is excluded unless the user says so: the only action offered on
    // the candidate is to exclude it, which means it is currently kept.
    expect(screen.getByRole('button', { name: /exclude it/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /keep it/i })).not.toBeInTheDocument();

    await commit(user, 3);

    const snapshot = await readSnapshot(db);
    // Both legitimate occurrences committed.
    expect(snapshot.transactions).toHaveLength(3);
    expect(
      snapshot.transactions.filter((row) => row.descriptionRaw === 'HARBOR BEAN COFFEE'),
    ).toHaveLength(2);

    // And they remain distinguishable in storage.
    const fingerprints = snapshot.transactions.map((row) => row.fingerprint);
    expect(new Set(fingerprints).size).toBe(3);

    const session = snapshot.importSessions[0]!;
    expect(session.rowCount).toBe(3);
    expect(session.acceptedCount).toBe(3);
    expect(session.rejectedCount).toBe(0);
    expect(session.duplicateCandidateCount).toBe(1);
    expect(session.rowCount).toBe(session.acceptedCount + session.rejectedCount);
  });

  it('removes exactly the excluded row when the user excludes it', async () => {
    await account('account-a', 'Everyday Checking');
    const user = userEvent.setup();
    await renderWizard();

    await setUp(user, [csvFile(REPEATED_CSV)], ['account-a']);
    await screen.findByText(/repeated inside one file/i);
    await user.click(screen.getByRole('button', { name: /exclude it/i }));

    await commit(user, 2);

    const snapshot = await readSnapshot(db);
    expect(snapshot.transactions).toHaveLength(2);
    // One coffee removed, one kept — not both, and not neither.
    expect(
      snapshot.transactions.filter((row) => row.descriptionRaw === 'HARBOR BEAN COFFEE'),
    ).toHaveLength(1);
    // The unrelated row is untouched.
    expect(snapshot.transactions.some((row) => row.descriptionRaw === 'PINEBROOK MARKET')).toBe(
      true,
    );

    const session = snapshot.importSessions[0]!;
    expect(session.rowCount).toBe(3);
    expect(session.acceptedCount).toBe(2);
    // An excluded candidate becomes a rejection only because the user said so.
    expect(session.rejectedCount).toBe(1);
    expect(session.duplicateCandidateCount).toBe(1);
    expect(session.rowCount).toBe(session.acceptedCount + session.rejectedCount);
  });
});

describe('two staged files that share a name', () => {
  it('keep their decisions apart', async () => {
    await account('account-a', 'Everyday Checking');
    const user = userEvent.setup();
    await renderWizard();

    // Both are called `statement.csv`, and both have a candidate at row 2.
    await setUp(
      user,
      [csvFile(REPEATED_CSV, 'statement.csv'), csvFile(OTHER_REPEATED_CSV, 'statement.csv')],
      ['account-a', 'account-a'],
    );

    await screen.findByText(/repeated inside one file/i);
    const excludeButtons = screen.getAllByRole('button', { name: /exclude it/i });
    expect(excludeButtons).toHaveLength(2);

    // Exclude only the first file's repeat.
    await user.click(excludeButtons[0]!);

    await commit(user, 4);

    const snapshot = await readSnapshot(db);
    const descriptions = snapshot.transactions.map((row) => row.descriptionRaw).sort();

    // File one lost exactly one coffee; file two kept both fares.
    expect(descriptions).toEqual([
      'HARBOR BEAN COFFEE',
      'PINEBROOK MARKET',
      'RIVERLINE TRANSIT',
      'RIVERLINE TRANSIT',
    ]);

    const session = snapshot.importSessions[0]!;
    expect(session.rowCount).toBe(5);
    expect(session.acceptedCount).toBe(4);
    expect(session.rejectedCount).toBe(1);
    expect(session.rowCount).toBe(session.acceptedCount + session.rejectedCount);
    // One name, stored once.
    expect(session.sourceFileNames).toEqual(['statement.csv']);
  });
});

describe('per-file account routing', () => {
  it('sends two files to two different existing accounts', async () => {
    await account('account-checking', 'Everyday Checking');
    await account('account-card', 'Rewards Card');

    const user = userEvent.setup();
    await renderWizard();

    await setUp(
      user,
      [csvFile(PLAIN_CSV, 'checking.csv'), csvFile(REPEATED_CSV, 'card.csv')],
      ['account-checking', 'account-card'],
    );

    await commit(user, 4);

    const snapshot = await readSnapshot(db);
    expect(snapshot.transactions).toHaveLength(4);

    const byDescription = new Map(
      snapshot.transactions.map((row) => [row.descriptionRaw, row.accountId]),
    );
    expect(byDescription.get('GARDEN STATE FUEL')).toBe('account-checking');
    expect(byDescription.get('HARBOR BEAN COFFEE')).toBe('account-card');
    expect(byDescription.get('PINEBROOK MARKET')).toBe('account-card');

    const session = snapshot.importSessions[0]!;
    expect([...session.accountIds].sort()).toEqual(['account-card', 'account-checking']);
    expect(session.sourceFileNames.sort()).toEqual(['card.csv', 'checking.csv']);

    // No account was invented, and the two pre-existing ones survive.
    expect(snapshot.accounts).toHaveLength(2);
  });

  it('creates one shared new account for two files without writing it early', async () => {
    const user = userEvent.setup();
    await renderWizard();

    for (const file of [csvFile(PLAIN_CSV, 'one.csv'), csvFile(REPEATED_CSV, 'two.csv')]) {
      await user.upload(screen.getByLabelText(/choose csv files/i), file);
    }
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Remove /i })).toHaveLength(2),
    );
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 2 of 6/i });
    await waitFor(() => expect(screen.getAllByLabelText(/^Delimiter$/i)).toHaveLength(2));
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 3 of 6/i });
    const dates = screen.getAllByLabelText(/^Date column$/i);
    const descriptions = screen.getAllByLabelText(/^Description column$/i);
    const amounts = screen.getAllByLabelText(/^Amount column$/i);
    for (let index = 0; index < 2; index += 1) {
      await user.selectOptions(dates[index]!, '0');
      await user.selectOptions(descriptions[index]!, '1');
      await user.selectOptions(amounts[index]!, '2');
    }
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 4 of 6/i });

    // Stage one new account on the first file...
    await user.click(screen.getAllByRole('button', { name: /create a new account/i })[0]!);
    await user.type(screen.getByLabelText(/^Account name$/i), 'Shared Checking');
    await user.click(screen.getByRole('button', { name: /stage this account/i }));

    // ...nothing is written yet...
    expect(await db.accounts.count()).toBe(0);

    // ...and the second file can select that same staged account.
    const accountSelects = screen.getAllByLabelText(/which account/i);
    await user.selectOptions(
      accountSelects[1]!,
      screen
        .getAllByRole('option', {
          name: /Shared Checking \(new in this import\)/i,
        })[0]!
        .getAttribute('value')!,
    );

    for (const radio of screen.getAllByLabelText(/Year first/i)) {
      await user.click(radio);
    }
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);

    await commit(user, 4);

    const snapshot = await readSnapshot(db);
    // Exactly one account created, holding every row from both files.
    expect(snapshot.accounts).toHaveLength(1);
    const accountId = snapshot.accounts[0]!.id;
    expect(snapshot.accounts[0]?.label).toBe('Shared Checking');
    expect(snapshot.transactions.every((row) => row.accountId === accountId)).toBe(true);
    expect(snapshot.importSessions[0]?.accountIds).toEqual([accountId]);
  });
});

describe('what a decision leaves behind', () => {
  it('persists no raw CSV, no rejected row, and no transient decision identity', async () => {
    await account('account-a', 'Everyday Checking');
    const user = userEvent.setup();
    await renderWizard();

    const withInvalid = [
      'Date,Description,Amount,Memo',
      '2026-04-08,HARBOR BEAN COFFEE,-4.75,SECRET-MEMO',
      '2026-04-08,HARBOR BEAN COFFEE,-4.75,SECRET-MEMO',
      '2026-13-45,BROKEN ROW,-1.00,SECRET-MEMO',
    ].join('\n');

    await setUp(user, [csvFile(withInvalid)], ['account-a']);
    await screen.findByText(/repeated inside one file/i);
    await user.click(screen.getByRole('button', { name: /exclude it/i }));

    await commit(user, 1);

    const everything = JSON.stringify(await readSnapshot(db));

    // Raw file content, including the unmapped column and the invalid row.
    expect(everything).not.toContain('SECRET-MEMO');
    expect(everything).not.toContain('BROKEN ROW');
    expect(everything).not.toContain('Date,Description,Amount,Memo');
    expect(everything).not.toContain('2026-13-45');

    // The decision key is built from an in-memory staged-file UUID. No UUID of
    // that shape may appear anywhere in stored data except as a record id.
    const snapshot = await readSnapshot(db);
    const storedIds = new Set([
      ...snapshot.transactions.map((row) => row.id),
      ...snapshot.importSessions.map((row) => row.id),
      ...snapshot.accounts.map((row) => row.id),
    ]);
    const uuids =
      everything.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ??
      [];
    for (const uuid of uuids) {
      expect(storedIds.has(uuid)).toBe(true);
    }

    const session = snapshot.importSessions[0]!;
    expect(session.rowCount).toBe(3);
    expect(session.acceptedCount).toBe(1);
    // One invalid row plus one excluded duplicate.
    expect(session.rejectedCount).toBe(2);
    expect(session.rowCount).toBe(session.acceptedCount + session.rejectedCount);
  });
});
