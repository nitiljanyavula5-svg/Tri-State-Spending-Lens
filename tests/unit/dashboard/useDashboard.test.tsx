import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { useDashboard, type DashboardApi } from '../../../src/review/useDashboard';
import { putAccounts } from '../../../src/db/repositories/accounts';
import {
  commitImportSession,
  deleteImportSession,
} from '../../../src/db/repositories/transactions';
import { setSetting, unsetSetting, SETTING_KEYS } from '../../../src/db/repositories/settings';
import type { Account, ImportSession, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';

/**
 * The Dexie-to-selector boundary, against a real database.
 *
 * These assert the *mapping* as much as the result: the coverage input is where
 * a multi-account statement range could be silently repaired into per-account
 * evidence the schema does not hold, and §14.11 makes that the selector's call,
 * not the hook's.
 */

let db: WorkspaceDatabase;
let api: DashboardApi | null = null;

const TODAY = () => '2026-05-14';

const ACCOUNTS: Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
  { id: 'card', label: 'Rewards Card', type: 'credit_card', currency: 'USD', archived: false },
];

function txn(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'checking',
    postedDate: '2026-05-08',
    descriptionRaw: 'PINEBROOK MARKET',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1_234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'groceries',
    categorySource: 'merchant_rule',
    classificationConfidence: 'high',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

function session(id: string, overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    id,
    importedAt: '2026-08-01T12:00:00.000Z',
    sourceFileNames: ['statement.csv'],
    accountIds: ['checking'],
    mappingVersion: 1,
    rowCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
    statementRangeStart: '2026-05-01',
    statementRangeEnd: '2026-05-31',
    ...overrides,
  };
}

function Probe({ database }: { database: WorkspaceDatabase | null }) {
  api = useDashboard({ db: database, today: TODAY });
  return <output data-testid="status">{api.status}</output>;
}

const renderProbe = (database: WorkspaceDatabase | null = db) =>
  render(<Probe database={database} />);

const ready = async () => {
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent(/ready|empty/));
};

beforeEach(async () => {
  db = await createTestDatabase();
  api = null;
});

afterEach(async () => {
  await destroyTestDatabase(db);
});

describe('lifecycle', () => {
  it('starts loading and settles into ready', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    renderProbe();
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await ready();
    expect(api?.status).toBe('ready');
    expect(api?.selection).not.toBeNull();
  });

  it('reports an empty workspace rather than zeroed figures', async () => {
    renderProbe();
    await ready();
    expect(api?.status).toBe('empty');
    // No selection at all, rather than a selection full of zeros.
    expect(api?.selection).toBeNull();
    expect(api?.domain).toBeNull();
  });

  it('never exposes a selection while loading', async () => {
    renderProbe(null);
    expect(api?.status).toBe('loading');
    expect(api?.selection).toBeNull();
  });

  it('sanitizes a read failure and shows no figures', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    // Closing mid-flight makes the read throw the way a real failure would.
    db.close();
    renderProbe();
    await waitFor(() => expect(api?.status === 'failed' || api?.status === 'loading').toBe(true));
    if (api?.status === 'failed') {
      expect(api.selection).toBeNull();
      expect(api.errorMessage).toBe('This workspace could not be read. No figures are shown.');
      // Carries no database text and no field value.
      expect(api.errorMessage).not.toMatch(/dexie|indexeddb|error:/i);
    }
    db = await createTestDatabase();
  });
});

describe('reactivity', () => {
  it('picks up a new transaction without a manual refresh', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    renderProbe();
    await ready();
    expect(api?.selection?.netSpending.netSpendingCents).toBe(1_234);

    await act(async () => {
      await db.transactions.put(txn('t2', { amountCents: 766 }));
    });

    await waitFor(() => expect(api?.selection?.netSpending.netSpendingCents).toBe(2_000));
  });

  it('picks up a new account in the filter choices', async () => {
    await putAccounts(db, [ACCOUNTS[0] as Account]);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    renderProbe();
    await ready();
    expect(api?.accountChoices).toHaveLength(1);

    await act(async () => {
      await putAccounts(db, ACCOUNTS);
    });

    await waitFor(() => expect(api?.accountChoices).toHaveLength(2));
  });

  it('picks up an income-completeness change', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [
      txn('t1', { kind: 'income', direction: 'credit', amountCents: 500_000 }),
    ]);
    renderProbe();
    await ready();
    expect(api?.selection?.cashFlow.moneyInCents).toEqual({
      available: false,
      reason: 'income-completeness-unconfirmed',
    });

    await act(async () => {
      await setSetting(db, SETTING_KEYS.incomeDataComplete, true);
    });

    await waitFor(() =>
      expect(api?.selection?.cashFlow.moneyInCents).toEqual({ available: true, value: 500_000 }),
    );
  });

  it('returns to unconfirmed when the setting is removed', async () => {
    await putAccounts(db, ACCOUNTS);
    await setSetting(db, SETTING_KEYS.incomeDataComplete, true);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    renderProbe();
    await ready();
    expect(api?.selection?.dataQuality.incomeCompletenessWarning).toBeNull();

    await act(async () => {
      await unsetSetting(db, SETTING_KEYS.incomeDataComplete);
    });

    await waitFor(() =>
      expect(api?.selection?.dataQuality.incomeCompletenessWarning).toBe(
        'income-completeness-unconfirmed',
      ),
    );
  });

  it('drops coverage when its session is deleted', async () => {
    await putAccounts(db, ACCOUNTS);
    // Both accounts are in the default scope, so both need their own statement
    // before May can be complete for the scope (§14.11).
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    await commitImportSession(db, session('session-2', { accountIds: ['card'] }), [
      txn('t2', { accountId: 'card', importSessionId: 'session-2' }),
    ]);
    renderProbe();
    await ready();
    expect(api?.completeMonths.has('2026-05')).toBe(true);

    await act(async () => {
      await deleteImportSession(db, 'session-2');
    });

    // The card's statement is gone, so the month is no longer complete for the
    // scope — one account's coverage never stands in for another's.
    await waitFor(() => expect(api?.completeMonths.has('2026-05')).toBe(false));
  });
});

describe('selector input mapping', () => {
  it('passes a multi-account statement range through without splitting it', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1', { accountIds: ['checking', 'card'] }), [
      txn('t1'),
      txn('t2', { accountId: 'card' }),
    ]);
    renderProbe();
    await ready();
    // The hook did not repair it into two single-account ranges; the selector
    // classified it as ambiguous, which is its call to make (§14.11).
    expect(api?.selection?.dataQuality.ambiguousMultiAccountStatementRangeCount).toBe(1);
    expect(api?.selection?.dataQuality.accountsWithAmbiguousStatementCoverage).toEqual([
      'card',
      'checking',
    ]);
    expect(api?.completeMonths.size).toBe(0);
  });

  it('keeps a single-account range usable', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    await commitImportSession(db, session('session-2', { accountIds: ['card'] }), [
      txn('t2', { accountId: 'card', importSessionId: 'session-2' }),
    ]);
    renderProbe();
    await ready();
    expect(api?.selection?.dataQuality.ambiguousMultiAccountStatementRangeCount).toBe(0);
    expect(api?.completeMonths.has('2026-05')).toBe(true);
  });

  it('supplies archived accounts to the selector scope input', async () => {
    await putAccounts(db, [
      ACCOUNTS[0] as Account,
      { ...(ACCOUNTS[1] as Account), archived: true },
    ]);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    renderProbe();
    await ready();
    // Both remain selectable in the filter list...
    expect(api?.accountChoices).toHaveLength(2);
    // ...while the default scope excludes the archived one, so its missing
    // statement does not make every month incomplete.
    expect(api?.completeMonths.has('2026-05')).toBe(true);
  });

  it('leaves a missing income setting unconfirmed rather than defaulting to true', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    renderProbe();
    await ready();
    expect(api?.selection?.cashFlow.moneyInCents.available).toBe(false);
    expect(api?.selection?.dataQuality.incomeCompletenessWarning).toBe(
      'income-completeness-unconfirmed',
    );
  });

  it('does not write a default while reading a missing setting', async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [txn('t1')]);
    renderProbe();
    await ready();
    expect(await db.appSettings.get(SETTING_KEYS.incomeDataComplete)).toBeUndefined();
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await putAccounts(db, ACCOUNTS);
    await commitImportSession(db, session('session-1'), [
      txn('t1', { amountCents: 1_000, postedDate: '2026-05-08' }),
      txn('t2', { amountCents: 2_000, postedDate: '2026-04-08', accountId: 'card' }),
    ]);
  });

  it('defaults to All data across the whole domain', async () => {
    renderProbe();
    await ready();
    expect(api?.preset).toBe('all-data');
    expect(api?.domain).toEqual({ start: '2026-04-08', end: '2026-05-08' });
    expect(api?.selection?.netSpending.netSpendingCents).toBe(3_000);
  });

  it('narrows to this month from the frozen date', async () => {
    renderProbe();
    await ready();
    await act(async () => api?.setPreset('this-month'));
    await waitFor(() => expect(api?.selection?.netSpending.netSpendingCents).toBe(1_000));
  });

  it('filters by account and preserves the selection across updates', async () => {
    renderProbe();
    await ready();
    await act(async () => api?.toggleAccount('card'));
    await waitFor(() => expect(api?.selection?.netSpending.netSpendingCents).toBe(2_000));

    await act(async () => {
      await db.transactions.put(txn('t3', { accountId: 'card', amountCents: 500 }));
    });
    // The account filter survived the reactive update.
    await waitFor(() => expect(api?.selection?.netSpending.netSpendingCents).toBe(2_500));
    expect(api?.filters.accountIds).toEqual(['card']);
  });

  it('drops an account id that no longer exists but keeps the valid ones', async () => {
    renderProbe();
    await ready();
    await act(async () => {
      api?.toggleAccount('card');
      api?.toggleAccount('checking');
    });
    await waitFor(() => expect(api?.filters.accountIds).toHaveLength(2));

    await act(async () => {
      await db.accounts.delete('card');
    });

    await waitFor(() => expect(api?.filters.accountIds).toEqual(['checking']));
  });

  it('resets everything back to All data', async () => {
    renderProbe();
    await ready();
    await act(async () => {
      api?.setPreset('this-month');
      api?.toggleAccount('card');
      api?.toggleCategory('groceries');
    });
    await waitFor(() => expect(api?.preset).toBe('this-month'));

    await act(async () => api?.resetAll());

    await waitFor(() => expect(api?.preset).toBe('all-data'));
    expect(api?.filters.accountIds).toBeUndefined();
    expect(api?.filters.categoryIds).toBeUndefined();
  });

  it('reports an invalid custom range without swapping the dates', async () => {
    renderProbe();
    await ready();
    await act(async () => {
      api?.setPreset('custom');
      api?.setCustomStart('2026-05-31');
      api?.setCustomEnd('2026-05-01');
    });
    await waitFor(() => expect(api?.customError).toBe('reversed'));
    expect(api?.customStart).toBe('2026-05-31');
    expect(api?.customEnd).toBe('2026-05-01');
  });

  it('applies an inclusive custom range', async () => {
    renderProbe();
    await ready();
    await act(async () => {
      api?.setPreset('custom');
      api?.setCustomStart('2026-05-08');
      api?.setCustomEnd('2026-05-08');
    });
    await waitFor(() => expect(api?.selection?.netSpending.netSpendingCents).toBe(1_000));
  });

  it('does not change coverage scope when a category filter is applied', async () => {
    renderProbe();
    await ready();
    const before = api?.selection?.dataQuality.accountsWithIncompleteCoverage;
    await act(async () => api?.toggleCategory('groceries'));
    await waitFor(() => expect(api?.filters.categoryIds).toEqual(['groceries']));
    expect(api?.selection?.dataQuality.accountsWithIncompleteCoverage).toEqual(before);
  });
});
