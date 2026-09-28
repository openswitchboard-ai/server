/**
 * 0.D gate suite — Playwright against LIVE dev, phone viewport (390x844).
 *
 * Gates evidenced here:
 *  (a) full register -> set PIN -> two confirmations -> the one onboarding
 *      question -> assistant OAuth -> post a want via MCP (kind, reach and the
 *      figure read-back) -> nobody introduced yet -> it shows on "Your wants
 *      and haves" -> take it down;
 *  (b) the accept link opens one question and looking does not spend it; the
 *      press spends it (second GET -> "already been used"); expiry
 *      (expires_at manipulated in the TEST database); the main page reaches
 *      the same question, with the warnings on it;
 *  (c) route isolation live: an MCP bearer token 403s on EVERY /
 *      route (enumerated from the app's own route table) and a counter
 *      session cookie 401s on /mcp;
 *  (d) 6 wrong PINs -> lockout with backoff;
 *  (e) prod: the create-account door is closed (separate spec: prod.spec.ts).
 *
 * Locators are roles, headings, labels and short fragments rather than whole
 * paragraphs, so a reworded sentence under a heading does not fail a gate that
 * is about something else.
 *
 * SES sandbox note: every flow really attempts the SES send; verification
 * codes are stamped/read via the RDS Data API purely as sandbox-era test
 * observability (single-use + 15-min TTL semantics untouched).
 */
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { COUNTER_COOKIE } from '../../src/counter/session.js';
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
  setAutoNegotiate,
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
    ...(process.env.OSB_RATELIMIT_BYPASS
      ? { extraHTTPHeaders: { 'x-osb-ratelimit-bypass': process.env.OSB_RATELIMIT_BYPASS } }
      : {}),
  });
  page = await ctx.newPage();
});
test.afterAll(async () => {
  await ctx?.close();
});

// Simulator address, same reason as helpers.ts testEmail(): real e2e+…@openswitchboard.ai
// addresses hard-bounced and drove the SES bounce rate up.
const aliceEmail = `success+e2e-${randomBytes(5).toString('hex')}@simulator.amazonses.com`;
const ALICE_PIN = '731642';
let aliceAccountId: string;
let aliceToken: string; // alice's assistant's bearer token
let aliceCardId: string;
let bob: TestActor;
let introId: string;

async function stampCode(verificationId: string, code: string): Promise<void> {
  await dbExec('UPDATE email_verifications SET code_hash = :h WHERE id = :id::uuid', [
    { name: 'h', value: sha256hex(`${code}:${verificationId}`) },
    { name: 'id', value: verificationId },
  ]);
}

/**
 * Post a want or have the way an assistant does now. The first attempt can
 * come back unposted — more detail, how far it reaches, a figure read back to
 * the human — and every one of those refusals carries a `reference`. Sending
 * it back on the next try is what tells the switchboard the question has been
 * put, so the same posting then goes up as it stands. (mcpCall already resends
 * once on a figure read-back; it resends the same arguments, so it only gets
 * past the gate once the reference is in them.)
 */
async function post(token: string, listing: Record<string, unknown>) {
  let reference: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await mcpCall(token, 'publish_intent', {
      listing,
      ...(reference ? { reference } : {}),
    });
    const asked = ['more_detail_needed', 'confirm_figure'].includes(r.result?.what_happened);
    if (r.isError || !asked || !r.result?.reference) return r;
    reference = r.result.reference as string;
  }
  throw new Error('the posting was still being asked about after five tries');
}

/** A near-term expiry for an offer, as the protocol wants it. */
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

/** The single-use accept page for one offer, fetched the way an assistant does. */
async function acceptLink(offerId: string): Promise<{ link: string; pressId: string }> {
  const r = await mcpCall(aliceToken, 'respond', {
    intro_id: introId,
    action: 'request_accept',
    offer_id: offerId,
  });
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  expect(r.result.link).toMatch(/\/a\/[0-9a-f-]{36}\./);
  return { link: r.result.link as string, pressId: r.result.press_id as string };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
// Gate (a): the full human journey at phone viewport.
// ---------------------------------------------------------------------------

test('register: email -> code -> PIN -> two confirmations -> one question -> main page', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your main page.' })).toBeVisible();
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

  // The choice screen: a passkey where the device can make one, a PIN
  // otherwise. This browser has no authenticator, so the passkey half stays
  // hidden and Alice takes the PIN.
  await expect(page.getByRole('heading', { name: 'How will you approve things?' })).toBeVisible();
  await page.locator('#pin').fill(ALICE_PIN);
  await page.locator('#pin2').fill(ALICE_PIN);
  await shot(page, '04-set-pin');
  await page.getByRole('button', { name: 'Set my PIN' }).click();

  await expect(page.getByRole('heading', { name: /^Add a passkey/ })).toBeVisible();
  await shot(page, '05-passkey-offer');
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.getByRole('heading', { name: 'Two things to confirm.' })).toBeVisible();
  await page.getByLabel('I am 18 or older.').check();
  await page.getByLabel(/^My assistant may post wants and haves for me\./).check();
  await shot(page, '06-consent');
  await page.getByRole('button', { name: 'Open my account' }).click();

  // The one onboarding question. Email is where a fresh account already sits,
  // and the name boxes are left for the names step to ask when it matters.
  await expect(page.getByRole('heading', { name: 'How do you hear about things?' })).toBeVisible();
  await page.locator('input[name="hears_via"][value="email"]').check();
  await shot(page, '06b-hears-via');
  await page.getByRole('button', { name: 'Save and carry on' }).click();

  // The main page opens on what is waiting, with the two quiet rows under it.
  await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible();
  await expect(page.getByText('Nothing to decide right now.')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Your wants and haves/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Settings/ })).toBeVisible();
  // Patch is on the page, and he is a real image served with a year of cache.
  await expect(page.locator('header.site img.patch')).toBeVisible();
  const patch = await page.request.get(`${COUNTER_URL}/assets/patch.png`);
  expect(patch.status()).toBe(200);
  expect(patch.headers()['content-type']).toContain('image/png');
  expect(patch.headers()['cache-control']).toContain('immutable');
  const favicon = await page.request.get(`${COUNTER_URL}/assets/favicon.png`);
  expect(favicon.status()).toBe(200);
  await shot(page, '07-dashboard');

  const rows = await dbExec('SELECT id, status FROM accounts WHERE email_hash = :h', [
    { name: 'h', value: sha256hex(aliceEmail) },
  ]);
  aliceAccountId = rows[0][0] as string;
  expect(rows[0][1]).toBe('active');
});

test('assistant OAuth: the authorize hand-off happens on the main page host, in-browser', async () => {
  // DCR + PKCE as alice's assistant.
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
  // The browser (holding only the main-page session) walks the hand-off.
  await page.goto(`${BASE_URL}/oauth/authorize?${q}`);
  await expect(page.getByRole('heading', { name: /^Let this (agent|assistant) work/ })).toBeVisible();
  await expect(page.getByText('e2e-agent')).toBeVisible();
  await shot(page, '08-authorize-agent');
  // The ceremony rides along where the session is not inside its window.
  const pin = page.getByLabel(/PIN/);
  if (await pin.count()) await pin.fill(ALICE_PIN);
  // Authorising hands the key over in a new tab, so the callback is caught as a
  // request on the whole context rather than as this tab's URL.
  const callback = ctx.waitForEvent('request', {
    predicate: (r) => r.url().startsWith(redirectUri),
  });
  await page.getByRole('button', { name: /^Authori[sz]e$/ }).click();
  const code = new URL((await callback).url()).searchParams.get('code')!;
  expect(code).toBeTruthy();
  for (const p of ctx.pages()) if (p !== page) await p.close();
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

test('assistant posts a want; nobody introduced yet; it shows on Your wants and haves', async () => {
  const w = await post(
    aliceToken,
    minimalWant({
      kind: 'mountain bike',
      geo: { ...(minimalWant().geo as object), reach: 'radius' },
      price: { band: { min: 0, max: 800 }, ccy: 'AUD' },
      attributes: { condition: 'good' },
    }),
  );
  expect(w.isError, JSON.stringify(w.result)).toBe(false);
  aliceCardId = w.result.intent_id;
  expect(aliceCardId).toBeTruthy();
  expect(w.result.state).toBe('PENDING_SCREENING');
  await waitForCardState(aliceToken, aliceCardId, ['PUBLISHED']);

  // Nobody has been introduced to a fresh want.
  const m = await mcpCall(aliceToken, 'check_in', { intent_id: aliceCardId });
  expect(m.isError).toBe(false);
  expect(m.result.introductions ?? []).toEqual([]);

  await page.goto('/ledger');
  await expect(page.getByRole('heading', { name: /^Your wants and haves/ })).toBeVisible();
  const row = page.locator(`[data-card-id="${aliceCardId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(/mountain bike/i);
  // COPY CULL (0.H): the raw slug and the old name appear nowhere on the page.
  const html = await page.content();
  expect(html).not.toContain('goods.bicycle.mountain');
  expect(html.toLowerCase()).not.toContain('the counter');
  // The private band is the owner's alone to see, and nobody is introduced yet.
  await expect(row).toContainText(/private band 0–800 AUD|your limit is private/);
  await expect(row).toContainText(/no matches yet|nobody introduced yet/);
  await shot(page, '09-ledger-card');
});

// ---------------------------------------------------------------------------
// Gate (b): a counterparty, an introduction, offers parked for the human.
// ---------------------------------------------------------------------------

test('offer arrives: the accept link opens one question, and looking does not spend it', async () => {
  bob = await bootstrapActor('Bob', 'Subiaco');
  const h = await post(
    bob.accessToken,
    minimalHave({
      kind: 'mountain bike',
      geo: { ...(minimalHave().geo as object), reach: 'radius' },
      price: { band: { min: 400, max: 400 }, ccy: 'AUD' },
      ask: { amount: 620, ccy: 'AUD' },
      attributes: { condition: 'good', model: 'Trek Marlin 5', year: 2019 },
    }),
  );
  expect(h.isError, JSON.stringify(h.result)).toBe(false);
  const haveId = h.result.intent_id;
  await waitForCardState(bob.accessToken, haveId, ['PUBLISHED']);

  await sendOp({ op: 'create-match', card_want: aliceCardId, card_have: haveId, score: 0.9 });
  introId = await poll(async () => {
    const r = await mcpCall(aliceToken, 'check_in', { intent_id: aliceCardId });
    return r.result.introductions?.[0]?.intro_id as string | undefined;
  }, 'introduction to appear');

  // Bob's have starts on "Pass on", so his human writes a floor on it before
  // his assistant can name any figure at all.
  await setAutoNegotiate(bob.jar, haveId, { limit: 50 });
  const offer = await mcpCall(bob.accessToken, 'respond', {
    intro_id: introId,
    action: 'propose_offer',
    offer: { amount: 100, ccy: 'AUD', expiry: inAnHour() },
  });
  expect(offer.isError, JSON.stringify(offer.result)).toBe(false);
  // The one accept-direction action an assistant has: park it for the human.
  const sent = await mcpCall(aliceToken, 'respond', {
    intro_id: introId,
    action: 'send_to_human',
    offer_id: offer.result.offer_id,
  });
  expect(sent.result.state).toBe('awaiting-human');

  const { link } = await acceptLink(offer.result.offer_id);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /^Accept \$100 AUD for / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
  await expect(page.getByText('This link works once.')).toBeVisible();
  await shot(page, '10-accept-from-link');
  // The press spends a one-question link, never the look: open it again and
  // the same question is still there.
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /^Accept \$100 AUD for / })).toBeVisible();
});

test('accept link runs out (expires_at manipulated in test DB)', async () => {
  // A second offer -> a fresh link, then age it out in the DB.
  const offer = await mcpCall(bob.accessToken, 'respond', {
    intro_id: introId,
    action: 'propose_offer',
    offer: { amount: 110, ccy: 'AUD', expiry: inAnHour() },
  });
  expect(offer.isError, JSON.stringify(offer.result)).toBe(false);
  const { link, pressId } = await acceptLink(offer.result.offer_id);
  await dbExec(
    `UPDATE approval_links SET created_at = now() - interval '16 minutes',
        expires_at = now() - interval '1 minute' WHERE id = :id::uuid`,
    [{ name: 'id', value: pressId }],
  );
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /run out/ })).toBeVisible();
  await expect(page.getByText(/fresh one/).first()).toBeVisible();
  await shot(page, '12-link-expired');
});

test('the warning is one sentence; accepting takes the PIN; the press spends the link', async () => {
  // A big third offer: > 3x alice's median (100, 110) and from a < 7-day-old
  // account -> both warnings.
  const offer = await mcpCall(bob.accessToken, 'respond', {
    intro_id: introId,
    action: 'propose_offer',
    offer: { amount: 1000, ccy: 'AUD', expiry: inAnHour() },
  });
  expect(offer.isError, JSON.stringify(offer.result)).toBe(false);
  await mcpCall(aliceToken, 'respond', {
    intro_id: introId,
    action: 'send_to_human',
    offer_id: offer.result.offer_id,
  });

  // The main page's road to it: the tile opens the same one question.
  await page.goto('/');
  const tile = page.getByRole('link', { name: /1,?000 AUD/ }).first();
  await expect(tile).toBeVisible();
  await shot(page, '13-dashboard-pending');
  await tile.click();
  const question = page.getByRole('heading', { name: /^Accept \$1,?000 AUD for / });
  await expect(question).toBeVisible();
  // Both warnings are one sentence (src/counter/anomalies.ts): bob's account
  // is under a week old, and 1000 is over three times alice's usual.
  await expect(
    page.getByText(/^This is their first week on OpenSwitchboard, and this figure is [\d.]+ times your usual\.$/),
  ).toBeVisible();
  await shot(page, '14-accept-warnings');

  // The press, on the link the assistant was handed.
  const { link } = await acceptLink(offer.result.offer_id);
  await page.goto(link);
  await expect(question).toBeVisible();
  await page.getByLabel(/PIN/).fill(ALICE_PIN);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^(Accepted|Approved)/ })).toBeVisible();
  await shot(page, '15-accepted');

  // Pressed once, it is spent.
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /already been used/ })).toBeVisible();
  await shot(page, '11-link-already-used');

  const offers = await mcpCall(bob.accessToken, 'respond', {
    intro_id: introId,
    action: 'list_offers',
  });
  const accepted = offers.result.offers.find((o: any) => o.offer_id === offer.result.offer_id);
  expect(accepted.state).toBe('accepted-by-human');
});

test('Your wants and haves: taking one down is immediate', async () => {
  await page.goto('/ledger');
  const row = page.locator(`[data-card-id="${aliceCardId}"]`);
  await row
    .getByRole('link', { name: 'Take it down' })
    .or(row.getByRole('button', { name: /^(Take it down|Withdraw)$/ }))
    .click();
  // It asks once before it does anything, where the page has that step.
  const asked = page.getByRole('heading', { name: /^Take down / });
  const back = page.getByRole('heading', { name: /^Your wants and haves/ });
  await expect(asked.or(back)).toBeVisible();
  if (await asked.isVisible()) {
    await shot(page, '16a-take-down-question');
    await page.getByRole('button', { name: 'Take it down' }).click();
    await expect(back).toBeVisible();
  }
  await shot(page, '16-withdrawn');
  const li = await mcpCall(aliceToken, 'list_intents', {});
  const card = li.result.intents.find((i: any) => i.intent_id === aliceCardId);
  expect(card.state).toBe('WITHDRAWN');
  // Nothing left to take down on that one.
  await page.goto('/ledger');
  await expect(row.getByRole('link', { name: 'Take it down' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: /^(Take it down|Withdraw)$/ })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Gate (c): route isolation against LIVE dev, full enumeration.
// ---------------------------------------------------------------------------

test('route isolation live: bearer x every human-page route; cookie x /mcp', async () => {
  // Enumerate the whole route class from the app's own route table.
  process.env.COUNTER_LINK_HMAC_KEY ??= 'aa'.repeat(32);
  process.env.COUNTER_COOKIE_KEY ??= 'bb'.repeat(32);
  const { buildApp } = await import('../../src/app.js');
  const { COUNTER_ROUTE_TABLE } = await import('../../src/counter/routes.js');
  const enumApp = buildApp({
    envName: 'dev',
    port: 0,
    publicOrigin: 'https://mcp.test',
    counterOrigin: 'https://my.test',
    legacyCounterHosts: ['counter.test'],
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
  const session = cookies.find((c) => c.name === COUNTER_COOKIE);
  expect(session).toBeTruthy();
  const mcpRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      cookie: `${COUNTER_COOKIE}=${session!.value}`,
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
  const session = cookies.find((c) => c.name === COUNTER_COOKIE)!;
  const jar = new Jar();
  jar.cookies.set(COUNTER_COOKIE, session.value);
  // Elevation from the earlier approval may still be active; expire it so the
  // ceremony actually checks the PIN.
  await dbExec('UPDATE counter_sessions SET pin_ok_until = NULL WHERE account_id = :a::uuid', [
    { name: 'a', value: aliceAccountId },
  ]);
  const attempt = async (pin: string) =>
    counterFetch(jar, '/pin/verify', {
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
// Stop everything: one tap stops it all; the assistant's token dies; the PIN restores.
// ---------------------------------------------------------------------------

test('stop everything suspends assistant tokens; the PIN turns it back on', async () => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stop all wants and haves' }).click();
  await expect(page.getByRole('heading', { name: /^Everything is stopped/ })).toBeVisible();
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

  const pin = page.getByLabel(/PIN/);
  if (await pin.count()) await pin.fill(ALICE_PIN);
  await page.getByRole('button', { name: 'Turn everything back on' }).click();
  await expect(page.getByRole('button', { name: 'Stop all wants and haves' })).toBeVisible();
  const alive = await mcpCall(aliceToken, 'list_intents', {});
  expect(alive.isError).toBe(false);
  await shot(page, '18-kill-switch-off');
});
