/**
 * THE MONEY GROUP — safe hands, checked the way money has to be checked.
 *
 * This is the sim harness's answer to the one part of the product where a
 * wrong answer costs somebody real currency. It drives three whole settlements
 * against LIVE dev and the dev Stripe sandbox — one that releases, one that is
 * frozen and sent back, one that is frozen and split between the two of them —
 * and holds I8 to I15 against what it finds.
 *
 * TWO RULES OF EVIDENCE, and they are the reason this group exists at all:
 *
 *  1. NEVER TRUST THE API RESPONSE. Every state that matters — funded,
 *     released, refunded — lands from a signature-verified Stripe webhook, so
 *     a 200 or a 303 from the counter proves only that the request was
 *     accepted. Each state is read back out of the settlements table, and each
 *     figure out of Stripe's own API.
 *  2. READ BOTH LEDGERS. The database says what the switchboard believes;
 *     Stripe says what actually happened to the money. A defect that matters
 *     is usually the two disagreeing, so both are read and compared.
 *
 * WHAT IS SHORTCUT, AND WHAT IS NOT. The seller's connected account is created
 * pre-verified through Stripe's test-mode API (real sellers walk the hosted
 * account-link flow, which no harness can click), and the platform balance is
 * topped up so a release has funds to draw on. Nothing else is shortcut: the
 * approvals are pressed on the real approval pages with the real PIN, the
 * buyer's payment is the real hosted Checkout Session the server created,
 * completed in a browser with a test card, and every transition arrives on the
 * live webhook.
 *
 * COST. Three hosted Checkout Sessions in a headless browser, and the webhook
 * waits that go with them. Budget about ten to fifteen minutes.
 * SIM_SKIP_MONEY=1 leaves it out; SIM_ONLY_MONEY=1 runs it alone
 * (npm run sim:money).
 */
import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  attachStripeAccount,
  createPreVerifiedSeller,
  ensurePlatformBalance,
  payHostedCheckout,
  stripeApi,
  tinyPng,
} from '../integration/stripeHelpers.js';
import { ENV_NAME, counterFetch, mcpRpc, minimalHave, minimalWant, sendOp } from '../integration/helpers.js';
import type { Checker } from './checker.js';
import type { AgentMoveAttempt, ProposalAttempt } from './invariants.js';
import { Harness, SimActor, dbExec, group, groupEnd, log, poll } from './harness.js';

/** The consent log is a WORM bucket, named the same way in every environment. */
const CONSENT_BUCKET = `osb-${ENV_NAME}-consent-log-173291123487`;
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });

/**
 * The figure every settlement here is for. Deliberately not round: a gross-up on a
 * round number can be right by accident, and $73.40 makes the processing line
 * land on a fraction of a cent that has to be rounded somewhere.
 */
const AMOUNT = 73.4;
const AMOUNT_MINOR = 7340;

export interface MoneyResult {
  /** One line per settlement the group drove, for the report. */
  settlements: {
    id: string;
    kind: 'release' | 'return' | 'split';
    finalState: string;
    /** The three lines as persisted, and what Stripe actually took. */
    agreedMinor: number;
    feeMinor: number | null;
    processingMinor: number | null;
    buyerTotalMinor: number | null;
    chargedMinor?: number;
    transferMinor?: number;
    refundedMinor?: number;
  }[];
  /** Each invariant, and whether the group got far enough to check it. */
  checked: Record<'I8' | 'I9' | 'I10' | 'I11' | 'I12' | 'I13' | 'I14' | 'I15', 'held' | 'violated' | 'not reached'>;
  notes: string[];
}

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

/** One settlement row, straight out of the database. Never the API's word. */
async function settlementRow(id: string): Promise<Record<string, any>> {
  const rows = await dbExec(
    `SELECT state, amount::text, ccy, fee_amount_minor, processing_fee_minor, buyer_total_minor,
            buyer_approved_at::text, seller_approved_at::text, stripe_payment_intent,
            stripe_transfer_id, stripe_checkout_session, buyer_account::text, seller_account::text,
            refund_minor, release_minor, auto_release_at IS NOT NULL, deadlock_at IS NOT NULL,
            deadlock_at <= now(), dispute_ground, stripe_refund_id
       FROM settlements WHERE id = :id::uuid`,
    [{ name: 'id', value: id }],
  );
  const r = rows[0];
  if (!r) throw new Error(`settlement ${id} not found in the database`);
  const num = (v: any) => (v === null || v === undefined ? null : Number(v));
  return {
    state: String(r[0]),
    amount: Number(r[1]),
    ccy: String(r[2]),
    feeMinor: num(r[3]),
    processingMinor: num(r[4]),
    buyerTotalMinor: num(r[5]),
    buyerApprovedAt: r[6] ? String(r[6]) : null,
    sellerApprovedAt: r[7] ? String(r[7]) : null,
    paymentIntent: r[8] ? String(r[8]) : null,
    transferId: r[9] ? String(r[9]) : null,
    checkoutSession: r[10] ? String(r[10]) : null,
    buyerAccount: String(r[11]),
    sellerAccount: String(r[12]),
    refundMinor: num(r[13]),
    releaseMinor: num(r[14]),
    autoReleaseAtSet: r[15] === true,
    deadlockAtSet: r[16] === true,
    deadlockPassed: r[17] === true,
    disputeGround: r[18] ? String(r[18]) : null,
    refundId: r[19] ? String(r[19]) : null,
  };
}

/** What Stripe gave back against this settlement's charge, and how often. */
async function refundFacts(
  paymentIntent: string,
): Promise<{ refundedMinor: number; refundCount: number; chargeId: string }> {
  const charges = await stripeApi(`/v1/charges?payment_intent=${paymentIntent}`);
  const charge = charges.data[0];
  const refunds = await stripeApi(`/v1/refunds?charge=${charge.id}&limit=10`);
  return {
    refundedMinor: Number(charge.amount_refunded),
    refundCount: (refunds.data ?? []).length,
    chargeId: charge.id,
  };
}

/** Wait for the DATABASE to show a state. The webhook is what puts it there. */
async function waitState(id: string, want: string, timeoutMs = 150_000): Promise<void> {
  await poll(
    async () => ((await settlementRow(id)).state === want ? true : undefined),
    `settlement ${id.slice(0, 8)} -> ${want} (webhook-driven)`,
    timeoutMs,
    4_000,
  );
}

/**
 * Which accounts have a 'settlement-approved' event in the WORM consent log
 * for this settlement. This is the record that would be produced if anyone
 * ever asked who authorised the payment, so I8 reads it rather than trusting
 * the two timestamps on the row.
 *
 * The log is written on the way through, so a brief lag after the second
 * approval is normal; the caller polls.
 */
async function consentApprovals(settlementId: string): Promise<string[]> {
  const day = new Date().toISOString().slice(0, 10);
  const found: string[] = [];
  for (const prefix of [day, new Date(Date.now() - 864e5).toISOString().slice(0, 10)]) {
    let token: string | undefined;
    do {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: CONSENT_BUCKET,
          Prefix: `consent-events/${ENV_NAME}/${prefix}/`,
          ContinuationToken: token,
        }),
      );
      for (const obj of list.Contents ?? []) {
        const body = await s3.send(new GetObjectCommand({ Bucket: CONSENT_BUCKET, Key: obj.Key! }));
        let j: any;
        try {
          j = JSON.parse(await body.Body!.transformToString());
        } catch {
          continue;
        }
        if (j.event === 'settlement-approved' && j.settlement_id === settlementId) {
          found.push(String(j.account_id));
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
  return [...new Set(found)];
}

/** Approve on the real approval page, with the real PIN. */
async function approveOnPage(actor: SimActor, settlementId: string): Promise<number> {
  const res = await counterFetch(
    actor.jar,
    '/approve',
    form({
      action: 'settlement-approve',
      ref_id: settlementId,
      decision: 'approve',
      pin: actor.pin,
    }),
  );
  return res.status;
}

/** Propose a settlement over MCP, as an agent would. */
async function propose(
  h: Harness,
  actor: SimActor,
  matchId: string,
  amount = AMOUNT,
): Promise<{ id?: string; isError: boolean; detail: string }> {
  const r = await h.mcp(actor.accessToken, 'settle', {
    intro_id: matchId,
    amount,
    ccy: 'AUD',
    description: 'Sim money group: a bicycle, as agreed.',
  });
  return {
    id: r.isError ? undefined : (r.result?.settlement_id as string),
    isError: r.isError,
    detail: JSON.stringify(r.result).slice(0, 220),
  };
}

/**
 * Fund a settlement: the buyer's own pay route hands back the hosted Checkout
 * Session the server created, it is paid in a browser with a test card, and
 * the verified webhook drives approved -> funded. The state is read back out
 * of the database, never off the redirect.
 */
async function fund(buyer: SimActor, settlementId: string): Promise<void> {
  const pay = await counterFetch(buyer.jar, `/settlements/${settlementId}/pay`, form({}));
  if (pay.status !== 303) {
    throw new Error(`pay route answered ${pay.status}: ${(await pay.text()).slice(0, 200)}`);
  }
  const url = pay.headers.get('location') ?? '';
  if (!url.includes('checkout.stripe.com')) throw new Error(`pay route did not go to Stripe: ${url}`);
  await payHostedCheckout(url);
  await waitState(settlementId, 'funded');
}

/** The seller freezes handover evidence into the WORM vault: funded -> evidence-locked. */
async function lockEvidence(seller: SimActor, settlementId: string): Promise<void> {
  const png = tinyPng();
  const sha = createHash('sha256').update(png).digest('base64');
  const presign = await counterFetch(seller.jar, `/settlements/${settlementId}/evidence/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'handover.png',
      content_type: 'image/png',
      size: png.length,
      sha256_b64: sha,
    }),
  });
  if (presign.status !== 200) {
    throw new Error(`evidence presign answered ${presign.status}: ${(await presign.text()).slice(0, 200)}`);
  }
  const { url } = (await presign.json()) as any;
  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'x-amz-checksum-sha256': sha },
    body: png,
  });
  if (put.status !== 200) throw new Error(`evidence upload answered ${put.status}`);
  const lock = await counterFetch(seller.jar, `/settlements/${settlementId}/evidence/lock`, form({}));
  if (lock.status !== 303) {
    throw new Error(`evidence lock answered ${lock.status}: ${(await lock.text()).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// I9: everything an agent can reach, tried against a live settlement.
//
// The settle tool is the only settlement surface an agent has, so every shape
// that could plausibly drive a human step goes through it. A call counts as
// refused when it errored OR came back a plain read; what is never allowed is
// the state moving, which is asserted separately either way.
// ---------------------------------------------------------------------------
async function tryAgentMoves(
  h: Harness,
  buyer: SimActor,
  seller: SimActor,
  settlementId: string,
  matchId: string,
): Promise<AgentMoveAttempt[]> {
  const out: AgentMoveAttempt[] = [];
  const stateAtStart = (await settlementRow(settlementId)).state;
  const shapes: { label: string; actor: SimActor; args: Record<string, unknown> }[] = [
    { label: 'settle(settlement_id, action=approve) as the buyer', actor: buyer, args: { settlement_id: settlementId, action: 'approve' } },
    { label: 'settle(settlement_id, action=approve) as the seller', actor: seller, args: { settlement_id: settlementId, action: 'approve' } },
    { label: 'settle(settlement_id, decision=approve)', actor: buyer, args: { settlement_id: settlementId, decision: 'approve' } },
    { label: 'settle(settlement_id, action=confirm_receipt)', actor: buyer, args: { settlement_id: settlementId, action: 'confirm_receipt' } },
    { label: 'settle(settlement_id, action=release)', actor: seller, args: { settlement_id: settlementId, action: 'release' } },
    { label: 'settle(settlement_id, action=refund)', actor: buyer, args: { settlement_id: settlementId, action: 'refund' } },
    { label: 'settle(settlement_id, state=released)', actor: seller, args: { settlement_id: settlementId, state: 'released' } },
    { label: 'settle(intro_id, amount, ccy, state=funded)', actor: buyer, args: { intro_id: matchId, amount: AMOUNT, ccy: 'AUD', state: 'funded' } },
  ];
  for (const s of shapes) {
    const r = await h.mcp(s.actor.accessToken, 'settle', s.args);
    // WHAT COUNTS AS REFUSED, and it took a live run to get this right.
    //
    // The unknown properties below (action, decision, state) are simply
    // ignored: additionalProperties:false on the tool's inputSchema is a hint
    // to the client, and the server reads only the fields it knows. So these
    // calls come back as a plain READ of the settlement — which reports the
    // state the settlement is genuinely in.
    //
    // A first cut treated any funded/released/refunded in the response as the
    // call claiming to have done something, and reported six false GOT
    // THROUGHs against a settlement that had simply been funded a minute
    // earlier by the two humans. The honest test is whether the state MOVED:
    // read it back from the database after the call and compare. A response
    // echoing an unchanged state is a read, whatever words are in it.
    const after = (await settlementRow(settlementId)).state;
    const reported = /"state"\s*:\s*"([a-z-]+)"/.exec(r.raw)?.[1];
    const moved = after !== stateAtStart;
    out.push({
      label: s.label,
      refused: r.isError || !moved,
      detail: r.isError
        ? `refused: ${JSON.stringify(r.result).slice(0, 140)}`
        : `ignored the unknown field and answered with a plain read (state ${reported ?? '?'}, unchanged in the database)`,
    });
  }
  // The counter's own money routes, called by an agent's access token rather
  // than a signed-in human session. These are human pages; a bearer token must
  // get nowhere near them.
  for (const [label, path] of [
    ['POST /settlements/:id/confirm with an agent token', `/settlements/${settlementId}/confirm`],
    ['POST /settlements/:id/dispute with an agent token', `/settlements/${settlementId}/dispute`],
    ['POST /settlements/:id/pay with an agent token', `/settlements/${settlementId}/pay`],
  ] as const) {
    try {
      const res = await fetch(`${process.env.OSB_COUNTER_URL ?? 'https://my-dev.openswitchboard.ai'}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
          'content-type': 'application/x-www-form-urlencoded',
          ...(process.env.OSB_RATELIMIT_BYPASS
            ? { 'x-osb-ratelimit-bypass': process.env.OSB_RATELIMIT_BYPASS }
            : {}),
        },
        body: '',
      });
      // No session cookie, so the counter must send it to sign-in (302/303 to
      // /login) or refuse outright. A 200 or a redirect to Stripe would mean a
      // bearer token reached a human page.
      const loc = res.headers.get('location') ?? '';
      const reachedStripe = loc.includes('checkout.stripe.com');
      out.push({
        label,
        refused: !reachedStripe && res.status !== 200,
        detail: `HTTP ${res.status}${loc ? ` -> ${loc.slice(0, 80)}` : ''}`,
      });
    } catch (e) {
      out.push({ label, refused: true, detail: `network refusal: ${(e as Error).message.slice(0, 100)}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export async function runMoney(
  h: Harness,
  check: Checker,
  actors: SimActor[],
): Promise<MoneyResult> {
  const res: MoneyResult = {
    settlements: [],
    checked: {
      I8: 'not reached', I9: 'not reached', I10: 'not reached', I11: 'not reached',
      I12: 'not reached', I13: 'not reached', I14: 'not reached', I15: 'not reached',
    },
    notes: [],
  };
  const before = check.violations.length;
  const took = (id: keyof MoneyResult['checked'], from: number) => {
    res.checked[id] = check.violations.slice(from).some((v) => v.invariant === id) ? 'violated' : 'held';
  };

  const [buyer, seller, outsider] = actors;
  const bucket = h.bucket('sm');

  // --- the board: a want and a have that meet, plus a stranger's have that
  //     will pair with the buyer at stage 0 for the I12 wrong-stage probe.
  const want = await h.publish(buyer, minimalWant({ geo: { bucket, radius_km: 25 }, attributes: { condition: 'good' } }));
  const have = await h.publish(seller, minimalHave({ geo: { bucket, radius_km: 25 }, attributes: { condition: 'good' }, ask: { amount: 80, ccy: 'AUD' } }));
  await h.waitCardDB(want.result.intent_id, ['PUBLISHED']);
  await h.waitCardDB(have.result.intent_id, ['PUBLISHED']);
  const matchId = await h.createMatch(buyer, want.result.intent_id, seller, have.result.intent_id, 0.9);
  log(`introduction ${matchId.slice(0, 8)} — buyer ${buyer.label}, seller ${seller.label}`);

  // --- I12, first half: a proposal before stage 3.
  const guards: ProposalAttempt[] = [];
  {
    const early = await propose(h, buyer, matchId);
    guards.push({
      label: 'settle proposed at stage 0, before either human has opted in',
      refused: early.isError,
      detail: early.detail,
    });
    if (!early.isError && early.id) res.notes.push(`a stage-0 proposal created settlement ${early.id}`);
  }

  // --- reach stage 3: both interests, both opt-ins.
  for (const [actor, action] of [
    [buyer, 'express_interest'],
    [seller, 'express_interest'],
    [buyer, 'opt_in'],
    [seller, 'opt_in'],
  ] as const) {
    await h.mcp(actor.accessToken, 'respond', { intro_id: matchId, action });
  }

  // --- I12, second half: the wrong party, and a shape the schema must refuse.
  {
    const stranger = await propose(h, outsider, matchId);
    guards.push({
      label: 'settle proposed by an account that is not on the introduction',
      refused: stranger.isError,
      detail: stranger.detail,
    });
    const noCcy = await h.mcp(buyer.accessToken, 'settle', { intro_id: matchId, amount: AMOUNT });
    guards.push({
      label: 'settle proposed with an amount and no currency',
      refused: noCcy.isError,
      detail: JSON.stringify(noCcy.result).slice(0, 160),
    });
    const tiny = await h.mcp(buyer.accessToken, 'settle', { intro_id: matchId, amount: 0.5, ccy: 'AUD' });
    guards.push({
      label: 'settle proposed for less than the fee riding on it',
      refused: tiny.isError,
      detail: JSON.stringify(tiny.result).slice(0, 160),
    });
  }
  {
    const from = check.violations.length;
    check.proposalGuards(guards, 'money group, proposal guards');
    took('I12', from);
  }
  for (const g of guards) log(`  I12 ${g.refused ? 'REFUSED' : 'GOT THROUGH'}: ${g.label}`);

  // --- Stripe: a pre-verified seller and a platform balance to draw on.
  const sellerStripeId = await createPreVerifiedSeller(matchId.slice(0, 8));
  await attachStripeAccount(seller.accountId, sellerStripeId);
  await ensurePlatformBalance(AMOUNT_MINOR * 4, 'AUD');
  log(`seller connected account ${sellerStripeId} attached, platform balance topped up`);

  // =========================================================================
  // SETTLEMENT ONE: the release path.
  // =========================================================================
  group('settlement 1 of 2: proposed -> funded -> released');
  const one = await propose(h, buyer, matchId);
  if (!one.id) throw new Error(`could not propose the release-path settlement: ${one.detail}`);
  const sid = one.id;
  log(`settlement ${sid.slice(0, 8)} proposed for $${AMOUNT} AUD`);

  // I8's sharpest probe: with ONE approval standing, the buyer's pay route
  // must refuse. Money that can start moving on one signature is the defect.
  if ((await approveOnPage(buyer, sid)) !== 303) res.notes.push("the buyer's approval press did not answer 303");
  const payEarly = await counterFetch(buyer.jar, `/settlements/${sid}/pay`, form({}));
  log(`  pay route with one approval standing: HTTP ${payEarly.status} (409 is the refusal we want)`);
  if ((await approveOnPage(seller, sid)) !== 303) res.notes.push("the seller's approval press did not answer 303");

  await fund(buyer, sid);
  log('  funded (webhook-driven, read back from the settlements table)');

  // I8, on the full record: both timestamps, and both approvals in the WORM log.
  {
    const row = await settlementRow(sid);
    const approvals = await poll(
      async () => {
        const a = await consentApprovals(sid);
        return a.length >= 2 ? a : undefined;
      },
      'both settlement approvals in the WORM consent log',
      90_000,
      6_000,
    ).catch(async () => consentApprovals(sid));
    const from = check.violations.length;
    check.funded(
      {
        settlementId: sid,
        state: row.state,
        buyerApprovedAt: row.buyerApprovedAt,
        sellerApprovedAt: row.sellerApprovedAt,
        consentApprovals: approvals,
        buyerAccount: row.buyerAccount,
        sellerAccount: row.sellerAccount,
        payBeforeBothApprovalsStatus: payEarly.status,
      },
      'money group, settlement 1 at funded',
    );
    took('I8', from);
    log(`  I8: consent log holds ${approvals.length} approval(s) for this settlement`);
  }

  // I9: with real money now held, try every agent-reachable way to move it.
  {
    const stateBefore = (await settlementRow(sid)).state;
    const attempts = await tryAgentMoves(h, buyer, seller, sid, matchId);
    const stateAfter = (await settlementRow(sid)).state;
    // The LIVE surface, not a constant: I9's first half is a claim about what
    // the deployment actually offers, and a list read off this file would only
    // ever agree with itself. tools/list is off the per-account read ceiling.
    let toolNames: string[] = [...EXPECTED_MONEY_SURFACE];
    try {
      const listed = await mcpRpc(buyer.accessToken, 'tools/list', {});
      const live: string[] = (listed?.result?.tools ?? []).map((t: any) => t.name);
      if (live.length) toolNames = live;
      else res.notes.push('tools/list came back empty, so I9 fell back to the expected surface');
    } catch (e) {
      res.notes.push(`tools/list failed (${(e as Error).message.slice(0, 100)}); I9 used the expected surface`);
    }
    const from = check.violations.length;
    check.agentReach({ toolNames, attempts, stateBefore, stateAfter }, 'money group, agent reach against a funded settlement');
    took('I9', from);
    for (const a of attempts) log(`  I9 ${a.refused ? 'REFUSED' : 'GOT THROUGH'}: ${a.label} — ${a.detail}`);
  }

  await lockEvidence(seller, sid);
  await waitState(sid, 'evidence-locked', 60_000);
  log('  evidence locked by the seller');

  const confirm = await counterFetch(buyer.jar, `/settlements/${sid}/confirm`, form({ pin: buyer.pin }));
  log(`  buyer confirmed receipt: HTTP ${confirm.status}`);
  await waitState(sid, 'released');
  log('  released (webhook-driven)');

  // I10: ask Stripe what actually happened to the money.
  {
    const row = await settlementRow(sid);
    const pi = await stripeApi(`/v1/payment_intents/${row.paymentIntent}`);
    const transfer = await stripeApi(`/v1/transfers/${row.transferId}`);
    let destinationPaymentMinor: number | undefined;
    try {
      const destPayment = await stripeApi(
        `/v1/charges/${transfer.destination_payment}`,
        undefined,
        'GET',
        sellerStripeId,
      );
      destinationPaymentMinor = Number(destPayment.amount);
    } catch (e) {
      res.notes.push(`could not read the seller's own connected-account charge: ${(e as Error).message.slice(0, 120)}`);
    }
    const from = check.violations.length;
    check.release(
      {
        settlementId: sid,
        agreedMinor: AMOUNT_MINOR,
        feeMinor: row.feeMinor,
        processingMinor: row.processingMinor,
        buyerTotalMinor: row.buyerTotalMinor,
        chargedMinor: Number(pi.amount_received),
        transferMinor: Number(transfer.amount),
        transferGroup: transfer.transfer_group ?? null,
        transferDestination: transfer.destination ?? null,
        sellerStripeAccount: sellerStripeId,
        transferData: pi.transfer_data,
        applicationFeeAmount: pi.application_fee_amount,
        ...(destinationPaymentMinor !== undefined ? { destinationPaymentMinor } : {}),
      },
      'money group, settlement 1 at released',
    );
    took('I10', from);
    log(
      `  I10: buyer charged ${pi.amount_received} = ${AMOUNT_MINOR} + ${row.feeMinor} + ${row.processingMinor}; ` +
        `seller transferred ${transfer.amount}`,
    );
    res.settlements.push({
      id: sid,
      kind: 'release',
      finalState: (await settlementRow(sid)).state,
      agreedMinor: AMOUNT_MINOR,
      feeMinor: row.feeMinor,
      processingMinor: row.processingMinor,
      buyerTotalMinor: row.buyerTotalMinor,
      chargedMinor: Number(pi.amount_received),
      transferMinor: Number(transfer.amount),
    });
  }
  groupEnd();

  // =========================================================================
  // SETTLEMENT TWO: the payment freezes, the item goes back, the AGREED
  // AMOUNT follows it. This used to be "dispute -> whole total refunded", and
  // the change of behaviour is the whole reason I13 and I15 exist.
  // =========================================================================
  group('settlement 2 of 3: funded -> frozen -> sent back -> refunded');
  const two = await propose(h, buyer, matchId);
  if (!two.id) throw new Error(`could not propose the freeze-path settlement: ${two.detail}`);
  const did = two.id;
  await approveOnPage(buyer, did);
  await approveOnPage(seller, did);
  await fund(buyer, did);
  await lockEvidence(seller, did);
  await waitState(did, 'evidence-locked', 60_000);
  log(`  settlement ${did.slice(0, 8)} handed over; the buyer now says something is wrong`);

  const frozeAt = await counterFetch(
    buyer.jar,
    `/settlements/${did}/dispute`,
    form({ ground: 'not_as_described' }),
  );
  log(`  said something is wrong: HTTP ${frozeAt.status}`);

  // I15, the sharpest probe in this group: with the payment frozen and the
  // fourteen days still running, wind the HANDOVER clock into the past and
  // run the sweep. Nothing may move.
  {
    const before = await settlementRow(did);
    await dbExec(
      `UPDATE settlements SET auto_release_at = now() - interval '1 minute' WHERE id = :id::uuid`,
      [{ name: 'id', value: did }],
    );
    await sendOp({ op: 'settlement-auto-release' });
    await new Promise((r) => setTimeout(r, 20_000));
    const after = await settlementRow(did);
    const refunds = await refundFacts(after.paymentIntent);
    const from = check.violations.length;
    check.frozen(
      {
        settlementId: did,
        stateBefore: before.state,
        stateAfter: after.state,
        autoReleaseAtSet: after.autoReleaseAtSet,
        deadlockAtSet: after.deadlockAtSet,
        deadlockPassed: after.deadlockPassed,
        transferId: after.transferId,
        refundedMinor: refunds.refundedMinor,
      },
      'money group, settlement 2 frozen inside its window',
    );
    took('I15', from);
    log(
      `  I15: frozen at '${before.state}', still '${after.state}' after a sweep; ` +
        `transfer ${after.transferId ?? 'null'}, refunded ${refunds.refundedMinor}`,
    );
  }

  // The buyer sends it back with tracking; the seller says they have it.
  const returned = await counterFetch(
    buyer.jar,
    `/settlements/${did}/returned`,
    form({ tracking: 'SIM-RETURN-7XY4410092' }),
  );
  const gotItBack = await counterFetch(
    seller.jar,
    `/settlements/${did}/return-received`,
    form({ pin: seller.pin }),
  );
  log(`  sent back: HTTP ${returned.status}; seller has it back: HTTP ${gotItBack.status}`);
  await waitState(did, 'refunded');
  // The idempotency probe: pressing it again must not produce a second refund.
  const secondPress = await counterFetch(
    seller.jar,
    `/settlements/${did}/return-received`,
    form({ pin: seller.pin }),
  );

  {
    const row = await settlementRow(did);
    const refunds = await refundFacts(row.paymentIntent);
    const from = check.violations.length;
    check.refund(
      {
        settlementId: did,
        state: row.state,
        agreedMinor: AMOUNT_MINOR,
        feeMinor: row.feeMinor,
        processingMinor: row.processingMinor,
        buyerTotalMinor: row.buyerTotalMinor,
        refundMinor: row.refundMinor,
        refundedMinor: refunds.refundedMinor,
        refundCount: refunds.refundCount,
        transferId: row.transferId,
        secondPressStatus: secondPress.status,
      },
      'money group, settlement 2 at refunded',
    );
    took('I11', from);
    const feeFrom = check.violations.length;
    check.fees(
      {
        settlementId: did,
        agreedMinor: AMOUNT_MINOR,
        feeMinor: row.feeMinor,
        processingMinor: row.processingMinor,
        buyerTotalMinor: row.buyerTotalMinor,
        refundedMinor: refunds.refundedMinor,
      },
      'money group, settlement 2 at refunded',
    );
    took('I13', feeFrom);
    log(
      `  I11 + I13: ${refunds.refundedMinor} of the agreed ${AMOUNT_MINOR} went back across ` +
        `${refunds.refundCount} refund object(s); the buyer's total was ${row.buyerTotalMinor}, ` +
        `so ${(row.buyerTotalMinor ?? 0) - refunds.refundedMinor} stayed with the fee lines`,
    );
    res.settlements.push({
      id: did,
      kind: 'return',
      finalState: row.state,
      agreedMinor: AMOUNT_MINOR,
      feeMinor: row.feeMinor,
      processingMinor: row.processingMinor,
      buyerTotalMinor: row.buyerTotalMinor,
      refundedMinor: refunds.refundedMinor,
    });
  }
  groupEnd();

  // =========================================================================
  // SETTLEMENT THREE: the two of them agree a split, and the money follows
  // the agreement in both directions at once.
  // =========================================================================
  group('settlement 3 of 3: funded -> frozen -> split agreed -> settled-split');
  const three = await propose(h, buyer, matchId);
  if (!three.id) throw new Error(`could not propose the split-path settlement: ${three.detail}`);
  const sid3 = three.id;
  await approveOnPage(buyer, sid3);
  await approveOnPage(seller, sid3);
  await fund(buyer, sid3);
  await lockEvidence(seller, sid3);
  await waitState(sid3, 'evidence-locked', 60_000);
  await counterFetch(buyer.jar, `/settlements/${sid3}/dispute`, form({ ground: 'not_as_described' }));

  // A deliberately awkward split: the two figures have to add up to 7340 to
  // the cent, and neither of them may borrow from a fee line.
  const REFUND_PART = 1840;
  const RELEASE_PART = AMOUNT_MINOR - REFUND_PART; // 5500
  const proposed = await counterFetch(
    seller.jar,
    `/settlements/${sid3}/resolution`,
    form({
      refund_to_buyer: (REFUND_PART / 100).toFixed(2),
      release_to_seller: (RELEASE_PART / 100).toFixed(2),
    }),
  );
  const agreed = await counterFetch(
    buyer.jar,
    `/settlements/${sid3}/resolution/approve`,
    form({
      refund_minor: String(REFUND_PART),
      release_minor: String(RELEASE_PART),
      pin: buyer.pin,
    }),
  );
  log(`  split proposed: HTTP ${proposed.status}; agreed: HTTP ${agreed.status}`);
  await waitState(sid3, 'settled-split');

  {
    const row = await settlementRow(sid3);
    const refunds = await refundFacts(row.paymentIntent);
    const transfer = row.transferId ? await stripeApi(`/v1/transfers/${row.transferId}`) : undefined;
    const transferMinor = transfer ? Number(transfer.amount) : 0;
    const from = check.violations.length;
    check.split(
      {
        settlementId: sid3,
        agreedMinor: AMOUNT_MINOR,
        refundedMinor: refunds.refundedMinor,
        transferMinor,
        rowRefundMinor: row.refundMinor,
        rowReleaseMinor: row.releaseMinor,
        state: row.state,
      },
      'money group, settlement 3 at settled-split',
    );
    took('I14', from);
    const feeFrom = check.violations.length;
    check.fees(
      {
        settlementId: sid3,
        agreedMinor: AMOUNT_MINOR,
        feeMinor: row.feeMinor,
        processingMinor: row.processingMinor,
        buyerTotalMinor: row.buyerTotalMinor,
        refundedMinor: refunds.refundedMinor,
      },
      'money group, settlement 3 at settled-split',
    );
    if (res.checked.I13 !== 'violated') took('I13', feeFrom);
    log(
      `  I14: ${refunds.refundedMinor} back + ${transferMinor} out = ` +
        `${refunds.refundedMinor + transferMinor} of the ${AMOUNT_MINOR} held`,
    );
    res.settlements.push({
      id: sid3,
      kind: 'split',
      finalState: row.state,
      agreedMinor: AMOUNT_MINOR,
      feeMinor: row.feeMinor,
      processingMinor: row.processingMinor,
      buyerTotalMinor: row.buyerTotalMinor,
      transferMinor,
      refundedMinor: refunds.refundedMinor,
    });
  }
  groupEnd();

  if (check.violations.length === before) res.notes.push('every money invariant held on both settlements');
  return res;
}

/**
 * The tool surface, as the money group asserts it.
 *
 * I9's first half is a claim about NAMES, and it is worth stating in one
 * place: these eleven are the whole switchboard, and not one of them is a
 * money step. The runner reads the live list from tools/list; this constant is
 * what the money group holds it against when it wants the surface in hand
 * without spending another read on an account's ceiling.
 */
export const EXPECTED_MONEY_SURFACE = [
  'amend_intent',
  'check_in',
  'collect_messages',
  'list_intents',
  'open_conversation',
  'publish_intent',
  'respond',
  'send_message',
  'settle',
  'standing_arrangement',
  'withdraw_intent',
] as const;

/** The money group's lines for the run report. */
export function formatMoneyTable(r: MoneyResult): string[] {
  const out: string[] = [];
  for (const s of r.settlements) {
    out.push(
      `${s.kind.padEnd(7)} ${s.id.slice(0, 8)}  final=${s.finalState}  ` +
        `agreed=${s.agreedMinor} fee=${s.feeMinor} processing=${s.processingMinor} ` +
        `buyer_total=${s.buyerTotalMinor}` +
        (s.chargedMinor !== undefined ? `  stripe_charged=${s.chargedMinor}` : '') +
        (s.transferMinor !== undefined ? `  transfer=${s.transferMinor}` : '') +
        (s.refundedMinor !== undefined ? `  refunded=${s.refundedMinor}` : ''),
    );
  }
  for (const [id, verdict] of Object.entries(r.checked)) {
    out.push(`${id}: ${verdict}`);
  }
  for (const n of r.notes) out.push(`note: ${n}`);
  return out;
}
