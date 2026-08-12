import { expect, test, type Page } from '@playwright/test';
import { seedWorkspace } from './seedWorkspace';

/**
 * How long an undo entry lives, and who owns it.
 *
 * `docs/phase-4-services.md` §5 names exactly one boundary: **a reload**. Undo
 * is "session-local", bounded at twenty, and one bulk command, one relationship
 * confirmation, or one edit-plus-rule is one entry. Nothing in any specification
 * scopes the stack to a page — so moving between the review routes must not
 * lose it, and transaction and relationship commands must share one history in
 * the order they happened.
 *
 * This file exists because an earlier implementation created the manager inside
 * each review page, which quietly destroyed the history on every navigation.
 */

const undoButton = (page: Page) => page.getByRole('button', { name: /undo last change/i });

async function stored(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('tri-state-spending-lens');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const read = (store: string): Promise<Array<Record<string, unknown>>> =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        request.onerror = () => reject(request.error);
      });
    const transactions = await read('transactions');
    const links = await read('transactionLinks');
    db.close();
    return { transactions, linkCount: links.length };
  });
}

/** Edits one transaction's category — one undo entry. */
async function editPinebrook(page: Page, category: string) {
  await page.goto('/app/transactions');
  await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();
  await page.getByLabel('Search').fill('PINEBROOK MARKET');
  await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: /^Review/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Category').selectOption(category);
  await dialog.getByRole('button', { name: /save this transaction/i }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Confirms the checking/savings transfer — one undo entry.
 *
 * Assumes the relationship page is already open. Callers choose how they got
 * there, which matters: `page.goto` is a reload and legitimately clears the
 * stack, so a test about surviving *navigation* has to use in-app routing.
 */
async function confirmTransfer(page: Page) {
  const transfers = page.getByRole('region', { name: /possible transfers and card payments/i });
  const pair = transfers.getByRole('listitem').filter({ hasText: 'TRANSFER TO SAVINGS' });
  await pair.getByRole('button', { name: /link these two/i }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^link them$/i })
    .click();
  await expect.poll(async () => (await stored(page)).linkCount).toBe(1);
}

test.describe('undo lifetime', () => {
  test('survives client-side navigation away from the page that created it', async ({ page }) => {
    await seedWorkspace(page);
    await editPinebrook(page, 'groceries');
    await expect(undoButton(page)).toBeVisible();

    // Away, using in-app routing rather than a reload.
    await page.getByRole('link', { name: /review links/i }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();
    await expect(undoButton(page)).toBeVisible();

    // And back again.
    await page.getByRole('link', { name: /back to transactions/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();
    await expect(undoButton(page)).toBeVisible();

    // Still the same entry, and it still works.
    await undoButton(page).click();
    await expect
      .poll(
        async () =>
          (await stored(page)).transactions.find((row) => row.id === 'buy-pinebrook')?.categoryId,
      )
      .toBe('other');
  });

  test('survives navigation for a relationship confirmation too', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');
    await confirmTransfer(page);
    await expect(undoButton(page)).toBeVisible();

    await page.getByRole('link', { name: /back to transactions/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();
    await expect(undoButton(page)).toBeVisible();

    await undoButton(page).click();
    await expect.poll(async () => (await stored(page)).linkCount).toBe(0);
  });

  test('holds transaction and relationship commands in one chronological stack', async ({
    page,
  }) => {
    await seedWorkspace(page);

    // Command 1: a transaction edit, on the transactions route.
    await editPinebrook(page, 'groceries');

    // Command 2: a relationship confirmation, reached by in-app routing so the
    // document — and therefore the session stack — is never torn down.
    await page.getByRole('link', { name: /review links/i }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();
    await confirmTransfer(page);

    // The newest entry is the relationship, whichever page we are on.
    await expect(undoButton(page)).toContainText(/link transfer/i);
    await undoButton(page).click();
    await expect.poll(async () => (await stored(page)).linkCount).toBe(0);

    // Underneath it, still reachable, is the earlier transaction edit — made on
    // a different route. Two separate per-page stacks could not do this.
    await expect(undoButton(page)).toContainText(/edit/i);
    await undoButton(page).click();
    await expect
      .poll(
        async () =>
          (await stored(page)).transactions.find((row) => row.id === 'buy-pinebrook')?.categoryId,
      )
      .toBe('other');

    // Both reversed, so nothing is left to undo.
    await expect(undoButton(page)).toHaveCount(0);
  });

  test('is cleared by a reload while the edits themselves survive', async ({ page }) => {
    await seedWorkspace(page);
    await editPinebrook(page, 'groceries');
    await expect(undoButton(page)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();

    // The one documented boundary.
    await expect(undoButton(page)).toHaveCount(0);
    expect(
      (await stored(page)).transactions.find((row) => row.id === 'buy-pinebrook')?.categoryId,
    ).toBe('groceries');
  });

  test('is dropped when the workspace it describes is deleted', async ({ page }) => {
    await seedWorkspace(page);
    await editPinebrook(page, 'groceries');
    await expect(undoButton(page)).toBeVisible();

    await page.goto('/app/settings');
    await page.getByRole('button', { name: /^delete all data$/i }).click();
    await page.getByRole('button', { name: /yes, delete everything/i }).click();
    await expect(page.getByRole('status')).toContainText(/all local data has been deleted/i);

    // "Delete all data" must not leave whole copies of the deleted rows sitting
    // in an in-memory undo entry.
    await expect(undoButton(page)).toHaveCount(0);
    await page.goto('/app/transactions');
    await expect(page.getByRole('heading', { name: /nothing to review yet/i })).toBeVisible();
    await expect(undoButton(page)).toHaveCount(0);
  });
});
