import 'fake-indexeddb/auto';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { RULES_PAGE_SIZE } from '../../../src/domain/reviewLimits';
import type { Account, MerchantRule, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderApp } from '../helpers/renderApp';

/**
 * The rule manager, against a real database.
 *
 * Every assertion that matters reads the *stored* rule back out rather than
 * trusting a label: the manager is the only thing between a user and the rule
 * services, so the question is always "did the service run, and did the row
 * really change".
 *
 * Rendered through the whole Settings route rather than in isolation, because
 * "rule CRUD is reachable" is itself part of what has to be true.
 */

let db: WorkspaceDatabase;

const ACCOUNTS: readonly Account[] = [
  {
    id: 'checking',
    label: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    archived: false,
  },
];

function transaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'checking',
    postedDate: '2026-04-08',
    descriptionRaw: 'PINEBROOK MARKET #114',
    merchantNormalized: 'PINEBROOK MARKET',
    amountCents: 1_234,
    direction: 'debit',
    kind: 'purchase',
    categoryId: 'other',
    categorySource: 'uncategorized',
    classificationConfidence: 'none',
    tags: [],
    excludedFromSpending: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

function rule(id: string, overrides: Partial<MerchantRule> = {}): MerchantRule {
  return {
    id,
    matchType: 'exact',
    pattern: `MERCHANT ${id}`,
    categoryId: 'groceries',
    priority: 0,
    createdByUser: true,
    ...overrides,
  };
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.accounts.bulkAdd([...ACCOUNTS]);
  await db.importSessions.add({
    id: 'session-1',
    importedAt: '2026-08-01T12:00:00.000Z',
    sourceFileNames: ['statement.csv'],
    accountIds: ['checking'],
    mappingVersion: 1,
    rowCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    duplicateCandidateCount: 0,
    warnings: [],
  });
  await setWorkspaceMode(db, 'personal');
});

afterEach(async () => {
  // Unmount before deleting, so a live query is never subscribed to a database
  // that is going away.
  cleanup();
  await destroyTestDatabase(db);
});

async function renderRules() {
  renderApp('/app/settings', { database: db });
  await screen.findByRole('heading', { level: 1, name: /^settings$/i });
  await screen.findByRole('heading', { level: 2, name: /^merchant rules$/i });
  // The provider opens IndexedDB asynchronously and the create control stays
  // disabled until it has. Clicking before that is a silent no-op.
  await waitFor(() =>
    expect(manager().getByRole('button', { name: /create a rule/i })).toBeEnabled(),
  );
}

/** The rule manager section, so queries cannot stray into the rest of Settings. */
function manager() {
  return within(screen.getByRole('region', { name: /^merchant rules$/i }) as HTMLElement);
}

const user = () => userEvent.setup();

describe('reachability and the empty state', () => {
  it('is reachable from Settings and explains what a rule does', async () => {
    await renderRules();

    expect(await screen.findByText(/you have not created any rules yet/i)).toBeInTheDocument();
    // The three promises that stop a rule being frightening.
    expect(manager().getByText(/does not change, recategorize, or rewrite/i)).toBeInTheDocument();
    expect(
      manager().getByText(/never deletes, reverts, or recategorizes a transaction/i),
    ).toBeInTheDocument();
    expect(manager().getByText(/higher priority wins/i)).toBeInTheDocument();
  });

  it('renders a loading state before the rules arrive', async () => {
    await db.merchantRules.add(rule('r1'));
    renderApp('/app/settings', { database: db });

    // The provider opens the workspace asynchronously, so the manager renders
    // its loading line before the first read resolves.
    expect(await screen.findByText(/loading your rules…/i)).toBeInTheDocument();
    expect(await screen.findByText(/1 rule, listed in the order they apply/i)).toBeInTheDocument();
  });

  it('renders a sanitized failure with a retry when the read fails', async () => {
    vi.spyOn(db.merchantRules, 'toArray').mockRejectedValue(new Error('idb exploded'));
    await renderRules();

    expect(await screen.findByText(/your rules could not be read/i)).toBeInTheDocument();
    expect(manager().getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // The Dexie detail never reaches the interface.
    expect(document.body.textContent).not.toMatch(/idb exploded/);
  });
});

describe('listing and pagination', () => {
  it('lists rules in the order they actually apply', async () => {
    await db.merchantRules.bulkAdd([
      rule('low', { pattern: 'LOW PRIORITY', priority: 1 }),
      rule('high', { pattern: 'HIGH PRIORITY', priority: 9 }),
    ]);
    await renderRules();

    await screen.findByText(/2 rules, listed in the order they apply/i);
    const items = within(manager().getByRole('list', { name: 'Your rules' })).getAllByRole(
      'listitem',
    );
    // Higher priority first, matching `sortRulesByPrecedence`.
    expect(items[0]).toHaveTextContent('HIGH PRIORITY');
  });

  it('pages through a long list', async () => {
    const many: MerchantRule[] = [];
    for (let index = 0; index < RULES_PAGE_SIZE + 3; index += 1) {
      many.push(rule(`r${String(index).padStart(2, '0')}`, { priority: 100 - index }));
    }
    await db.merchantRules.bulkAdd(many);
    await renderRules();

    await screen.findByText(new RegExp(`${RULES_PAGE_SIZE + 3} rules`, 'i'));
    const pager = manager().getByRole('navigation', { name: /rule pagination/i });
    expect(within(pager).getByText(/page 1 of 2/i)).toBeInTheDocument();

    await user().click(within(pager).getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(
        within(manager().getByRole('navigation', { name: /rule pagination/i })).getByText(
          /page 2 of 2/i,
        ),
      ).toBeInTheDocument(),
    );
  });

  it('counts matching stored transactions without changing them', async () => {
    await db.transactions.bulkAdd([
      transaction('a'),
      transaction('b', { postedDate: '2026-04-09' }),
    ]);
    await db.merchantRules.add(rule('r1', { pattern: 'PINEBROOK MARKET' }));
    await renderRules();

    await screen.findByText(/1 rule, listed in the order they apply/i);
    await user().click(manager().getByRole('button', { name: /count transactions matching/i }));

    expect(await screen.findByText(/2 stored transactions match/i)).toBeInTheDocument();
    // Counting is a read. Nothing was reclassified.
    const rows = await db.transactions.toArray();
    expect(rows.every((row) => row.categoryId === 'other')).toBe(true);
  });
});

describe('creating a rule', () => {
  it('persists the rule and leaves existing transactions alone', async () => {
    const u = user();
    await db.transactions.add(transaction('a'));
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');

    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /^create rule$/i }));

    // The rule matches the stored row, so the product asks whether to apply it
    // retroactively. Declining is what keeps history untouched — and waiting
    // for the offer explicitly is what keeps this test deterministic, since the
    // editor closes a beat before the offer opens.
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent(/matches 1 transaction already stored/i),
    );
    await u.click(screen.getByRole('button', { name: /not now/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Stored, not merely displayed.
    const stored = await db.merchantRules.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.pattern).toBe('PINEBROOK MARKET');
    expect(stored[0]?.categoryId).toBe('groceries');
    expect(stored[0]?.createdByUser).toBe(true);

    // §12: the rule is for the future. The stored row is untouched.
    const row = await db.transactions.get('a');
    expect(row?.categoryId).toBe('other');
    expect(row?.categorySource).toBe('uncategorized');
  });

  it('canonicalizes the pattern the same way matching does', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), '  pinebrook   market ');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');

    expect(within(dialog).getByText(/stored and matched as/i)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /^create rule$/i }));

    await waitFor(async () => {
      const stored = await db.merchantRules.toArray();
      expect(stored[0]?.pattern).toBe('PINEBROOK MARKET');
    });
  });

  it('announces the outcome through the page live region', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /^create rule$/i }));

    // One live region for the whole page, so announcements cannot collide.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/rule saved.*future imports/i),
    );
  });

  it('restores focus to the control that opened the dialog', async () => {
    const u = user();
    await renderRules();

    const opener = manager().getByRole('button', { name: /create a rule/i });
    await u.click(opener);
    await screen.findByRole('dialog');
    await u.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('cancels on Escape without writing anything', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await db.merchantRules.count()).toBe(0);
  });
});

describe('validation', () => {
  it('blocks a rule that would change nothing', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');

    // No merchant, category, or kind chosen: the rule would match and then do
    // nothing, which reads as broken rather than empty.
    expect(within(dialog).getByText(/has to change something/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^create rule$/i })).toBeDisabled();
    expect(await db.merchantRules.count()).toBe(0);
  });

  it('refuses a dangerously short "contains" pattern', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');

    await u.click(within(dialog).getByLabelText(/contains this anywhere/i));
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PI');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');

    expect(within(dialog).getByText(/at least 3 characters/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^create rule$/i })).toBeDisabled();
  });

  it('warns about a short but legal "contains" pattern instead of refusing it', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');

    await u.click(within(dialog).getByLabelText(/contains this anywhere/i));
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINE');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');

    expect(
      within(dialog).getByText(/may match more transactions than you expect/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^create rule$/i })).toBeEnabled();
  });

  it('refuses a non-integer priority', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');

    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');
    await u.clear(within(dialog).getByLabelText(/^priority$/i));
    await u.type(within(dialog).getByLabelText(/^priority$/i), '1.5');

    expect(within(dialog).getByText(/whole number in the allowed range/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^create rule$/i })).toBeDisabled();
  });
});

describe('editing a rule', () => {
  it('persists the change', async () => {
    const u = user();
    await db.merchantRules.add(rule('r1', { pattern: 'PINEBROOK MARKET', categoryId: 'other' }));
    await renderRules();

    await screen.findByText(/1 rule, listed in the order they apply/i);
    await u.click(manager().getByRole('button', { name: /^edit the rule for/i }));

    const dialog = await screen.findByRole('dialog');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const stored = await db.merchantRules.get('r1');
      expect(stored?.categoryId).toBe('groceries');
    });
    // The id is preserved, so this is an edit rather than a replacement.
    expect(await db.merchantRules.count()).toBe(1);
  });
});

describe('deleting a rule', () => {
  it('requires a confirmation and never touches transactions', async () => {
    const u = user();
    await db.transactions.add(
      transaction('a', { categoryId: 'groceries', categorySource: 'user_rule' }),
    );
    await db.merchantRules.add(rule('r1', { pattern: 'PINEBROOK MARKET' }));
    await renderRules();

    await screen.findByText(/1 rule, listed in the order they apply/i);
    await u.click(manager().getByRole('button', { name: /^delete the rule for/i }));

    // A single click must not remove anything.
    expect(await db.merchantRules.count()).toBe(1);
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(/your transactions are not affected/i)).toBeInTheDocument();

    await u.click(within(confirm).getByRole('button', { name: /delete rule/i }));

    await waitFor(async () => expect(await db.merchantRules.count()).toBe(0));

    // The row keeps the classification it was given.
    const row = await db.transactions.get('a');
    expect(row?.categoryId).toBe('groceries');
    expect(row?.categorySource).toBe('user_rule');
  });

  it('lets the user cancel without deleting', async () => {
    const u = user();
    await db.merchantRules.add(rule('r1'));
    await renderRules();

    await screen.findByText(/1 rule, listed in the order they apply/i);
    await u.click(manager().getByRole('button', { name: /^delete the rule for/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^cancel$/i }),
    );

    expect(await db.merchantRules.count()).toBe(1);
  });
});

describe('duplicate submission', () => {
  it('writes one rule even when the confirm button is clicked twice', async () => {
    const u = user();
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');

    const save = within(dialog).getByRole('button', { name: /^create rule$/i });
    // Two clicks in the same tick, before the first await settles.
    await Promise.all([u.click(save), u.click(save).catch(() => undefined)]);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await db.merchantRules.count()).toBe(1);
  });
});

describe('a sanitized write failure', () => {
  it('reports the refusal without a Dexie detail and keeps the workspace as it was', async () => {
    const u = user();
    await renderRules();

    vi.spyOn(db.merchantRules, 'add').mockRejectedValue(new Error('quota exceeded, disk on fire'));

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /^create rule$/i }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not be saved/i);
    expect(document.body.textContent).not.toMatch(/disk on fire/);
    expect(await db.merchantRules.count()).toBe(0);
  });
});

describe('applying a rule to transactions already stored', () => {
  it('offers the choice as soon as a rule is created, and states the scope', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('a'),
      transaction('b', { postedDate: '2026-04-09' }),
    ]);
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /^create rule$/i }));

    // category-rules.md §5.3: creating a rule must show how many stored rows it
    // matches and let the user decide whether to apply it retroactively.
    // Polled, because the editor closes first and the offer opens once the
    // bounded match read resolves — there is a beat with no dialog at all.
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent(
        /matches 2 transactions already stored/i,
      ),
    );
    const offer = screen.getByRole('dialog');
    expect(offer).toHaveTextContent(/those transactions will change/i);

    // Declining changes nothing at all; the rule itself still exists.
    await u.click(within(offer).getByRole('button', { name: /not now/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const rows = await db.transactions.toArray();
    expect(rows.every((row) => row.categoryId === 'other')).toBe(true);
    expect(await db.merchantRules.count()).toBe(1);
  });

  it('rewrites the matching rows once confirmed, as one undoable command', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('a'),
      transaction('b', { postedDate: '2026-04-09' }),
      transaction('c', {
        merchantNormalized: 'HARBOR BEAN COFFEE',
        descriptionRaw: 'HARBOR BEAN COFFEE',
        postedDate: '2026-04-10',
      }),
    ]);
    await db.merchantRules.add(
      rule('r1', { pattern: 'PINEBROOK MARKET', categoryId: 'groceries' }),
    );
    await renderRules();

    await screen.findByText(/1 rule, listed in the order they apply/i);
    await u.click(manager().getByRole('button', { name: /^apply the rule for/i }));

    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent(/matches 2 transactions already stored/i);
    await u.click(within(confirm).getByRole('button', { name: /apply to existing transactions/i }));

    await waitFor(async () => {
      const rows = await db.transactions.toArray();
      expect(rows.filter((row) => row.categoryId === 'groceries')).toHaveLength(2);
    });

    // Only the matching rows changed.
    expect((await db.transactions.get('c'))?.categoryId).toBe('other');
    // A rule application is a tier-1 decision on each row it touched.
    expect((await db.transactions.get('a'))?.categorySource).toBe('user');

    // One command, one undo entry, on the shared session stack.
    const undoControl = await manager().findByRole('button', { name: /undo last change/i });
    await u.click(undoControl);
    await waitFor(async () => {
      const rows = await db.transactions.toArray();
      expect(rows.every((row) => row.categoryId === 'other')).toBe(true);
    });
  });

  it('says nothing about applying when no stored row matches', async () => {
    const u = user();
    await db.transactions.add(
      transaction('a', {
        merchantNormalized: 'HARBOR BEAN COFFEE',
        descriptionRaw: 'HARBOR BEAN COFFEE',
      }),
    );
    await renderRules();

    await u.click(manager().getByRole('button', { name: /create a rule/i }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/pattern to match/i), 'PINEBROOK MARKET');
    await u.selectOptions(within(dialog).getByLabelText(/set the category to/i), 'groceries');
    await u.click(within(dialog).getByRole('button', { name: /^create rule$/i }));

    // Nothing matches, so there is no retroactive question to ask.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await db.merchantRules.count()).toBe(1);
  });
});
