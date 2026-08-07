import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The import wizard end to end, in a real browser.
 *
 * This is the only place the wizard runs against the **real** Web Worker and a
 * real IndexedDB. The component tests fake the worker transport to drive the
 * flow deterministically; this proves the same flow works with the genuine one.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function blocking(violations: Array<{ id: string; impact?: string | null; nodes: unknown[] }>) {
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

const CSV = [
  'Date,Description,Amount,Memo',
  '2026-04-08,PINEBROOK MARKET,-12.34,MEMO-NEVER-STORED',
  '2026-04-09,GARDEN STATE FUEL,-40.00,MEMO-NEVER-STORED',
  '2026-04-10,PAYROLL DEPOSIT,1500.00,MEMO-NEVER-STORED',
].join('\n');

async function stageFile(page: Page, name = 'statement.csv', contents = CSV) {
  await page.goto('/import');
  await page
    .getByLabel(/choose csv files/i)
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(contents, 'utf8') });
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
}

/** Clicks Continue once it is enabled. */
async function next(page: Page) {
  const button = page.getByRole('button', { name: 'Continue' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
}

/**
 * Advances with the keyboard.
 *
 * Order matters: wait for enabled, *then* focus, *then* press. Focusing first
 * can land on a still-disabled button — the wizard keeps Continue disabled
 * while a file is being read — and the keypress is then silently lost.
 */
async function keyboardNext(page: Page) {
  const button = page.getByRole('button', { name: 'Continue' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
}

/** Steps 1 to 4, ending with the wizard ready to normalize. */
async function completeSetup(page: Page) {
  await next(page); // step 1 -> 2

  await expect(page.getByRole('heading', { name: /Step 2 of 6/i })).toBeVisible();
  await expect(page.getByLabel('Delimiter', { exact: true })).toBeVisible({ timeout: 15_000 });
  await next(page);

  await expect(page.getByRole('heading', { name: /Step 3 of 6/i })).toBeVisible();
  await page.getByLabel('Date column', { exact: true }).selectOption('0');
  await page.getByLabel('Description column', { exact: true }).selectOption('1');
  await page.getByLabel('Amount column', { exact: true }).selectOption('2');
  await next(page);

  await expect(page.getByRole('heading', { name: /Step 4 of 6/i })).toBeVisible();
  await page.getByRole('button', { name: /create a new account/i }).click();
  await page.getByLabel('Account name', { exact: true }).fill('Everyday Checking');
  await page.getByRole('button', { name: /stage this account/i }).click();
  await page.getByLabel(/year first/i).check();
  await next(page);
}

test.describe('the import wizard', () => {
  test('imports a CSV end to end through the real worker', async ({ page }) => {
    await stageFile(page);
    await completeSetup(page);

    await expect(page.getByRole('heading', { name: /Step 5 of 6/i })).toBeVisible();
    await expect(page.getByText('Rows read')).toBeVisible({ timeout: 20_000 });
    await next(page);

    await expect(page.getByRole('heading', { name: /Step 6 of 6/i })).toBeVisible();
    await expect(page.getByText(/3 rows read = 3 imported \+ 0 not imported/i)).toBeVisible();

    await page.getByRole('button', { name: /import 3 transactions/i }).click();
    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 20_000 });

    // The rows really are in this browser's database.
    const stored = await page.evaluate(async () => {
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
      return rows as Array<{ descriptionRaw: string; kind: string; amountCents: number }>;
    });

    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.descriptionRaw).sort()).toEqual([
      'GARDEN STATE FUEL',
      'PAYROLL DEPOSIT',
      'PINEBROOK MARKET',
    ]);
    // Debits default to purchase, credits to unknown.
    expect(stored.find((row) => row.descriptionRaw === 'PINEBROOK MARKET')?.kind).toBe('purchase');
    expect(stored.find((row) => row.descriptionRaw === 'PAYROLL DEPOSIT')?.kind).toBe('unknown');

    // Nothing from the unmapped column reached storage.
    expect(JSON.stringify(stored)).not.toContain('MEMO-NEVER-STORED');
  });

  test('appears in history and can be rolled back', async ({ page }) => {
    await stageFile(page);
    await completeSetup(page);
    await expect(page.getByText('Rows read')).toBeVisible({ timeout: 20_000 });
    await next(page);
    await page.getByRole('button', { name: /import 3 transactions/i }).click();
    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 20_000 });

    const history = page.getByRole('region', { name: /import history/i });
    await expect(history.getByText('statement.csv')).toBeVisible();

    await history
      .getByRole('button', { name: /roll back/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /remove 3 transactions/i }).click();

    await expect(page.getByText(/removed 3 transactions/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/no imports yet/i)).toBeVisible();
  });

  test('never sends any part of the file anywhere', async ({ page }) => {
    const bodies: string[] = [];
    const urls: string[] = [];

    page.on('request', (request) => {
      urls.push(request.url());
      const body = request.postData();
      if (body) bodies.push(body);
    });

    const consoleText: string[] = [];
    page.on('console', (message) => consoleText.push(message.text()));

    await stageFile(page);
    await completeSetup(page);
    await expect(page.getByText('Rows read')).toBeVisible({ timeout: 20_000 });
    await next(page);
    await page.getByRole('button', { name: /import 3 transactions/i }).click();
    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 20_000 });

    const offSite = urls.filter((url) => !url.startsWith(page.url().split('/import')[0]!));
    expect(offSite).toEqual([]);

    for (const value of ['PINEBROOK', 'PAYROLL', '1500.00', 'MEMO-NEVER-STORED', 'statement.csv']) {
      expect(urls.join(' ')).not.toContain(value);
      expect(bodies.join(' ')).not.toContain(value);
      expect(consoleText.join(' ')).not.toContain(value);
      expect(await page.title()).not.toContain(value);
    }

    expect(page.url()).not.toContain('PINEBROOK');
  });

  test('can be completed with the keyboard alone', async ({ page }) => {
    // The file input still needs a programmatic set — a browser will not let a
    // script open the picker — but every step after it is driven by keys.
    await stageFile(page);

    await keyboardNext(page);
    await expect(page.getByRole('heading', { name: /Step 2 of 6/i })).toBeVisible();
    await expect(page.getByLabel('Delimiter', { exact: true })).toBeVisible({ timeout: 20_000 });

    await keyboardNext(page);
    await expect(page.getByRole('heading', { name: /Step 3 of 6/i })).toBeVisible();
    await page.getByLabel('Date column', { exact: true }).selectOption('0');
    await page.getByLabel('Description column', { exact: true }).selectOption('1');
    await page.getByLabel('Amount column', { exact: true }).selectOption('2');

    await keyboardNext(page);
    await expect(page.getByRole('heading', { name: /Step 4 of 6/i })).toBeVisible();

    const createAccount = page.getByRole('button', { name: /create a new account/i });
    await createAccount.focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Account name', { exact: true }).focus();
    await page.keyboard.type('Keyboard Account');
    const stage = page.getByRole('button', { name: /stage this account/i });
    await expect(stage).toBeEnabled();
    await stage.focus();
    await page.keyboard.press('Enter');
    await page.getByLabel(/year first/i).focus();
    await page.keyboard.press('Space');
    await expect(page.getByLabel(/year first/i)).toBeChecked();

    await keyboardNext(page);
    await expect(page.getByText('Rows read')).toBeVisible({ timeout: 25_000 });

    await keyboardNext(page);
    await expect(page.getByRole('heading', { name: /Step 6 of 6/i })).toBeVisible();

    const commit = page.getByRole('button', { name: /import 3 transactions/i });
    await expect(commit).toBeEnabled();
    await commit.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 25_000 });
  });

  test('a confirmation dialog traps focus and Escape cancels rather than confirms', async ({
    page,
  }) => {
    await stageFile(page);
    await completeSetup(page);
    await expect(page.getByText('Rows read')).toBeVisible({ timeout: 20_000 });
    await next(page);
    await page.getByRole('button', { name: /import 3 transactions/i }).click();
    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 20_000 });

    await page
      .getByRole('button', { name: /roll back/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Cancel holds focus on open, so a stray Enter dismisses rather than
    // destroying data.
    await expect(dialog.getByRole('button', { name: /^cancel$/i })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Escape cancelled: the import is still there.
    await expect(page.getByText(/no imports yet/i)).toBeHidden();
  });

  test('has no serious or critical accessibility violations at any step', async ({ page }) => {
    await stageFile(page);

    const atStep = async () => {
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(blocking(results.violations)).toEqual([]);
    };

    await atStep();
    await next(page);
    await expect(page.getByLabel('Delimiter', { exact: true })).toBeVisible({ timeout: 15_000 });
    await atStep();

    await next(page);
    await page.getByLabel('Date column', { exact: true }).selectOption('0');
    await page.getByLabel('Description column', { exact: true }).selectOption('1');
    await page.getByLabel('Amount column', { exact: true }).selectOption('2');
    await atStep();

    await next(page);
    await page.getByRole('button', { name: /create a new account/i }).click();
    await page.getByLabel('Account name', { exact: true }).fill('Everyday Checking');
    await page.getByRole('button', { name: /stage this account/i }).click();
    await page.getByLabel(/year first/i).check();
    await atStep();

    await next(page);
    await expect(page.getByText('Rows read')).toBeVisible({ timeout: 20_000 });
    await atStep();

    await next(page);
    await expect(page.getByRole('heading', { name: /Step 6 of 6/i })).toBeVisible();
    await atStep();
  });

  test('never scrolls the page sideways while working through the wizard', async ({ page }) => {
    await stageFile(page);
    await completeSetup(page);
    await expect(page.getByText('Rows read')).toBeVisible({ timeout: 20_000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // A wide preview table scrolls inside its own container, never the page.
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('refuses a file that is not a CSV, with a fixed message', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel(/choose csv files/i).setInputFiles({
      name: 'statement.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4', 'utf8'),
    });

    await expect(page.getByText(/only \.csv files can be imported/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});
