/**
 * 0.D gate suite — Playwright against LIVE dev, phone viewport (390x844).
 *
 * Gates evidenced here:
 *  (a) full register -> set PIN -> consent -> agent OAuth -> post card via
 *      MCP -> match-less state -> ledger shows card -> withdraw;
 *  (b) approval link single-use (second GET -> clean "already used" page)
 *      and expiry (expires_at manipulated in the TEST database);
 *  (c) route isolation live: an MCP bearer token 403s on EVERY /counter
 *      route (enumerated from the app's own route table) and a counter
 *      session cookie 401s on /mcp;
 *  (d) 6 wrong PINs -> lockout with backoff;
 *  (e) prod: the create-account door is closed (separate spec: prod.spec.ts).
 *
 * SES sandbox note: every flow really attempts the SES send; verification
 * codes are stamped/read via the RDS Data API purely as sandbox-era test
 * observability (single-use + 15-min TTL semantics untouched).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  BASE_URL,
  COUNTER_URL,
  Jar,
  bootstrapActor,
  counterFetch,
  dbExec,
  mcpCall,
  minimalHave,
  minimalWant,
  poll,
  sendOp,
  sha256hex,
  waitForCardState,
  type TestActor,
} from '../integration/helpers.js';

const SHOTS = 'e2e-screenshots'; // outside Playwright's managed outputDir (each run clears that)
const b64url = (b: Buffer) => b.toString('base64url');

test.describe.configure({ mode: 'serial' });

// One browser context for the whole serial journey: the counter session
// cookie must persist across tests (phone viewport per the gate).
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }: { browser: Browser }) => {
  ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: COUNTER_URL,
  });
  page = await ctx.newPage();
});
test.afterAll(async () => {
  await ctx?.close();
});

const aliceEmail = `e2e+${randomBytes(5).toString('hex')}@openswitchboard.ai`;
const ALICE_PIN = '731642';
let aliceAccountId: string;
let aliceToken: string; // alice's AGENT bearer token
let aliceCardId: string;
let bob: TestActor;
let matchId: string;

async function stampCode(verificationId: string, code: string): Promise<void> {
  await dbExec('UPDATE email_verifications SET code_hash = :h WHERE id = :id::uuid', [
    { name: 'h', value: sha256hex(`${code}:${verificationId}`) },
    { name: 'id', value: verificationId },
  ]);
}

let hmacKey: Buffer | undefined;
async function linkHmacKey(): Promise<Buffer> {
  if (!hmacKey) {
    const sm = new SecretsManagerClient({ region: 'us-east-1' });
    const r = await sm.send(new GetSecretValueCommand({ SecretId: 'osb/dev/counter/keys' }));
    hmacKey = Buffer.from(JSON.parse(r.SecretString!).link_hmac_key, 'hex');
  }
  return hmacKey;
}

/** Reconstruct the newest pending approval-link token for an account (the
 *  email is unreadable in the SES sandbox; the DB stores only the hash, so
 *  the harness re-signs from the row + the HMAC key it is entitled to read). */
async function latestLinkToken(accountId: string): Promise<{ id: string; token: string }> {
  const rows = await poll(async () => {
    const r = await dbExec(
      `SELECT id, account_id, action, ref_id, amount, ccy, counterparty_account
       FROM approval_links WHERE account_id = :a::uuid AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [{ name: 'a', value: accountId }],
    );
    return r.length ? r : undefined;
  }, 'approval link row');
  const [id, account_id, action, ref_id, amount, ccy, counterparty_account] = rows[0] as string[];
  const binding = [id, account_id, action, ref_id, amount === null ? '' : String(Number(amount)), ccy ?? '', counterparty_account].join('|');
  const mac = createHmac('sha256', await linkHmacKey()).update(binding).digest('base64url');
  return { id, token: `${id}.${mac}` };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
// Gate (a): the full human journey at phone viewport.
// ---------------------------------------------------------------------------

test('register: email -> code -> PIN -> consent -> account live', async () => {
  await page.goto('/counter');
  await expect(page.getByRole('heading', { name: 'Your approval page.' })).toBeVisible();
  await shot(page, '01-landing');

  await page.getByRole('link', { name: 'Open an account' }).click();
  await page.getByLabel('Email').fill(aliceEmail);
  await shot(page, '02-register-email');
  await page.getByRole('button', { name: 'Email me a code' }).click();

  await expect(page.getByText('Enter the six-digit code')).toBeVisible();
  const verificationId = await page.locator('input[name="verification_id"]').inputValue();
  await stampCode(verificationId, '555123');
  await page.getByLabel('Code').fill('555123');
  await shot(page, '03-code-entry');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Set your PIN.' })).toBeVisible();
  await page.locator('#pin').fill(ALICE_PIN);
  await page.locator('#pin2').fill(ALICE_PIN);
  await shot(page, '04-set-pin');
  await page.getByRole('button', { name: 'Set PIN' }).click();

  await expect(page.getByRole('heading', { name: 'Add a passkey?' })).toBeVisible();
  await shot(page, '05-passkey-offer');
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.getByText('I am 18 or older.')).toBeVisible();
  await expect(
    page.getByText('My agent may store wants & haves as cards on my behalf.'),
  ).toBeVisible();
  await page.getByLabel('I am 18 or older.').check();
  await page
    .getByLabel('My agent may store wants & haves as cards on my behalf. I can see, edit, or withdraw everything on my approval page.')
    .check();
  await shot(page, '06-consent');
  await page.getByRole('button', { name: 'Open my account' }).click();

  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible();
  await shot(page, '07-dashboard');

  const rows = await dbExec('SELECT id, status FROM accounts WHERE email_hash = :h', [
    { name: 'h', value: sha256hex(aliceEmail) },
  ]);
  aliceAccountId = rows[0][0] as string;
  expect(rows[0][1]).toBe('active');
});

test('agent OAuth: authorize hand-off happens on the counter, in-browser', async () => {
  // DCR + PKCE as alice's agent.
  const redirectUri = 'https://example.com/cb';
  const reg = await fetch(`${BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'e2e-agent', redirect_uris: [redirectUri] }),
  });
  expect(reg.status).toBe(201);
  const client: any = await reg.json();
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'switchboard',
    state: 'e2e-state',
  });
  // The browser (holding only the counter session) walks the hand-off.
  await page.goto(`${BASE_URL}/oauth/authorize?${q}`);
  await expect(page.getByRole('heading', { name: /Let this agent work/ })).toBeVisible();
  await expect(page.getByText('e2e-agent')).toBeVisible();
  await shot(page, '08-authorize-agent');
  await page.getByRole('button', { name: 'Authorize' }).click();
  await page.waitForURL(/example\.com\/cb/);
  const code = new URL(page.url()).searchParams.get('code')!;
  expect(code).toBeTruthy();
  const tok = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: redirectUri,
    }).toString(),
  });
  expect(tok.status).toBe(200);
  aliceToken = ((await tok.json()) as any).access_token;
  expect(aliceToken).toBeTruthy();
});

test('agent posts a card; matches are empty; ledger shows it', async () => {
  const w = await mcpCall(aliceToken, 'publish_intent', {
    card: minimalWant({
      price: { band: { min: 0, max: 800 }, ccy: 'AUD' },
      attributes: { condition: 'good' },
    }),
  });
  expect(w.isError).toBe(false);
  aliceCardId = w.result.intent_id;
  expect(w.result.state).toBe('PENDING_SCREENING');
  await waitForCardState(aliceToken, aliceCardId, ['PUBLISHED']);

  // Match-less state for a fresh card.
  const m = await mcpCall(aliceToken, 'check_matches', { intent_id: aliceCardId });
  expect(m.result.matches).toEqual([]);

  await page.goto('/counter/ledger');
  // COPY CULL (0.H): the ledger shows the taxonomy's human label, and the raw
  // slug appears nowhere on the page.
  await expect(page.getByText('Mountain bikes')).toBeVisible();
  expect(await page.content()).not.toContain('goods.bicycle.mountain');
  expect((await page.content()).toLowerCase()).not.toContain('the counter');
  await expect(page.getByText('PUBLISHED')).toBeVisible();
  await expect(page.getByText('private band 0–800 AUD')).toBeVisible(); // owner-only
  await expect(page.getByText('no matches yet')).toBeVisible();
  await shot(page, '09-ledger-card');
});

// ---------------------------------------------------------------------------
// Gate (b) setup: a counterparty, a match, an offer parked for the human.
// ---------------------------------------------------------------------------

test('offer arrives: approval link is single-use', async () => {
  bob = await bootstrapActor('Bob', 'Subiaco');
  const h = await mcpCall(bob.accessToken, 'publish_intent', {
    card: minimalHave({
      price: { band: { min: 400, max: 400 }, ccy: 'AUD' },
      ask: { amount: 620, ccy: 'AUD' },
      attributes: { condition: 'good', model: 'Trek Marlin 5', year: 2019 },
    }),
  });
  expect(h.isError).toBe(false);
  const haveId = h.result.intent_id;
  await waitForCardState(bob.accessToken, haveId, ['PUBLISHED']);

  await sendOp({ op: 'create-match', card_want: aliceCardId, card_have: haveId, score: 0.9 });
  matchId = await poll(async () => {
    const r = await mcpCall(aliceToken, 'check_matches', { intent_id: aliceCardId });
    return r.result.matches?.[0]?.match_id as string | undefined;
  }, 'match to appear');

  // Stage 1 -> 2 (offers unlock), then bob proposes and alice's agent parks it.
  await mcpCall(aliceToken, 'respond', { match_id: matchId, action: 'express_interest' });
  await mcpCall(bob.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
  const offer = await mcpCall(bob.accessToken, 'respond', {
    match_id: matchId,
    action: 'propose_offer',
    offer: { amount: 100, ccy: 'AUD', expiry: new Date(Date.now() + 3600_000).toISOString() },
  });
  expect(offer.isError).toBe(false);
  const sent = await mcpCall(aliceToken, 'respond', {
    match_id: matchId,
    action: 'send_to_human',
    offer_id: offer.result.offer_id,
  });
  expect(sent.result.state).toBe('awaiting-human');

  const { token } = await latestLinkToken(aliceAccountId);
  // First authenticated GET renders the approval page and burns the link.
  await page.goto(`/counter/a/${token}`);
  await expect(page.getByRole('heading', { name: 'Approve this settlement?' })).toBeVisible();
  await expect(page.getByText('100 AUD')).toBeVisible();
  await shot(page, '10-approval-from-link');
  // Second GET: clean "already used" page.
  await page.goto(`/counter/a/${token}`);
  await expect(page.getByRole('heading', { name: 'Already used.' })).toBeVisible();
  await expect(page.getByText('works exactly once')).toBeVisible();
  await shot(page, '11-link-already-used');
});

test('approval link expires (created_at/expires_at manipulated in test DB)', async () => {
  // A second offer -> a fresh link, then age it out in the DB.
  const offer = await mcpCall(bob.accessToken, 'respond', {
    match_id: matchId,
    action: 'propose_offer',
    offer: { amount: 110, ccy: 'AUD', expiry: new Date(Date.now() + 3600_000).toISOString() },
  });
  await mcpCall(aliceToken, 'respond', {
    match_id: matchId,
    action: 'send_to_human',
    offer_id: offer.result.offer_id,
  });
  const { id, token } = await latestLinkToken(aliceAccountId);
  await dbExec(
    `UPDATE approval_links SET created_at = now() - interval '16 minutes',
        expires_at = now() - interval '1 minute' WHERE id = :id::uuid`,
    [{ name: 'id', value: id }],
  );
  await page.goto(`/counter/a/${token}`);
  await expect(page.getByRole('heading', { name: 'Link expired.' })).toBeVisible();
  await expect(page.getByText('links live for 15 minutes')).toBeVisible();
  await shot(page, '12-link-expired');
});

test('anomalies are LOUD; approve ceremony needs the PIN; offer settles', async () => {
  // A big third offer: > 3x alice's median (100, 110) and from a < 7-day-old
  // account -> both anomaly banners.
  const offer = await mcpCall(bob.accessToken, 'respond', {
    match_id: matchId,
    action: 'propose_offer',
    offer: { amount: 1000, ccy: 'AUD', expiry: new Date(Date.now() + 3600_000).toISOString() },
  });
  await mcpCall(aliceToken, 'respond', {
    match_id: matchId,
    action: 'send_to_human',
    offer_id: offer.result.offer_id,
  });

  await page.goto('/counter');
  await expect(page.getByText('WAITING FOR YOU').first()).toBeVisible();
  await shot(page, '13-dashboard-pending');
  await page.getByRole('link', { name: 'Review & decide' }).first().click();

  await expect(page.getByRole('heading', { name: 'Approve this settlement?' })).toBeVisible();
  await expect(page.getByText('1000 AUD')).toBeVisible();
  await expect(page.getByText(/× your usual amount/)).toBeVisible();
  await expect(page.getByText('this offer comes from a brand-new account')).toBeVisible();
  await shot(page, '14-approval-anomalies');

  await page.getByLabel('Confirm with your PIN').fill(ALICE_PIN);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Approved' })).toBeVisible();
  await shot(page, '15-approved');

  const offers = await mcpCall(bob.accessToken, 'respond', {
    match_id: matchId,
    action: 'list_offers',
  });
  const accepted = offers.result.offers.find((o: any) => o.offer_id === offer.result.offer_id);
  expect(accepted.state).toBe('accepted-by-human');
});

test('ledger: withdraw is immediate', async () => {
  await page.goto('/counter/ledger');
  await page
    .locator(`[data-card-id="${aliceCardId}"]`)
    .getByRole('button', { name: 'Withdraw' })
    .click();
  await expect(page.getByText('Withdrawn — effective immediately.')).toBeVisible();
  await expect(page.getByText('WITHDRAWN', { exact: true })).toBeVisible();
  await shot(page, '16-withdrawn');
  const li = await mcpCall(aliceToken, 'list_intents', {});
  const card = li.result.intents.find((i: any) => i.intent_id === aliceCardId);
  expect(card.state).toBe('WITHDRAWN');
});

// ---------------------------------------------------------------------------
// Gate (c): route isolation against LIVE dev, full enumeration.
// ---------------------------------------------------------------------------

test('route isolation live: bearer x every /counter route; cookie x /mcp', async () => {
  // Enumerate the whole route class from the app's own route table.
  process.env.COUNTER_LINK_HMAC_KEY ??= 'aa'.repeat(32);
  process.env.COUNTER_COOKIE_KEY ??= 'bb'.repeat(32);
  const { buildApp } = await import('../../src/app.js');
  const { COUNTER_ROUTE_TABLE } = await import('../../src/counter/routes.js');
  const enumApp = buildApp({
    envName: 'dev',
    port: 0,
    publicOrigin: 'https://mcp.test',
    counterOrigin: 'https://counter.test',
    sesFrom: 'x',
    sesReplyTo: 'x',
    sesConfigurationSet: 'x',
    emailEventsQueueUrl: 'x',
    dbSecretArn: 'x',
    screeningQueueUrl: 'x',
    matchingQueueUrl: 'x',
    opsQueueUrl: 'x',
    consentLogBucket: 'x',
    identityKeyArn: 'x',
    bedrockModelId: 'x',
    registrationMode: 'dev-bootstrap',
    region: 'us-east-1',
    quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
    docsBase: 'x',
  } as any);
  await enumApp.ready(); // plugin registration is deferred until ready()
  expect(COUNTER_ROUTE_TABLE.length).toBeGreaterThanOrEqual(25);

  const matrix: string[] = [];
  for (const r of COUNTER_ROUTE_TABLE) {
    const url = r.url
      .replace(':token', 'sometoken')
      .replace(':id', '00000000-0000-0000-0000-000000000000');
    const res = await fetch(`${COUNTER_URL}${url}`, {
      method: r.method,
      headers: { authorization: `Bearer ${aliceToken}` }, // a REAL, live token
      redirect: 'manual',
    });
    matrix.push(`${r.method} ${url} + MCP bearer -> ${res.status}`);
    expect(res.status, `${r.method} ${url}`).toBe(403);
  }

  // A REAL counter session cookie (from the signed-in page) against /mcp.
  const cookies = await page.context().cookies(COUNTER_URL);
  const session = cookies.find((c) => c.name === 'osb_counter');
  expect(session).toBeTruthy();
  const mcpRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      cookie: `osb_counter=${session!.value}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  matrix.push(`POST /mcp + counter session cookie -> ${mcpRes.status}`);
  expect(mcpRes.status).toBe(401);
  console.log('\nROUTE-ISOLATION MATRIX (live dev):\n' + matrix.join('\n'));
});

// ---------------------------------------------------------------------------
// Gate (d): 6 wrong PINs -> lockout with backoff.
// ---------------------------------------------------------------------------

test('6 wrong PINs lock the PIN with backoff', async () => {
  const cookies = await page.context().cookies(COUNTER_URL);
  const session = cookies.find((c) => c.name === 'osb_counter')!;
  const jar = new Jar();
  jar.cookies.set('osb_counter', session.value);
  // Elevation from the earlier approval may still be active; expire it so the
  // ceremony actually checks the PIN.
  await dbExec('UPDATE counter_sessions SET pin_ok_until = NULL WHERE account_id = :a::uuid', [
    { name: 'a', value: aliceAccountId },
  ]);
  const attempt = async (pin: string) =>
    counterFetch(jar, '/counter/pin/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin }).toString(),
    });
  const statuses: number[] = [];
  for (let i = 1; i <= 6; i++) statuses.push((await attempt('999999')).status);
  expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]); // tries 1-4
  expect(statuses[4]).toBe(423); // 5th wrong try -> locked
  expect(statuses[5]).toBe(423); // 6th wrong PIN -> still locked (backoff)
  // Even the CORRECT PIN is refused while locked, with a retry-after.
  const lockedCorrect = await attempt(ALICE_PIN);
  expect(lockedCorrect.status).toBe(423);
  const body: any = await lockedCorrect.json();
  expect(body.retry_after_s).toBeGreaterThan(0);
  console.log(`lockout verified: retry_after_s=${body.retry_after_s}`);
  // Reset for any later runs.
  await dbExec(
    'UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = :a::uuid',
    [{ name: 'a', value: aliceAccountId }],
  );
});

// ---------------------------------------------------------------------------
// Kill switch: one tap pauses everything; agent token dies; PIN restores.
// ---------------------------------------------------------------------------

test('kill switch suspends agent tokens; PIN un-pauses', async () => {
  await page.goto('/counter');
  await page.getByRole('button', { name: 'Pause everything now' }).click();
  await expect(page.getByText('Everything is paused.')).toBeVisible();
  await shot(page, '17-kill-switch-on');

  const dead = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(dead.status).toBe(401); // suspended, not revoked

  await page.getByLabel('PIN').fill(ALICE_PIN);
  await page.getByRole('button', { name: 'Turn everything back on' }).click();
  await expect(page.getByText('Kill switch')).toBeVisible();
  const alive = await mcpCall(aliceToken, 'list_intents', {});
  expect(alive.isError).toBe(false);
  await shot(page, '18-kill-switch-off');
});
