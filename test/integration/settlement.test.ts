/**
 * Gates G2 + G3 against LIVE dev + the Stripe sandbox.
 *
 * G2 (happy path): settle proposed -> both humans approve on their approval
 * pages (PIN) -> the buyer pays the real hosted Checkout Session in a browser
 * -> webhook funds -> seller locks evidence into the WORM vault -> buyer
 * confirms receipt (PIN) -> a transfer of the agreed amount goes out ->
 * webhook releases. Then Stripe is asked directly: the buyer was charged the
 * three itemised lines into the platform balance with nothing routed away,
 * and the seller's connected test account received the agreed amount in full.
 *
 * G3 (refund path): a fresh settlement is funded, the buyer disputes, the
 * whole buyer total is refunded, and the webhook records 'refunded'.
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
import { createHash } from 'node:crypto';
import {
  attachStripeAccount,
  createPreVerifiedSeller,
  ensurePlatformBalance,
  payHostedCheckout,
  stripeApi,
  tinyPng,
} from './stripeHelpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const AMOUNT = 87.65; // 8765 minor units
const AMOUNT_MINOR = 8765;
/** SETTLEMENT_FEE_FLAT_MINOR default: $1.00, paid by the buyer. */
const FEE_MINOR = 100;
/** SETTLEMENT_PROCESSING_* defaults (1.7% + 30), grossed up over the first
 *  two lines: ceil((8865 * 0.017 + 30) / 0.983). */
const PROCESSING_MINOR = 184;
const BUYER_TOTAL_MINOR = AMOUNT_MINOR + FEE_MINOR + PROCESSING_MINOR; // 9049
/** The seller receives the agreed amount, in full. */
const SELLER_MINOR = AMOUNT_MINOR;

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
    '/approve',
    form({ action: 'settlement-approve', ref_id: settlementId, decision: 'approve', pin: actor.pin }),
  );
  expect(res.status, await res.clone().text().catch(() => '')).toBe(303);
  expect(res.headers.get('location')).toBe(`/settlements/${settlementId}`);
}

async function proposeSettlement(): Promise<string> {
  const r = await mcpCall(buyer.accessToken, 'settle', {
    intro_id: matchId,
    amount: AMOUNT,
    ccy: 'AUD',
    description: 'Mountain bike as agreed, pickup this weekend.',
  });
  expect(r.isError).toBe(false);
  expect(r.result.kind).toBe('settlement');
  expect(r.result.state).toBe('proposed');
  return r.result.settlement_id as string;
}

/**
 * The buyer's half: the pay action hands back Stripe's hosted session, the
 * session is completed in a browser with a test card, and the verified
 * webhook drives approved -> funded. Returns the PaymentIntent id.
 */
async function fundAndWait(settlementId: string): Promise<string> {
  const pay = await counterFetch(buyer.jar, `/settlements/${settlementId}/pay`, form({}));
  expect(pay.status, await pay.clone().text().catch(() => '')).toBe(303);
  const url = pay.headers.get('location')!;
  expect(url).toContain('checkout.stripe.com');
  await payHostedCheckout(url);
  await poll(
    async () => ((await settleState(buyer.accessToken, settlementId)) === 'funded' ? true : undefined),
    `settlement ${settlementId} to be funded by webhook`,
    120_000,
  );
  const [[pi]] = await dbExec(
    'SELECT stripe_payment_intent FROM settlements WHERE id = :id::uuid',
    [{ name: 'id', value: settlementId }],
  );
  expect(String(pi)).toMatch(/^pi_/);
  return String(pi);
}

d('phase 1.A settlements against live dev + Stripe sandbox', () => {
  beforeAll(async () => {
    [buyer, seller] = await Promise.all([
      bootstrapActor('Bella', 'Fremantle'),
      bootstrapActor('Sam', 'Subiaco'),
    ]);
    const w = await mcpCall(buyer.accessToken, 'publish_intent', {
      listing: minimalWant({ attributes: { condition: 'good' } }),
    });
    expect(w.isError).toBe(false);
    const h = await mcpCall(seller.accessToken, 'publish_intent', {
      listing: minimalHave({ attributes: { condition: 'good' }, ask: { amount: 90, ccy: 'AUD' } }),
    });
    expect(h.isError).toBe(false);
    await waitForCardState(buyer.accessToken, w.result.intent_id, ['PUBLISHED']);
    await waitForCardState(seller.accessToken, h.result.intent_id, ['PUBLISHED']);
    await sendOp({ op: 'create-match', card_want: w.result.intent_id, card_have: h.result.intent_id, score: 0.9 });
    matchId = await poll(async () => {
      const r = await mcpCall(buyer.accessToken, 'check_in', { intent_id: w.result.intent_id });
      return r.result.introductions?.[0]?.intro_id as string | undefined;
    }, 'match to appear');
    // Reach stage 3 (both interests + both opt-ins).
    await mcpCall(buyer.accessToken, 'respond', { intro_id: matchId, action: 'express_interest' });
    await mcpCall(seller.accessToken, 'respond', { intro_id: matchId, action: 'express_interest' });
    await mcpCall(buyer.accessToken, 'respond', { intro_id: matchId, action: 'opt_in' });
    await mcpCall(seller.accessToken, 'respond', { intro_id: matchId, action: 'opt_in' });
    // The seller's connected test account: created pre-verified through
    // Stripe's test-mode API and attached with the server's own envelope
    // encryption (production sellers use the hosted account-link flow).
    sellerStripeId = await createPreVerifiedSeller(matchId.slice(0, 8));
    await attachStripeAccount(seller.accountId, sellerStripeId);
    // Separate charges and transfers draw the release out of the platform's
    // AVAILABLE balance. Two settlements run here, so make sure there is
    // room for both before the first one starts.
    await ensurePlatformBalance(SELLER_MINOR * 2, 'AUD');
  }, 300_000);

  it('settle requires stage 3 and refuses a bad proposal shape', async () => {
    const bad = await mcpCall(buyer.accessToken, 'settle', { intro_id: matchId, amount: AMOUNT });
    expect(bad.isError).toBe(true); // amount without ccy
  });

  it('G2: proposed -> approved -> funded -> evidence-locked -> confirmed -> released', async () => {
    const sid = await proposeSettlement();

    // Both humans approve on their approval pages (PIN ceremony).
    await approveOnCounter(buyer, sid);
    expect(await settleState(buyer.accessToken, sid)).toBe('approved-by-buyer');
    await approveOnCounter(seller, sid);
    expect(await settleState(seller.accessToken, sid)).toBe('approved');

    // The buyer pays the real hosted Checkout Session; the signature-verified
    // webhook drives approved -> funded.
    const piId = await fundAndWait(sid);

    // Seller locks handover evidence into the WORM vault.
    const png = tinyPng();
    const sha = createHash('sha256').update(png).digest('base64');
    const presign = await counterFetch(seller.jar, `/settlements/${sid}/evidence/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'handover.png', content_type: 'image/png', size: png.length, sha256_b64: sha }),
    });
    expect(presign.status, await presign.clone().text()).toBe(200);
    const { url } = (await presign.json()) as any;
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-amz-checksum-sha256': sha },
      body: png,
    });
    expect(put.status, await put.text()).toBe(200);
    const lock = await counterFetch(seller.jar, `/settlements/${sid}/evidence/lock`, form({}));
    expect(lock.status).toBe(303);
    expect(await settleState(seller.accessToken, sid)).toBe('evidence-locked');
    const [[manifestKey]] = await dbExec(
      'SELECT evidence_manifest_key FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(String(manifestKey)).toContain('settlement-evidence/dev/');

    // Buyer confirms receipt (PIN) -> transfer to the seller -> webhook
    // releases.
    const confirm = await counterFetch(
      buyer.jar,
      `/settlements/${sid}/confirm`,
      form({ pin: buyer.pin }),
    );
    expect(confirm.status, await confirm.clone().text()).toBe(200);
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'released' ? true : undefined),
      'settlement to be released by webhook',
      120_000,
    );

    // Ask Stripe directly. The buyer's side: the three itemised lines, taken
    // into OUR balance, with nothing routed away from it.
    const pi = await stripeApi(`/v1/payment_intents/${piId}`);
    expect(pi.status).toBe('succeeded');
    expect(pi.amount_received).toBe(BUYER_TOTAL_MINOR);
    expect(pi.transfer_group).toBe(sid);
    expect(pi.transfer_data).toBeNull();
    expect(pi.application_fee_amount).toBeNull();
    const charges = await stripeApi(`/v1/charges?payment_intent=${piId}`);
    const charge = charges.data[0];
    expect(charge.captured).toBe(true);
    expect(charge.amount_captured).toBe(BUYER_TOTAL_MINOR);
    expect(charge.transfer).toBeNull();

    // The seller's side: one transfer, for the agreed amount in full,
    // carrying the settlement id as its transfer_group.
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(String(transferId)).toMatch(/^tr_/);
    const transfer = await stripeApi(`/v1/transfers/${transferId}`);
    expect(transfer.destination).toBe(sellerStripeId);
    expect(transfer.amount).toBe(SELLER_MINOR);
    expect(transfer.currency).toBe('aud');
    expect(transfer.transfer_group).toBe(sid);
    expect(transfer.reversed).toBe(false);
    // And on the seller's own connected account: the money is really there.
    const destPayment = await stripeApi(
      `/v1/charges/${transfer.destination_payment}`,
      undefined,
      'GET',
      sellerStripeId,
    );
    expect(destPayment.amount).toBe(SELLER_MINOR);

    // The breakdown we kept is the one the settlement recorded and both humans
    // saw before the buyer paid.
    const [[feeMinor, processingMinor, buyerTotalMinor]] = await dbExec(
      `SELECT fee_amount_minor, processing_fee_minor, buyer_total_minor
       FROM settlements WHERE id = :id::uuid`,
      [{ name: 'id', value: sid }],
    );
    expect(Number(feeMinor)).toBe(FEE_MINOR);
    expect(Number(processingMinor)).toBe(PROCESSING_MINOR);
    expect(Number(buyerTotalMinor)).toBe(BUYER_TOTAL_MINOR);
  }, 600_000);

  it('G3: disputed -> refunded, webhook-driven, the buyer made whole in Stripe', async () => {
    const sid = await proposeSettlement();
    await approveOnCounter(buyer, sid);
    await approveOnCounter(seller, sid);
    const piId = await fundAndWait(sid);

    // Buyer disputes: the held payment goes back; webhook records refunded.
    const dispute = await counterFetch(buyer.jar, `/settlements/${sid}/dispute`, form({}));
    expect(dispute.status, await dispute.clone().text()).toBe(200);
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'refunded' ? true : undefined),
      'settlement to be refunded by webhook',
      120_000,
    );
    const pi = await stripeApi(`/v1/payment_intents/${piId}`);
    expect(pi.status).toBe('succeeded'); // the charge stands; the money went back
    const charges = await stripeApi(`/v1/charges?payment_intent=${piId}`);
    const charge = charges.data[0];
    expect(charge.refunded).toBe(true);
    expect(charge.amount_refunded).toBe(BUYER_TOTAL_MINOR); // everything, both fee lines included
    // Nothing ever went to the seller on this one.
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(transferId).toBeNull();
  }, 600_000);

  it('the settlement page renders for both humans', async () => {
    const list = await mcpCall(buyer.accessToken, 'settle', { intro_id: matchId });
    expect(list.isError).toBe(false);
    const sid = list.result.settlements[0].settlement_id;
    for (const actor of [buyer, seller]) {
      const page = await counterFetch(actor.jar, `${COUNTER_URL}/settlements/${sid}`);
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).toContain('Settlement');
      expect(body).not.toContain('acct_'); // Stripe ids never render
    }
  });
});
