import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fillerRows, reviewFixture, seedWorkspace } from './seedWorkspace';

/**
 * The Phase 4 review experience, in a real browser.
 *
 * The component suite already proves the services run and the rows change.
 * What only a browser can prove is here: routing, real IndexedDB persistence
 * across a reload, a real download, the responsive layout actually switching,
 * and the privacy boundary holding while all of it happens.
 *
 * Playwright gives each test a fresh browser context, so every test starts with
 * empty origin storage and seeds exactly what it needs.
 */

/** Rows on screen, whichever layout this viewport is using. */
function reviewButtons(page: Page) {
  return page.getByRole('button', { name: /^Review/ });
}

/**
 * Text in the layout this viewport is actually showing.
 *
 * The table and the card list both carry every value, and only one of them is
 * displayed. `.first()` alone would pick whichever comes first in the markup,
 * which at phone width is the hidden table.
 */
function visibleText(page: Page, text: string) {
  return page.getByText(text).filter({ visible: true }).first();
}

async function gotoTransactions(page: Page) {
  await page.goto('/app/transactions');
  await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();
}

/** Opens the editor for the row whose merchant is given. */
async function openReviewFor(page: Page, merchant: string) {
  await page.getByLabel('Search').fill(merchant);
  await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();
  await reviewButtons(page).first().click();
  return page.getByRole('dialog');
}

/** Reads the workspace straight out of this browser's IndexedDB. */
async function storedTransactions(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('tri-state-spending-lens');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const rows: unknown[] = await new Promise((resolve, reject) => {
      const request = db.transaction('transactions').objectStore('transactions').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows as Array<Record<string, unknown>>;
  });
}

/** The field-level audit log, straight out of this browser's IndexedDB. */
async function storedUserEdits(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('tri-state-spending-lens');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const rows: unknown[] = await new Promise((resolve, reject) => {
      const request = db.transaction('userEdits').objectStore('userEdits').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows as Array<{ entityId: string; field: string }>;
  });
}

async function storedCount(page: Page, store: 'merchantRules' | 'transactionLinks') {
  return page.evaluate(async (name) => {
    const open = indexedDB.open('tri-state-spending-lens');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const count: number = await new Promise((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  }, store);
}

/* ------------------------------------------------------------ the basics - */

test.describe('reaching the review page', () => {
  test('an empty workspace offers an import rather than an empty grid', async ({ page }) => {
    await gotoTransactions(page);
    await expect(page.getByRole('heading', { name: /nothing to review yet/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /import a csv/i }).first()).toBeVisible();
  });

  test('the demo workspace fills the grid', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /try the demo/i })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 1, name: /^overview$/i })).toBeVisible();

    await gotoTransactions(page);
    // The demo spans four months, so there is far more than a page of rows.
    await expect(page.getByText(/^\d{3,} transactions$/)).toBeVisible();
    await expect(reviewButtons(page).first()).toBeVisible();
  });

  test('a personal workspace shows the rows it was given', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);

    await expect(page.getByText('14 transactions')).toBeVisible();
    await expect(visibleText(page, 'PINEBROOK MARKET')).toBeVisible();
    // A personal workspace is never labelled as the demo.
    await expect(page.getByText(/fictional demo data/i)).toHaveCount(0);
  });

  test('exposes only one layout to assistive technology', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    // The table and the card list both exist in the markup and are switched by
    // CSS. The hidden one must be out of the accessibility tree entirely, or
    // every control would be announced — and clickable — twice.
    await expect(reviewButtons(page)).toHaveCount(14);
    await expect(page.getByRole('checkbox', { name: /^Select transaction/ })).toHaveCount(14);
    // One live region, one export control, one undo slot.
    await expect(page.getByRole('status')).toHaveCount(1);
  });
});

/* -------------------------------------------------- search, filter, page - */

test.describe('finding rows', () => {
  test('searches the raw description and the merchant, and combines filters', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    // The statement's own words.
    await page.getByLabel('Search').fill('SQ *HARBOR');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    // The reviewed merchant, for the same row.
    await page.getByLabel('Search').fill('harbor bean coffee');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    // Search plus account plus category, all at once.
    await page.getByLabel('Search').fill('');
    await page.getByLabel('Account').selectOption({ label: 'Rewards Card' });
    await page.getByLabel('Category').selectOption('groceries');
    await expect(page.getByText('2 transactions')).toBeVisible();

    await page.getByRole('button', { name: /clear all filters/i }).click();
    await expect(page.getByText('14 transactions')).toBeVisible();
  });

  test('shows a no-results state rather than an empty table', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await page.getByLabel('Search').fill('ZZZ-NOTHING-MATCHES');

    await expect(
      page.getByRole('heading', { name: /no transactions match these filters/i }),
    ).toBeVisible();
  });

  test('pages through a large workspace and keeps the DOM bounded', async ({ page }) => {
    await seedWorkspace(page, [...reviewFixture(), ...fillerRows(300)]);
    await gotoTransactions(page);
    await expect(page.getByText('314 transactions')).toBeVisible();

    // 314 rows in the workspace, one page of 50 on screen. A grid that rendered
    // everything would still "work" and would be unusable.
    await expect(reviewButtons(page)).toHaveCount(50);
    await expect(page.getByText(/showing 1–50/i)).toBeVisible();

    await page.getByRole('button', { name: /^next$/i }).click();
    await expect(page.getByText(/showing 51–100/i)).toBeVisible();
    await expect(reviewButtons(page)).toHaveCount(50);

    await page.getByLabel(/rows per page/i).selectOption('25');
    await expect(reviewButtons(page)).toHaveCount(25);
    await expect(page.getByText(/page 1 of 13/i)).toBeVisible();
  });
});

test.describe('sorting', () => {
  // The sortable column headers belong to the desktop table; the card list has
  // no column to click. Sorting is therefore a wide-viewport behaviour.
  test.skip(({ isMobile }) => Boolean(isMobile), 'covers the wide-viewport table only');

  test('sorts by a column and reports the state through aria-sort', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    const amount = page.getByRole('columnheader', { name: /Amount/ });
    await expect(amount).toHaveAttribute('aria-sort', 'none');

    await page.getByRole('button', { name: /^Amount/ }).click();
    await expect(amount).toHaveAttribute('aria-sort', 'descending');

    await page.getByRole('button', { name: /^Amount/ }).click();
    await expect(amount).toHaveAttribute('aria-sort', 'ascending');

    // Ascending really is ascending: the smallest amount is first.
    const firstRow = page.locator('tbody tr').first();
    await expect(firstRow).toContainText('-7.77');
  });
});

/* ------------------------------------------------------------- editing - */

test.describe('editing one transaction', () => {
  test('persists the change across a full page reload', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    const dialog = await openReviewFor(page, 'PINEBROOK MARKET');
    await dialog.getByLabel('Category').selectOption('groceries');
    await dialog.getByLabel('Merchant').fill('PINEBROOK CORNER MARKET');
    await dialog.getByRole('button', { name: /save this transaction/i }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();
    await expect(visibleText(page, 'PINEBROOK CORNER MARKET')).toBeVisible();

    const stored = await storedTransactions(page);
    const row = stored.find((entry) => entry.id === 'buy-pinebrook');
    expect(row?.categoryId).toBe('groceries');
    expect(row?.merchantNormalized).toBe('PINEBROOK CORNER MARKET');
    // A manual change is a tier-1 decision.
    expect(row?.categorySource).toBe('user');
  });

  test('never changes a source field, whatever is edited', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    const before = (await storedTransactions(page)).find((row) => row.id === 'buy-pinebrook')!;

    const dialog = await openReviewFor(page, 'PINEBROOK MARKET');
    await expect(dialog.getByText(/never changed/i)).toBeVisible();
    // There is no control that could change the source at all.
    await expect(dialog.getByLabel(/^amount$/i)).toHaveCount(0);
    await expect(dialog.getByLabel(/^description$/i)).toHaveCount(0);
    await expect(dialog.getByLabel(/^date$/i)).toHaveCount(0);

    await dialog.getByLabel('Category').selectOption('travel');
    await dialog.getByRole('button', { name: /save this transaction/i }).click();
    await expect(dialog).toBeHidden();

    const after = (await storedTransactions(page)).find((row) => row.id === 'buy-pinebrook')!;
    for (const field of [
      'fingerprint',
      'importSessionId',
      'originalRow',
      'accountId',
      'postedDate',
      'descriptionRaw',
      'amountCents',
      'direction',
      'createdAt',
    ]) {
      expect(after[field], `${field} must be immutable`).toEqual(before[field]);
    }
    expect(after.categoryId).toBe('travel');
  });

  test('writes once when the save control is clicked twice', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    const dialog = await openReviewFor(page, 'PINEBROOK MARKET');
    await dialog.getByLabel('Category').selectOption('groceries');

    // Both clicks in one browser turn. Two awaited round-trips are not a
    // double click at all — the first save finishes before the second starts.
    await dialog
      .getByRole('button', { name: /save this transaction/i })
      .evaluate((element: HTMLElement) => {
        element.click();
        element.click();
      });
    await expect(dialog).toBeHidden();

    // One command, so one audit entry per changed field — not two.
    const edits = await storedUserEdits(page);
    const categoryEdits = edits.filter(
      (edit) => edit.entityId === 'buy-pinebrook' && edit.field === 'categoryId',
    );
    expect(categoryEdits).toHaveLength(1);
  });

  test('changes only this transaction when no rule is asked for', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    const dialog = await openReviewFor(page, 'PINEBROOK MARKET');
    await dialog.getByLabel('Category').selectOption('groceries');
    await dialog.getByRole('button', { name: /save this transaction/i }).click();
    await expect(dialog).toBeHidden();

    // A transaction-only edit creates no rule at all.
    expect(await storedCount(page, 'merchantRules')).toBe(0);
  });

  test('creates the transaction change and the rule as one action', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    const dialog = await openReviewFor(page, 'HARBOR BEAN COFFEE');
    await dialog.getByLabel('Category').selectOption('groceries');
    await dialog.getByLabel(/also create a rule/i).check();
    await expect(dialog.getByText(/future imports only/i)).toBeVisible();
    await dialog.getByRole('button', { name: /save and create rule/i }).click();
    await expect(dialog).toBeHidden();

    expect(await storedCount(page, 'merchantRules')).toBe(1);

    const stored = await storedTransactions(page);
    expect(stored.find((row) => row.id === 'buy-harbor')?.categoryId).toBe('groceries');
    // The rule is for the future: no other row was rewritten.
    expect(stored.find((row) => row.id === 'buy-pinebrook')?.categoryId).toBe('other');
  });

  test('cancels on Escape and restores focus to the control that opened it', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByLabel('Search').fill('PINEBROOK MARKET');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    const opener = reviewButtons(page).first();
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Category').selectOption('travel');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Focus comes back, and Escape never saves.
    await expect(opener).toBeFocused();
    const stored = await storedTransactions(page);
    expect(stored.find((row) => row.id === 'buy-pinebrook')?.categoryId).toBe('other');
  });
});

/* --------------------------------------------------------------- bulk - */

test.describe('bulk editing', () => {
  test('selects only the visible page and undoes the whole change at once', async ({ page }) => {
    await seedWorkspace(page, [...reviewFixture(), ...fillerRows(60)]);
    await gotoTransactions(page);
    await expect(page.getByText('74 transactions')).toBeVisible();

    await page.getByRole('checkbox', { name: /select every transaction on this page/i }).check();
    // 74 rows in the workspace, 50 on this page. §7 forbids silently selecting
    // every filtered row.
    await expect(page.getByText('50 selected on this page')).toBeVisible();

    await page.getByLabel(/set category for selected/i).selectOption('travel');
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /apply change/i }).click();

    await expect(page.getByRole('button', { name: /undo last change/i })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).filter((row) => row.categoryId === 'travel').length,
      )
      .toBe(50);

    // One bulk command is one undo unit.
    await page.getByRole('button', { name: /undo last change/i }).click();
    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).filter((row) => row.categoryId === 'travel').length,
      )
      .toBe(0);
  });

  test('loses undo on reload while the edits themselves survive', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByRole('checkbox', { name: /select every transaction on this page/i }).check();
    await page.getByLabel(/set category for selected/i).selectOption('travel');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /apply change/i })
      .click();

    const undo = page.getByRole('button', { name: /undo last change/i });
    await expect(undo).toBeVisible();
    await expect(page.getByText(/until you reload this page/i)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();

    // The promise the interface makes: the change is permanent, the undo is not.
    await expect(page.getByRole('button', { name: /undo last change/i })).toHaveCount(0);
    expect(
      (await storedTransactions(page)).filter((row) => row.categoryId === 'travel'),
    ).toHaveLength(14);
  });
});

/* --------------------------------------------------------------- rules - */

test.describe('the rule manager', () => {
  test('creates, edits, and deletes a rule without touching transactions', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { level: 2, name: /^merchant rules$/i })).toBeVisible();

    const manager = page.getByRole('region', { name: /^merchant rules$/i });

    // --- create -----------------------------------------------------------
    await manager.getByRole('button', { name: /create a rule/i }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel(/pattern to match/i).fill('PINEBROOK MARKET');
    await dialog.getByLabel(/set the category to/i).selectOption('groceries');
    await dialog.getByRole('button', { name: /count matching transactions/i }).click();
    await expect(dialog.getByText(/1 match/i)).toBeVisible();
    await dialog.getByRole('button', { name: /^create rule$/i }).click();

    // Creating a rule now asks whether to apply it to the row it already
    // matches (category-rules.md §5.3). Declining leaves history alone.
    const offer = page.getByRole('dialog');
    await expect(offer).toContainText(/matches 1 transaction already stored/i);
    await offer.getByRole('button', { name: /not now/i }).click();
    await expect(offer).toBeHidden();

    await expect(page.getByRole('status')).toContainText(/rule saved/i);
    expect(await storedCount(page, 'merchantRules')).toBe(1);

    // --- edit -------------------------------------------------------------
    await manager.getByRole('button', { name: /edit the rule for PINEBROOK MARKET/i }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel(/set the category to/i).selectOption('dining');
    await dialog.getByRole('button', { name: /save changes/i }).click();
    await expect(dialog).toBeHidden();

    await expect.poll(async () => storedCount(page, 'merchantRules')).toBe(1);
    await expect(manager.getByText('Dining')).toBeVisible();

    // --- delete -----------------------------------------------------------
    await manager.getByRole('button', { name: /delete the rule for PINEBROOK MARKET/i }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(/your transactions are not affected/i)).toBeVisible();
    await confirm.getByRole('button', { name: /delete rule/i }).click();

    await expect.poll(async () => storedCount(page, 'merchantRules')).toBe(0);

    // Deleting a rule never deletes, reverts, or recategorizes a transaction.
    const stored = await storedTransactions(page);
    expect(stored).toHaveLength(14);
    expect(stored.find((row) => row.id === 'buy-pinebrook')?.categoryId).toBe('other');
  });

  test('applies a rule to stored transactions only when explicitly confirmed', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/settings');
    const manager = page.getByRole('region', { name: /^merchant rules$/i });
    await expect(manager).toBeVisible();

    await manager.getByRole('button', { name: /create a rule/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/pattern to match/i).fill('PINEBROOK MARKET');
    await dialog.getByLabel(/set the category to/i).selectOption('groceries');
    await dialog.getByRole('button', { name: /^create rule$/i }).click();

    // category-rules.md §5.3: the count and the retroactive choice are offered
    // as soon as the rule is created.
    const offer = page.getByRole('dialog');
    await expect(offer).toContainText(/matches 1 transaction already stored/i);
    await expect(offer).toContainText(/those transactions will change/i);

    // Declining leaves history exactly as it was.
    await offer.getByRole('button', { name: /not now/i }).click();
    await expect(offer).toBeHidden();
    expect(
      (await storedTransactions(page)).find((row) => row.id === 'buy-pinebrook')?.categoryId,
    ).toBe('other');

    // Confirming is the one action that rewrites stored rows.
    await manager.getByRole('button', { name: /^apply the rule for/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /apply to existing transactions/i })
      .click();

    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).find((row) => row.id === 'buy-pinebrook')?.categoryId,
      )
      .toBe('groceries');

    // One command, one undo entry, and it really reverses.
    await manager.getByRole('button', { name: /undo last change/i }).click();
    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).find((row) => row.id === 'buy-pinebrook')?.categoryId,
      )
      .toBe('other');
  });

  test('refuses a rule that would change nothing', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/settings');
    const manager = page.getByRole('region', { name: /^merchant rules$/i });
    await manager.getByRole('button', { name: /create a rule/i }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/pattern to match/i).fill('PINEBROOK MARKET');

    await expect(dialog.getByText(/has to change something/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^create rule$/i })).toBeDisabled();
    expect(await storedCount(page, 'merchantRules')).toBe(0);
  });
});

/* ------------------------------------------------------- relationships - */

test.describe('reviewing possible links', () => {
  test('is reachable from the transactions page', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await page.getByRole('link', { name: /review links/i }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/app\/transactions\/relationships$/);
  });

  test('shows suggestions without writing anything', async ({ page }) => {
    await seedWorkspace(page);
    const before = await storedTransactions(page);

    await page.goto('/app/transactions/relationships');
    await expect(page.getByText(/possible pairs?$/i).first()).toBeVisible();
    await expect(page.getByText(/suggestions, not conclusions/i).first()).toBeVisible();

    // Looking at a suggestion must leave the workspace byte-identical.
    expect(await storedTransactions(page)).toEqual(before);
    expect(await storedCount(page, 'transactionLinks')).toBe(0);
  });

  test('confirms a transfer, then unlinks it again', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const transfers = page.getByRole('region', { name: /possible transfers and card payments/i });
    await expect(transfers.getByText('2 possible pairs')).toBeVisible();

    // The 20,000-cent checking/savings pair is the transfer.
    const pair = transfers.getByRole('listitem').filter({ hasText: 'TRANSFER TO SAVINGS' });
    await expect(pair.getByLabel(/treat them as/i)).toHaveValue('transfer');
    await pair.getByRole('button', { name: /link these two/i }).click();

    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(/never counted as spending/i)).toBeVisible();
    await confirm.getByRole('button', { name: /^link them$/i }).click();

    await expect.poll(async () => storedCount(page, 'transactionLinks')).toBe(1);
    const linked = await storedTransactions(page);
    expect(linked.find((row) => row.id === 't-out')?.kind).toBe('transfer');
    expect(linked.find((row) => row.id === 't-in')?.kind).toBe('transfer');

    // --- unlink -----------------------------------------------------------
    const confirmedSection = page.getByRole('region', { name: /links you have confirmed/i });
    await expect(confirmedSection.getByText(/confirmed transfer/i)).toBeVisible();
    await confirmedSection.getByRole('button', { name: /unlink these/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^unlink$/i })
      .click();

    await expect.poll(async () => storedCount(page, 'transactionLinks')).toBe(0);
    // Unlinking removes the pairing, not the classification.
    const afterUnlink = await storedTransactions(page);
    expect(afterUnlink.find((row) => row.id === 't-out')?.kind).toBe('transfer');
  });

  test('confirms a card payment and undoes it as one unit', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const transfers = page.getByRole('region', { name: /possible transfers and card payments/i });
    const pair = transfers.getByRole('listitem').filter({ hasText: 'REWARDS CARD PAYMENT' });
    // A credit card is involved, so a card payment is what is proposed.
    await expect(pair.getByLabel(/treat them as/i)).toHaveValue('payment');

    await pair.getByRole('button', { name: /link these two/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^link them$/i })
      .click();

    await expect.poll(async () => storedCount(page, 'transactionLinks')).toBe(1);
    expect((await storedTransactions(page)).find((row) => row.id === 'p-out')?.kind).toBe(
      'payment',
    );

    await page.getByRole('button', { name: /undo last change/i }).click();
    await expect.poll(async () => storedCount(page, 'transactionLinks')).toBe(0);
    expect((await storedTransactions(page)).find((row) => row.id === 'p-out')?.kind).toBe(
      'purchase',
    );
  });

  test('confirms a refund, which inherits the purchase fields and stays a refund', async ({
    page,
  }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const refunds = page.getByRole('region', { name: /^possible refunds$/i });
    await expect(refunds.getByText(/2 refunds with a matching purchase/i)).toBeVisible();

    const group = refunds.getByRole('listitem').filter({ hasText: 'QUILL AND PAGE BOOKS' }).first();
    await group
      .getByRole('button', { name: /this is the purchase/i })
      .first()
      .click();

    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(/stays a refund/i)).toBeVisible();
    await confirm.getByRole('button', { name: /^link them$/i }).click();

    await expect.poll(async () => storedCount(page, 'transactionLinks')).toBe(1);
    const stored = await storedTransactions(page);
    const refund = stored.find((row) => row.id === 'r-refund');
    // Inherits the purchase's reviewed category, and is still visibly a refund.
    expect(refund?.categoryId).toBe('shopping');
    expect(refund?.kind).toBe('refund');

    // --- unlink -----------------------------------------------------------
    const confirmedSection = page.getByRole('region', { name: /links you have confirmed/i });
    await confirmedSection.getByRole('button', { name: /unlink these/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^unlink$/i })
      .click();
    await expect.poll(async () => storedCount(page, 'transactionLinks')).toBe(0);
  });

  test('shows an ambiguous refund as ambiguous rather than guessing', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const refunds = page.getByRole('region', { name: /^possible refunds$/i });
    const ambiguous = refunds
      .getByRole('listitem')
      .filter({ hasText: 'GREENLEAF GROCERS' })
      .first();

    await expect(ambiguous.getByText(/more than one purchase fits/i)).toBeVisible();
    await expect(ambiguous.getByText(/2 possible purchases/i)).toBeVisible();
  });

  test('offers a manual decision for a credit nothing matches', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const refunds = page.getByRole('region', { name: /^possible refunds$/i });
    await expect(refunds.getByText(/1 credit with no matching purchase/i)).toBeVisible();
    await refunds.getByRole('button', { name: /review this transaction/i }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Kind').selectOption('income');
    await dialog.getByRole('button', { name: /save this transaction/i }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).find((row) => row.id === 'orphan-credit')?.kind,
      )
      .toBe('income');
    // Editing by hand never invents a relationship.
    expect(await storedCount(page, 'transactionLinks')).toBe(0);
  });
});

/* -------------------------------------------------------------- export - */

test.describe('exporting a cleaned CSV', () => {
  test('downloads every transaction, with hostile cells neutralized', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByRole('button', { name: /export csv/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/nothing is uploaded/i)).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /download csv/i }).click();
    const download = await downloadPromise;

    // A filename carrying no personal value.
    expect(download.suggestedFilename()).toMatch(
      /^tri-state-spending-lens-transactions-\d{4}-\d{2}-\d{2}\.csv$/,
    );

    const csv = readFileSync(await download.path(), 'utf8');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(15); // header + 14 rows
    expect(csv).toContain('Posted date,Account,Raw description');
    expect(csv).toContain('PINEBROOK MARKET');
    // The formula trigger is neutralized, so a spreadsheet reads it as text.
    expect(csv).toContain("'=cmd|/c calc");
    expect(csv).not.toMatch(/,=cmd\|/);
    // Integer cents survive as a decimal string, with the sign from direction.
    expect(csv).toContain('-12.34');
  });

  test('downloads only the filtered rows', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    // No filter, no filtered-export control.
    await expect(page.getByRole('button', { name: /export these .* results/i })).toHaveCount(0);

    await page.getByLabel('Category').selectOption('dining');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /export this 1 result/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/matching your current filters/i)).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /download csv/i }).click();
    const csv = readFileSync(await (await downloadPromise).path(), 'utf8');

    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2); // header + 1 row
    expect(csv).toContain('HARBOR BEAN COFFEE');
    expect(csv).not.toContain('PINEBROOK MARKET');
  });
});

/* ------------------------------------------------------- keyboard, mobile - */

test.describe('keyboard operation', () => {
  test('completes an edit without a mouse', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByLabel('Search').fill('PINEBROOK MARKET');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    const opener = reviewButtons(page).first();
    await opener.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Cancel takes focus on open, so a stray Enter dismisses rather than saves.
    await expect(dialog.getByRole('button', { name: /^cancel$/i })).toBeFocused();

    await dialog.getByLabel('Category').selectOption('groceries');
    const save = dialog.getByRole('button', { name: /save this transaction/i });
    await save.focus();
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).find((row) => row.id === 'buy-pinebrook')?.categoryId,
      )
      .toBe('groceries');
  });
});

test.describe('phone-width operation', () => {
  test.skip(({ isMobile }) => !isMobile, 'covers the narrow-viewport layout only');

  test('completes the essential review flow on a phone', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    // The desktop table is gone from the accessibility tree at this width.
    await expect(page.getByRole('table')).toHaveCount(0);

    const dialog = await openReviewFor(page, 'PINEBROOK MARKET');
    await dialog.getByLabel('Category').selectOption('groceries');
    await dialog.getByRole('button', { name: /save this transaction/i }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).find((row) => row.id === 'buy-pinebrook')?.categoryId,
      )
      .toBe('groceries');
  });

  test('never scrolls sideways on the review surfaces', async ({ page }) => {
    await seedWorkspace(page);

    for (const route of ['/app/transactions', '/app/transactions/relationships', '/app/settings']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${route} overflows horizontally`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------- lifecycle - */

test.describe('lifecycle', () => {
  test('leaves the row whole when a full reload interrupts a save', async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));

    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    const dialog = await openReviewFor(page, 'PINEBROOK MARKET');
    await dialog.getByLabel('Category').selectOption('groceries');
    await dialog.getByRole('button', { name: /save this transaction/i }).dispatchEvent('click');

    // A hard navigation tears the document down. Whether the IndexedDB
    // transaction had already committed is a genuine race, so this deliberately
    // does *not* assert that the edit survived — nothing can promise that. What
    // must hold either way is that the row is not left half-written.
    await page.goto('/app/overview');
    await expect(page.getByRole('heading', { level: 1, name: /^overview$/i })).toBeVisible();

    await gotoTransactions(page);
    const row = (await storedTransactions(page)).find((entry) => entry.id === 'buy-pinebrook')!;
    const edits = await storedUserEdits(page);
    const categoryEdits = edits.filter(
      (edit) => edit.entityId === 'buy-pinebrook' && edit.field === 'categoryId',
    );

    if (row.categoryId === 'groceries') {
      // Committed: the whole command landed, audit entry included.
      expect(row.categorySource).toBe('user');
      expect(categoryEdits).toHaveLength(1);
    } else {
      // Aborted: nothing at all was written.
      expect(row.categoryId).toBe('other');
      expect(row.categorySource).toBe('uncategorized');
      expect(row.updatedAt).toBe('2026-08-01T12:00:00.000Z');
      expect(categoryEdits).toHaveLength(0);
    }

    // Source information is untouched on either path.
    expect(row.descriptionRaw).toBe('PINEBROOK MARKET #114');
    expect(row.amountCents).toBe(1234);
    expect(crashes).toEqual([]);
  });

  test('completes a pending write when in-app navigation unmounts the page', async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));

    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByRole('checkbox', { name: /select every transaction on this page/i }).check();
    await page.getByLabel(/set category for selected/i).selectOption('travel');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /apply change/i })
      .click();

    // Client-side routing, not a reload: the component unmounts but the
    // document — and the open database connection — survive. Here the write is
    // genuinely guaranteed to land, and the unmounted page must not crash
    // trying to render its result.
    await page.getByRole('link', { name: /review links/i }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();

    await expect
      .poll(
        async () =>
          (await storedTransactions(page)).filter((row) => row.categoryId === 'travel').length,
      )
      .toBe(14);
    expect(crashes).toEqual([]);
  });

  test('keeps a created rule across a reload, still without touching history', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/settings');
    const manager = page.getByRole('region', { name: /^merchant rules$/i });

    await manager.getByRole('button', { name: /create a rule/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/pattern to match/i).fill('HARBOR BEAN COFFEE');
    await dialog.getByLabel(/set the category to/i).selectOption('groceries');
    await dialog.getByRole('button', { name: /^create rule$/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /not now/i })
      .click();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /^settings$/i })).toBeVisible();

    // The rule is really persisted, and history is still untouched.
    await expect(manager.getByText(/1 rule, listed in the order they apply/i)).toBeVisible();
    expect(await storedCount(page, 'merchantRules')).toBe(1);
    expect(
      (await storedTransactions(page)).find((row) => row.id === 'buy-harbor')?.categoryId,
    ).toBe('dining');
  });

  test('keeps a confirmed relationship across a reload', async ({ page }) => {
    await seedWorkspace(page);
    await page.goto('/app/transactions/relationships');

    const transfers = page.getByRole('region', { name: /possible transfers and card payments/i });
    const pair = transfers.getByRole('listitem').filter({ hasText: 'TRANSFER TO SAVINGS' });
    await pair.getByRole('button', { name: /link these two/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^link them$/i })
      .click();
    await expect.poll(async () => storedCount(page, 'transactionLinks')).toBe(1);

    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();

    // The link and both kind changes survived; only the undo did not.
    await expect(page.getByRole('region', { name: /links you have confirmed/i })).toBeVisible();
    expect(await storedCount(page, 'transactionLinks')).toBe(1);
    const rows = await storedTransactions(page);
    expect(rows.find((row) => row.id === 't-out')?.kind).toBe('transfer');
    expect(rows.find((row) => row.id === 't-in')?.kind).toBe('transfer');
    await expect(page.getByRole('button', { name: /undo last change/i })).toHaveCount(0);
  });

  test('returns to a clean review page after leaving and coming back', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await page.getByLabel('Search').fill('PINEBROOK');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    await page.goto('/app/overview');
    await gotoTransactions(page);

    // Filters are transient by construction: nothing persisted them.
    await expect(page.getByLabel('Search')).toHaveValue('');
    await expect(page.getByText('14 transactions')).toBeVisible();
  });
});

/* --------------------------------------------------------------- privacy - */

test.describe('the privacy boundary', () => {
  test('sends nothing anywhere while the whole review flow runs', async ({ page }) => {
    const offending: string[] = [];
    const markers = ['PINEBROOK', 'HARBOR BEAN', 'QUILL AND PAGE', 'GREENLEAF', 'buy-pinebrook'];

    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://localhost:4173')) offending.push(`external request: ${url}`);

      const body = request.postData() ?? '';
      for (const marker of markers) {
        if (url.includes(marker) || body.includes(marker)) {
          offending.push(`${request.method()} carried "${marker}"`);
        }
      }
    });

    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByLabel('Search').fill('PINEBROOK');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    const dialog = page.getByRole('dialog');
    await reviewButtons(page).first().click();
    await dialog.getByLabel('Category').selectOption('groceries');
    await dialog.getByRole('button', { name: /save this transaction/i }).click();
    await expect(dialog).toBeHidden();

    await page.goto('/app/transactions/relationships');
    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();

    expect(offending).toEqual([]);
  });

  test('keeps personal values out of the URL and the document title', async ({ page }) => {
    await seedWorkspace(page);
    await gotoTransactions(page);
    await page.getByLabel('Search').fill('PINEBROOK MARKET');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    // A merchant name must never reach a browser history entry.
    await expect(page).toHaveTitle('Transactions · Tri-State Spending Lens');
    expect(page.url()).not.toMatch(/PINEBROOK|HARBOR|QUILL/i);

    await page.goto('/app/transactions/relationships');
    await expect(page).toHaveTitle('Linked transactions · Tri-State Spending Lens');
    expect(page.url()).not.toMatch(/PINEBROOK|HARBOR|QUILL/i);
  });

  test('logs nothing to the console during the review flow', async ({ page }) => {
    const noise: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        noise.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));

    await seedWorkspace(page);
    await gotoTransactions(page);
    await expect(page.getByText('14 transactions')).toBeVisible();

    await page.getByLabel('Search').fill('PINEBROOK');
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();
    await page.getByLabel('Search').fill('');

    await page.goto('/app/transactions/relationships');
    await expect(
      page.getByRole('heading', { level: 1, name: /^linked transactions$/i }),
    ).toBeVisible();

    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { level: 2, name: /^merchant rules$/i })).toBeVisible();

    expect(noise).toEqual([]);
  });
});
