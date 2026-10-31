/**
 * A directory reviewer's account signs in with a passphrase, against a LIVE
 * deployment (src/counter/reviewerSignIn.ts, migration 070). Run with:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * Proves:
 *  - an ordinary account's address still gets an emailed code;
 *  - once marked through the ops queue, the same address asks for the
 *    passphrase and sends no code;
 *  - a wrong passphrase is refused, the right one signs in;
 *  - the session it opens has no PIN window: authorising an assistant still
 *    takes the account's PIN;
 *  - ending it puts the address back on emailed codes.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  BASE_URL,
  COUNTER_URL,
  Jar,
  TestActor,
  counterFetch,
  liveFetch,
  poll,
  registerActor,
  sendOp,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

async function loginPage(email: string): Promise<string> {
  const res = await counterFetch(new Jar(), '/login', form({ email }));
  return res.text();
}

describe.skipIf(!RUN)('reviewer sign-in', () => {
  let actor: TestActor;
  const passphrase = `osb-rv-${randomBytes(24).toString('base64url')}`;

  beforeAll(async () => {
    actor = await registerActor();
  }, 120_000);

  it('signs a reviewer in with the passphrase and nothing else', async () => {
    expect(await loginPage(actor.email)).toMatch(/name="verification_id"/);

    const passphrase_hash = await argon2.hash(passphrase, { type: argon2.argon2id });
    await sendOp({ op: 'reviewer-sign-in', action: 'enable', email: actor.email, passphrase_hash, label: 'integration', days: 1 });
    await poll(async () => ((await loginPage(actor.email)).includes('/login/reviewer') ? true : undefined), 'reviewer row live');
    expect(await loginPage(actor.email)).not.toMatch(/name="verification_id"/);

    const wrong = await counterFetch(new Jar(), '/login/reviewer', form({ email: actor.email, passphrase: passphrase + 'x' }));
    expect(wrong.status).toBe(401);

    const jar = new Jar();
    const right = await counterFetch(jar, '/login/reviewer', form({ email: actor.email, passphrase }));
    expect(right.status).toBe(303);
    expect(right.headers.get('location') ?? '').not.toMatch(/\/login/);

    // Authorising an assistant still takes the PIN.
    const reg = await liveFetch(`${BASE_URL}/oauth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.OSB_RATELIMIT_BYPASS ? { 'x-osb-ratelimit-bypass': process.env.OSB_RATELIMIT_BYPASS } : {}),
      },
      body: JSON.stringify({ client_name: 'osb-reviewer-test', redirect_uris: ['http://127.0.0.1:47391/cb'] }),
    });
    const client = (await reg.json()) as any;
    const verifier = randomBytes(48).toString('base64url');
    const q = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:47391/cb',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'switchboard',
      state: 'st-reviewer',
      resource: `${BASE_URL}/mcp`,
    });
    const handoff = await liveFetch(`${BASE_URL}/oauth/authorize?${q}`, { redirect: 'manual' });
    const counterUrl = handoff.headers.get('location')!;
    expect(counterUrl.startsWith(COUNTER_URL)).toBe(true);
    expect((await counterFetch(jar, counterUrl)).status).toBe(200);
    const noPin = await counterFetch(jar, '/authorize', form({ decision: 'approve' }));
    expect(new URL(noPin.headers.get('location') ?? 'http://x/').searchParams.get('code')).toBeNull();
    const withPin = await counterFetch(jar, '/authorize', form({ decision: 'approve', pin: actor.pin }));
    expect(withPin.status).toBe(303);
    expect(new URL(withPin.headers.get('location')!).searchParams.get('code')).toBeTruthy();

    await sendOp({ op: 'reviewer-sign-in', action: 'disable', email: actor.email });
    await poll(async () => (/name="verification_id"/.test(await loginPage(actor.email)) ? true : undefined), 'reviewer row gone');
  }, 240_000);
});
