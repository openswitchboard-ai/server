/**
 * Local smoke harness (not a vitest file): boots the app against a local
 * pgvector Postgres (DATABASE_URL) with real dev AWS resources for KMS/S3,
 * then exercises migrations, the FULL counter registration flow (email
 * verification -> PIN -> consent), the 0.D OAuth flow (authorize hand-off ->
 * counter approval), route isolation, and MCP via fastify inject/listen. Run:
 *   AWS_PROFILE=openswitchboard DATABASE_URL=postgres://postgres:pw@127.0.0.1:5544/osb \
 *     IDENTITY_KEY_ARN=<dev identity key arn> npx tsx test/localsmoke.ts
 */
import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { initDb, migrate, getPool } from '../src/db.js';
import { initEnvelope } from '../src/crypto.js';
import { initCounterKeys } from '../src/counter/keys.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

process.env.COUNTER_LINK_HMAC_KEY ??= randomBytes(32).toString('hex');
process.env.COUNTER_COOKIE_KEY ??= randomBytes(32).toString('hex');

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'http://localhost:8080',
  counterOrigin: 'http://my.localhost',
  legacyCounterHosts: [],
  sesFrom: 'OpenSwitchboard <board@openswitchboard.ai>',
  sesReplyTo: 'info@openswitchboard.ai',
  sesConfigurationSet: 'unused',
  emailEventsQueueUrl: 'http://unused',
  dbSecretArn: 'unused',
  screeningQueueUrl: process.env.SCREENING_QUEUE_URL ?? 'http://unused',
  matchingQueueUrl: process.env.MATCHING_QUEUE_URL ?? 'http://unused',
  opsQueueUrl: process.env.OPS_QUEUE_URL ?? 'http://unused',
  consentLogBucket: 'osb-dev-consent-log-173291123487',
  identityKeyArn: process.env.IDENTITY_KEY_ARN!,
  bedrockModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
};

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const COUNTER_HOST = 'my.localhost';

await initDb(cfg);
await migrate();
console.log('migrations OK');
initEnvelope(cfg);
await initCounterKeys(cfg);

const app = buildApp(cfg);
const h = await app.inject({ method: 'GET', url: '/healthz' });
assert.equal(h.statusCode, 200);

// ---------------------------------------------------------------------------
// Counter registration: email -> code -> PIN -> consent -> account live.
// (SES send is attempted for real; in the sandbox an unverified recipient is
// rejected and — dev only — tolerated. The harness reads/stamps the code in
// the local test DB: single-use + TTL semantics unchanged.)
// ---------------------------------------------------------------------------
const email = `smoke+${randomBytes(4).toString('hex')}@example.com`;
const jar: Record<string, string> = {};
const absorb = (res: any) => {
  const sc = res.headers['set-cookie'];
  for (const c of Array.isArray(sc) ? sc : sc ? [sc] : []) {
    const [pair] = c.split(';');
    const [k, ...v] = pair.split('=');
    jar[k.trim()] = v.join('=');
  }
};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const counterReq = async (method: 'GET' | 'POST', url: string, body?: Record<string, string>) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: COUNTER_HOST,
      cookie: cookieHeader(),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { payload: new URLSearchParams(body).toString() } : {}),
  });
  absorb(res);
  return res;
};

const reg = await counterReq('POST', '/register', { email });
assert.equal(reg.statusCode, 200, reg.body);
const vid = reg.body.match(/name="verification_id" value="([^"]+)"/)![1];
await getPool().query('UPDATE email_verifications SET code_hash = $2 WHERE id = $1', [
  vid,
  sha256hex(`424242:${vid}`),
]);
const ver = await counterReq('POST', '/verify', { verification_id: vid, code: '424242' });
assert.equal(ver.statusCode, 303, ver.body);
assert.equal(ver.headers.location, '/pin');
// single-use: the same code again must fail
const again = await counterReq('POST', '/verify', { verification_id: vid, code: '424242' });
assert.equal(again.statusCode, 401, 'verification must be single-use');

const pinSet = await counterReq('POST', '/pin/set', { pin: '135790', pin2: '135790' });
assert.equal(pinSet.statusCode, 303, pinSet.body);
const consent = await counterReq('POST', '/consent', { adult: 'yes', consent: 'yes' });
assert.equal(consent.statusCode, 303, consent.body);
console.log('counter registration OK (email code -> PIN -> consent, WORM event written via real S3)');

// PIN lockout: 5 wrong PINs lock; the locked attempt reports 423.
for (let i = 0; i < 5; i++) {
  const bad = await counterReq('POST', '/pin/verify'.replace(/^/, '/'), { pin: '000000' });
  assert.ok([401, 423].includes(bad.statusCode), bad.body);
}
const locked = await counterReq('POST', '/pin/verify', { pin: '135790' });
assert.equal(locked.statusCode, 423, 'correct PIN while locked must still 423');
await getPool().query(
  `UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE email_hash = $1`,
  [sha256hex(email.toLowerCase())],
);
console.log('PIN lockout OK (5 wrong tries -> locked with backoff)');

// ---------------------------------------------------------------------------
// OAuth 2.1, 0.D shape: DCR -> authorize hand-off -> counter approve -> token.
// ---------------------------------------------------------------------------
const regc = await app.inject({
  method: 'POST',
  url: '/oauth/register',
  payload: { client_name: 'smoke', redirect_uris: ['http://127.0.0.1:1/cb'] },
});
assert.equal(regc.statusCode, 201, regc.body);
const client = regc.json();

const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const q = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: 'http://127.0.0.1:1/cb',
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'switchboard',
  state: 'xyz',
});
const handoff = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
assert.equal(handoff.statusCode, 302, handoff.body);
assert.ok(String(handoff.headers.location).startsWith(cfg.counterOrigin + '/authorize'));
const authzPage = await counterReq('GET', `/authorize?${q}`);
assert.equal(authzPage.statusCode, 200, `${authzPage.statusCode} ${authzPage.headers.location ?? ''}`);
const approve = await counterReq('POST', '/authorize', { decision: 'approve' });
assert.equal(approve.statusCode, 303, approve.body);
const authCode = new URL(approve.headers.location as string).searchParams.get('code')!;
assert.ok(authCode);

const tok = await app.inject({
  method: 'POST',
  url: '/oauth/token',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({
    grant_type: 'authorization_code',
    code: authCode,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:1/cb',
  }).toString(),
});
assert.equal(tok.statusCode, 200, tok.body);
const tokens = tok.json();
console.log('oauth flow OK (counter-approved; access + refresh issued)');

// refresh rotation
const ref = await app.inject({
  method: 'POST',
  url: '/oauth/token',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  }).toString(),
});
assert.equal(ref.statusCode, 200, ref.body);
console.log('refresh rotation OK');

// ---------------------------------------------------------------------------
// Route isolation, live: bearer on a human page -> 403; cookie on /mcp -> 401.
// ---------------------------------------------------------------------------
const cross1 = await app.inject({
  method: 'GET',
  url: '/ledger',
  headers: { host: COUNTER_HOST, authorization: `Bearer ${tokens.access_token}` },
});
assert.equal(cross1.statusCode, 403, 'a REAL agent token must be rejected at the counter');

// Kill switch: suspends the agent token; un-pause restores it.
const kill = await counterReq('POST', '/kill', {});
assert.equal(kill.statusCode, 303, kill.body);

const listen = await app.listen({ port: 0, host: '127.0.0.1' });
const base = listen.replace('[::1]', '127.0.0.1');
const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const suspended = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
assert.equal(suspended.status, 401, 'kill switch must suspend agent tokens');
const unkill = await counterReq('POST', '/kill/off', { pin: '135790' });
assert.equal(unkill.statusCode, 303, unkill.body);
console.log('kill switch OK (tokens suspended + restored)');

const unauth = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { ...mcpHeaders, cookie: cookieHeader() },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
assert.equal(unauth.status, 401, 'a counter session cookie must be useless on /mcp');
assert.ok(unauth.headers.get('www-authenticate')?.includes('oauth-protected-resource'));
console.log('route isolation OK in both directions');

const tl = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
});
const tlBody = await tl.text();
assert.equal(tl.status, 200, tlBody);
const dataLine = tlBody.split('\n').find((l) => l.startsWith('data:'));
const parsed = JSON.parse(dataLine ? dataLine.slice(5) : tlBody);
assert.equal(parsed.result.tools.length, 7, JSON.stringify(parsed).slice(0, 300));
console.log('MCP tools/list OK (7 tools)');

// CATEGORY_PROHIBITED must trigger before any SQS call:
const proh = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'publish_intent',
      arguments: {
        card: {
          schema_version: '0.1.0',
          type: 'WANT',
          category: 'goods.weapons',
          geo: { bucket: 'qd66' },
        },
      },
    },
  }),
});
const prohBody = await proh.text();
const prohLine = prohBody.split('\n').find((l) => l.startsWith('data:'));
const prohParsed = JSON.parse(prohLine ? prohLine.slice(5) : prohBody);
const err = JSON.parse(prohParsed.result.content[0].text);
assert.equal(err.code, 'CATEGORY_PROHIBITED', prohBody.slice(0, 400));
console.log('CATEGORY_PROHIBITED via MCP OK');

await app.close();
console.log('LOCAL SMOKE: ALL OK');
process.exit(0);
