import { expect, test } from '@playwright/test';
import { ROUTES } from './routes';

test.describe('route smoke', () => {
  for (const route of ROUTES) {
    test(`${route.path} loads with its heading and title`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      await expect(page).toHaveTitle(route.title);
    });
  }

  test('an unknown address shows the not-found page rather than a blank screen', async ({
    page,
  }) => {
    await page.goto('/definitely-not-a-page');
    await expect(page.getByRole('heading', { level: 1, name: /page not found/i })).toBeVisible();
  });

  test('deep links work on a full page load, not only on client navigation', async ({ page }) => {
    const response = await page.goto('/app/recurring');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: /recurring charges/i })).toBeVisible();
  });
});

test.describe('desktop navigation', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'covers the wide-viewport navigation only');

  test('moves between sections without a full page reload', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });

    await nav.getByRole('link', { name: 'Transactions' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^transactions$/i })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/transactions$/);

    await nav.getByRole('link', { name: 'Budget' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^budget$/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Budget' })).toHaveAttribute('aria-current', 'page');
  });

  test('shows the full navigation and hides the mobile toggle', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: /menu/i })).toBeHidden();

    const header = page.getByRole('banner');
    await expect(header.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Import' })).toBeVisible();
  });

  test('the skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const skip = page.getByRole('link', { name: /skip to main content/i });
    await expect(skip).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });
});

test.describe('mobile navigation', () => {
  test.skip(({ isMobile }) => !isMobile, 'covers the narrow-viewport navigation only');

  test('opens the menu, navigates, and closes itself again', async ({ page }) => {
    await page.goto('/');

    const toggle = page.getByRole('button', { name: /menu/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const panel = page.getByRole('navigation', { name: 'All sections' });
    await expect(panel).toBeVisible();

    await panel.getByRole('link', { name: /insights/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^insights$/i })).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('collapses the desktop navigation and the header utility links', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
    await expect(page.getByRole('button', { name: /menu/i })).toBeVisible();

    // The Settings icon link belongs to the wide layout; at phone width it
    // lives in the menu panel instead.
    await expect(page.getByRole('banner').getByRole('link', { name: 'Settings' })).toBeHidden();
  });

  test('Escape closes the menu', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /menu/i });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('the page never scrolls sideways at phone width', async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route.path);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${route.path} overflows horizontally`).toBe(false);
    }
  });
});
