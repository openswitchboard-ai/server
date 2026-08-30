/**
 * Gate (e): PROD registration stays CLOSED. The counter code paths deploy to
 * prod, but the create-account door is shut behind the launch flag.
 * Run only when the prod deploy has landed:
 *   OSB_CHECK_PROD=1 npx playwright test test/e2e/prod.spec.ts
 */
import { test, expect } from '@playwright/test';

const PROD_COUNTER = 'https://counter.openswitchboard.ai';
const PROD_MCP = 'https://mcp.openswitchboard.ai';

test.skip(process.env.OSB_CHECK_PROD !== '1', 'prod gate runs post-deploy (OSB_CHECK_PROD=1)');

test('prod /counter/register shows the closed page (GET)', async ({ page }) => {
  await page.goto(`${PROD_COUNTER}/counter/register`);
  await expect(page.getByRole('heading', { name: 'Registration opens at launch.' })).toBeVisible();
  await expect(page.locator('input[type=email]')).toHaveCount(0);
  await page.screenshot({ path: 'e2e-screenshots/19-prod-register-closed.png', fullPage: true });
});

test('prod /counter/register POST refuses to create anything', async () => {
  const res = await fetch(`${PROD_COUNTER}/counter/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'door-check@example.com' }).toString(),
  });
  const body = await res.text();
  expect(body).toContain('Registration opens at launch');
  expect(body).not.toContain('verification_id'); // no code page, no verification row
});

test('prod /oauth/authorize is still the closed page', async () => {
  const res = await fetch(`${PROD_MCP}/oauth/authorize?client_id=x`, { redirect: 'manual' });
  expect(res.status).toBe(200); // no hand-off redirect in prod
  const body = await res.text();
  expect(body).toContain('Registration opens at launch');
});
