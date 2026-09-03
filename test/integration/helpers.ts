import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';

export const BASE_URL = process.env.OSB_BASE_URL ?? 'https://mcp-dev.openswitchboard.ai';
export const COUNTER_URL = process.env.OSB_COUNTER_URL ?? 'https://my-dev.openswitchboard.ai';
/** The hostname the human pages used to be on. It still answers, with a 308. */
export const LEGACY_COUNTER_URL =
  process.env.OSB_LEGACY_COUNTER_URL ?? 'https://counter-dev.openswitchboard.ai';
export const ENV_NAME = process.env.OSB_TEST_ENV ?? 'dev';
const region = process.env.AWS_REGION ?? 'us-east-1';

const ssm = new SSMClient({ region });
const sqs = new SQSClient({ region });
const rdsData = new RDSDataClient({ region });

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

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
export async function ensurePin(jar: Jar, pin = '246810'): Promise<string> {
  const res = await counterFetch(jar, '/');
  if (res.status === 303 && res.headers.get('location')?.includes('/pin')) {
    const set = await counterFetch(jar, '/pin/set', form({ pin, pin2: pin }));
    if (set.status !== 303) throw new Error(`pin set failed: ${set.status}`);
  }
  return pin;
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
  // The ops queue is shared and strictly ordered per batch: a burst of
  // match-notify sends can sit in front of this create-account for well over a
  // minute. Waiting longer costs nothing when the queue is quiet.
  const accountId = await poll(
    async () => {
      const rows = await dbExec('SELECT id FROM accounts WHERE email_hash = :h', [
        { name: 'h', value: sha256hex(email.trim().toLowerCase()) },
      ]);
      return rows[0]?.[0] as string | undefined;
    },
    `account ${email} to exist`,
    180_000,
  );
  const jar = new Jar();
  await counterLogin(jar, email);
  const pin = await ensurePin(jar);
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

  const pin = '246810';
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
  // A loopback callback gets the handoff page (200), which carries the code
  // for copy-back; an https callback gets the plain redirect (303).
  let authCode: string | undefined;
  if (approve.status === 303) {
    authCode = new URL(approve.headers.get('location')!).searchParams.get('code') ?? undefined;
  } else if (approve.status === 200) {
    authCode = (await approve.text()).match(/id="codebox">(osb_ac_[A-Za-z0-9_-]+)</)?.[1];
  } else {
    throw new Error(`counter approve failed: ${approve.status}`);
  }
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
  return { raw, result: text ? JSON.parse(text) : result, isError };
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
    ...overrides,
  };
}

export function minimalHave(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    type: 'HAVE',
    category: 'goods.bicycle.mountain',
    geo: { bucket: RUN_BUCKET, radius_km: 25 },
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
          `list_intents failed while waiting for card state: ${JSON.stringify(r.error ?? r).slice(0, 300)}`,
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
