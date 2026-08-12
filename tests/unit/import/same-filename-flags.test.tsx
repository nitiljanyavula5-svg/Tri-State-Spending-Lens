import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { ImportWizard } from '../../../src/components/import/ImportWizard';
import { buildStagedImport, commitImport } from '../../../src/db/importCommit';
import { putAccount } from '../../../src/db/repositories/accounts';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { readSnapshot } from '../../../src/db/workspace';
import { canonicalizeText } from '../../../src/import/canonical';
import { computeFingerprint } from '../../../src/import/fingerprint';
import type { FingerprintedRow } from '../../../src/import/normalizeFile';
import { fixedClock } from '../../../src/lib/clock';
import { createTestDatabase, destroyTestDatabase } from '../../unit/helpers/testDatabase';
import { renderWithProviders } from '../../unit/helpers/renderApp';
import { createInProcessWorkerClient } from './helpers/inProcessWorkerClient';
import { testSha256 } from './helpers/fixtures';

/**
 * Two staged files that share a sanitized filename and overlap on row numbers.
 *
 * `fileName#originalRow` is not a row identity: a user can select the same
 * statement from two folders, and both then contain a "row 2". Every transient
 * association the Health Report and the duplicate review make — questionable
 * flags, candidate flags, exclusions — has to survive that.
 *
 * These assert the **rendered flags** and the **persisted rows**, because a
 * count that happens to be right while the wrong row wears the badge is still
 * wrong output.
 */

const ACCOUNT = 'account-a';

/**
 * Row 1 is the keeper for a repeat; row 2 is questionable because its amount is
 * zero; row 3 repeats row 1 inside this same file.
 */
const FILE_A = [
  'Date,Description,Amount',
  '2026-04-01,ALPHA ONE,-1.00',
  '2026-04-02,ALPHA TWO,0.00',
  '2026-04-01,ALPHA ONE,-1.00',
].join('\n');

/** Row 1 already exists in the workspace; rows 2 and 3 are unremarkable. */
const FILE_B = [
  'Date,Description,Amount',
  '2026-06-01,CHARLIE ONE,-9.00',
  '2026-05-02,BRAVO TWO,-2.00',
  '2026-05-03,BRAVO THREE,-3.00',
].join('\n');

function csvFile(contents: string): File {
  // Both files are called the same thing. That is the whole point.
  return new File([contents], 'statement.csv', { type: 'text/csv' });
}

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
  await putAccount(db, {
    id: ACCOUNT,
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

/**
 * Stores one transaction whose fingerprint matches file B's first row, so that
 * row is nominated from the existing-workspace scope.
 */
async function seedMatchingWorkspaceRow(): Promise<void> {
  const descriptionCanonical = canonicalizeText('CHARLIE ONE');
  const fingerprint = await computeFingerprint(
    {
      accountId: ACCOUNT,
      postedDate: '2026-06-01',
      direction: 'debit',
      amountCents: 900,
      descriptionCanonical,
      occurrenceIndex: 0,
    },
    testSha256,
  );

  const row: FingerprintedRow = {
    fileName: 'earlier.csv',
    originalRow: 1,
    postedDate: '2026-06-01',
    descriptionRaw: 'CHARLIE ONE',
    merchantNormalized: descriptionCanonical,
    descriptionCanonical,
    amountCents: 900,
    direction: 'debit',
    questions: [],
    fingerprint,
    occurrenceIndex: 0,
    accountId: ACCOUNT,
  };

  const result = await commitImport(
    db,
    buildStagedImport({
      rowCount: 1,
      acceptedRows: [row],
      excludedRows: [],
      rejections: [],
      duplicateCandidates: [],
      warnings: [],
      sourceFileNames: ['earlier.csv'],
      newAccounts: [],
      sessionId: 'session-earlier',
      newId: () => 'txn-earlier',
      clock: fixedClock('2026-06-02T10:00:00.000Z'),
    }),
  );
  expect(result.ok).toBe(true);
}

type User = ReturnType<typeof userEvent.setup>;

async function renderWizard() {
  renderWithProviders(<ImportWizard createClient={() => createInProcessWorkerClient()} />, db);
  await screen.findByRole('heading', { name: /Step 1 of 6/i });
}

async function clickContinue(user: User) {
  const button = await screen.findByRole('button', { name: 'Continue' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

/** Stages both same-named files and walks to the review step. */
async function reachReview(user: User) {
  for (const contents of [FILE_A, FILE_B]) {
    await user.upload(screen.getByLabelText(/choose csv files/i), csvFile(contents));
  }
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Remove /i })).toHaveLength(2));
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
  for (const select of screen.getAllByLabelText(/which account/i)) {
    await user.selectOptions(select, ACCOUNT);
  }
  for (const radio of screen.getAllByLabelText(/Year first/i)) {
    await user.click(radio);
  }
  await clickContinue(user);

  await screen.findByRole('heading', { name: /Step 5 of 6/i });
  await screen.findByText(/Rows read/i);
}

/**
 * The flags actually rendered in the preview table, keyed by row number and
 * description — the only pair that distinguishes these rows on screen, since
 * both files display the same name.
 */
function renderedFlags(): Map<string, string> {
  const region = screen.getByRole('region', {
    name: /normalized rows that will be imported/i,
  });
  const [, ...bodyRows] = within(region).getAllByRole('row');

  const flags = new Map<string, string>();
  for (const tableRow of bodyRows) {
    const cells = within(tableRow)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? '');
    // File, Row, Date, Description, Amount, Direction, Flags
    flags.set(`${cells[1]}|${cells[3]}`, cells[6] ?? '');
  }
  return flags;
}

/** The file-name column, to prove no internal identity is shown. */
function renderedFileNames(): string[] {
  const region = screen.getByRole('region', {
    name: /normalized rows that will be imported/i,
  });
  const [, ...bodyRows] = within(region).getAllByRole('row');
  return bodyRows.map((tableRow) => within(tableRow).getAllByRole('cell')[0]?.textContent ?? '');
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

describe('flags never cross between two staged files with the same name', () => {
  it('keeps questionable, within-file, and workspace flags on their own rows', async () => {
    await seedMatchingWorkspaceRow();
    const user = userEvent.setup();
    await renderWizard();
    await reachReview(user);

    const flags = renderedFlags();

    // Both files really do overlap on row numbers 1, 2 and 3.
    expect(flags.has('1|ALPHA ONE')).toBe(true);
    expect(flags.has('1|CHARLIE ONE')).toBe(true);
    expect(flags.has('2|ALPHA TWO')).toBe(true);
    expect(flags.has('2|BRAVO TWO')).toBe(true);
    expect(flags.has('3|ALPHA ONE')).toBe(true);
    expect(flags.has('3|BRAVO THREE')).toBe(true);

    // File A row 2 is questionable — its amount is zero.
    expect(flags.get('2|ALPHA TWO')).toContain('needs review');
    // File B's row 2 must not inherit it.
    expect(flags.get('2|BRAVO TWO')).toBe('');

    // File A row 3 repeats row 1 inside the same file.
    expect(flags.get('3|ALPHA ONE')).toContain('duplicate candidate');
    // File B's row 3 must not inherit it.
    expect(flags.get('3|BRAVO THREE')).toBe('');

    // File B row 1 already exists in the workspace.
    expect(flags.get('1|CHARLIE ONE')).toContain('duplicate candidate');
    // File A's row 1 is the keeper and must not inherit it.
    expect(flags.get('1|ALPHA ONE')).toBe('');
  });

  it('scopes each candidate to the right group and shows only sanitized names', async () => {
    await seedMatchingWorkspaceRow();
    const user = userEvent.setup();
    await renderWizard();
    await reachReview(user);

    // One within-file candidate, one workspace candidate — in their own groups.
    const withinFile = screen.getByRole('heading', { name: /repeated inside one file \(1\)/i });
    const workspace = screen.getByRole('heading', { name: /already in your workspace \(1\)/i });
    expect(withinFile).toBeInTheDocument();
    expect(workspace).toBeInTheDocument();

    // Every rendered file name is the user's sanitized name.
    for (const name of renderedFileNames()) {
      expect(name).toBe('statement.csv');
    }

    // No staged-file identity anywhere on screen.
    expect(document.body.textContent ?? '').not.toMatch(UUID);
  });

  it('counts and flags stay consistent, and an exclusion moves exactly one row', async () => {
    await seedMatchingWorkspaceRow();
    const user = userEvent.setup();
    await renderWizard();
    await reachReview(user);

    // Six staged rows, two of them candidates, one of them questionable.
    expect(screen.getByRole('heading', { name: /possible duplicates/i })).toBeInTheDocument();

    // Exclude only file A's within-file repeat.
    const withinFileSection = screen
      .getByRole('heading', { name: /repeated inside one file/i })
      .closest('section');
    expect(withinFileSection).not.toBeNull();
    await user.click(
      within(withinFileSection as HTMLElement).getByRole('button', { name: /exclude it/i }),
    );

    // The other candidate is untouched.
    const workspaceSection = screen
      .getByRole('heading', { name: /already in your workspace/i })
      .closest('section');
    expect(
      within(workspaceSection as HTMLElement).getByRole('button', { name: /exclude it/i }),
    ).toBeInTheDocument();

    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 6 of 6/i });

    // 6 rows read = 5 imported + 1 excluded.
    expect(screen.getByText(/6 rows read = 5 imported \+ 1 not imported/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /Import 5 transactions/i }));
    await screen.findByText(/Import complete/i);

    const snapshot = await readSnapshot(db);
    const fresh = snapshot.transactions.filter((row) => row.importSessionId !== 'session-earlier');
    const descriptions = fresh.map((row) => row.descriptionRaw).sort();

    // Exactly one ALPHA ONE survived: the repeat went, the keeper stayed. Every
    // row from file B is present, including the workspace-scope candidate the
    // user chose not to exclude.
    expect(descriptions).toEqual([
      'ALPHA ONE',
      'ALPHA TWO',
      'BRAVO THREE',
      'BRAVO TWO',
      'CHARLIE ONE',
    ]);

    const session = snapshot.importSessions.find((row) => row.id !== 'session-earlier')!;
    expect(session.rowCount).toBe(6);
    expect(session.acceptedCount).toBe(5);
    expect(session.rejectedCount).toBe(1);
    expect(session.duplicateCandidateCount).toBe(2);
    expect(session.rowCount).toBe(session.acceptedCount + session.rejectedCount);
    // One display name, stored once, with no internal identity.
    expect(session.sourceFileNames).toEqual(['statement.csv']);
  });

  it('persists no staged-file identity anywhere', async () => {
    await seedMatchingWorkspaceRow();
    const user = userEvent.setup();
    await renderWizard();
    await reachReview(user);
    await clickContinue(user);
    await screen.findByRole('heading', { name: /Step 6 of 6/i });
    await user.click(await screen.findByRole('button', { name: /Import 6 transactions/i }));
    await screen.findByText(/Import complete/i);

    const snapshot = await readSnapshot(db);
    const serialized = JSON.stringify(snapshot);

    // Every UUID in stored data must be a record's own primary key.
    const storedIds = new Set([
      ...snapshot.transactions.map((row) => row.id),
      ...snapshot.importSessions.map((row) => row.id),
      ...snapshot.accounts.map((row) => row.id),
      ...snapshot.mappingPresets.map((row) => row.id),
    ]);
    for (const uuid of serialized.match(UUID) ?? []) {
      expect(storedIds.has(uuid)).toBe(true);
    }

    // And no raw file content came along for the ride.
    expect(serialized).not.toContain('Date,Description,Amount');
  });
});
