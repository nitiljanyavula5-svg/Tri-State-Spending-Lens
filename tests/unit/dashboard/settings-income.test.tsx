import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { IncomeCompletenessControl } from '../../../src/components/dashboard/IncomeCompletenessControl';
import {
  getSetting,
  setSetting,
  SETTING_KEYS,
  setWorkspaceMode,
} from '../../../src/db/repositories/settings';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderWithProviders } from '../helpers/renderApp';

/**
 * The tri-state income confirmation, against calculation-contract.md §14.1.
 *
 * The state that matters most is the third one. "Not confirmed" must *remove*
 * the row, because a stored sentinel would make silence indistinguishable from
 * an answer — and the whole point of the gate is that an unanswered workspace
 * does not publish a savings rate.
 */

let db: WorkspaceDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

const render = () => renderWithProviders(<IncomeCompletenessControl db={db} />, db);

const radio = (name: RegExp) => screen.getByRole('radio', { name });

describe('initial state', () => {
  it('starts at Not confirmed when the setting is absent', async () => {
    render();
    await waitFor(() => expect(radio(/not confirmed/i)).toBeChecked());
    expect(await getSetting(db, SETTING_KEYS.incomeDataComplete)).toBeUndefined();
  });

  it('reflects a stored true', async () => {
    await setSetting(db, SETTING_KEYS.incomeDataComplete, true);
    render();
    await waitFor(() => expect(radio(/^complete/i)).toBeChecked());
  });

  it('reflects a stored false', async () => {
    await setSetting(db, SETTING_KEYS.incomeDataComplete, false);
    render();
    await waitFor(() => expect(radio(/incomplete/i)).toBeChecked());
  });
});

describe('persisting a choice', () => {
  it('stores true for Complete', async () => {
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(radio(/not confirmed/i)).toBeChecked());
    await user.click(radio(/^complete/i));
    await waitFor(async () =>
      expect(await getSetting(db, SETTING_KEYS.incomeDataComplete)).toBe(true),
    );
  });

  it('stores false for Incomplete', async () => {
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(radio(/not confirmed/i)).toBeChecked());
    await user.click(radio(/incomplete/i));
    await waitFor(async () =>
      expect(await getSetting(db, SETTING_KEYS.incomeDataComplete)).toBe(false),
    );
  });

  it('removes the row when returning to Not confirmed', async () => {
    const user = userEvent.setup();
    await setSetting(db, SETTING_KEYS.incomeDataComplete, true);
    render();
    await waitFor(() => expect(radio(/^complete/i)).toBeChecked());

    await user.click(radio(/not confirmed/i));

    await waitFor(async () =>
      // Absent, not a third stored value.
      expect(await db.appSettings.get(SETTING_KEYS.incomeDataComplete)).toBeUndefined(),
    );
  });

  it('leaves every unrelated setting untouched', async () => {
    const user = userEvent.setup();
    await setWorkspaceMode(db, 'personal');
    await setSetting(db, SETTING_KEYS.homeState, 'NJ');
    await setSetting(db, SETTING_KEYS.incomeDataComplete, true);
    render();
    await waitFor(() => expect(radio(/^complete/i)).toBeChecked());

    await user.click(radio(/not confirmed/i));

    await waitFor(async () =>
      expect(await db.appSettings.get(SETTING_KEYS.incomeDataComplete)).toBeUndefined(),
    );
    expect(await getSetting(db, SETTING_KEYS.homeState)).toBe('NJ');
    expect(await getSetting(db, SETTING_KEYS.workspaceMode)).toBe('personal');
  });
});

describe('accessibility and copy', () => {
  it('groups the options under a question', async () => {
    render();
    await waitFor(() => expect(radio(/not confirmed/i)).toBeChecked());
    expect(
      screen.getByRole('group', { name: /is the imported income data complete/i }),
    ).toBeInTheDocument();
  });

  it('says what the confirmation controls', async () => {
    render();
    await waitFor(() => expect(radio(/not confirmed/i)).toBeChecked());
    expect(
      screen.getByText(/decides whether money in, net cash flow, and savings rate/i),
    ).toBeInTheDocument();
  });

  it('does not claim that Complete validates the imported records', async () => {
    render();
    await waitFor(() => expect(radio(/not confirmed/i)).toBeChecked());
    expect(
      screen.getByText(/does not check or validate the imported records/i),
    ).toBeInTheDocument();
  });

  it('is operable by keyboard', async () => {
    const user = userEvent.setup();
    render();
    await waitFor(() => expect(radio(/not confirmed/i)).toBeChecked());
    await user.tab();
    expect(radio(/not confirmed/i)).toHaveFocus();
  });
});
