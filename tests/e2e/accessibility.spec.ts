import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ROUTES } from './routes';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Automated accessibility testing must find no serious or critical violations
 * (product-spec.md §10.5). Lower-impact findings are reported in the failure
 * message when they occur alongside a real one, but do not fail the build on
 * their own — automated checks cannot see everything, and treating every
 * minor advisory as a blocker trains people to ignore the suite.
 */
function blocking(violations: Array<{ id: string; impact?: string | null; nodes: unknown[] }>) {
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test.describe('accessibility', () => {
  for (const route of ROUTES) {
    test(`${route.path} has no serious or critical violations`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = blocking(results.violations);

      expect(
        serious,
        serious.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} nodes)`).join('\n'),
      ).toEqual([]);
    });
  }

  test('the not-found page is accessible too', async ({ page }) => {
    await page.goto('/definitely-not-a-page');
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(blocking(results.violations)).toEqual([]);
  });

  test('the open mobile menu is accessible', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the menu only opens at narrow widths');

    await page.goto('/');
    await page.getByRole('button', { name: /menu/i }).click();
    await expect(page.getByRole('navigation', { name: 'All sections' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(blocking(results.violations)).toEqual([]);
  });
});
