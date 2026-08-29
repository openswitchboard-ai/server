import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

export const BASE_URL = process.env.OSB_BASE_URL ?? 'https://mcp-dev.openswitchboard.ai';
export const ENV_NAME = process.env.OSB_TEST_ENV ?? 'dev';
const region = process.env.AWS_REGION ?? 'us-east-1';

const ssm = new SSMClient({ region });
const sqs = new SQSClient({ region });

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

export interface TestActor {
  email: string;
  code: string;
  accessToken: string;
}

/** Bootstrap a dev account via the internal ops queue, then run the full
 * OAuth 2.1 flow (DCR + authorization-code + PKCE) against the live server. */
export async function bootstrapActor(firstName: string, locality: string): Promise<TestActor> {
  const email = `testsuite+${randomBytes(6).toString('hex')}@openswitchboard.ai`;
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
  const accessToken = await poll(
    () => oauthFlow(email, code).catch(() => undefined),
    `account ${email} to be usable via OAuth`,
  );
  return { email, code, accessToken };
}

export async function oauthFlow(email: string, code: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:47391/cb';
  // 1. Dynamic client registration.
  const reg = await fetch(`${BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'osb-integration-suite', redirect_uris: [redirectUri] }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const client = (await reg.json()) as any;

  // 2. PKCE.
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // 3. Login+consent form post -> 302 with code.
  const form = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'switchboard',
    state: 'st-' + randomBytes(6).toString('hex'),
    resource: `${BASE_URL}/mcp`,
    email,
    login_code: code,
  });
  const authz = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  if (authz.status !== 302) throw new Error(`authorize failed: ${authz.status}`);
  const loc = new URL(authz.headers.get('location')!);
  const authCode = loc.searchParams.get('code');
  if (!authCode) throw new Error('no code in redirect');

  // 4. Token exchange.
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

export const SCHEMA_VERSION = '0.1.0';

export function minimalWant(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    type: 'WANT',
    category: 'goods.bicycle.mountain',
    geo: { bucket: 'qd66', radius_km: 25 },
    ...overrides,
  };
}

export function minimalHave(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    type: 'HAVE',
    category: 'goods.bicycle.mountain',
    geo: { bucket: 'qd66', radius_km: 25 },
    ...overrides,
  };
}

export async function waitForCardState(
  token: string,
  intentId: string,
  want: string[],
  timeoutMs = 120_000,
): Promise<string> {
  return poll(
    async () => {
      const r = await mcpCall(token, 'list_intents', {});
      const item = r.result.intents.find((i: any) => i.intent_id === intentId);
      if (item && want.includes(item.state)) return item.state as string;
      return undefined;
    },
    `card ${intentId} to reach ${want.join('|')}`,
    timeoutMs,
  );
}
