/**
 * The settlement money shape, exercised against the real Stripe sandbox.
 *
 * This suite drives the server's OWN settlementStripe functions — the same
 * code the deployment runs — with the database and the envelope encryption
 * stood in for, so the whole Stripe side can be proved without a deployment
 * in front of it. It is the companion to settlement.test.ts, which proves the
 * same path end to end through live dev and the signature-verified webhook.
 *
 * What it establishes:
 *  - a v2 Recipient account is created the way the server creates it, and a
 *    pre-verified one reads back stripe_transfers: active;
 *  - the hosted onboarding link comes back for the recipient configuration;
 *  - the Checkout Session takes the agreed amount into the PLATFORM balance,
 *    carrying the settlement id as its transfer_group, with no destination
 *    and no application fee — and a real browser can pay it;
 *  - verifyPaymentMatchesSettlement accepts that payment and refuses a
 *    payment of the wrong amount;
 *  - the release transfers amount - fee to the seller, once, however many
 *    times it is called;
 *  - the refund path puts the buyer's money back in full.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

// The two things this suite stands in for: the database, and the envelope
// encryption of the seller's connected-account id. Everything else is real.
const dbCalls: { sql: string; params: any[] }[] = [];
let sellerAccountIdStored: string | undefined;
let sellerGeoCountry: string | null = 'AU';

vi.mock('../../src/db.js', () => ({
  getPool: () => ({
    query: async (sql: string, params: any[] = []) => {
      dbCalls.push({ sql, params });
      if (/geo_country/.test(sql)) return { rows: [{ geo_country: sellerGeoCountry }], rowCount: 1 };
      if (/UPDATE accounts SET stripe_account_id_enc/.test(sql)) {
        sellerAccountIdStored = String(params[1]);
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }),
}));

vi.mock('../../src/domain/accounts.js', () => ({
  getAccount: async (id: string) => ({
    id,
    data_key_enc: Buffer.from('unused'),
    // Present exactly when a connected account has been attached, the way the
    // real column behaves.
    stripe_account_id_enc: sellerAccountIdStored ? Buffer.from(sellerAccountIdStored) : null,
  }),
}));

vi.mock('../../src/domain/counterOps.js', () => ({
  accountEmail: async () => 'testsuite+seller@openswitchboard.ai',
}));

vi.mock('../../src/crypto.js', () => ({
  // The id goes in and comes back out; the real envelope crypto is covered by
  // its own suite and by the live-dev settlement gate.
  encryptField: async (_a: string, _k: unknown, v: string) => v,
  decryptFields: async (_a: string, _k: unknown, fields: Record<string, string>) => ({
    stripe_account_id: sellerAccountIdStored ?? fields.stripe_account_id,
  }),
}));

const { initStripe, getStripe, settlementFeeMinor, toMinorUnits } = await import(
  '../../src/stripe.js'
);
const stripeDomain = await import('../../src/domain/settlementStripe.js');
const { createPreVerifiedSeller, ensurePlatformBalance, payHostedCheckout } = await import(
  './stripeHelpers.js'
);

const cfg: any = {
  envName: 'dev',
  counterOrigin: 'https://my-dev.openswitchboard.ai',
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
  stripeSecretArn: 'osb/dev/stripe',
};

const AMOUNT = 87.65;
const AMOUNT_MINOR = 8765;
const FEE_MINOR = 100;

/** A settlement row, exactly as the database would hand it over. */
function settlementRow(over: Record<string, any> = {}): any {
  return {
    id: crypto.randomUUID(),
    match_id: crypto.randomUUID(),
    proposer_account: crypto.randomUUID(),
    buyer_account: crypto.randomUUID(),
    seller_account: crypto.randomUUID(),
    amount: String(AMOUNT),
    ccy: 'AUD',
    description: null,
    state: 'approved',
    fee_amount_minor: 0,
    buyer_approved_at: null,
    seller_approved_at: null,
    stripe_checkout_session: null,
    stripe_payment_intent: null,
    stripe_transfer_id: null,
    evidence_manifest_key: null,
    ...over,
  };
}

d('the settlement money shape against the Stripe sandbox', () => {
  let preVerifiedSeller: string;

  beforeAll(async () => {
    initStripe(cfg);
    preVerifiedSeller = await createPreVerifiedSeller(`unit${Date.now().toString(36)}`);
    sellerAccountIdStored = preVerifiedSeller;
    await ensurePlatformBalance(AMOUNT_MINOR * 2, 'AUD');
  }, 180_000);

  it('opens a v2 recipient account for a seller, and asks for it to be onboarded', async () => {
    sellerAccountIdStored = undefined;
    const s = settlementRow();
    const acctId = await stripeDomain.ensureSellerStripeAccount(cfg, s.seller_account, s);
    expect(acctId).toMatch(/^acct_/);
    // Freshly opened, so it cannot receive anything yet.
    expect(await stripeDomain.sellerAccountReady(acctId)).toBe(false);
    // And the hosted flow that fixes that comes back as a Stripe URL.
    const link = await stripeDomain.sellerOnboardingLink(cfg, acctId, s.id);
    expect(link).toMatch(/^https:\/\/connect\.stripe\.com\//);
    sellerAccountIdStored = preVerifiedSeller;
  }, 120_000);

  it('reads a pre-verified recipient as ready', async () => {
    expect(await stripeDomain.sellerAccountReady(preVerifiedSeller)).toBe(true);
  }, 60_000);

  it('takes the buyer\'s money into the platform balance and releases amount - fee', async () => {
    const s = settlementRow();
    const { url, sessionId } = await stripeDomain.createCheckoutForSettlement(cfg, s);
    expect(url).toContain('checkout.stripe.com');

    const stripe = await getStripe();
    const created = await stripe.checkout.sessions.retrieve(sessionId);
    expect(created.amount_total).toBe(AMOUNT_MINOR);
    expect(created.currency).toBe('aud');
    expect(created.metadata?.osb_settlement_id).toBe(s.id);
    // The label Stripe asks integrations to carry, with its random suffix.
    expect(created.integration_identifier).toMatch(/^osb_settlement_[a-z]{8}$/);
    // The fee was written onto the settlement when the session was made.
    const feeWrite = dbCalls.find((c) => /fee_amount_minor = \$3/.test(c.sql));
    expect(feeWrite?.params[2]).toBe(FEE_MINOR);

    // A real browser pays the real page.
    await payHostedCheckout(url);
    const paid = await stripe.checkout.sessions.retrieve(sessionId);
    expect(paid.status).toBe('complete');
    expect(paid.payment_status).toBe('paid');
    const piId = String(paid.payment_intent);
    s.stripe_payment_intent = piId;

    // Nothing was routed away from us, and the settlement id ties it together.
    const pi = await stripe.paymentIntents.retrieve(piId);
    expect(pi.status).toBe('succeeded');
    expect(pi.amount_received).toBe(AMOUNT_MINOR);
    expect(pi.transfer_group).toBe(s.id);
    expect(pi.transfer_data ?? null).toBeNull();
    expect(pi.application_fee_amount ?? null).toBeNull();

    // The check the webhook runs before it funds anything.
    expect(await stripeDomain.verifyPaymentMatchesSettlement(cfg, s, piId)).toEqual({ ok: true });
    const wrongAmount = await stripeDomain.verifyPaymentMatchesSettlement(
      cfg,
      { ...s, amount: '99.99' },
      piId,
    );
    expect(wrongAmount.ok).toBe(false);

    // Release: one transfer, for the amount less the flat introductory fee.
    const transfer = await stripeDomain.transferToSellerForSettlement(cfg, s);
    expect(transfer.amount).toBe(AMOUNT_MINOR - FEE_MINOR);
    expect(transfer.currency).toBe('aud');
    expect(transfer.destination).toBe(preVerifiedSeller);
    expect(transfer.transfer_group).toBe(s.id);

    // Called again — a human pressing confirm twice — the seller is paid once.
    const again = await stripeDomain.transferToSellerForSettlement(cfg, s);
    expect(again.id).toBe(transfer.id);

    // And the money is really on the seller's account.
    const dest = await stripe.charges.retrieve(
      String(transfer.destination_payment),
      {},
      { stripeAccount: preVerifiedSeller },
    );
    expect(dest.amount).toBe(AMOUNT_MINOR - FEE_MINOR);
  }, 600_000);

  it('refuses to release to a seller who cannot receive transfers', async () => {
    sellerAccountIdStored = undefined;
    const s = settlementRow();
    const fresh = await stripeDomain.ensureSellerStripeAccount(cfg, s.seller_account, s);
    sellerAccountIdStored = fresh;
    await expect(stripeDomain.transferToSellerForSettlement(cfg, s)).rejects.toThrow(
      /cannot receive transfers/,
    );
    sellerAccountIdStored = preVerifiedSeller;
  }, 120_000);

  it('puts the buyer\'s money back in full on a refund, fee included', async () => {
    const s = settlementRow();
    const { url, sessionId } = await stripeDomain.createCheckoutForSettlement(cfg, s);
    await payHostedCheckout(url);
    const stripe = await getStripe();
    const paid = await stripe.checkout.sessions.retrieve(sessionId);
    s.stripe_payment_intent = String(paid.payment_intent);

    await stripeDomain.refundPaymentForSettlement(s);
    // Called twice: still one refund.
    await stripeDomain.refundPaymentForSettlement(s);

    const pi = await stripe.paymentIntents.retrieve(String(s.stripe_payment_intent), {
      expand: ['latest_charge'],
    });
    const charge = pi.latest_charge as any;
    expect(charge.refunded).toBe(true);
    expect(charge.amount_refunded).toBe(AMOUNT_MINOR);
    const refunds = await stripe.refunds.list({ charge: charge.id });
    expect(refunds.data).toHaveLength(1);
  }, 600_000);

  it('the fee is the flat introductory one, whatever the settlement is worth', () => {
    expect(settlementFeeMinor(toMinorUnits(AMOUNT, 'AUD'), cfg)).toBe(FEE_MINOR);
    expect(settlementFeeMinor(toMinorUnits(2500, 'AUD'), cfg)).toBe(FEE_MINOR);
  });
});
