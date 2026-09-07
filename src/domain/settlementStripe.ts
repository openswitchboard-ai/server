/**
 * Stripe orchestration for settlements: seller onboarding (Accounts v2,
 * Recipient configuration, hosted account-link flow), the buyer's payment
 * (a Stripe-hosted Checkout Session captured straight into the PLATFORM
 * balance), the transfer out to the seller on confirmed receipt, and the
 * refund back to the buyer on a dispute.
 *
 * SHAPE: separate charges and transfers.
 *   - The buyer's money is captured immediately into our own Stripe balance.
 *     No destination charge, no transfer_data, no application fee, no manual
 *     capture. The settlement id is the PaymentIntent's transfer_group.
 *   - The buyer pays three itemised lines: the agreed amount, our flat
 *     introductory fee, and card processing at Stripe's standard rate, grossed
 *     up so the first two survive Stripe's cut of the whole charge.
 *   - "Safe hands" is therefore the platform holding the money rather than a
 *     card authorisation ageing out. Releasing is a Transfer of the AGREED
 *     AMOUNT to the seller's connected account, with the same transfer_group
 *     and the settlement id as its idempotency key: the seller receives what
 *     was agreed, in full, and the two fee lines stay in the platform balance
 *     because the buyer put them there.
 *   - Refunding is a refund of the PaymentIntent for part or all of the AGREED
 *     AMOUNT, never the fee lines: the terms say the $1 and the processing
 *     cost are kept in every outcome, because the processor keeps its fee on a
 *     refund. The money never left our balance, so nothing has to be reversed.
 *   - A dispute resolved by agreement moves both at once: a partial refund of
 *     the buyer's part and a transfer of the seller's part, the two adding up
 *     to the agreed amount, either of them possibly zero and then skipped.
 *
 * NOTE these functions move money but never settlement STATE: state changes
 * live exclusively in settlements.ts behind human/webhook contexts. Transfer
 * and refund are called only from the approval page's session-authenticated
 * routes, right after the human transition that authorises them, and the
 * funded/released/refunded states land from verified webhooks.
 */
import { randomBytes } from 'node:crypto';
import type Stripe from 'stripe';
import { getPool } from '../db.js';
import { decryptFields, encryptField } from '../crypto.js';
import { getAccount } from './accounts.js';
import { accountEmail } from './counterOps.js';
import { getStripe, settlementBreakdown, toMinorUnits } from '../stripe.js';
import type { Config } from '../config.js';
import type { SettlementRow } from './settlements.js';

/** Country we open a seller's connected account in when we cannot tell. */
const DEFAULT_COUNTRY = 'AU';

/** Decrypt the seller's connected-account id, if one exists. */
export async function sellerStripeAccountId(
  sellerAccountId: string,
  purposeRef: string,
): Promise<string | undefined> {
  const a: any = await getAccount(sellerAccountId);
  if (!a?.stripe_account_id_enc) return undefined;
  const f = await decryptFields(
    sellerAccountId,
    a.data_key_enc,
    { stripe_account_id: a.stripe_account_id_enc },
    { purpose: 'settlement-payment-routing', actor: 'system', refs: { settlement_id: purposeRef } },
  );
  return f.stripe_account_id;
}

/**
 * Which country to open the seller's account in. The switchboard holds no
 * address for anyone; the nearest honest signal is the country the listing
 * they are selling from resolved to. Falls back to AU.
 */
async function sellerCountry(s: SettlementRow): Promise<string> {
  const r = await getPool().query(
    `SELECT c.geo_country FROM settlements s
       JOIN matches m ON m.id = s.match_id
       JOIN cards c ON c.id = m.card_have
     WHERE s.id = $1`,
    [s.id],
  );
  const code = r.rows[0]?.geo_country;
  return /^[A-Za-z]{2}$/.test(code ?? '') ? String(code).toUpperCase() : DEFAULT_COUNTRY;
}

/**
 * Ensure the seller has a Stripe connected account (created at first
 * settlement approval). Accounts v2 with a Recipient configuration: the
 * account receives transfers into its Stripe balance and is never the
 * merchant of record, which is what separate charges and transfers needs.
 * The platform collects fees and carries losses. The account id is
 * envelope-encrypted onto the seller's account row.
 */
export async function ensureSellerStripeAccount(
  cfg: Config,
  sellerAccountId: string,
  settlement: SettlementRow,
): Promise<string> {
  const existing = await sellerStripeAccountId(sellerAccountId, settlement.id);
  if (existing) return existing;
  // Stripe needs somewhere to write to the seller about their own payment
  // setup, and a Recipient configuration is refused without one. This is the
  // seller's own address, decrypted for that single purpose, at the moment
  // they approve the settlement that opens the account.
  const contactEmail = await accountEmail(sellerAccountId, 'settlement-payment-setup');
  if (!contactEmail) throw new Error('seller has no email for Stripe payment setup');
  const stripe = await getStripe();
  const created = await stripe.v2.core.accounts.create({
    contact_email: contactEmail,
    dashboard: 'express',
    defaults: {
      currency: settlement.ccy.toLowerCase(),
      responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      profile: {
        business_url: 'https://openswitchboard.ai',
        product_description: 'Person-to-person settlement through OpenSwitchboard',
      },
    },
    identity: { country: await sellerCountry(settlement) },
    configuration: {
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
    },
    metadata: { osb_env: cfg.envName, osb_settlement: settlement.id },
  });
  const a: any = await getAccount(sellerAccountId);
  if (!a) throw new Error('seller account missing');
  const enc = await encryptField(sellerAccountId, a.data_key_enc, created.id);
  const r = await getPool().query(
    `UPDATE accounts SET stripe_account_id_enc = $2, stripe_account_created_at = now()
     WHERE id = $1 AND stripe_account_id_enc IS NULL RETURNING id`,
    [sellerAccountId, enc],
  );
  if (!r.rowCount) {
    // Lost a race to a concurrent approval: keep the stored one, drop ours.
    await stripe.v2.core.accounts.close(created.id, { applied_configurations: ['recipient'] })
      .catch(() => {});
    const kept = await sellerStripeAccountId(sellerAccountId, settlement.id);
    if (!kept) throw new Error('failed to store seller connected account');
    return kept;
  }
  return created.id;
}

/** Hosted onboarding link for the seller's payment setup. Single-use. */
export async function sellerOnboardingLink(
  cfg: Config,
  stripeAccountId: string,
  settlementId: string,
): Promise<string> {
  const stripe = await getStripe();
  const link = await stripe.v2.core.accountLinks.create({
    account: stripeAccountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        refresh_url: `${cfg.counterOrigin}/settlements/${settlementId}`,
        return_url: `${cfg.counterOrigin}/settlements/${settlementId}`,
      },
    },
  });
  return link.url;
}

/**
 * Can this connected account receive a transfer yet?
 *
 * The one true reading is the Recipient configuration's stripe_transfers
 * capability. charges_enabled and payouts_enabled describe a merchant account
 * and say nothing about whether we can move money into this one, so they are
 * never consulted.
 *
 * This is asked FRESH before every transfer, as well as on the page. Stripe
 * announces a capability going active or lapsing as a v2 thin event
 * (v2.core.account[configuration.recipient].capability_status_updated), which
 * arrives on a v2 event destination rather than the v1 webhook endpoint this
 * service runs — a second inbound surface, with its own signing secret, whose
 * only job would be to cache an answer we can simply ask for. Asking at the
 * moment it matters is both simpler and stricter: a capability that lapsed
 * between onboarding and release stops the release here, rather than failing
 * at Stripe with the settlement already marked done.
 */
export async function sellerAccountReady(stripeAccountId: string): Promise<boolean> {
  const stripe = await getStripe();
  const acct = await stripe.v2.core.accounts.retrieve(stripeAccountId, {
    include: ['configuration.recipient'],
  });
  return (
    acct.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status ===
    'active'
  );
}

/** Eight random letters, the label Stripe asks integrations to carry. */
function integrationIdentifier(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (const b of randomBytes(8)) suffix += letters[b % 26];
  return `osb_settlement_${suffix}`;
}

/**
 * Create the buyer's Checkout Session: Stripe's hosted payment page, captured
 * immediately into the platform balance. No destination, no application fee —
 * the seller's share leaves later, as a transfer. The settlement id travels
 * as the PaymentIntent's transfer_group so the charge and the transfer sit
 * together in Stripe's own reporting.
 *
 * THREE LINE ITEMS, because the buyer pays the fees and is shown what they
 * are: the thing itself at the agreed amount, our flat introductory fee, and
 * card processing at Stripe's standard rate. The seller receives the agreed
 * amount in full.
 *
 * The breakdown is written onto the settlement row here, at the moment the
 * buyer is shown it. That row, and not a recomputation from config, is what
 * the funding webhook checks the payment against later.
 */
export async function createCheckoutForSettlement(
  cfg: Config,
  s: SettlementRow,
): Promise<{ url: string; sessionId: string }> {
  const stripe = await getStripe();
  const amountMinor = toMinorUnits(Number(s.amount), s.ccy);
  const b = settlementBreakdown(amountMinor, cfg);
  const currency = s.ccy.toLowerCase();
  const line = (unit_amount: number, name: string) => ({
    quantity: 1,
    price_data: { currency, unit_amount, product_data: { name } },
  });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: `${cfg.counterOrigin}/settlements/${s.id}`,
    cancel_url: `${cfg.counterOrigin}/settlements/${s.id}`,
    integration_identifier: integrationIdentifier(),
    line_items: [
      line(b.amountMinor, 'What you agreed (held until you confirm receipt)'),
      line(b.feeMinor, 'Protected payment — introductory fee'),
      line(b.processingMinor, "Card processing, at Stripe's standard rate"),
    ],
    payment_intent_data: {
      transfer_group: s.id,
      metadata: { osb_settlement_id: s.id, osb_env: cfg.envName },
    },
    metadata: { osb_settlement_id: s.id, osb_env: cfg.envName },
  });
  if (!session.url) throw new Error('stripe checkout session has no url');
  await getPool().query(
    `UPDATE settlements SET stripe_checkout_session = $2, fee_amount_minor = $3,
       processing_fee_minor = $4, buyer_total_minor = $5, updated_at = now()
     WHERE id = $1`,
    [s.id, session.id, b.feeMinor, b.processingMinor, b.buyerTotalMinor],
  );
  return { url: session.url, sessionId: session.id };
}

/**
 * The buyer's payment URL: reuse the settlement's open Checkout Session if
 * one exists (a second completed session would charge the buyer twice),
 * create one otherwise.
 */
export async function checkoutUrlForSettlement(cfg: Config, s: SettlementRow): Promise<string> {
  const stripe = await getStripe();
  if (s.stripe_checkout_session) {
    const existing = await stripe.checkout.sessions.retrieve(s.stripe_checkout_session);
    if (existing.status === 'open' && existing.url) return existing.url;
  }
  const created = await createCheckoutForSettlement(cfg, s);
  return created.url;
}

/**
 * Release: transfer the AGREED AMOUNT, in full, from the platform balance to
 * the seller. Our fee and the processing recovery never touch this figure —
 * the buyer paid both as lines of their own, so they are already sitting in
 * the platform balance by construction.
 *
 * The settlement id is the idempotency key, so a retry — a human pressing
 * confirm twice, a route replayed — can never pay the seller twice. The
 * seller's readiness is re-checked against Stripe right here, because the
 * capability may have lapsed since the money was taken.
 *
 * The 'released' STATE does not land here: transfer.created arrives on the
 * verified webhook and drives confirmed -> released. See the note in
 * stripeWebhook.ts for why.
 */
export async function transferToSellerForSettlement(
  cfg: Config,
  s: SettlementRow,
  /** The seller's part of an agreed split. Left out, it is the whole agreed
   *  amount — every road but a split sends all of it. */
  partMinor?: number,
): Promise<Stripe.Transfer> {
  const sellerId = await sellerStripeAccountId(s.seller_account, s.id);
  if (!sellerId) throw new Error('settlement has no seller connected account');
  if (!(await sellerAccountReady(sellerId))) {
    throw new Error(`seller account ${sellerId} cannot receive transfers`);
  }
  const stripe = await getStripe();
  const agreedMinor = toMinorUnits(Number(s.amount), s.ccy);
  const amountMinor = partMinor ?? agreedMinor;
  // A settlement holds the agreed amount and nothing else, so no road out of
  // it can send the seller more than that. Checked here, at the last moment
  // before the money moves, whatever the caller believed.
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > agreedMinor) {
    throw new Error(`release of ${amountMinor} is not inside the agreed ${agreedMinor}`);
  }
  const transfer = await stripe.transfers.create(
    {
      amount: amountMinor,
      currency: s.ccy.toLowerCase(),
      destination: sellerId,
      transfer_group: s.id,
      metadata: { osb_settlement_id: s.id, osb_env: cfg.envName },
    },
    { idempotencyKey: `osb-settlement-release-${s.id}` },
  );
  await getPool().query(
    `UPDATE settlements SET stripe_transfer_id = $2, updated_at = now() WHERE id = $1`,
    [s.id, transfer.id],
  );
  return transfer;
}

/**
 * Refund: part or all of the AGREED AMOUNT goes back to the buyer, and never a
 * fee.
 *
 * THE FEES ARE NEVER REFUNDED, on any road, and that is a promise the public
 * terms make rather than a convenience: "The $1 and the processing cost are
 * kept in every outcome, including a refund, because the processor keeps its
 * fee on a refund and we pass it on rather than absorb it into the price." So
 * this always carries an explicit amount — the old refund carried none, which
 * is Stripe's way of saying "all of it", and all of it is exactly what must
 * not go back.
 *
 * The amount is checked against the agreed amount here, at the last moment
 * before the money moves: a settlement holds the agreed amount and nothing
 * else, so no road out of it can send the buyer more than that.
 *
 * The money never left the platform balance, so there is nothing to claw back
 * from the seller. THERE IS NO TRANSFER REVERSAL HERE ANY MORE, and the reason
 * is worth writing down: the old refund reversed one in case a release and a
 * dispute had crossed. They cannot. A dispute is only accepted from 'funded'
 * or 'evidence-locked' and a transfer only goes out from 'confirmed', and the
 * single state writer is a compare-and-swap, so of a confirm and a dispute
 * exactly one wins. Keeping the reversal would have been actively wrong for an
 * agreed split, where a refund and a transfer are both meant to happen.
 *
 * The refund id is written to the row as soon as the API returns, the way the
 * transfer id is. That mark is also what keeps the sweep's refunding rules
 * from firing twice on a settlement whose webhook is slow.
 *
 * The 'refunded' state lands from the charge.refunded webhook.
 */
export async function refundAgreedAmountForSettlement(
  s: SettlementRow,
  amountMinor: number,
): Promise<void> {
  if (!s.stripe_payment_intent) throw new Error('settlement has no payment to refund');
  const agreedMinor = toMinorUnits(Number(s.amount), s.ccy);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > agreedMinor) {
    throw new Error(`refund of ${amountMinor} is not inside the agreed ${agreedMinor}`);
  }
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(s.stripe_payment_intent);
  const charge = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (charge) {
    const existing = await stripe.refunds.list({ charge, limit: 1 });
    if (existing.data.length) {
      // Idempotent retry path: record whatever went out, so the row and Stripe
      // agree even when the first attempt's response was lost.
      await getPool().query(
        `UPDATE settlements SET stripe_refund_id = COALESCE(stripe_refund_id, $2), updated_at = now()
         WHERE id = $1`,
        [s.id, existing.data[0].id],
      );
      return;
    }
  }
  const refund = await stripe.refunds.create(
    {
      payment_intent: s.stripe_payment_intent,
      amount: amountMinor,
      metadata: { osb_settlement_id: s.id },
    },
    { idempotencyKey: `osb-settlement-refund-${s.id}` },
  );
  await getPool().query(
    `UPDATE settlements SET stripe_refund_id = $2, updated_at = now() WHERE id = $1`,
    [s.id, refund.id],
  );
}

/**
 * Both legs of an agreed split, in the order that is safe to be interrupted
 * in: the buyer's refund first, the seller's transfer second. A crash between
 * them leaves a buyer part-refunded and a settlement still in 'resolved',
 * which is visible and recoverable; the other order would leave the seller
 * paid and the buyer waiting.
 *
 * A leg of zero is skipped rather than sent, because Stripe has no zero-amount
 * refund or transfer and because there is nothing to move. markSplitLeg knows
 * not to wait for a leg that was never sent.
 *
 * Both legs carry the settlement id as their idempotency key, so this whole
 * function is safe to call again: the buyer is refunded once and the seller is
 * paid once, however many times anyone presses anything.
 */
export async function moveSplitForSettlement(
  cfg: Config,
  s: SettlementRow,
): Promise<void> {
  const refundMinor = s.refund_minor ?? 0;
  const releaseMinor = s.release_minor ?? 0;
  const agreedMinor = toMinorUnits(Number(s.amount), s.ccy);
  if (refundMinor + releaseMinor !== agreedMinor) {
    throw new Error(
      `split ${refundMinor} + ${releaseMinor} does not add up to the agreed ${agreedMinor}`,
    );
  }
  if (refundMinor > 0) await refundAgreedAmountForSettlement(s, refundMinor);
  if (releaseMinor > 0) await transferToSellerForSettlement(cfg, s, releaseMinor);
}

/**
 * Verify a PaymentIntent actually matches its settlement before the funded
 * transition: the right total, right currency, the settlement's own
 * transfer_group, and money actually taken. Anything else is refused — a
 * webhook event can only fund a settlement with the exact payment shape the
 * settlement calls for.
 *
 * The total checked is buyer_total_minor, WRITTEN ONTO THE ROW when the
 * Checkout Session was created, so this is a comparison against the figure
 * the buyer was actually shown. It is never recomputed from config here: a
 * fee or a rate changed between the session and the payment would otherwise
 * refuse an honest payment. A settlement with no recorded total has no
 * session behind it and funds nothing.
 *
 * There is no capture-method check any more: these charges capture on the
 * spot, and no destination to check either, because the money lands in the
 * platform balance and is transferred on separately.
 */
export async function verifyPaymentMatchesSettlement(
  s: SettlementRow,
  paymentIntentId: string,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const expectedMinor = s.buyer_total_minor;
  if (expectedMinor === null || expectedMinor === undefined) {
    return { ok: false, problem: 'settlement has no recorded buyer total' };
  }
  if (pi.status !== 'succeeded') return { ok: false, problem: `status ${pi.status}` };
  if (pi.amount_received !== expectedMinor) {
    return { ok: false, problem: `received ${pi.amount_received} != ${expectedMinor}` };
  }
  if (pi.currency.toUpperCase() !== s.ccy.toUpperCase()) {
    return { ok: false, problem: `currency ${pi.currency}` };
  }
  if (pi.transfer_group !== s.id) {
    return { ok: false, problem: `transfer_group ${pi.transfer_group}` };
  }
  if (pi.transfer_data || pi.application_fee_amount) {
    return { ok: false, problem: 'payment routes money away from the platform balance' };
  }
  return { ok: true };
}
