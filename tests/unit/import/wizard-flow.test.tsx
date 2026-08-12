import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { ImportWizard } from '../../../src/components/import/ImportWizard';
import { putAccount } from '../../../src/db/repositories/accounts';
import { listMappingPresets } from '../../../src/db/repositories/mappingPresets';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { readSnapshot, replaceWorkspace } from '../../../src/db/workspace';
import { buildDemoWorkspace } from '../../../src/data/demo/dataset';
import { createTestDatabase, destroyTestDatabase } from '../../unit/helpers/testDatabase';
import { renderWithProviders } from '../../unit/helpers/renderApp';
import { createInProcessWorkerClient } from './helpers/inProcessWorkerClient';

/**
 * The wizard driven end to end, against a real database.
 *
 * Assertions are about **persisted rows**, not about text on screen: the point
 * of the flow is what ends up in IndexedDB, and a test that only checks the
 * success message would pass with nothing written.
 */

const SIGNED_CSV = [
  'Date,Description,Amount,Memo',
  '2026-04-08,PINEBROOK MARKET,-12.34,UNMAPPED-SECRET-A',
  '2026-04-09,GARDEN STATE FUEL,-40.00,UNMAPPED-SECRET-B',
  '2026-04-10,PAYROLL DEPOSIT,1500.00,UNMAPPED-SECRET-C',
].join('\n');

const DEBIT_CREDIT_CSV = [
  'Date,Description,Debit,Credit',
  '2026-05-01,CORNER DINER,22.50,',
  '2026-05-02,REFUND,,10.00',
].join('\n');

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

async function renderWizard(options: { onNormalize?: () => void } = {}) {
  // A *fresh* client per call, exactly like `createImportWorkerClient` in
  // production. Returning one shared instance would break after any action
  // that disposes the client — cancelling, or starting over — because a
  // disposed client answers every later request with `worker-failed`.
  const view = renderWithProviders(
    <ImportWizard
      createClient={() =>
        createInProcessWorkerClient(options.onNormalize ? { onNormalize: options.onNormalize } : {})
      }
    />,
    db,
  );
  await screen.findByRole('heading', { name: /Step 1 of 6/i });
  return view;
}

/** Advances past whichever step is on screen. */
async function clickContinue(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole('button', { name: 'Continue' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

/** Steps 1 and 2: stage a file and accept the detected format. */
async function stageAndDetect(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(screen.getByLabelText(/choose csv files/i), file);
  await screen.findByText(file.name);
  await clickContinue(user);

  await screen.findByRole('heading', { name: /Step 2 of 6/i });
  // Detection has to finish before the format controls appear.
  await screen.findByLabelText(/^Delimiter$/i);
  await clickContinue(user);
}

async function mapSignedColumns(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: /Step 3 of 6/i });
  await user.selectOptions(screen.getByLabelText(/^Date column$/i), '0');
  await user.selectOptions(screen.getByLabelText(/^Description column$/i), '1');
  await user.selectOptions(screen.getByLabelText(/^Amount column$/i), '2');
  await clickContinue(user);
}

describe('a complete import into an existing account', () => {
  it('persists the session, the rows, and the workspace mode', async () => {
    await putAccount(db, {
      id: 'account-checking',
      label: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      archived: false,
    });

    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);

    // Step 4 — conventions and account.
    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    await user.selectOptions(screen.getByLabelText(/which account/i), 'account-checking');
    await user.click(screen.getByLabelText(/Year first/i));
    await clickContinue(user);

    // Step 5 — normalization runs here.
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);
    await clickContinue(user);

    // Step 6 — commit.
    await screen.findByRole('heading', { name: /Step 6 of 6/i });
    await user.click(await screen.findByRole('button', { name: /Import 3 transactions/i }));
    await screen.findByText(/Import complete/i);

    const snapshot = await readSnapshot(db);

    expect(snapshot.transactions).toHaveLength(3);
    expect(snapshot.importSessions).toHaveLength(1);

    const session = snapshot.importSessions[0]!;
    expect(session.rowCount).toBe(3);
    expect(session.acceptedCount).toBe(3);
    expect(session.rejectedCount).toBe(0);
    expect(session.rowCount).toBe(session.acceptedCount + session.rejectedCount);
    expect(session.sourceFileNames).toEqual(['statement.csv']);

    for (const row of snapshot.transactions) {
      expect(row.importSessionId).toBe(session.id);
      expect(row.accountId).toBe('account-checking');
      expect(row.categoryId).toBe('other');
      expect(row.categorySource).toBe('uncategorized');
      expect(row.classificationConfidence).toBe('none');
      expect(row.tags).toEqual([]);
      expect(row.excludedFromSpending).toBe(false);
    }

    // The approved direction defaults: debits are purchases, credits unknown.
    const byDescription = new Map(snapshot.transactions.map((row) => [row.descriptionRaw, row]));
    expect(byDescription.get('PINEBROOK MARKET')?.kind).toBe('purchase');
    expect(byDescription.get('PINEBROOK MARKET')?.direction).toBe('debit');
    expect(byDescription.get('PAYROLL DEPOSIT')?.kind).toBe('unknown');
    expect(byDescription.get('PAYROLL DEPOSIT')?.direction).toBe('credit');

    // Amounts are unsigned magnitudes in integer cents.
    expect(byDescription.get('PINEBROOK MARKET')?.amountCents).toBe(1234);
    expect(byDescription.get('PAYROLL DEPOSIT')?.amountCents).toBe(150_000);

    expect(snapshot.appSettings.find((setting) => setting.key === 'workspaceMode')?.value).toBe(
      'personal',
    );
  });

  it('stores nothing from an unmapped column, and no raw CSV', async () => {
    await putAccount(db, {
      id: 'account-checking',
      label: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      archived: false,
    });

    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);
    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    await user.selectOptions(screen.getByLabelText(/which account/i), 'account-checking');
    await user.click(screen.getByLabelText(/Year first/i));
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);
    await clickContinue(user);
    await user.click(await screen.findByRole('button', { name: /Import 3 transactions/i }));
    await screen.findByText(/Import complete/i);

    const everything = JSON.stringify(await readSnapshot(db));

    expect(everything).not.toContain('UNMAPPED-SECRET-A');
    expect(everything).not.toContain('UNMAPPED-SECRET-B');
    expect(everything).not.toContain('UNMAPPED-SECRET-C');
    expect(everything).not.toContain('Date,Description,Amount,Memo');
    // The mapped description is kept: §3.6 requires it to remain visible.
    expect(everything).toContain('PINEBROOK MARKET');
  });
});

describe('creating an account as part of the import', () => {
  it('writes the account and the rows together', async () => {
    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(DEBIT_CREDIT_CSV));

    await screen.findByRole('heading', { name: /Step 3 of 6/i });
    await user.selectOptions(screen.getByLabelText(/^Date column$/i), '0');
    await user.selectOptions(screen.getByLabelText(/^Description column$/i), '1');
    await user.click(screen.getByLabelText(/separate debit and credit/i));
    await user.selectOptions(await screen.findByLabelText(/^Debit column$/i), '2');
    await user.selectOptions(screen.getByLabelText(/^Credit column$/i), '3');
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    await user.click(screen.getByRole('button', { name: /create a new account/i }));
    await user.type(screen.getByLabelText(/^Account name$/i), 'Rewards Card');
    await user.selectOptions(screen.getByLabelText(/^Account type$/i), 'credit_card');
    await user.click(screen.getByRole('button', { name: /stage this account/i }));

    // Nothing is written when the account is merely staged.
    expect(await db.accounts.count()).toBe(0);

    await user.click(screen.getByLabelText(/Year first/i));
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);
    await clickContinue(user);
    await user.click(await screen.findByRole('button', { name: /Import 2 transactions/i }));
    await screen.findByText(/Import complete/i);

    const snapshot = await readSnapshot(db);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]).toMatchObject({
      label: 'Rewards Card',
      type: 'credit_card',
      currency: 'USD',
    });

    const accountId = snapshot.accounts[0]!.id;
    expect(snapshot.transactions.every((row) => row.accountId === accountId)).toBe(true);
    expect(snapshot.importSessions[0]?.accountIds).toContain(accountId);

    // The debit/credit layout states direction structurally.
    const diner = snapshot.transactions.find((row) => row.descriptionRaw === 'CORNER DINER');
    const refund = snapshot.transactions.find((row) => row.descriptionRaw === 'REFUND');
    expect(diner?.direction).toBe('debit');
    expect(diner?.amountCents).toBe(2250);
    expect(refund?.direction).toBe('credit');
    expect(refund?.kind).toBe('unknown');
  });
});

describe('duplicate candidates', () => {
  it('are suggestions: an untouched candidate is still imported', async () => {
    await putAccount(db, {
      id: 'account-checking',
      label: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      archived: false,
    });

    const user = userEvent.setup();
    await renderWizard();

    // The same file twice: every row of the second overlaps the first.
    await user.upload(
      screen.getByLabelText(/choose csv files/i),
      csvFile(SIGNED_CSV, 'april-a.csv'),
    );
    await user.upload(
      screen.getByLabelText(/choose csv files/i),
      csvFile(SIGNED_CSV, 'april-b.csv'),
    );
    await screen.findByText('april-b.csv');
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 2 of 6/i });
    await waitFor(() => expect(screen.getAllByLabelText(/^Delimiter$/i)).toHaveLength(2));
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 3 of 6/i });
    const dateSelects = screen.getAllByLabelText(/^Date column$/i);
    const descriptionSelects = screen.getAllByLabelText(/^Description column$/i);
    const amountSelects = screen.getAllByLabelText(/^Amount column$/i);
    for (let index = 0; index < 2; index += 1) {
      await user.selectOptions(dateSelects[index]!, '0');
      await user.selectOptions(descriptionSelects[index]!, '1');
      await user.selectOptions(amountSelects[index]!, '2');
    }
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    for (const select of screen.getAllByLabelText(/which account/i)) {
      await user.selectOptions(select, 'account-checking');
    }
    for (const radio of screen.getAllByLabelText(/Year first/i)) {
      await user.click(radio);
    }
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/possible duplicates/i);

    // Three rows are flagged as overlapping the earlier file, and the wording
    // never claims the match proves they are the same transaction.
    expect(screen.getByText(/suggestions, not findings/i)).toBeInTheDocument();

    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 6 of 6/i });

    // Nothing was excluded, so all six rows commit and none are counted as
    // rejected merely for being flagged.
    await user.click(await screen.findByRole('button', { name: /Import 6 transactions/i }));
    await screen.findByText(/Import complete/i);

    const snapshot = await readSnapshot(db);
    expect(snapshot.transactions).toHaveLength(6);
    const session = snapshot.importSessions[0]!;
    expect(session.acceptedCount).toBe(6);
    expect(session.rejectedCount).toBe(0);
    expect(session.duplicateCandidateCount).toBe(3);
  });

  it('excludes only what the user explicitly excludes', async () => {
    await putAccount(db, {
      id: 'account-checking',
      label: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      archived: false,
    });

    const user = userEvent.setup();
    await renderWizard();

    await user.upload(
      screen.getByLabelText(/choose csv files/i),
      csvFile(SIGNED_CSV, 'april-a.csv'),
    );
    await user.upload(
      screen.getByLabelText(/choose csv files/i),
      csvFile(SIGNED_CSV, 'april-b.csv'),
    );
    await screen.findByText('april-b.csv');
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 2 of 6/i });
    await waitFor(() => expect(screen.getAllByLabelText(/^Delimiter$/i)).toHaveLength(2));
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 3 of 6/i });
    const dateSelects = screen.getAllByLabelText(/^Date column$/i);
    const descriptionSelects = screen.getAllByLabelText(/^Description column$/i);
    const amountSelects = screen.getAllByLabelText(/^Amount column$/i);
    for (let index = 0; index < 2; index += 1) {
      await user.selectOptions(dateSelects[index]!, '0');
      await user.selectOptions(descriptionSelects[index]!, '1');
      await user.selectOptions(amountSelects[index]!, '2');
    }
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    for (const select of screen.getAllByLabelText(/which account/i)) {
      await user.selectOptions(select, 'account-checking');
    }
    for (const radio of screen.getAllByLabelText(/Year first/i)) {
      await user.click(radio);
    }
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/possible duplicates/i);

    await user.click(screen.getByRole('button', { name: /Exclude all 3 candidates/i }));
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 6 of 6/i });
    await user.click(await screen.findByRole('button', { name: /Import 3 transactions/i }));
    await screen.findByText(/Import complete/i);

    const snapshot = await readSnapshot(db);
    expect(snapshot.transactions).toHaveLength(3);

    const session = snapshot.importSessions[0]!;
    expect(session.rowCount).toBe(6);
    expect(session.acceptedCount).toBe(3);
    // An excluded candidate becomes a rejection only because the user said so.
    expect(session.rejectedCount).toBe(3);
    expect(session.duplicateCandidateCount).toBe(3);
    expect(session.rowCount).toBe(session.acceptedCount + session.rejectedCount);
  });
});

describe('replacing a demo workspace', () => {
  beforeEach(async () => {
    await replaceWorkspace(db, buildDemoWorkspace());
  });

  it('leaves the demo untouched when the confirmation is cancelled', async () => {
    const before = await readSnapshot(db);
    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);
    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    await user.click(screen.getByRole('button', { name: /create a new account/i }));
    await user.type(screen.getByLabelText(/^Account name$/i), 'My Checking');
    await user.click(screen.getByRole('button', { name: /stage this account/i }));
    await user.click(screen.getByLabelText(/Year first/i));
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 6 of 6/i });
    await user.click(await screen.findByRole('button', { name: /Import 3 transactions/i }));

    // The dialog is the gate; cancelling it must write nothing at all.
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('replaces the fictional data atomically once confirmed', async () => {
    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);
    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    await user.click(screen.getByRole('button', { name: /create a new account/i }));
    await user.type(screen.getByLabelText(/^Account name$/i), 'My Checking');
    await user.click(screen.getByRole('button', { name: /stage this account/i }));
    await user.click(screen.getByLabelText(/Year first/i));
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 6 of 6/i });
    await user.click(await screen.findByRole('button', { name: /Import 3 transactions/i }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /replace and import/i }));
    await screen.findByText(/Import complete/i);

    const snapshot = await readSnapshot(db);
    expect(snapshot.transactions).toHaveLength(3);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]?.label).toBe('My Checking');
    expect(snapshot.importSessions).toHaveLength(1);
    // Every demo row is gone.
    expect(snapshot.transactions.every((row) => !row.id.startsWith('demo-'))).toBe(true);
    expect(snapshot.merchantRules).toHaveLength(0);
    expect(snapshot.budgetPlans).toHaveLength(0);
    expect(snapshot.appSettings.find((setting) => setting.key === 'workspaceMode')?.value).toBe(
      'personal',
    );
  });
});

describe('failure and retry', () => {
  it('keeps the workspace and the staged choices when the commit fails', async () => {
    await putAccount(db, {
      id: 'account-checking',
      label: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      archived: false,
    });
    await setWorkspaceMode(db, 'personal');
    const before = await readSnapshot(db);

    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);
    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    await user.selectOptions(screen.getByLabelText(/which account/i), 'account-checking');
    await user.click(screen.getByLabelText(/Year first/i));
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 6 of 6/i });

    // The write fails after the session row has already been added inside the
    // transaction, so only an atomic commit leaves the workspace unchanged.
    vi.spyOn(db.transactions, 'bulkAdd').mockImplementation((() => {
      throw new Error('injected storage failure');
    }) as never);

    await user.click(await screen.findByRole('button', { name: /Import 3 transactions/i }));
    await screen.findByText(/was not saved/i);

    expect(await readSnapshot(db)).toEqual(before);
    // The staged work survives so the user can retry rather than start over.
    expect(screen.getByText(/statement\.csv/i)).toBeInTheDocument();
  });

  it('cannot be double-submitted into two sessions', async () => {
    await putAccount(db, {
      id: 'account-checking',
      label: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      archived: false,
    });

    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);
    await screen.findByRole('heading', { name: /Step 4 of 6/i });
    await user.selectOptions(screen.getByLabelText(/which account/i), 'account-checking');
    await user.click(screen.getByLabelText(/Year first/i));
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 5 of 6/i });
    await screen.findByText(/Rows read/i);
    await clickContinue(user);

    await screen.findByRole('heading', { name: /Step 6 of 6/i });
    const commitButton = await screen.findByRole('button', { name: /Import 3 transactions/i });

    // Two clicks before the first settles.
    await Promise.all([user.click(commitButton), user.click(commitButton)]);
    await screen.findByText(/Import complete/i);

    expect(await db.importSessions.count()).toBe(1);
    expect(await db.transactions.count()).toBe(3);
  });
});

describe('mapping presets', () => {
  it('saves a preset holding structure only, then applies it to a matching file', async () => {
    await putAccount(db, {
      id: 'account-checking',
      label: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      archived: false,
    });

    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);

    // Back to step 3 to save the mapping that was just made.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: /Step 3 of 6/i });
    await user.type(screen.getByLabelText(/save this mapping/i), 'Everyday checking export');
    await user.click(screen.getByRole('button', { name: /save preset/i }));
    await screen.findByText('Saved.');

    const presets = await listMappingPresets(db);
    expect(presets).toHaveLength(1);
    expect(presets[0]?.name).toBe('Everyday checking export');

    // A preset stores structure, never content or a destination.
    const serialized = JSON.stringify(presets[0]);
    expect(serialized).not.toContain('PINEBROOK');
    expect(serialized).not.toContain('account-checking');
    expect(serialized).not.toContain('statement.csv');
    expect(serialized).not.toContain('2026-04-08');

    // It is offered as compatible for the same column layout.
    expect(await screen.findByRole('button', { name: /^Apply$/i })).toBeEnabled();
  });

  it('refuses to apply a preset saved for different columns', async () => {
    const user = userEvent.setup();
    await renderWizard();

    await stageAndDetect(user, csvFile(SIGNED_CSV));
    await mapSignedColumns(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: /Step 3 of 6/i });
    await user.type(screen.getByLabelText(/save this mapping/i), 'Signed layout');
    await user.click(screen.getByRole('button', { name: /save preset/i }));
    await screen.findByText('Saved.');

    // Start again with a file whose columns differ.
    await user.click(screen.getByRole('button', { name: /start over/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /start over/i }));

    await screen.findByRole('heading', { name: /Step 1 of 6/i });
    await stageAndDetect(user, csvFile(DEBIT_CREDIT_CSV, 'other.csv'));
    await screen.findByRole('heading', { name: /Step 3 of 6/i });

    expect(await screen.findByRole('button', { name: /does not fit/i })).toBeDisabled();
    // Two of four column names differ, so it is offered as incompatible.
    expect(screen.getByText(/column names differ/i)).toBeInTheDocument();
  });
});
