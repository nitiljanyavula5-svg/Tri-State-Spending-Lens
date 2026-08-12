import 'fake-indexeddb/auto';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../../../src/db/database';
import { setWorkspaceMode } from '../../../src/db/repositories/settings';
import { readSnapshot } from '../../../src/db/workspace';
import { spendingTreatment } from '../../../src/classification/spending';
import type { Account, Transaction } from '../../../src/types/domain';
import { createTestDatabase, destroyTestDatabase } from '../helpers/testDatabase';
import { renderApp } from '../helpers/renderApp';

/**
 * Reviewing possible relationships, against a real database.
 *
 * The failure this page could cause is silent: `transfer` and `payment` are
 * excluded from net spending, so a link made without the user's say-so hides
 * money they really spent. Every test that merely *looks* at suggestions
 * therefore compares a full workspace snapshot before and after, and every test
 * that confirms one reads the rows back out.
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
  { id: 'savings', label: 'Savings', type: 'savings', currency: 'USD', archived: false },
  { id: 'card', label: 'Rewards Card', type: 'credit_card', currency: 'USD', archived: false },
];

function transaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    fingerprint: id.padEnd(64, '0'),
    importSessionId: 'session-1',
    originalRow: 1,
    accountId: 'checking',
    postedDate: '2026-04-08',
    descriptionRaw: 'TRANSFER TO SAVINGS',
    merchantNormalized: 'TRANSFER TO SAVINGS',
    amountCents: 50_000,
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

const purchase = (id: string, overrides: Partial<Transaction> = {}) =>
  transaction(id, {
    accountId: 'card',
    direction: 'debit',
    kind: 'purchase',
    merchantNormalized: 'QUILL AND PAGE BOOKS',
    descriptionRaw: 'QUILL AND PAGE BOOKS',
    amountCents: 2_400,
    categoryId: 'shopping',
    categorySource: 'user',
    postedDate: '2026-04-01',
    ...overrides,
  });

const refund = (id: string, overrides: Partial<Transaction> = {}) =>
  transaction(id, {
    accountId: 'card',
    direction: 'credit',
    kind: 'refund',
    merchantNormalized: 'QUILL AND PAGE BOOKS',
    descriptionRaw: 'QUILL AND PAGE BOOKS',
    amountCents: 2_400,
    categoryId: 'other',
    postedDate: '2026-04-20',
    ...overrides,
  });

beforeEach(async () => {
  db = await createTestDatabase();
  await db.accounts.bulkAdd([...ACCOUNTS]);
  await db.importSessions.add({
    id: 'session-1',
    importedAt: '2026-08-01T12:00:00.000Z',
    sourceFileNames: ['statement.csv'],
    accountIds: ['checking', 'savings', 'card'],
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
  cleanup();
  await destroyTestDatabase(db);
});

function renderPage() {
  return renderApp('/app/transactions/relationships', { database: db });
}

const transfers = () =>
  within(screen.getByRole('region', { name: /possible transfers and card payments/i }));
const refunds = () => within(screen.getByRole('region', { name: /^possible refunds$/i }));
const confirmed = () => within(screen.getByRole('region', { name: /links you have confirmed/i }));

const user = () => userEvent.setup();

/** The two sides of one movement: money out of checking, into savings. */
async function seedTransferPair() {
  await db.transactions.bulkAdd([
    transaction('out', { accountId: 'checking', direction: 'debit' }),
    transaction('in', {
      accountId: 'savings',
      direction: 'credit',
      descriptionRaw: 'TRANSFER FROM CHECKING',
      merchantNormalized: 'TRANSFER FROM CHECKING',
      postedDate: '2026-04-09',
    }),
  ]);
}

describe('the empty workspace', () => {
  it('explains what will appear rather than showing an empty queue', async () => {
    renderPage();
    expect(await screen.findByText(/nothing to link yet/i)).toBeInTheDocument();
  });
});

describe('transfer suggestions', () => {
  it('offers a pair and writes absolutely nothing by being viewed', async () => {
    await seedTransferPair();
    const before = await readSnapshot(db);

    renderPage();
    await screen.findByText(/1 possible pair/i);

    expect(transfers().getByText('Suggestion')).toBeInTheDocument();
    // The language never claims certainty.
    expect(transfers().getByText(/suggestions, not conclusions/i)).toBeInTheDocument();

    // Looking is not deciding.
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('shows both endpoints with their dates, accounts, and directions', async () => {
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    expect(transfers().getByText('Money out')).toBeInTheDocument();
    expect(transfers().getByText('Money in')).toBeInTheDocument();
    expect(transfers().getByText('2026-04-08')).toBeInTheDocument();
    expect(transfers().getByText('2026-04-09')).toBeInTheDocument();
    expect(transfers().getByText('Everyday Checking')).toBeInTheDocument();
    expect(transfers().getByText('Savings')).toBeInTheDocument();
    // Direction is words, not a sign alone.
    expect(transfers().getByText(/money out\)/i)).toBeInTheDocument();
    expect(transfers().getByText(/money in\)/i)).toBeInTheDocument();
  });

  it('leaves two same-value purchases in one account completely alone', async () => {
    await db.transactions.bulkAdd([
      transaction('a', { accountId: 'checking', direction: 'debit', kind: 'purchase' }),
      transaction('b', { accountId: 'checking', direction: 'debit', kind: 'purchase' }),
    ]);
    const before = await readSnapshot(db);

    renderPage();
    expect(await screen.findByText(/no possible transfers found/i)).toBeInTheDocument();
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('confirms a transfer only after an explicit confirmation, and changes both kinds', async () => {
    const u = user();
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    await u.click(transfers().getByRole('button', { name: /link these two/i }));

    // A single click opens a confirmation; it does not link.
    expect(await db.transactionLinks.count()).toBe(0);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/never counted as spending/i)).toBeInTheDocument();

    await u.click(within(dialog).getByRole('button', { name: /^link them$/i }));

    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));

    const out = await db.transactions.get('out');
    const incoming = await db.transactions.get('in');
    // Both sides move together, so the pair can never be half-classified.
    expect(out?.kind).toBe('transfer');
    expect(incoming?.kind).toBe('transfer');
    expect(spendingTreatment(out!)).toBe('excluded-by-kind');
    expect(spendingTreatment(incoming!)).toBe('excluded-by-kind');
  });

  it('confirms a card payment when the user chooses that instead', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'card', direction: 'credit' }),
    ]);
    renderPage();
    await screen.findByText(/1 possible pair/i);

    // A credit card is involved, so `payment` is proposed by default.
    const choice = transfers().getByLabelText(/if you link these, treat them as/i);
    expect(choice).toHaveValue('payment');

    await u.click(transfers().getByRole('button', { name: /link these two/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/credit-card payment/i)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /^link them$/i }));

    await waitFor(async () => expect((await db.transactions.get('out'))?.kind).toBe('payment'));
    expect((await db.transactionLinks.toArray())[0]?.kind).toBe('transfer');
  });

  it('lets the user override the proposed kind before confirming', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      transaction('out', { accountId: 'checking', direction: 'debit' }),
      transaction('in', { accountId: 'card', direction: 'credit' }),
    ]);
    renderPage();
    await screen.findByText(/1 possible pair/i);

    await u.selectOptions(
      transfers().getByLabelText(/if you link these, treat them as/i),
      'transfer',
    );
    await u.click(transfers().getByRole('button', { name: /link these two/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^link them$/i }),
    );

    // The inference was a default, not a decision.
    await waitFor(async () => expect((await db.transactions.get('out'))?.kind).toBe('transfer'));
  });

  it('reports a sanitized refusal when an endpoint was linked elsewhere first', async () => {
    const u = user();
    await seedTransferPair();
    await db.transactions.add(
      transaction('third', { accountId: 'card', direction: 'credit', postedDate: '2026-04-09' }),
    );
    renderPage();
    await screen.findByText(/^2 possible pairs$/i);

    // Another view of the same workspace claims one endpoint first.
    await db.transactionLinks.add({
      id: 'external-link',
      kind: 'transfer',
      fromTransactionId: 'out',
      toTransactionId: 'third',
      createdAt: '2026-08-02T09:00:00.000Z',
    });

    await u.click(transfers().getAllByRole('button', { name: /link these two/i })[0]!);
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^link them$/i }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/already linked/i);
    // The refusal changed nothing: still just the one pre-existing link.
    expect(await db.transactionLinks.count()).toBe(1);
    expect((await db.transactions.get('in'))?.kind).toBe('purchase');
  });

  it('cancels without linking', async () => {
    const u = user();
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    await u.click(transfers().getByRole('button', { name: /link these two/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^cancel$/i }),
    );

    expect(await db.transactionLinks.count()).toBe(0);
    expect((await db.transactions.get('out'))?.kind).toBe('purchase');
  });
});

describe('unlinking and undo', () => {
  async function confirmTheTransfer(u: ReturnType<typeof user>) {
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);
    await u.click(transfers().getByRole('button', { name: /link these two/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^link them$/i }),
    );
    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));
  }

  it('shows the confirmed link and explains its spending treatment', async () => {
    const u = user();
    await confirmTheTransfer(u);

    expect(await screen.findByText(/links you have confirmed/i)).toBeInTheDocument();
    expect(confirmed().getByText(/confirmed transfer/i)).toBeInTheDocument();
    expect(confirmed().getByText(/never counted as spending/i)).toBeInTheDocument();
  });

  it('unlinks after a confirmation and leaves the confirmed kinds alone', async () => {
    const u = user();
    await confirmTheTransfer(u);
    await screen.findByText(/links you have confirmed/i);

    await u.click(confirmed().getByRole('button', { name: /unlink these/i }));
    const dialog = await screen.findByRole('dialog');
    // The contract, stated where the user is deciding.
    expect(within(dialog).getByText(/their kinds are left as they are/i)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /^unlink$/i }));

    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(0));
    // Unlinking says the pairing was wrong, not the classification.
    expect((await db.transactions.get('out'))?.kind).toBe('transfer');
    expect((await db.transactions.get('in'))?.kind).toBe('transfer');
  });

  it('undoes a confirmation as one unit, removing the link and both kind changes', async () => {
    const u = user();
    await confirmTheTransfer(u);

    await u.click(await screen.findByRole('button', { name: /undo last change/i }));

    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(0));
    expect((await db.transactions.get('out'))?.kind).toBe('purchase');
    expect((await db.transactions.get('in'))?.kind).toBe('purchase');
  });

  it('undoes an unlink by putting the relationship back', async () => {
    const u = user();
    await confirmTheTransfer(u);
    await screen.findByText(/links you have confirmed/i);

    await u.click(confirmed().getByRole('button', { name: /unlink these/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^unlink$/i }),
    );
    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(0));

    await u.click(await screen.findByRole('button', { name: /undo last change/i }));
    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));
  });

  it('warns that undo does not survive a reload', async () => {
    const u = user();
    await confirmTheTransfer(u);
    expect(await screen.findByText(/until you reload this page/i)).toBeInTheDocument();
  });
});

describe('refund suggestions', () => {
  it('offers the matching purchase and writes nothing by being viewed', async () => {
    await db.transactions.bulkAdd([purchase('p'), refund('r')]);
    const before = await readSnapshot(db);

    renderPage();
    await screen.findByText(/1 refund with a matching purchase/i);

    expect(refunds().getByText('The refund')).toBeInTheDocument();
    expect(refunds().getByText('The purchase')).toBeInTheDocument();
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('shows ambiguity instead of choosing for the user', async () => {
    await db.transactions.bulkAdd([
      purchase('p1', { postedDate: '2026-04-01' }),
      purchase('p2', { postedDate: '2026-04-10' }),
      refund('r'),
    ]);
    renderPage();
    await screen.findByText(/1 refund with a matching purchase/i);

    expect(refunds().getByText(/more than one purchase fits/i)).toBeInTheDocument();
    expect(
      refunds().getByText(/cannot tell which purchase this refund reverses/i),
    ).toBeInTheDocument();
    expect(refunds().getAllByRole('button', { name: /this is the purchase/i })).toHaveLength(2);
  });

  it('confirms a refund, inherits the purchase fields, and stays a refund', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      purchase('p', { merchantNormalized: 'QUILL AND PAGE BOOKS', categoryId: 'shopping' }),
      refund('r', { categoryId: 'other' }),
    ]);
    renderPage();
    await screen.findByText(/1 refund with a matching purchase/i);

    await u.click(refunds().getByRole('button', { name: /this is the purchase/i }));

    expect(await db.transactionLinks.count()).toBe(0);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stays a refund/i)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /^link them$/i }));

    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));

    const stored = await db.transactions.get('r');
    expect(stored?.categoryId).toBe('shopping');
    expect(stored?.merchantNormalized).toBe('QUILL AND PAGE BOOKS');
    // Visibly still a refund, so it never disappears into the purchase.
    expect(stored?.kind).toBe('refund');
    expect(spendingTreatment(stored!)).toBe('included-refund');
  });

  it('will not pair a refund endpoint twice', async () => {
    const u = user();
    await db.transactions.bulkAdd([
      purchase('p1', { postedDate: '2026-04-01' }),
      purchase('p2', { postedDate: '2026-04-10' }),
      refund('r'),
    ]);
    renderPage();
    await screen.findByText(/1 refund with a matching purchase/i);

    await u.click(refunds().getAllByRole('button', { name: /this is the purchase/i })[0]!);
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^link them$/i }),
    );
    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));

    // The refund is spoken for, so it is no longer offered at all.
    await waitFor(() =>
      expect(screen.queryByText(/refund with a matching purchase/i)).not.toBeInTheDocument(),
    );
    expect(await db.transactionLinks.count()).toBe(1);
  });

  it('unlinks a confirmed refund', async () => {
    const u = user();
    await db.transactions.bulkAdd([purchase('p'), refund('r')]);
    renderPage();
    await screen.findByText(/1 refund with a matching purchase/i);

    await u.click(refunds().getByRole('button', { name: /this is the purchase/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^link them$/i }),
    );
    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));

    await screen.findByText(/links you have confirmed/i);
    expect(confirmed().getByText(/confirmed refund/i)).toBeInTheDocument();

    await u.click(confirmed().getByRole('button', { name: /unlink these/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^unlink$/i }),
    );

    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(0));
    expect((await db.transactions.get('r'))?.kind).toBe('refund');
  });
});

describe('a refund nothing matches', () => {
  it('is listed honestly and can still be classified by hand', async () => {
    const u = user();
    await db.transactions.add(refund('r', { kind: 'unknown', categoryId: 'other' }));
    renderPage();

    expect(await screen.findByText(/1 credit with no matching purchase/i)).toBeInTheDocument();
    expect(refunds().getByText(/that is a real answer, not a failure/i)).toBeInTheDocument();

    await u.click(refunds().getByRole('button', { name: /review this transaction/i }));
    const dialog = await screen.findByRole('dialog');

    await u.selectOptions(within(dialog).getByLabelText(/^Kind$/i), 'refund');
    await u.selectOptions(within(dialog).getByLabelText(/^Category$/i), 'shopping');
    await u.click(within(dialog).getByRole('button', { name: /save this transaction/i }));

    await waitFor(async () => {
      const stored = await db.transactions.get('r');
      expect(stored?.kind).toBe('refund');
      expect(stored?.categoryId).toBe('shopping');
    });
    // Editing by hand never invents a relationship.
    expect(await db.transactionLinks.count()).toBe(0);
  });
});

describe('accessibility and lifecycle', () => {
  it('announces an outcome through one polite live region', async () => {
    const u = user();
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    // Exactly one live region, so announcements cannot collide.
    expect(screen.getAllByRole('status')).toHaveLength(1);

    await u.click(transfers().getByRole('button', { name: /link these two/i }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /^link them$/i }),
    );

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/transfer linked/i));
  });

  it('restores focus to the control that opened a dialog', async () => {
    const u = user();
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    const opener = transfers().getByRole('button', { name: /link these two/i });
    await u.click(opener);
    await screen.findByRole('dialog');
    await u.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(await db.transactionLinks.count()).toBe(0);
  });

  it('completes a confirmation with the keyboard alone', async () => {
    const u = user();
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    const open = transfers().getByRole('button', { name: /link these two/i });
    open.focus();
    await u.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /^link them$/i });
    confirm.focus();
    await u.keyboard('{Enter}');

    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));
  });

  it('renders one set of controls, so no action can fire twice', async () => {
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    // A single reflowing layout serves every width, so there is no second copy
    // of a control hidden by CSS at desktop size.
    expect(screen.getAllByRole('button', { name: /link these two/i })).toHaveLength(1);
  });

  it('renders a sanitized failure with a retry when the read fails', async () => {
    // Rows first: an empty workspace renders its own state and never reaches
    // the suggestion collectors at all.
    await seedTransferPair();
    vi.spyOn(db.transactions, 'toArray').mockRejectedValue(new Error('idb exploded'));

    renderPage();

    expect(
      await screen.findByText(/these suggestions could not be worked out/i, undefined, {
        timeout: 5_000,
      }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/idb exploded/);
  });

  it('survives navigating away while a confirmation is in flight', async () => {
    const u = user();
    await seedTransferPair();
    const view = renderPage();
    await screen.findByText(/1 possible pair/i);

    await u.click(transfers().getByRole('button', { name: /link these two/i }));
    const dialog = await screen.findByRole('dialog');
    within(dialog)
      .getByRole('button', { name: /^link them$/i })
      .click();

    // Torn down mid-command. The write still lands; the unmounted component
    // must not try to render its result.
    view.unmount();

    await waitFor(async () => expect(await db.transactionLinks.count()).toBe(1));
    expect((await db.transactions.get('out'))?.kind).toBe('transfer');
  });

  it('keeps the document title constant, whatever is on screen', async () => {
    await seedTransferPair();
    renderPage();
    await screen.findByText(/1 possible pair/i);

    expect(document.title).toBe('Linked transactions · Tri-State Spending Lens');
    expect(document.title).not.toMatch(/TRANSFER TO SAVINGS/);
  });
});
