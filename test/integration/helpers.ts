import { createHash, randomBytes, randomInt, scryptSync } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';

export const BASE_URL = process.env.OSB_BASE_URL ?? 'https://mcp-dev.openswitchboard.ai';
export const COUNTER_URL = process.env.OSB_COUNTER_URL ?? 'https://my-dev.openswitchboard.ai';
/**
 * The hostname the human pages used to be on, if this deployment had one; it
 * still answers, with a 308. Per-deployment and often absent, so it is named
 * rather than guessed: set OSB_LEGACY_COUNTER_URL to exercise the redirect.
 */
export const LEGACY_COUNTER_URL = process.env.OSB_LEGACY_COUNTER_URL;
export const ENV_NAME = process.env.OSB_TEST_ENV ?? 'dev';

/**
 * The WORM consent-log bucket for the environment under test. S3 bucket names
 * are globally unique, so every deployment's is different and there is nothing
 * sensible to default to — export OSB_CONSENT_BUCKET with the name of yours.
 * Read at first use so importing this module needs nothing set.
 */
export function consentBucket(): string {
  const name = process.env.OSB_CONSENT_BUCKET;
  if (!name) {
    throw new Error(
      'OSB_CONSENT_BUCKET is not set. Export the name of the consent-log bucket ' +
        `for the ${ENV_NAME} deployment you are testing against.`,
    );
  }
  return name;
}
const region = process.env.AWS_REGION ?? 'us-east-1';

const ssm = new SSMClient({ region });
const sqs = new SQSClient({ region });
const rdsData = new RDSDataClient({ region });

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The PIN every account this harness creates is given. Generated once per
 * process rather than fixed in the source, so nothing that reads like a real
 * credential is committed and two harnesses running side by side do not share
 * one. It never leaves the run: the accounts are throwaway and the PIN is only
 * ever posted back to the deployment under test.
 */
export const TEST_PIN = String(randomInt(0, 1_000_000)).padStart(6, '0');

// ---------------------------------------------------------------------------
// Dev-DB observability via the RDS Data API (SES is in its sandbox, so the
// harness manipulates/reads verification state in the TEST database instead
// of an inbox; token semantics — single-use, 15-min TTL, hashed at rest —
// are untouched). See counter/email.ts for the full sandbox note.
// ---------------------------------------------------------------------------
let dbArns: { resourceArn: string; secretArn: string } | undefined;
export async function dbExec(
  sql: string,
  parameters: { name: string; value: any }[] = [],
): Promise<any[][]> {
  if (!dbArns) {
    const [cluster, secret] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: `/osb/${ENV_NAME}/db/cluster-arn` })),
      ssm.send(new GetParameterCommand({ Name: `/osb/${ENV_NAME}/db/secret-arn` })),
    ]);
    dbArns = { resourceArn: cluster.Parameter!.Value!, secretArn: secret.Parameter!.Value! };
  }
  const r = await rdsData.send(
    new ExecuteStatementCommand({
      ...dbArns,
      database: 'osb',
      sql,
      parameters: parameters.map((p) => ({
        name: p.name,
        value:
          typeof p.value === 'number'
            ? { doubleValue: p.value }
            : typeof p.value === 'boolean'
              ? { booleanValue: p.value }
              : { stringValue: String(p.value) },
      })),
    }),
  );
  return (r.records ?? []).map((row) =>
    row.map((f: any) => f.stringValue ?? f.longValue ?? f.doubleValue ?? f.booleanValue ?? null),
  );
}

// ---------------------------------------------------------------------------
// Minimal cookie jar for the counter's session cookie.
// ---------------------------------------------------------------------------
export class Jar {
  cookies = new Map<string, string>();
  absorb(res: Response) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const [k, ...v] = pair.split('=');
      this.cookies.set(k.trim(), v.join('='));
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export async function counterFetch(
  jar: Jar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(path.startsWith('http') ? path : `${COUNTER_URL}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      ...(init.headers ?? {}),
      cookie: jar.header(),
      ...(process.env.OSB_RATELIMIT_BYPASS
        ? { 'x-osb-ratelimit-bypass': process.env.OSB_RATELIMIT_BYPASS }
        : {}),
    },
  });
  jar.absorb(res);
  return res;
}

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

/**
 * Sign in to the counter by email code: POST /login creates the
 * verification (the server genuinely attempts the SES send), then the
 * harness stamps a known code onto that row (sandbox-era observability) and
 * submits it.
 */
export async function counterLogin(jar: Jar, email: string): Promise<void> {
  const res = await counterFetch(jar, '/login', form({ email }));
  if (res.status !== 200) throw new Error(`login start failed: ${res.status}`);
  const htmlBody = await res.text();
  const m = htmlBody.match(/name="verification_id" value="([^"]+)"/);
  if (!m) throw new Error('no verification_id in code page');
  const verificationId = m[1];
  const code = '424242';
  await dbExec(`UPDATE email_verifications SET code_hash = :h WHERE id = :id::uuid`, [
    { name: 'h', value: sha256hex(`${code}:${verificationId}`) },
    { name: 'id', value: verificationId },
  ]);
  const v = await counterFetch(jar, '/verify', form({ verification_id: verificationId, code }));
  if (v.status !== 303) throw new Error(`verify failed: ${v.status} ${await v.text()}`);
}

/** Ensure the signed-in account has a PIN (sets one if the flow asks for it). */
export async function ensurePin(jar: Jar, pin = TEST_PIN): Promise<string> {
  const res = await counterFetch(jar, '/');
  if (res.status === 303 && res.headers.get('location')?.includes('/pin')) {
    const set = await counterFetch(jar, '/pin/set', form({ pin, pin2: pin }));
    if (set.status !== 303) throw new Error(`pin set failed: ${set.status}`);
  }
  return pin;
}

/**
 * Answer the one onboarding question, the way a first-time person does.
 *
 * Since migration 027 an account carries `onboarded_at`, and until it is
 * stamped every signed-in GET of the dashboard answers 303 to /hello (see
 * counter/routes.ts nextStep). A harness that signs in and reads a page has to
 * come past that door like anybody else, or every page assertion it makes is
 * an assertion about a redirect.
 *
 * It answers with 'email', which is where a fresh account already sits: the
 * suites that wait on a summons, a nudge or a digest are waiting on mail the
 * switchboard only sends to an account that hears that way, so the helper
 * leaves that fact exactly as it found it. The first name, the area and the
 * zone are left alone too — each belongs to the suite that is about it.
 *
 * Idempotent: an account already past the question is redirected on, which is
 * the same 303 a fresh answer gets.
 */
export async function completeOnboarding(jar: Jar): Promise<void> {
  const res = await counterFetch(jar, '/hello', form({ hears_via: 'email' }));
  if (res.status !== 303) throw new Error(`onboarding failed: ${res.status}`);
  // The page redirects to whatever is still owed, so being sent back to an
  // earlier step means nothing was stamped and every page read after this
  // would be a read of a redirect. Say so here rather than there.
  const next = res.headers.get('location') ?? '';
  if (['/hello', '/pin', '/consent', '/login'].includes(next)) {
    throw new Error(`onboarding did not stick: the account still owes ${next}`);
  }
}

/**
 * Issue an agent key the way a human does: a signed-in counter session plus a
 * PIN ceremony on /agent-keys. Returns the plaintext key (shown once)
 * and the handle the approval page revokes it by.
 */
export async function createAgentKey(
  jar: Jar,
  pin: string,
  name = 'integration-suite key',
): Promise<{ token: string; keyId: string }> {
  const res = await counterFetch(jar, '/agent-keys', form({ name, pin }));
  if (res.status !== 200) throw new Error(`agent key create failed: ${res.status}`);
  const body = await res.text();
  const token = body.match(/id="keybox">(osb_ak_[A-Za-z0-9_-]+)</)?.[1];
  if (!token) throw new Error('no key on the created page');
  const list = await counterFetch(jar, '/agent-keys');
  const keyId = (await list.text()).match(/name="key_id" value="([0-9a-f-]{36})"/)?.[1];
  if (!keyId) throw new Error('new key is missing from the listing');
  return { token, keyId };
}

/**
 * Switch one card to "Auto-negotiate" and write the numbers, exactly as its
 * human would on their own page.
 *
 * Every card lands on "Pass on", where an agent may not author a figure at all,
 * so any harness that drives respond(propose_offer) has to come through here
 * first. That is the point of the feature rather than an obstacle to it: the
 * suite has to do what a person would do.
 */
export async function setAutoNegotiate(
  jar: Jar,
  cardId: string,
  numbers: { open?: number; limit: number; step?: number; ccy?: string },
): Promise<void> {
  const res = await counterFetch(
    jar,
    `/ledger/${cardId}/numbers`,
    form({
      mode: 'mandate',
      ...(numbers.open !== undefined ? { open: String(numbers.open) } : {}),
      limit: String(numbers.limit),
      ...(numbers.step !== undefined ? { step: String(numbers.step) } : {}),
      ccy: numbers.ccy ?? 'AUD',
    }),
  );
  if (res.status !== 200) {
    throw new Error(`setting the card's numbers failed: ${res.status} ${await res.text()}`);
  }
}

/** Type a figure on the human's own page and send it as their side's offer. */
export async function humanOffer(
  jar: Jar,
  matchId: string,
  o: { amount: number; ccy?: string; note?: string; goodFor?: 3 | 7 | 14 },
): Promise<Response> {
  return counterFetch(
    jar,
    `/matches/${matchId}/offer`,
    form({
      amount: String(o.amount),
      ccy: o.ccy ?? 'AUD',
      ...(o.note ? { note: o.note } : {}),
      good_for: String(o.goodFor ?? 7),
    }),
  );
}

/** Revoke an agent key from the approval page. */
export async function revokeAgentKey(jar: Jar, keyId: string): Promise<void> {
  const res = await counterFetch(jar, '/agent-keys/revoke', form({ key_id: keyId }));
  if (res.status !== 200) throw new Error(`agent key revoke failed: ${res.status}`);
}

let opsQueueUrl: string | undefined;
export async function sendOp(body: Record<string, unknown>): Promise<void> {
  if (!opsQueueUrl) {
    const p = await ssm.send(
      new GetParameterCommand({ Name: `/osb/${ENV_NAME}/sqs/ops-queue-url` }),
    );
    opsQueueUrl = p.Parameter!.Value!;
  }
  await sqs.send(
    new SendMessageCommand({ QueueUrl: opsQueueUrl, MessageBody: JSON.stringify(body) }),
  );
}

export async function poll<T>(
  fn: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 90_000,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Test-actor addresses live on the SES mailbox simulator, NOT a real domain:
 * simulator deliveries are accepted in the sandbox and do NOT count against
 * the account's daily sending quota. (Real `testsuite+…@openswitchboard.ai`
 * addresses did, and two e2e runs' worth of summons/verification mail
 * exhausted the 200/day sandbox quota on 2026-09-01, failing every suite that
 * waits on an email side effect.)
 */
const testEmail = () =>
  `success+testsuite-${randomBytes(6).toString('hex')}@simulator.amazonses.com`;

export interface TestActor {
  email: string;
  accountId: string;
  pin: string;
  accessToken: string;
  jar: Jar;
}

/**
 * How long to wait for an account the ops queue is making.
 *
 * That queue is shared and strictly ordered per batch, and it carries a
 * summons for every match the engine makes. Since the engine started finding
 * the matches the fixture city was seeded to have, a create-account can sit
 * behind hundreds of them. Waiting longer costs nothing when the queue is
 * quiet, and a suite that gives up here fails on the queue rather than on
 * anything it set out to prove.
 */
export const OPS_ACCOUNT_WAIT_MS = 300_000;

/** Bootstrap a dev account via the internal ops queue, then run the full
 * OAuth 2.1 flow (DCR + counter login/consent + PKCE) against live dev. */
export async function bootstrapActor(firstName: string, locality: string): Promise<TestActor> {
  const email = testEmail();
  const code = `osb-dev-${randomBytes(18).toString('base64url')}`;
  const salt = randomBytes(16);
  const hash = `scrypt$${salt.toString('hex')}$${scryptSync(code, salt, 32).toString('hex')}`;
  await sendOp({
    op: 'create-account',
    email,
    first_name: firstName,
    locality,
    login_code_hash: hash,
  });
  const accountId = await poll(
    async () => {
      const rows = await dbExec('SELECT id FROM accounts WHERE email_hash = :h', [
        { name: 'h', value: sha256hex(email.trim().toLowerCase()) },
      ]);
      return rows[0]?.[0] as string | undefined;
    },
    `account ${email} to exist`,
    OPS_ACCOUNT_WAIT_MS,
  );
  const jar = new Jar();
  await counterLogin(jar, email);
  const pin = await ensurePin(jar);
  // The onboarding question sits between the PIN and the pages this actor is
  // about, so it is answered here, once, for every suite.
  await completeOnboarding(jar);
  const accessToken = await oauthFlow(jar);
  return { email, accountId, pin, accessToken, jar };
}

/**
 * An actor that arrives the way a real person does: through the registration
 * pages. Nothing is injected through the ops queue, so the account lands with
 * NO first name and NO area on file — the state that broke stage-3 disclosure.
 * Use this (rather than bootstrapActor) for anything that exercises the
 * collection path.
 */
export async function registerActor(): Promise<TestActor> {
  const email = testEmail();
  const jar = new Jar();
  const start = await counterFetch(jar, '/register', form({ email }));
  if (start.status !== 200) throw new Error(`register start failed: ${start.status}`);
  const verificationId = (await start.text()).match(/name="verification_id" value="([^"]+)"/)?.[1];
  if (!verificationId) throw new Error('no verification_id on the code page');
  const code = '424242';
  await dbExec(`UPDATE email_verifications SET code_hash = :h WHERE id = :id::uuid`, [
    { name: 'h', value: sha256hex(`${code}:${verificationId}`) },
    { name: 'id', value: verificationId },
  ]);
  const v = await counterFetch(jar, '/verify', form({ verification_id: verificationId, code }));
  if (v.status !== 303) throw new Error(`verify failed: ${v.status}`);

  const pin = TEST_PIN;
  const setPin = await counterFetch(jar, '/pin/set', form({ pin, pin2: pin }));
  if (setPin.status !== 303) throw new Error(`pin set failed: ${setPin.status}`);
  const consent = await counterFetch(jar, '/consent', form({ adult: 'yes', consent: 'yes' }));
  if (consent.status !== 303) throw new Error(`consent failed: ${consent.status}`);

  const accountId = (
    await dbExec('SELECT id FROM accounts WHERE email_hash = :h', [
      { name: 'h', value: sha256hex(email.trim().toLowerCase()) },
    ])
  )[0]?.[0] as string;
  if (!accountId) throw new Error(`no account row for ${email}`);
  const accessToken = await oauthFlow(jar);
  return { email, accountId, pin, accessToken, jar };
}

/** What a signed-in human would see on their "what you share on a match" page. */
export async function readSharedProfilePage(
  jar: Jar,
): Promise<{ firstName: string; locality: string }> {
  const res = await counterFetch(jar, '/profile');
  if (res.status !== 200) throw new Error(`profile page: ${res.status}`);
  const body = await res.text();
  return {
    firstName: body.match(/id="first_name"[^>]*value="([^"]*)"/)?.[1] ?? '',
    locality: body.match(/id="locality"[^>]*value="([^"]*)"/)?.[1] ?? '',
  };
}

/** Fill the shared profile from the human's own page. */
export async function setSharedProfile(
  jar: Jar,
  firstName: string,
  locality: string,
): Promise<Response> {
  return counterFetch(jar, '/profile', form({ first_name: firstName, locality }));
}

/**
 * Approve a stage-3 disclosure at the approval page, supplying the first name
 * and area in the same submission when the page is asking for them.
 */
export async function approveDisclosure(
  jar: Jar,
  matchId: string,
  pin: string,
  shared?: { firstName: string; locality: string },
): Promise<{ status: number; body: string; asked: boolean }> {
  const page = await counterFetch(jar, `/approvals/match/${matchId}`);
  const pageBody = await page.text();
  const asked = pageBody.includes('name="first_name"');
  const res = await counterFetch(
    jar,
    '/approve',
    form({
      action: 'stage3-disclosure',
      ref_id: matchId,
      decision: 'approve',
      pin,
      ...(shared ? { first_name: shared.firstName, locality: shared.locality } : {}),
    }),
  );
  return { status: res.status, body: await res.text(), asked };
}

/**
 * The names step the way a person does it: the single-use link their agent was
 * handed, read once and then pressed with the PIN. From 2026-09-12 this is the
 * ONLY road to an opt-in — respond(opt_in) records nothing and answers
 * CONSENT_REQUIRED carrying this link, every time. Pass the human_action of
 * that refusal (or the link on its own) straight in.
 *
 * Where nothing is on file the same page asks for the first name and area, so
 * the two fields ride along with the press; `asked` says whether it did.
 */
export async function pressNamesLink(
  actor: TestActor,
  humanAction: string,
  shared?: { firstName: string; locality: string },
): Promise<{ status: number; body: string; asked: boolean }> {
  const link = String(humanAction).match(/https?:\/\/\S+\/a\/\S+/)?.[0];
  if (!link) throw new Error(`no one-question link to press in: ${humanAction}`);
  const ask = await counterFetch(actor.jar, link);
  const askBody = await ask.text();
  if (ask.status !== 200) throw new Error(`the names page answered ${ask.status}`);
  if (!askBody.includes('Share your first name and area')) {
    throw new Error(`the link did not open the names question: ${askBody.slice(0, 200)}`);
  }
  const pressed = await counterFetch(
    actor.jar,
    link,
    form({
      decision: 'yes',
      pin: actor.pin,
      ...(shared ? { first_name: shared.firstName, locality: shared.locality } : {}),
    }),
  );
  return {
    status: pressed.status,
    body: await pressed.text(),
    asked: askBody.includes('name="first_name"'),
  };
}

/**
 * Both humans through the names step on one introduction, which is what opens
 * stage 3. Each side's agent asks for the opt-in, is refused with that human's
 * own single-use link, and the human presses it; two presses and the details
 * are open. Returns the two refusals, in the order the parties were given, so
 * a suite can assert on what the agent was told.
 */
export async function reachStage3(
  introId: string,
  parties: { actor: TestActor; shared?: { firstName: string; locality: string } }[],
): Promise<{ raw: string; result: any; isError: boolean }[]> {
  const refusals: { raw: string; result: any; isError: boolean }[] = [];
  for (const { actor, shared } of parties) {
    const refused = await mcpCall(actor.accessToken, 'respond', {
      intro_id: introId,
      action: 'opt_in',
    });
    if (!refused.isError || refused.result?.code !== 'CONSENT_REQUIRED') {
      throw new Error(`opt_in should be refused with the link: ${JSON.stringify(refused.result)}`);
    }
    const pressed = await pressNamesLink(actor, refused.result.human_action, shared);
    if (pressed.status !== 200) {
      throw new Error(`the names press answered ${pressed.status}: ${pressed.body.slice(0, 200)}`);
    }
    refusals.push(refused);
  }
  return refusals;
}

/**
 * OAuth 2.1 flow, 0.D shape: DCR + PKCE on the MCP hostname; the human
 * login/consent half happens on the COUNTER hostname with a signed-in
 * counter session (the PIN and passkey never transit the agent path).
 */
export async function oauthFlow(jar: Jar): Promise<string> {
  const redirectUri = 'http://127.0.0.1:47391/cb';
  // 1. Dynamic client registration.
  const reg = await fetch(`${BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.OSB_RATELIMIT_BYPASS
        ? { 'x-osb-ratelimit-bypass': process.env.OSB_RATELIMIT_BYPASS }
        : {}),
    },
    body: JSON.stringify({ client_name: 'osb-integration-suite', redirect_uris: [redirectUri] }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const client = (await reg.json()) as any;

  // 2. PKCE.
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // 3. /oauth/authorize on the MCP host hands the human over to the counter.
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'switchboard',
    state: 'st-' + randomBytes(6).toString('hex'),
    resource: `${BASE_URL}/mcp`,
  });
  const handoff = await fetch(`${BASE_URL}/oauth/authorize?${q}`, { redirect: 'manual' });
  if (handoff.status !== 302) throw new Error(`authorize handoff failed: ${handoff.status}`);
  const counterUrl = handoff.headers.get('location')!;
  if (!counterUrl.startsWith(COUNTER_URL)) throw new Error(`handoff not to counter: ${counterUrl}`);

  // 4. The counter authorize page (signed-in session) + approval post.
  const page = await counterFetch(jar, counterUrl);
  if (page.status !== 200) throw new Error(`counter authorize page: ${page.status} -> ${page.headers.get('location')}`);
  const approve = await counterFetch(jar, '/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ decision: 'approve' }).toString(),
  });
  // Approval is a plain redirect to the callback, loopback or https alike.
  if (approve.status !== 303) throw new Error(`counter approve failed: ${approve.status}`);
  const authCode = new URL(approve.headers.get('location')!).searchParams.get('code') ?? undefined;
  if (!authCode) throw new Error(`no code handed back (status ${approve.status})`);

  // 5. Token exchange (MCP host).
  const tok = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (tok.status !== 200) throw new Error(`token failed: ${tok.status}`);
  const tokens = (await tok.json()) as any;
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('missing tokens');
  return tokens.access_token as string;
}

let rpcId = 1;
/** Raw MCP tools/call over Streamable HTTP. Returns { raw, result }. */
export async function mcpCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ raw: string; result: any; isError: boolean }> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`mcp ${name} http ${res.status}: ${raw.slice(0, 300)}`);
  let payload: any;
  if (raw.startsWith('event:') || raw.includes('\ndata:') || raw.startsWith('data:')) {
    const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
    payload = JSON.parse(dataLine!.slice(5));
  } else {
    payload = JSON.parse(raw);
  }
  if (payload.error) throw new Error(`mcp rpc error: ${JSON.stringify(payload.error)}`);
  const result = payload.result;
  const isError = result?.isError === true;
  const text = result?.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : result;
  if (name === 'publish_intent' && !isError && parsed?.intent_id) {
    const mine = publishedCards.get(token) ?? new Set<string>();
    mine.add(parsed.intent_id as string);
    publishedCards.set(token, mine);
  }
  return { raw, result: parsed, isError };
}

// ---------------------------------------------------------------------------
// Board hygiene. Every card these suites publish lives on the shared dev
// board until it expires, and the matcher reads that board: a few hundred
// leftover fixture cards in one category is a pile that later runs have to
// find their own counterpart inside. So the suite takes its cards back down
// when it is done - through withdraw_intent, the same door a person's agent
// uses - and publishes them with the shortest TTL the protocol allows so that
// a run which dies mid-flight still clears itself within a day.
//
// The hook is registered from module scope, which the runner attaches to the
// file currently being loaded: importing these helpers is what opts a suite
// in, so no suite can forget. Two runners load this file - vitest for the
// integration suites, Playwright for the counter journey - and neither will
// tolerate the other's package being imported inside its process, so each is
// tried in turn and whichever answers gets the hook.
// ---------------------------------------------------------------------------
const publishedCards = new Map<string, Set<string>>();

/** The TTL fixture cards get: one day, the protocol minimum. */
export const FIXTURE_TTL_DAYS = 1;

export async function withdrawPublishedCards(): Promise<number> {
  let taken = 0;
  for (const [token, ids] of publishedCards) {
    for (const id of ids) {
      try {
        const r = await mcpCall(token, 'withdraw_intent', { intent_id: id });
        if (!r.isError) taken++;
      } catch {
        // A card the suite already withdrew, or an account whose token has
        // gone: teardown is best-effort and never fails a green run.
      }
    }
  }
  publishedCards.clear();
  console.log(`board teardown: withdrew ${taken} fixture cards`);
  return taken;
}

/**
 * Take named cards down NOW rather than at the end of the run.
 *
 * The posting quota an account lives under is five open wants and haves, so a
 * suite that needs a fresh pair for each of several gates cannot leave the
 * earlier pairs standing: by the sixth publish the quota refuses it and the
 * gate fails on the board rather than on what it set out to prove. A gate that
 * puts its own pair back as it ends never gets near the ceiling.
 *
 * Same door as everything else here - `withdraw_intent`, the one a person's
 * agent uses - and the card is dropped from the teardown list so the run's
 * final sweep does not count it twice. Best-effort: a card already gone never
 * fails a gate.
 */
export async function withdrawCards(token: string, ...intentIds: string[]): Promise<void> {
  const mine = publishedCards.get(token);
  for (const id of intentIds) {
    try {
      await mcpCall(token, 'withdraw_intent', { intent_id: id });
    } catch {
      // Already withdrawn, or a token that has gone.
    }
    mine?.delete(id);
  }
}

/**
 * Nagatha, the standing agent under test. Her cards are hers: every harness
 * that touches them does it deliberately and by name, and this helper refuses
 * to sweep them by accident.
 */
export const NAGATHA_ACCOUNT_ID = '411af5b9-b2a9-4126-83f8-73bf4934f5dd';

/**
 * Take down EVERY live card owned by the accounts a run created, not only the
 * ones the run remembered publishing.
 *
 * WHY THIS EXISTS. A harness tracks the cards it published through its own
 * helpers, and `withdrawPublishedCards` / `Harness.reclaimCards` take those
 * back. But an eval run drives a real agent, and a driven agent publishes
 * cards of its own accord — an amend that reposts, a second listing it decided
 * to make, a card published after the last snapshot the runner took. Those
 * were never in the tracking list, so they stayed PUBLISHED on the dev board
 * after the run that made them was over, matched against later runs, and were
 * the residue this fixes. The accounts are fresh per run and abandoned after
 * it, so nothing they own is wanted once the run ends: withdrawing all of it
 * is right, not merely convenient.
 *
 * Withdrawal, not deletion: the card moves to WITHDRAWN, the same terminal
 * state the owning agent would put it in. Best-effort in the strong sense —
 * it never throws, so it can never fail a green run.
 */
export async function retireAccountCards(
  accountIds: (string | undefined)[],
  label = 'teardown',
): Promise<number> {
  const ids = [...new Set(accountIds.filter((id): id is string => !!id))].filter(
    (id) => id !== NAGATHA_ACCOUNT_ID,
  );
  if (!ids.length) return 0;
  try {
    const rows = await dbExec(
      `UPDATE cards SET lifecycle_state = 'WITHDRAWN', updated_at = now()
        WHERE account_id = ANY(string_to_array(:ids, ',')::uuid[])
          AND lifecycle_state IN ('PUBLISHED','PENDING_SCREENING')
        RETURNING id`,
      [{ name: 'ids', value: ids.join(',') }],
    );
    const n = rows.length;
    console.log(`board ${label}: retired ${n} card(s) across ${ids.length} run account(s)`);
    return n;
  } catch (e) {
    console.log(`board ${label}: card retirement failed (${(e as Error).message})`);
    return 0;
  }
}

for (const register of [
  async () => (await import('vitest')).afterAll(withdrawPublishedCards, 300_000),
  async () => (await import('@playwright/test')).test.afterAll(withdrawPublishedCards),
]) {
  try {
    await register();
    break;
  } catch {
    // Not this runner (or not a runner at all - a script importing these
    // helpers gets no hook, and takes its own cards down).
  }
}

export async function mcpRpc(token: string, method: string, params: any): Promise<any> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const raw = await res.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(dataLine ? dataLine.slice(5) : raw);
}

export const SCHEMA_VERSION = '0.3.0';

/**
 * Run-unique geo bucket for the minimal fixtures. Since 0.F the matcher is
 * live on dev: cards in a bucket shared with previous runs' leftovers get
 * auto-matched against them, turning fixture cards into CONTESTED holders
 * (collection window) and breaking single-pair assertions. A per-run bucket
 * keeps each suite run an island: '_' keeps it out of the geohash namespace
 * AND out of the 0.3.0 gazetteer, so these cards stay unplaced and meet only
 * cards carrying the same string. Real place resolution is proved in
 * geo.test.ts, where two spellings of one city have to meet.
 */
export const RUN_BUCKET = `g_${randomBytes(2).toString('hex')}`;

export function minimalWant(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    type: 'WANT',
    category: 'goods.bicycle.mountain',
    geo: { bucket: RUN_BUCKET, radius_km: 25 },
    ttl_days: FIXTURE_TTL_DAYS,
    ...overrides,
  };
}

export function minimalHave(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    type: 'HAVE',
    category: 'goods.bicycle.mountain',
    geo: { bucket: RUN_BUCKET, radius_km: 25 },
    ttl_days: FIXTURE_TTL_DAYS,
    ...overrides,
  };
}

/**
 * list_intents shares the per-account hourly read ceiling (60/h) with the
 * other read tools, so waits are budgeted: 5s between polls, ONE poller per
 * account. When an account holds several cards, wait for them together with
 * waitForCardStates — N concurrent single-card waits on one token burn the
 * ceiling N times as fast, and a blown ceiling fails every later read for
 * the rest of the hour.
 */
export async function waitForCardStates(
  token: string,
  intentIds: string[],
  want: string[],
  timeoutMs = 120_000,
): Promise<Record<string, string>> {
  const pending = new Set(intentIds);
  const reached: Record<string, string> = {};
  return poll(
    async () => {
      const r = await mcpCall(token, 'list_intents', {});
      if (!r.result?.intents) {
        // RATE_LIMITED (blown read ceiling) or another error envelope:
        // continuing to poll hides the cause — fail loudly with it.
        throw new Error(
          `list_intents failed while waiting for card state: ${JSON.stringify(r.result ?? r).slice(0, 300)}`,
        );
      }
      for (const i of r.result.intents) {
        if (pending.has(i.intent_id) && want.includes(i.state)) {
          pending.delete(i.intent_id);
          reached[i.intent_id] = i.state as string;
        }
      }
      return pending.size === 0 ? reached : undefined;
    },
    `cards [${[...pending].join(', ')}] to reach ${want.join('|')}`,
    timeoutMs,
    5_000,
  );
}

export async function waitForCardState(
  token: string,
  intentId: string,
  want: string[],
  timeoutMs = 120_000,
): Promise<string> {
  const reached = await waitForCardStates(token, [intentId], want, timeoutMs);
  return reached[intentId];
}
