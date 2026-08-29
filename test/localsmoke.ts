/**
 * Local smoke harness (not a vitest file): boots the app against a local
 * pgvector Postgres (DATABASE_URL) with real dev AWS resources for KMS/S3,
 * then exercises migrations, account creation, the OAuth flow and an MCP
 * tools/list via fastify inject. Run:
 *   AWS_PROFILE=openswitchboard DATABASE_URL=postgres://postgres:pw@127.0.0.1:5544/osb \
 *     npx tsx test/localsmoke.ts
 */
import assert from 'node:assert';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { initDb, migrate } from '../src/db.js';
import { initEnvelope } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { createAccount } from '../src/domain/accounts.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'http://localhost:8080',
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

await initDb(cfg);
await migrate();
console.log('migrations OK');
initEnvelope(cfg);

const email = `smoke+${randomBytes(4).toString('hex')}@example.com`;
const code = 'osb-dev-smoketest';
const salt = randomBytes(16);
const accountId = await createAccount({
  email,
  first_name: 'Smokey',
  locality: 'Testville',
  login_code_hash: `scrypt$${salt.toString('hex')}$${scryptSync(code, salt, 32).toString('hex')}`,
});
console.log('account created (envelope-encrypted via real KMS):', accountId);

const app = buildApp(cfg);
const h = await app.inject({ method: 'GET', url: '/healthz' });
assert.equal(h.statusCode, 200);

// DCR
const reg = await app.inject({
  method: 'POST',
  url: '/oauth/register',
  payload: { client_name: 'smoke', redirect_uris: ['http://127.0.0.1:1/cb'] },
});
assert.equal(reg.statusCode, 201, reg.body);
const client = reg.json();

// authorize (login form post)
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const form = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: 'http://127.0.0.1:1/cb',
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'switchboard',
  state: 'xyz',
  resource: '',
  email,
  login_code: code,
});
const az = await app.inject({
  method: 'POST',
  url: '/oauth/authorize',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: form.toString(),
});
assert.equal(az.statusCode, 302, az.body);
const authCode = new URL(az.headers.location as string).searchParams.get('code')!;

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
console.log('oauth flow OK (access + refresh issued)');

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

// MCP over HTTP: 401 without token, tools/list with token.
const listen = await app.listen({ port: 0, host: '127.0.0.1' });
const base = listen.replace('[::1]', '127.0.0.1');
const unauth = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
assert.equal(unauth.status, 401);
assert.ok(unauth.headers.get('www-authenticate')?.includes('oauth-protected-resource'));

const tl = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${tokens.access_token}`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
});
const tlBody = await tl.text();
assert.equal(tl.status, 200, tlBody);
const dataLine = tlBody.split('\n').find((l) => l.startsWith('data:'));
const parsed = JSON.parse(dataLine ? dataLine.slice(5) : tlBody);
assert.equal(parsed.result.tools.length, 7, JSON.stringify(parsed).slice(0, 300));
console.log('MCP tools/list OK (7 tools)');

// publish_intent to a nonexistent queue should fail cleanly (SQS unreachable),
// but a CATEGORY_PROHIBITED error must trigger before any SQS call:
const proh = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${tokens.access_token}`,
  },
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
