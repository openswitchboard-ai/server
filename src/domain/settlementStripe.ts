/**
 * Stripe orchestration for settlements: seller onboarding (Connect express
 * dashboard, hosted account-link flow), the escrowed Checkout payment
 * (manual-capture destination charge — we never see card details), capture
 * on release and cancellation on dispute.
 *
 * NOTE these functions move money but never settlement STATE: state changes
 * live exclusively in settlements.ts behind human/webhook contexts. Capture
 * and cancel are called only from the approval page's session-authenticated
 * routes, right after the human transition that authorises them.
 */
import { getPool } from '../db.js';
import { decryptFields, encryptField } from '../crypto.js';
import { getAccount } from './accounts.js';
import { feeMinorUnits, getStripe, toMinorUnits } from '../stripe.js';
import type { Config } from '../config.js';
import type { SettlementRow } from './settlements.js';

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
 * Ensure the seller has a Stripe connected account (created at first
 * settlement approval). Express-dashboard, Stripe-collected requirements,
 * platform holds pricing and liability — the marketplace shape. The account
 * id is envelope-encrypted onto the seller's account row.
 */
export async function ensureSellerStripeAccount(
  cfg: Config,
  sellerAccountId: string,
  settlementId: string,
): Promise<string> {
  const existing = await sellerStripeAccountId(sellerAccountId, settlementId);
  if (existing) return existing;
  const stripe = await getStripe();
  const created = await stripe.accounts.create({
    country: 'AU',
    controller: {
      fees: { payer: 'application' },
      losses: { payments: 'application' },
      stripe_dashboard: { type: 'express' },
      requirement_collection: 'stripe',
    },
    capabilities: { transfers: { requested: true } },
    metadata: { osb_env: cfg.envName, osb_settlement: settlementId },
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
    await stripe.accounts.del(created.id).catch(() => {});
    const kept = await sellerStripeAccountId(sellerAccountId, settlementId);
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
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${cfg.counterOrigin}/counter/settlements/${settlementId}`,
    return_url: `${cfg.counterOrigin}/counter/settlements/${settlementId}`,
    type: 'account_onboarding',
  });
  return link.url;
}

/** Can this connected account receive the destination transfer yet? */
export async function sellerAccountReady(stripeAccountId: string): Promise<boolean> {
  const stripe = await getStripe();
  const acct = await stripe.accounts.retrieve(stripeAccountId);
  return acct.capabilities?.transfers === 'active';
}

/**
 * Create the buyer's escrow Checkout Session: hosted payment page,
 * manual-capture PaymentIntent (the hold), destination charge to the
 * seller's connected account, application fee from config (set to 0).
 */
export async function createCheckoutForSettlement(
  cfg: Config,
  s: SettlementRow,
  sellerStripeId: string,
): Promise<{ url: string; sessionId: string }> {
  const stripe = await getStripe();
  const amountMinor = toMinorUnits(Number(s.amount), s.ccy);
  const fee = feeMinorUnits(amountMinor, cfg.settlementFeePercent);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: `${cfg.counterOrigin}/counter/settlements/${s.id}`,
    cancel_url: `${cfg.counterOrigin}/counter/settlements/${s.id}`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: s.ccy.toLowerCase(),
          unit_amount: amountMinor,
          product_data: { name: 'OpenSwitchboard settlement (held until you confirm receipt)' },
        },
      },
    ],
    payment_intent_data: {
      capture_method: 'manual',
      transfer_data: { destination: sellerStripeId },
      application_fee_amount: fee,
      metadata: { osb_settlement_id: s.id, osb_env: cfg.envName },
    },
    metadata: { osb_settlement_id: s.id, osb_env: cfg.envName },
  });
  if (!session.url) throw new Error('stripe checkout session has no url');
  await getPool().query(
    `UPDATE settlements SET stripe_checkout_session = $2, fee_amount_minor = $3,
       updated_at = now() WHERE id = $1`,
    [s.id, session.id, fee],
  );
  return { url: session.url, sessionId: session.id };
}

/** Capture the held payment (buyer confirmed receipt). The 'released' state
 *  lands when Stripe's webhook reports the capture. */
export async function capturePaymentForSettlement(s: SettlementRow): Promise<void> {
  if (!s.stripe_payment_intent) throw new Error('settlement has no payment to capture');
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(s.stripe_payment_intent);
  if (pi.status === 'succeeded') return; // capture already landed (retry path)
  await stripe.paymentIntents.capture(s.stripe_payment_intent);
}

/** Cancel the held payment (dispute): the authorisation is released back to
 *  the buyer's card. The 'refunded' state lands via webhook. */
export async function cancelPaymentForSettlement(s: SettlementRow): Promise<void> {
  if (!s.stripe_payment_intent) throw new Error('settlement has no payment to cancel');
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(s.stripe_payment_intent);
  if (pi.status === 'canceled') return; // idempotent retry path
  await stripe.paymentIntents.cancel(s.stripe_payment_intent);
}

/**
 * The buyer's payment URL: reuse the settlement's open Checkout Session if
 * one exists (a second completed session would double-hold the buyer's
 * money), create one otherwise.
 */
export async function checkoutUrlForSettlement(
  cfg: Config,
  s: SettlementRow,
  sellerStripeId: string,
): Promise<string> {
  const stripe = await getStripe();
  if (s.stripe_checkout_session) {
    const existing = await stripe.checkout.sessions.retrieve(s.stripe_checkout_session);
    if (existing.status === 'open' && existing.url) return existing.url;
  }
  const created = await createCheckoutForSettlement(cfg, s, sellerStripeId);
  return created.url;
}

/**
 * Verify a PaymentIntent actually matches its settlement before the funded
 * transition: right amount, right currency, right destination (the seller's
 * stored connected account), manual capture, and a live hold. Anything else
 * is refused — a webhook event can only fund a settlement with the exact
 * payment shape the settlement calls for.
 */
export async function verifyPaymentMatchesSettlement(
  cfg: Config,
  s: SettlementRow,
  paymentIntentId: string,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const expectedMinor = toMinorUnits(Number(s.amount), s.ccy);
  const expectedFee = feeMinorUnits(expectedMinor, cfg.settlementFeePercent);
  const sellerId = await sellerStripeAccountId(s.seller_account, s.id);
  if (pi.status !== 'requires_capture') return { ok: false, problem: `status ${pi.status}` };
  if (pi.capture_method !== 'manual') return { ok: false, problem: 'capture_method is automatic' };
  if (pi.amount !== expectedMinor) return { ok: false, problem: `amount ${pi.amount} != ${expectedMinor}` };
  if (pi.currency.toUpperCase() !== s.ccy.toUpperCase()) {
    return { ok: false, problem: `currency ${pi.currency}` };
  }
  if (!sellerId || pi.transfer_data?.destination !== sellerId) {
    return { ok: false, problem: 'destination is not the seller' };
  }
  if ((pi.application_fee_amount ?? 0) !== expectedFee) {
    return { ok: false, problem: `fee ${pi.application_fee_amount} != ${expectedFee}` };
  }
  return { ok: true };
}
