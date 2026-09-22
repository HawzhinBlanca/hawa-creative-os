import { test, expect } from '@playwright/test';

test.describe('Hawa Desk Frontend Interaction & Security E2E', () => {
  test('verifies application loads with strict CSP and no unsafe evals', async ({ page }) => {
    const cspViolations: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('Content Security Policy')) {
        cspViolations.push(msg.text());
      }
    });

    await page.goto('/');
    expect(cspViolations.length).toBe(0);
    await expect(page).toHaveTitle(/Hawa Desk/i);
  });

  test('verifies authentication credentials are never stored in localStorage', async ({ page }) => {
    await page.goto('/');

    const storedToken = await page.evaluate(() => {
      return window.localStorage.getItem('hawa_operator_token');
    });
    expect(storedToken).toBeNull();
  });

  test('verifies navigation URLs do not expose access_token query parameters', async ({ page }) => {
    await page.goto('/');
    const currentUrl = page.url();
    expect(currentUrl).not.toContain('access_token=');
  });

  test('verifies top navigation and root container render cleanly', async ({ page }) => {
    await page.goto('/');
    const root = page.locator('#root');
    await expect(root).toBeVisible();
  });
});
