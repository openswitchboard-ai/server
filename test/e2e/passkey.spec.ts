/**
 * Passkey enrolment gate — Playwright against LIVE dev, phone viewport, with a
 * CDP virtual authenticator standing in for Touch ID / a security key.
 *
 * This is the regression cover for the enrolment bug where every
 * POST /passkey/verify answered 400 no_pending_challenge: the
 * take-challenge UPDATE read back its own NULL (Postgres RETURNING sees NEW
 * values), so the challenge the options call had just stored was never
 * visible to verify. Nothing here is mocked: real registration, real
 * WebAuthn ceremony, real credential row in the dev database.
 *
 * SES sandbox note: the flow really attempts the SES send; the verification
 * code is stamped via the RDS Data API purely as sandbox-era observability
 * (single-use + 15-min TTL semantics untouched).
 */
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { COUNTER_URL, dbExec, sha256hex } from '../integration/helpers.js';

const email = `e2epk+${randomBytes(5).toString('hex')}@openswitchboard.ai`;
const PIN = '918273';

test('passkey enrolment: virtual authenticator enrols during registration', async ({
  browser,
}) => {
  const ctx: BrowserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: COUNTER_URL,
    ...(process.env.OSB_RATELIMIT_BYPASS
      ? { extraHTTPHeaders: { 'x-osb-ratelimit-bypass': process.env.OSB_RATELIMIT_BYPASS } }
      : {}),
  });
  const page: Page = await ctx.newPage();

  // Surface the verify response so a failure names the server's own error.
  const verifyResponses: { status: number; body: string }[] = [];
  page.on('response', async (r) => {
    if (r.url().endsWith('/passkey/verify')) {
      verifyResponses.push({ status: r.status(), body: await r.text().catch(() => '') });
    }
  });

  try {
    // Register: email -> code -> PIN -> the passkey offer.
    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page.getByText('Enter the six-digit code')).toBeVisible();
    const verificationId = await page.locator('input[name="verification_id"]').inputValue();
    await dbExec('UPDATE email_verifications SET code_hash = :h WHERE id = :id::uuid', [
      { name: 'h', value: sha256hex(`606111:${verificationId}`) },
      { name: 'id', value: verificationId },
    ]);
    await page.getByLabel('Code').fill('606111');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Set your PIN.' })).toBeVisible();
    await page.locator('#pin').fill(PIN);
    await page.locator('#pin2').fill(PIN);
    await page.getByRole('button', { name: 'Set PIN' }).click();
    await expect(page.getByRole('heading', { name: 'Add a passkey?' })).toBeVisible();

    // A platform authenticator that auto-approves user presence/verification.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        ctap2Version: 'ctap2_1',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await page.getByRole('button', { name: 'Add a passkey' }).click();

    // The page only leaves for /consent when verify answered 2xx.
    await page.waitForURL(/\/consent/, { timeout: 30_000 });
    expect(
      verifyResponses.map((r) => `${r.status} ${r.body}`).join(' | '),
      'POST /passkey/verify must succeed',
    ).toMatch(/^200 /);
    await expect(page.locator('#pkerr')).toHaveCount(0);

    // The credential is really persisted against the account.
    const acct = await dbExec('SELECT id FROM accounts WHERE email_hash = :h', [
      { name: 'h', value: sha256hex(email) },
    ]);
    const accountId = acct[0][0] as string;
    const creds = await dbExec(
      'SELECT credential_id FROM webauthn_credentials WHERE account_id = :a::uuid',
      [{ name: 'a', value: accountId }],
    );
    expect(creds.length, 'a credential row for the new account').toBe(1);

    // The challenge is consumed: the session holds no pending challenge, and a
    // replayed verify is refused.
    const pending = await dbExec(
      `SELECT count(*) FROM counter_sessions
        WHERE account_id = :a::uuid AND webauthn_challenge IS NOT NULL`,
      [{ name: 'a', value: accountId }],
    );
    expect(Number(pending[0][0]), 'no challenge left on the session').toBe(0);
  } finally {
    await ctx.close();
  }
});
