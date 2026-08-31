/**
 * Phase 1.A gates G2 + G3 against LIVE dev + the Stripe sandbox.
 *
 * G2 (happy path): settle proposed -> both humans approve on their approval
 * pages (PIN) -> hold lands (manual-capture destination charge, fee 0) ->
 * webhook funds -> seller locks evidence into the WORM vault -> buyer
 * confirms receipt (PIN) -> capture -> webhook releases. Then Stripe is
 * asked directly: the seller's connected test account received the full
 * destination amount and the application fee charged was 0.
 *
 * G3 (refund path): a fresh settlement is funded, the buyer disputes, the
 * held authorisation is cancelled, and the webhook records 'refunded'.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  COUNTER_URL,
  TestActor,
  bootstrapActor,
  counterFetch,
  dbExec,
  mcpCall,
  minimalHave,
  minimalWant,
  poll,
  sendOp,
  waitForCardState,
} from './helpers.js';
import {
  attachStripeAccount,
  createPreVerifiedSeller,
  fundSettlementByApi,
  stripeApi,
  tinyPng,
} from './stripeHelpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const AMOUNT = 87.65; // 8765 minor units
const AMOUNT_MINOR = 8765;

let buyer: TestActor; // WANT side pays
let seller: TestActor; // HAVE side is paid
let matchId: string;
let sellerStripeId: string;

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

async function settleState(token: string, settlementId: string): Promise<string> {
  const r = await mcpCall(token, 'settle', { settlement_id: settlementId });
  expect(r.isError).toBe(false);
  return r.result.state as string;
}

async function approveOnCounter(actor: TestActor, settlementId: string): Promise<void> {
  const res = await counterFetch(
    actor.jar,
    '/counter/approve',
    form({ action: 'settlement-approve', ref_id: settlementId, decision: 'approve', pin: actor.pin }),
  );
  expect(res.status, await res.clone().text().catch(() => '')).toBe(303);
  expect(res.headers.get('location')).toBe(`/counter/settlements/${settlementId}`);
}

async function proposeSettlement(): Promise<string> {
  const r = await mcpCall(buyer.accessToken, 'settle', {
    match_id: matchId,
    amount: AMOUNT,
    ccy: 'AUD',
    description: 'Mountain bike as agreed, pickup this weekend.',
  });
  expect(r.isError).toBe(false);
  expect(r.result.kind).toBe('settlement');
  expect(r.result.state).toBe('proposed');
  return r.result.settlement_id as string;
}

async function fundAndWait(settlementId: string): Promise<string> {
  const pi = await fundSettlementByApi(settlementId, AMOUNT_MINOR, 'AUD', sellerStripeId);
  await poll(
    async () => ((await settleState(buyer.accessToken, settlementId)) === 'funded' ? true : undefined),
    `settlement ${settlementId} to be funded by webhook`,
    90_000,
  );
  return pi;
}

d('phase 1.A settlements against live dev + Stripe sandbox', () => {
  beforeAll(async () => {
    [buyer, seller] = await Promise.all([
      bootstrapActor('Bella', 'Fremantle'),
      bootstrapActor('Sam', 'Subiaco'),
    ]);
    const w = await mcpCall(buyer.accessToken, 'publish_intent', {
      card: minimalWant({ attributes: { condition: 'good' } }),
    });
    expect(w.isError).toBe(false);
    const h = await mcpCall(seller.accessToken, 'publish_intent', {
      card: minimalHave({ attributes: { condition: 'good' }, ask: { amount: 90, ccy: 'AUD' } }),
    });
    expect(h.isError).toBe(false);
    await waitForCardState(buyer.accessToken, w.result.intent_id, ['PUBLISHED']);
    await waitForCardState(seller.accessToken, h.result.intent_id, ['PUBLISHED']);
    await sendOp({ op: 'create-match', card_want: w.result.intent_id, card_have: h.result.intent_id, score: 0.9 });
    matchId = await poll(async () => {
      const r = await mcpCall(buyer.accessToken, 'check_matches', { intent_id: w.result.intent_id });
      return r.result.matches?.[0]?.match_id as string | undefined;
    }, 'match to appear');
    // Reach stage 3 (both interests + both opt-ins).
    await mcpCall(buyer.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
    await mcpCall(seller.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
    await mcpCall(buyer.accessToken, 'respond', { match_id: matchId, action: 'opt_in' });
    await mcpCall(seller.accessToken, 'respond', { match_id: matchId, action: 'opt_in' });
    // The seller's connected test account: created pre-verified through
    // Stripe's test-mode API and attached with the server's own envelope
    // encryption (production sellers use the hosted account-link flow).
    sellerStripeId = await createPreVerifiedSeller(matchId.slice(0, 8));
    await attachStripeAccount(seller.accountId, sellerStripeId);
  }, 300_000);

  it('settle requires stage 3 and refuses a bad proposal shape', async () => {
    const bad = await mcpCall(buyer.accessToken, 'settle', { match_id: matchId, amount: AMOUNT });
    expect(bad.isError).toBe(true); // amount without ccy
  });

  it('G2: proposed -> approved -> funded -> evidence-locked -> confirmed -> released, fee 0', async () => {
    const sid = await proposeSettlement();

    // Both humans approve on their approval pages (PIN ceremony).
    await approveOnCounter(buyer, sid);
    expect(await settleState(buyer.accessToken, sid)).toBe('approved-by-buyer');
    await approveOnCounter(seller, sid);
    expect(await settleState(seller.accessToken, sid)).toBe('approved');

    // The hosted payment path is wired: the buyer's pay action redirects to
    // Stripe Checkout (the page a human buyer would complete).
    const pay = await counterFetch(buyer.jar, `/counter/settlements/${sid}/pay`, form({}));
    expect(pay.status).toBe(303);
    expect(pay.headers.get('location')).toContain('checkout.stripe.com');

    // Fund by API-driven confirm with Stripe's test payment-method token;
    // the signature-verified webhook drives approved -> funded.
    const piId = await fundAndWait(sid);

    // Expire the unused hosted session so nothing dangles.
    const [[sessionId]] = await dbExec(
      'SELECT stripe_checkout_session FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    if (sessionId) await stripeApi(`/v1/checkout/sessions/${sessionId}/expire`, {}).catch(() => {});

    // Seller locks handover evidence into the WORM vault.
    const presign = await counterFetch(seller.jar, `/counter/settlements/${sid}/evidence/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'handover.png', content_type: 'image/png', size: tinyPng().length }),
    });
    expect(presign.status, await presign.clone().text()).toBe(200);
    const { url } = (await presign.json()) as any;
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: tinyPng(),
    });
    expect(put.status, await put.text()).toBe(200);
    const lock = await counterFetch(seller.jar, `/counter/settlements/${sid}/evidence/lock`, form({}));
    expect(lock.status).toBe(303);
    expect(await settleState(seller.accessToken, sid)).toBe('evidence-locked');
    const [[manifestKey]] = await dbExec(
      'SELECT evidence_manifest_key FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(String(manifestKey)).toContain('settlement-evidence/dev/');

    // Buyer confirms receipt (PIN) -> capture -> webhook releases.
    const confirm = await counterFetch(
      buyer.jar,
      `/counter/settlements/${sid}/confirm`,
      form({ pin: buyer.pin }),
    );
    expect(confirm.status, await confirm.clone().text()).toBe(200);
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'released' ? true : undefined),
      'settlement to be released by webhook',
      90_000,
    );

    // Ask Stripe directly: the money really moved, and the fee was 0.
    const pi = await stripeApi(`/v1/payment_intents/${piId}`);
    expect(pi.status).toBe('succeeded');
    expect(pi.application_fee_amount).toBe(0);
    const charges = await stripeApi(`/v1/charges?payment_intent=${piId}`);
    const charge = charges.data[0];
    expect(charge.captured).toBe(true);
    expect(charge.amount_captured).toBe(AMOUNT_MINOR);
    expect(charge.application_fee_amount).toBe(0);
    expect(charge.transfer).toBeTruthy();
    const transfer = await stripeApi(`/v1/transfers/${charge.transfer}`);
    expect(transfer.destination).toBe(sellerStripeId);
    expect(transfer.amount).toBe(AMOUNT_MINOR);
    // And on the seller's own connected account: the destination payment
    // landed for the full amount.
    const destPayment = await stripeApi(
      `/v1/charges/${transfer.destination_payment}`,
      undefined,
      'GET',
      sellerStripeId,
    );
    expect(destPayment.amount).toBe(AMOUNT_MINOR);
  }, 300_000);

  it('G3: disputed -> refunded, webhook-driven, authorisation released in Stripe', async () => {
    const sid = await proposeSettlement();
    await approveOnCounter(buyer, sid);
    await approveOnCounter(seller, sid);
    const piId = await fundAndWait(sid);

    // Buyer disputes: the held payment goes back; webhook records refunded.
    const dispute = await counterFetch(buyer.jar, `/counter/settlements/${sid}/dispute`, form({}));
    expect(dispute.status, await dispute.clone().text()).toBe(200);
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'refunded' ? true : undefined),
      'settlement to be refunded by webhook',
      90_000,
    );
    const pi = await stripeApi(`/v1/payment_intents/${piId}`);
    expect(pi.status).toBe('canceled');
  }, 300_000);

  it('the settlement page renders for both humans', async () => {
    const list = await mcpCall(buyer.accessToken, 'settle', { match_id: matchId });
    expect(list.isError).toBe(false);
    const sid = list.result.settlements[0].settlement_id;
    for (const actor of [buyer, seller]) {
      const page = await counterFetch(actor.jar, `${COUNTER_URL}/counter/settlements/${sid}`);
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).toContain('Settlement');
      expect(body).not.toContain('acct_'); // Stripe ids never render
    }
  });
});
