/**
 * Review item M2 against the live deployment: the press approves the assistant
 * the page showed. Another page can point the person's browser at /authorize
 * with a different app's request while their tab is open; the press on the
 * original page must then approve nothing, and the newer request must still
 * work from its own page.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  BASE_URL,
  TestActor,
  authorizeRequestField,
  bootstrapActor,
  counterFetch,
  liveFetch,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

async function counterAuthorizeUrl(name: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:47391/cb';
  const reg = await liveFetch(`${BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.OSB_RATELIMIT_BYPASS ? { 'x-osb-ratelimit-bypass': process.env.OSB_RATELIMIT_BYPASS } : {}),
    },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri] }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as any;
  const challenge = createHash('sha256').update(randomBytes(48).toString('base64url')).digest('base64url');
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
  const handoff = await liveFetch(`${BASE_URL}/oauth/authorize?${q}`, { redirect: 'manual' });
  expect(handoff.status).toBe(302);
  return handoff.headers.get('location')!;
}

let ada: TestActor;

d('authorize press is bound to the request the page showed', () => {
  beforeAll(async () => {
    ada = await bootstrapActor('Ada', 'Fremantle');
  }, 300_000);

  it('a swapped-in request approves nothing from the old page, and works from its own', async () => {
    const shown = await counterFetch(ada.jar, await counterAuthorizeUrl('the one Ada meant'));
    expect(shown.status).toBe(200);
    const shownRequest = authorizeRequestField(await shown.text());

    // Another page sends Ada's browser to /authorize for a different app.
    const swapped = await counterFetch(ada.jar, await counterAuthorizeUrl('somebody else'));
    expect(swapped.status).toBe(200);
    const swappedRequest = authorizeRequestField(await swapped.text());
    expect(swappedRequest).not.toBe(shownRequest);

    // Ada presses on the page she was looking at: nothing is approved.
    for (const decision of ['approve', 'cancel']) {
      const press = await counterFetch(ada.jar, '/authorize', form({ decision, request: shownRequest, pin: ada.pin }));
      expect(press.status).toBe(409);
      expect(press.headers.get('location')).toBeNull();
    }
    // No fingerprint at all is refused the same way.
    const bare = await counterFetch(ada.jar, '/authorize', form({ decision: 'approve', pin: ada.pin }));
    expect(bare.status).toBe(409);

    // The request now held is still approvable from its own page.
    const ok = await counterFetch(ada.jar, '/authorize', form({ decision: 'approve', request: swappedRequest, pin: ada.pin }));
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });
});
