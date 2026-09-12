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
 *
 * G4 (auto-release): a settlement is funded, the seller declares handover,
 * the harness winds the settlement's own clock back into the past (the one
 * test-only reach into the database — a real window is seven days long), the
 * ops sweep runs, and the payment is released to the seller through the same
 * webhook the buyer's confirmation goes through. The row afterwards says which
 * road it took.
 *
 * G5 (a dispute inside the window wins): a settlement is funded and handed
 * over with its clock live, the buyer says something is wrong, the clock is
 * cleared as the dispute lands, and a sweep run with the clock wound back
 * finds nothing to release. Nothing moves: the payment is frozen, and it stays
 * frozen for the whole of its fourteen days.
 *
 * G6 (a split the two of them agreed): a frozen payment, the seller proposes
 * how to divide what is held, the buyer approves the same two figures, and
 * Stripe shows a PARTIAL refund to the buyer and a transfer to the seller
 * adding up to the agreed amount exactly — with the introductory fee and the
 * processing line still ours.
 *
 * G7 (the item goes back): a frozen payment, the buyer marks it sent back with
 * a tracking reference, the seller says they have it, and the agreed amount —
 * and only the agreed amount — is refunded.
 *
 * G8 (it never arrived and nobody could show otherwise): a frozen payment on
 * the 'not_arrived' ground, the seller adds no tracking, the harness winds the
 * dispute back past the seller's grace, the sweep runs, and the agreed amount
 * goes back to the buyer.
 *
 * G9 (the default rule releases): a frozen payment where the seller DID add
 * tracking and no return was sent, the harness winds the fourteen days into the
 * past, the sweep runs, and the agreed amount is released to the seller with
 * the row saying the rule did it.
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

/**
 * An introduction settles once — a released settlement closes the door on
 * that introduction — so each gate that funds a payment gets a fresh pair of
 * listings and its own introduction, taken to the names step.
 */
async function newIntroduction(): Promise<string> {
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
  await sendOp({
    op: 'create-match',
    card_want: w.result.intent_id,
    card_have: h.result.intent_id,
    score: 0.9,
  });
  // Read the introduction back from the database rather than from check_in.
  // Four introductions run through this suite and the per-account hourly read
  // ceiling is shared by every read tool, so the polling that used to find it
  // would spend most of the buyer's budget before the first payment. It also
  // names THIS pair rather than whichever introduction check_in listed first.
  const id = await poll(async () => {
    const rows = await dbExec(
      'SELECT id FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid',
      [
        { name: 'w', value: w.result.intent_id },
        { name: 'h', value: h.result.intent_id },
      ],
    );
    return rows[0] ? String(rows[0][0]) : undefined;
  }, 'the introduction to appear');
  await mcpCall(buyer.accessToken, 'respond', { intro_id: id, action: 'express_interest' });
  await mcpCall(seller.accessToken, 'respond', { intro_id: id, action: 'express_interest' });
  // Nothing holds either of them up any more (migration 030): a want or have
  // that several people have come forward on works through them one at a
  // time, and the go-ahead on the one that is live goes through at once.
  for (const actor of [buyer, seller]) {
    const r = await mcpCall(actor.accessToken, 'respond', { intro_id: id, action: 'opt_in' });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
  }
  return id;
}

async function proposeSettlement(introId = matchId): Promise<string> {
  const r = await mcpCall(buyer.accessToken, 'settle', {
    intro_id: introId,
    amount: AMOUNT,
    ccy: 'AUD',
    description: 'Mountain bike as agreed, pickup this weekend.',
  });
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  expect(r.result.kind).toBe('settlement');
  expect(r.result.state).toBe('proposed');
  return r.result.settlement_id as string;
}

/**
 * The seller declares the handover: funded -> evidence-locked, which starts
 * the buyer's window. Photos are optional, so this posts the lock with
 * nothing uploaded — the path a seller who simply says "done" takes.
 */
async function declareHandover(sid: string): Promise<void> {
  const lock = await counterFetch(seller.jar, `/settlements/${sid}/evidence/lock`, form({}));
  expect(lock.status, await lock.clone().text().catch(() => '')).toBe(303);
  expect(await settleState(seller.accessToken, sid)).toBe('evidence-locked');
}

/** The settlement's own clock, read as facts rather than as timestamps: the
 *  Data API hands timestamps back as bare strings, so the arithmetic that
 *  matters is done in the database. */
async function clockOf(sid: string): Promise<{
  handedOver: boolean;
  running: boolean;
  windowDays: number | null;
  autoReleased: boolean;
  confirmedVia: string | null;
}> {
  const [[handedOver, running, windowDays, autoReleased, confirmedVia]] = await dbExec(
    `SELECT handed_over_at IS NOT NULL, auto_release_at IS NOT NULL,
            EXTRACT(EPOCH FROM (auto_release_at - handed_over_at)) / 86400,
            auto_released, confirmed_via
     FROM settlements WHERE id = :id::uuid`,
    [{ name: 'id', value: sid }],
  );
  return {
    handedOver: handedOver === true,
    running: running === true,
    windowDays: windowDays === null ? null : Number(windowDays),
    autoReleased: autoReleased === true,
    confirmedVia: confirmedVia === null ? null : String(confirmedVia),
  };
}

/** What the agent sees on a settle read. */
async function settleRead(token: string, sid: string): Promise<any> {
  const r = await mcpCall(token, 'settle', { settlement_id: sid });
  expect(r.isError).toBe(false);
  return r.result;
}

/**
 * TEST-ONLY: wind this settlement's clock back into the past. A real window is
 * SETTLEMENT_AUTO_RELEASE_DAYS long and nothing in the product can shorten it;
 * the harness reaches into the dev database instead, exactly as it does for
 * verification tokens (see helpers.ts). The sweep's own condition is
 * `auto_release_at <= now()`, so this is the only thing that has to move.
 */
async function windClockBack(sid: string): Promise<void> {
  await dbExec(
    `UPDATE settlements SET auto_release_at = now() - interval '1 minute'
     WHERE id = :id::uuid AND auto_release_at IS NOT NULL`,
    [{ name: 'id', value: sid }],
  );
}

/**
 * TEST-ONLY, and the same reach as windClockBack: the dispute's own clocks. A
 * real dispute runs for fourteen days and a real tracking grace for seven, and
 * nothing in the product shortens either. Both sweep conditions are
 * `<stamp> <= now()`, so moving the stamps is all there is to do.
 */
async function windDisputeBack(sid: string, days: number): Promise<void> {
  await dbExec(
    `UPDATE settlements SET disputed_at = disputed_at - make_interval(days => :d::int),
       deadlock_at = deadlock_at - make_interval(days => :d::int)
     WHERE id = :id::uuid AND disputed_at IS NOT NULL`,
    [
      { name: 'id', value: sid },
      { name: 'd', value: days },
    ],
  );
}

/** The frozen half of a settlement row, read as facts. */
async function disputeOf(sid: string): Promise<{
  ground: string | null;
  deadlockRunning: boolean;
  refundMinor: number | null;
  releaseMinor: number | null;
  deliveryTracking: string | null;
  returnTracking: string | null;
  /** The keys of the frozen records in the Object-Lock bucket. */
  deliveryTrackingKey: string | null;
  returnTrackingKey: string | null;
  refundId: string | null;
  autoReleased: boolean;
  confirmedVia: string | null;
}> {
  const [
    [ground, deadlock, refundMinor, releaseMinor, delivery, ret, dKey, rKey, refundId, auto, via],
  ] = await dbExec(
    `SELECT dispute_ground, deadlock_at IS NOT NULL, refund_minor, release_minor,
              delivery_tracking, return_tracking, delivery_tracking_key, return_tracking_key,
              stripe_refund_id, auto_released, confirmed_via
       FROM settlements WHERE id = :id::uuid`,
    [{ name: 'id', value: sid }],
  );
  const num = (v: any) => (v === null || v === undefined ? null : Number(v));
  return {
    ground: ground === null ? null : String(ground),
    deadlockRunning: deadlock === true,
    refundMinor: num(refundMinor),
    releaseMinor: num(releaseMinor),
    deliveryTracking: delivery === null ? null : String(delivery),
    returnTracking: ret === null ? null : String(ret),
    deliveryTrackingKey: dKey === null ? null : String(dKey),
    returnTrackingKey: rKey === null ? null : String(rKey),
    refundId: refundId === null ? null : String(refundId),
    autoReleased: auto === true,
    confirmedVia: via === null ? null : String(via),
  };
}

/** What Stripe gave back against a settlement's charge. */
async function refundsFor(paymentIntent: string): Promise<{ refundedMinor: number; count: number }> {
  const charges = await stripeApi(`/v1/charges?payment_intent=${paymentIntent}`);
  const charge = charges.data[0];
  const refunds = await stripeApi(`/v1/refunds?charge=${charge.id}&limit=10`);
  return { refundedMinor: Number(charge.amount_refunded), count: (refunds.data ?? []).length };
}

/**
 * A funded, handed-over, frozen settlement on a fresh introduction — the
 * starting position for G6 through G9. Returns the settlement id and its
 * PaymentIntent.
 */
async function frozenSettlement(
  ground: 'not_arrived' | 'not_as_described',
): Promise<{ sid: string; piId: string }> {
  const sid = await proposeSettlement(await newIntroduction());
  await approveOnCounter(buyer, sid);
  await approveOnCounter(seller, sid);
  const piId = await fundAndWait(sid);
  await declareHandover(sid);
  const froze = await counterFetch(buyer.jar, `/settlements/${sid}/dispute`, form({ ground }));
  expect(froze.status, await froze.clone().text()).toBe(200);
  expect(await settleState(buyer.accessToken, sid)).toBe('disputed');
  // Freezing sends nothing anywhere. This is the whole change of behaviour, so
  // it is asserted at the start of every gate that depends on it.
  const stripeSaysNothing = await refundsFor(piId);
  expect(stripeSaysNothing.refundedMinor).toBe(0);
  const d = await disputeOf(sid);
  expect(d.ground).toBe(ground);
  expect(d.deadlockRunning).toBe(true);
  expect((await clockOf(sid)).running).toBe(false); // the handover clock is put away
  return { sid, piId };
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
    matchId = await newIntroduction();
    // The seller's connected test account: created pre-verified through
    // Stripe's test-mode API and attached with the server's own envelope
    // encryption (production sellers use the hosted account-link flow).
    sellerStripeId = await createPreVerifiedSeller(matchId.slice(0, 8));
    await attachStripeAccount(seller.accountId, sellerStripeId);
    // Separate charges and transfers draw every release and every refund out
    // of the platform's AVAILABLE balance. Eight settlements run here (G2
    // through G9, plus the shape probes); top up for all of them before the
    // first one starts.
    await ensurePlatformBalance((SELLER_MINOR + BUYER_TOTAL_MINOR) * 9, 'AUD');
  }, 420_000);

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
    // Stripe omits `transfer` on a charge that has none, so read the absence
    // the same way the PaymentIntent's transfer_data is read above.
    expect(charge.transfer ?? null).toBeNull();

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

  it('G3: saying something is wrong freezes the payment and moves nothing', async () => {
    const sid = await proposeSettlement(await newIntroduction());
    await approveOnCounter(buyer, sid);
    await approveOnCounter(seller, sid);
    const piId = await fundAndWait(sid);

    // The buyer says something is wrong. This used to send the whole buyer
    // total home — the agreed amount and both fee lines — and it is the
    // behaviour this gate now exists to prove is gone.
    const dispute = await counterFetch(
      buyer.jar,
      `/settlements/${sid}/dispute`,
      form({ ground: 'not_as_described' }),
    );
    expect(dispute.status, await dispute.clone().text()).toBe(200);
    expect(await settleState(buyer.accessToken, sid)).toBe('disputed');

    // Nothing has moved, in either ledger.
    const pi = await stripeApi(`/v1/payment_intents/${piId}`);
    expect(pi.status).toBe('succeeded');
    expect(pi.amount_received).toBe(BUYER_TOTAL_MINOR);
    const refunds = await refundsFor(piId);
    expect(refunds.refundedMinor).toBe(0);
    expect(refunds.count).toBe(0);
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(transferId).toBeNull();

    // The row says why it froze and when the rule decides.
    const d = await disputeOf(sid);
    expect(d.ground).toBe('not_as_described');
    expect(d.deadlockRunning).toBe(true);
    expect(d.refundId).toBeNull();

    // And the agent sees the same thing, with the sentence to relay.
    const read = await settleRead(buyer.accessToken, sid);
    expect(read.state).toBe('disputed');
    expect(read.dispute_ground).toBe('not_as_described');
    expect(read.deadlock_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(read.note.provenance).toBe('switchboard-system');
    expect(read.note.text).toContain('frozen');
    expect(read.note.text).toContain('approval page');
    // Pressing it again changes nothing.
    const again = await counterFetch(
      buyer.jar,
      `/settlements/${sid}/dispute`,
      form({ ground: 'not_as_described' }),
    );
    expect(again.status).toBe(200);
    expect(await settleState(buyer.accessToken, sid)).toBe('disputed');
    expect((await refundsFor(piId)).refundedMinor).toBe(0);
  }, 600_000);

  it('G4: handed over -> the window runs out -> released, with nobody confirming', async () => {
    const sid = await proposeSettlement(await newIntroduction());
    await approveOnCounter(buyer, sid);
    await approveOnCounter(seller, sid);
    await fundAndWait(sid);

    // The seller says it changed hands, adding no photos at all: that is the
    // optional half of the step, and the declaration is the part that counts.
    await declareHandover(sid);
    const started = await clockOf(sid);
    expect(started.handedOver).toBe(true);
    expect(started.running).toBe(true);
    // SETTLEMENT_AUTO_RELEASE_DAYS, measured off the row's own two stamps.
    expect(started.windowDays).toBeCloseTo(7, 3);
    expect(started.autoReleased).toBe(false);

    // The agent surface carries the deadline and the sentence to relay.
    const read = await settleRead(buyer.accessToken, sid);
    expect(read.state).toBe('evidence-locked');
    expect(read.auto_release_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(read.note.provenance).toBe('switchboard-system');
    expect(read.note.text).toContain('Handed over on');
    expect(read.note.text).toContain('releases to the seller on');

    // Both humans are shown the same clock on their own page.
    for (const actor of [buyer, seller]) {
      const page = await counterFetch(actor.jar, `${COUNTER_URL}/settlements/${sid}`);
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).toContain('Releases on its own');
      expect(body).toContain('Handed over');
    }

    // Wind the clock into the past (test-only) and run the sweep. Nobody
    // confirms anything from here on.
    await windClockBack(sid);
    await sendOp({ op: 'settlement-auto-release' });
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'released' ? true : undefined),
      'settlement to auto-release and be released by webhook',
      180_000,
    );

    // The row says which road it took, and the clock is put away.
    const after = await clockOf(sid);
    expect(after.autoReleased).toBe(true);
    expect(after.confirmedVia).toBe('auto-release');
    expect(after.running).toBe(false);
    expect(after.handedOver).toBe(true); // the record of the handover stays
    // The settle read drops the deadline with the window.
    const done = await settleRead(buyer.accessToken, sid);
    expect(done.state).toBe('released');
    expect(done.auto_release_at).toBeUndefined();

    // Ask Stripe: the seller really was paid the agreed amount, once.
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(String(transferId)).toMatch(/^tr_/);
    const transfer = await stripeApi(`/v1/transfers/${transferId}`);
    expect(transfer.destination).toBe(sellerStripeId);
    expect(transfer.amount).toBe(SELLER_MINOR);
    expect(transfer.transfer_group).toBe(sid);
    expect(transfer.reversed).toBe(false);

    // A second sweep over the same settlement changes nothing.
    await sendOp({ op: 'settlement-auto-release' });
    await new Promise((r) => setTimeout(r, 15_000));
    expect(await settleState(buyer.accessToken, sid)).toBe('released');
    const transfers = await stripeApi(`/v1/transfers?transfer_group=${sid}`);
    expect(transfers.data).toHaveLength(1);
  }, 900_000);

  it('G5: a dispute inside the window wins, and the sweep leaves a frozen payment alone', async () => {
    const { sid, piId } = await frozenSettlement('not_as_described');
    const read = await settleRead(buyer.accessToken, sid);
    expect(read.auto_release_at).toBeUndefined();

    // Winding the HANDOVER clock back does nothing: the dispute cleared it as
    // it landed, and the sweep's own condition never sees this settlement.
    await windClockBack(sid);
    await sendOp({ op: 'settlement-auto-release' });
    await new Promise((r) => setTimeout(r, 20_000));

    // Still frozen, and still inside its fourteen days. Nothing has moved in
    // either direction.
    expect(await settleState(buyer.accessToken, sid)).toBe('disputed');
    const after = await clockOf(sid);
    expect(after.autoReleased).toBe(false);
    expect(after.confirmedVia).toBeNull();
    expect((await disputeOf(sid)).deadlockRunning).toBe(true);
    expect((await refundsFor(piId)).refundedMinor).toBe(0);
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(transferId).toBeNull();
  }, 900_000);

  it('G6: a split the two of them agreed -> settled-split, both legs, fees kept', async () => {
    const { sid, piId } = await frozenSettlement('not_as_described');

    // Deliberately awkward figures: they have to add up to 8765 to the cent,
    // and neither may borrow from a fee line.
    const REFUND_PART = 2140;
    const RELEASE_PART = AMOUNT_MINOR - REFUND_PART; // 6625

    // A split that does not add up is refused before anything moves.
    const wrong = await counterFetch(
      seller.jar,
      `/settlements/${sid}/resolution`,
      form({ refund_to_buyer: '21.40', release_to_seller: '80.00' }),
    );
    expect(wrong.status).toBe(400);
    expect(await settleState(seller.accessToken, sid)).toBe('disputed');

    // The seller proposes; proposing is agreeing, so the settlement waits on
    // the buyer alone.
    const proposed = await counterFetch(
      seller.jar,
      `/settlements/${sid}/resolution`,
      form({
        refund_to_buyer: (REFUND_PART / 100).toFixed(2),
        release_to_seller: (RELEASE_PART / 100).toFixed(2),
      }),
    );
    expect(proposed.status, await proposed.clone().text()).toBe(200);
    expect(await settleState(seller.accessToken, sid)).toBe('resolution-proposed');
    // Still nothing moved on one approval — the sharpest probe in this gate.
    expect((await refundsFor(piId)).refundedMinor).toBe(0);

    // The agent read carries the split, in whole currency, for relaying.
    const read = await settleRead(buyer.accessToken, sid);
    expect(read.resolution.refund_to_buyer).toBe(REFUND_PART / 100);
    expect(read.resolution.release_to_seller).toBe(RELEASE_PART / 100);
    expect(read.resolution.approved_by_seller).toBe(true);
    expect(read.resolution.approved_by_buyer).toBe(false);
    expect(read.note.text).toContain('Only your human can accept it');

    // The buyer agrees to the same two figures, with the PIN ceremony.
    const agreed = await counterFetch(
      buyer.jar,
      `/settlements/${sid}/resolution/approve`,
      form({
        refund_minor: String(REFUND_PART),
        release_minor: String(RELEASE_PART),
        pin: buyer.pin,
      }),
    );
    expect(agreed.status, await agreed.clone().text()).toBe(200);
    await poll(
      async () =>
        (await settleState(buyer.accessToken, sid)) === 'settled-split' ? true : undefined,
      'settlement to reach settled-split from both verified events',
      180_000,
    );

    // Both ledgers. Stripe: a PARTIAL refund and a transfer, adding up to the
    // agreed amount exactly.
    const refunds = await refundsFor(piId);
    expect(refunds.refundedMinor).toBe(REFUND_PART);
    expect(refunds.count).toBe(1);
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    const transfer = await stripeApi(`/v1/transfers/${transferId}`);
    expect(transfer.amount).toBe(RELEASE_PART);
    expect(transfer.destination).toBe(sellerStripeId);
    expect(transfer.transfer_group).toBe(sid);
    expect(refunds.refundedMinor + transfer.amount).toBe(AMOUNT_MINOR);
    // THE FEE LINE: what the buyer paid over the agreed amount stayed here.
    expect(BUYER_TOTAL_MINOR - refunds.refundedMinor).toBeGreaterThanOrEqual(
      FEE_MINOR + PROCESSING_MINOR,
    );

    // The database agrees with Stripe about which two figures moved.
    const d = await disputeOf(sid);
    expect(d.refundMinor).toBe(REFUND_PART);
    expect(d.releaseMinor).toBe(RELEASE_PART);
    expect(d.deadlockRunning).toBe(false); // the dispute's clock is put away
    // And the introduction is closed to a fresh protected payment.
    const again = await mcpCall(buyer.accessToken, 'settle', {
      intro_id: (await dbExec('SELECT match_id::text FROM settlements WHERE id = :id::uuid', [
        { name: 'id', value: sid },
      ]))[0][0],
      amount: AMOUNT,
      ccy: 'AUD',
    });
    expect(again.isError).toBe(true);
    expect(JSON.stringify(again.result)).toContain('already finished');
  }, 900_000);

  it('G7: the item goes back tracked -> the AGREED amount is refunded', async () => {
    const { sid, piId } = await frozenSettlement('not_as_described');

    // The buyer sends it back with a tracking reference.
    const returned = await counterFetch(
      buyer.jar,
      `/settlements/${sid}/returned`,
      form({ tracking: 'INTEG-RETURN-7XY4410092' }),
    );
    expect(returned.status, await returned.clone().text()).toBe(200);
    const afterReturn = await disputeOf(sid);
    expect(afterReturn.returnTracking).toBe('INTEG-RETURN-7XY4410092');
    expect(afterReturn.returnTrackingKey).toContain(`/${sid}/tracking-return-`);
    // A marked return moves nothing on its own.
    expect((await refundsFor(piId)).refundedMinor).toBe(0);
    expect(await settleState(buyer.accessToken, sid)).toBe('disputed');
    // The seller's read says what is waiting on them.
    const sellerRead = await settleRead(seller.accessToken, sid);
    expect(sellerRead.return_tracking.text).toBe('INTEG-RETURN-7XY4410092');
    expect(sellerRead.return_tracking.provenance).toBe('counterparty-untrusted');
    expect(sellerRead.note.text).toContain('sent it back');

    // The seller says they have it: the agreed amount goes back.
    const gotItBack = await counterFetch(
      seller.jar,
      `/settlements/${sid}/return-received`,
      form({ pin: seller.pin }),
    );
    expect(gotItBack.status, await gotItBack.clone().text()).toBe(200);
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'refunded' ? true : undefined),
      'settlement to be refunded by webhook',
      180_000,
    );

    // The AGREED amount, and not a cent of the two fee lines.
    const refunds = await refundsFor(piId);
    expect(refunds.refundedMinor).toBe(AMOUNT_MINOR);
    expect(refunds.refundedMinor).not.toBe(BUYER_TOTAL_MINOR);
    expect(refunds.count).toBe(1);
    expect(BUYER_TOTAL_MINOR - refunds.refundedMinor).toBe(FEE_MINOR + PROCESSING_MINOR);
    const d = await disputeOf(sid);
    expect(d.refundMinor).toBe(AMOUNT_MINOR);
    expect(d.releaseMinor).toBe(0);
    expect(d.deadlockRunning).toBe(false);
    // The seller was never paid, and pressing it again refunds nothing twice.
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    expect(transferId).toBeNull();
    await counterFetch(seller.jar, `/settlements/${sid}/return-received`, form({ pin: seller.pin }));
    await new Promise((r) => setTimeout(r, 10_000));
    expect((await refundsFor(piId)).count).toBe(1);
  }, 900_000);

  it('G8: it never arrived and no tracking was added -> the AGREED amount goes back', async () => {
    const { sid, piId } = await frozenSettlement('not_arrived');
    expect((await disputeOf(sid)).deliveryTracking).toBeNull();

    // Inside the grace, the sweep leaves it alone.
    await sendOp({ op: 'settlement-auto-release' });
    await new Promise((r) => setTimeout(r, 20_000));
    expect(await settleState(buyer.accessToken, sid)).toBe('disputed');
    expect((await refundsFor(piId)).refundedMinor).toBe(0);

    // Wind the dispute past the seller's seven days and run it again.
    await windDisputeBack(sid, 8);
    await sendOp({ op: 'settlement-auto-release' });
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'refunded' ? true : undefined),
      'the never-arrived rule to refund, webhook-driven',
      180_000,
    );

    const refunds = await refundsFor(piId);
    expect(refunds.refundedMinor).toBe(AMOUNT_MINOR);
    expect(refunds.count).toBe(1);
    expect(BUYER_TOTAL_MINOR - refunds.refundedMinor).toBe(FEE_MINOR + PROCESSING_MINOR);
    const d = await disputeOf(sid);
    expect(d.refundMinor).toBe(AMOUNT_MINOR);
    expect(d.releaseMinor).toBe(0);
    expect(String(d.refundId)).toMatch(/^re_/);
    // A second sweep refunds nothing twice.
    await sendOp({ op: 'settlement-auto-release' });
    await new Promise((r) => setTimeout(r, 15_000));
    expect((await refundsFor(piId)).count).toBe(1);
  }, 900_000);

  it('G9: the default rule releases to the side that can show where it went', async () => {
    const { sid, piId } = await frozenSettlement('not_arrived');

    // The seller adds tracking. That answers the ground — the argument is now
    // about the item rather than the post — and leaves the fourteen days
    // exactly where they were.
    const tracked = await counterFetch(
      seller.jar,
      `/settlements/${sid}/tracking`,
      form({ tracking: 'INTEG-DELIVERY-4410092' }),
    );
    expect(tracked.status, await tracked.clone().text()).toBe(200);
    const afterTracking = await disputeOf(sid);
    expect(afterTracking.deliveryTracking).toBe('INTEG-DELIVERY-4410092');
    expect(afterTracking.ground).toBe('not_as_described');
    // The reference the whole rule turns on is frozen where it cannot be
    // altered, and the row points at that record: the column is the fast read,
    // the object in the WORM bucket is the record of truth.
    expect(afterTracking.deliveryTrackingKey).toContain(`/${sid}/tracking-delivery-`);

    // Past the seller's grace, the never-arrived rule no longer applies: the
    // ground moved, so nothing refunds.
    await windDisputeBack(sid, 8);
    await sendOp({ op: 'settlement-auto-release' });
    await new Promise((r) => setTimeout(r, 20_000));
    expect(await settleState(buyer.accessToken, sid)).toBe('disputed');
    expect((await refundsFor(piId)).refundedMinor).toBe(0);

    // Past the fourteen days, with tracking and no return sent, the payment
    // goes to the seller.
    await windDisputeBack(sid, 15);
    await sendOp({ op: 'settlement-auto-release' });
    await poll(
      async () => ((await settleState(buyer.accessToken, sid)) === 'released' ? true : undefined),
      'the default rule to release, webhook-driven',
      180_000,
    );

    const d = await disputeOf(sid);
    expect(d.releaseMinor).toBe(AMOUNT_MINOR);
    expect(d.refundMinor).toBe(0);
    expect(d.autoReleased).toBe(true);
    expect(d.confirmedVia).toBe('deadlock'); // nobody pressed anything
    expect(d.deadlockRunning).toBe(false);
    const [[transferId]] = await dbExec(
      'SELECT stripe_transfer_id FROM settlements WHERE id = :id::uuid',
      [{ name: 'id', value: sid }],
    );
    const transfer = await stripeApi(`/v1/transfers/${transferId}`);
    expect(transfer.amount).toBe(SELLER_MINOR);
    expect(transfer.destination).toBe(sellerStripeId);
    expect(transfer.transfer_group).toBe(sid);
    expect((await refundsFor(piId)).refundedMinor).toBe(0);
    // A second sweep pays nothing twice.
    await sendOp({ op: 'settlement-auto-release' });
    await new Promise((r) => setTimeout(r, 15_000));
    const transfers = await stripeApi(`/v1/transfers?transfer_group=${sid}`);
    expect(transfers.data).toHaveLength(1);
  }, 900_000);

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
