/**
 * Stripe wiring for the safe-hands settlement core.
 *
 * Every call goes through a StripeClient instance built here; no global key
 * is ever set. The API version is pinned.
 *
 * The secret key lives in Secrets Manager (osb/<env>/stripe, JSON
 * {secret_key, webhook_secret?}) and is injected as STRIPE_SECRET_ARN.
 * Deployments without it run with settlement handling OFF: nothing here is
 * called, `settle` answers SETTLEMENT_UNAVAILABLE, and /stripe/webhook 404s.
 *
 * The webhook endpoint is created through the API on boot (first deploy) —
 * its signing secret is written back into the same Secrets Manager secret as
 * `webhook_secret`. Incoming events are verified against that secret before
 * anything reads them; an unverifiable event is rejected and drives nothing.
 */
import Stripe from 'stripe';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { secretsManager } from './aws.js';
import type { Config } from './config.js';

export const STRIPE_WEBHOOK_PATH = '/stripe/webhook';

/**
 * Webhook events the settlement state machine consumes.
 *
 *   checkout.session.completed          -> funded (payment_status paid)
 *   checkout.session.async_payment_*    -> funded, or a logged failure, for
 *                                          the delayed payment methods
 *   transfer.created                    -> released (the seller's money left
 *                                          the platform balance)
 *   charge.refunded                     -> refunded
 */
export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'transfer.created',
  'charge.refunded',
];

interface StripeState {
  cfg: Config;
  client?: Stripe;
  secretJson?: Record<string, string>;
  secretFetchedAt?: number;
  webhookSecret?: string;
}

let state: StripeState | undefined;

export function initStripe(cfg: Config): void {
  state = { cfg };
}

function mustState(): StripeState {
  if (!state?.cfg.stripeSecretArn) {
    throw new Error('stripe is not configured on this deployment');
  }
  return state;
}

async function loadSecretJson(force = false): Promise<Record<string, string>> {
  const s = mustState();
  if (!force && s.secretJson && Date.now() - (s.secretFetchedAt ?? 0) < 5 * 60_000) {
    return s.secretJson;
  }
  const r = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: s.cfg.stripeSecretArn }),
  );
  const json = JSON.parse(r.SecretString ?? '{}');
  if (!json.secret_key) throw new Error('stripe secret is missing secret_key');
  s.secretJson = json;
  s.secretFetchedAt = Date.now();
  return json;
}

export async function getStripe(): Promise<Stripe> {
  const s = mustState();
  if (s.client) return s.client;
  const json = await loadSecretJson();
  s.client = new Stripe(json.secret_key, {
    apiVersion: '2026-07-29.dahlia' as Stripe.LatestApiVersion,
    maxNetworkRetries: 2,
  });
  return s.client;
}

/** The verified webhook signing secret. Throws until the endpoint exists. */
export async function getWebhookSecret(): Promise<string> {
  const s = mustState();
  if (s.webhookSecret) return s.webhookSecret;
  const json = await loadSecretJson(true);
  if (!json.webhook_secret) {
    throw new Error('stripe webhook endpoint is not provisioned yet');
  }
  s.webhookSecret = json.webhook_secret;
  return s.webhookSecret;
}

/**
 * Ensure the webhook endpoint for this deployment exists and its signing
 * secret is stored. Idempotent; safe to call on every boot. When an
 * endpoint for our URL exists but the stored secret is gone (secret was
 * rotated/recreated), the endpoint is recreated — a signing secret is only
 * readable at creation time.
 */
export async function ensureWebhookEndpoint(cfg: Config): Promise<void> {
  const s = mustState();
  const url = `${cfg.publicOrigin}${STRIPE_WEBHOOK_PATH}`;
  const json = await loadSecretJson(true);
  if (json.webhook_secret) {
    // Trust-but-verify: the endpoint must still exist and point at us, with
    // the current event set (updated in place when the set has grown).
    const stripe = await getStripe();
    const eps = await stripe.webhookEndpoints.list({ limit: 100 });
    const mine = eps.data.find((e) => e.url === url && e.status === 'enabled');
    if (mine) {
      // The stored set is brought to exactly this one: events are dropped as
      // well as added when the money shape changes, so nothing keeps arriving
      // that nothing reads.
      const have = new Set(mine.enabled_events);
      const differs =
        have.size !== WEBHOOK_EVENTS.length || !WEBHOOK_EVENTS.every((e) => have.has(e));
      if (differs) {
        await stripe.webhookEndpoints.update(mine.id, { enabled_events: WEBHOOK_EVENTS });
      }
      s.webhookSecret = json.webhook_secret;
      return;
    }
  }
  const stripe = await getStripe();
  const eps = await stripe.webhookEndpoints.list({ limit: 100 });
  for (const e of eps.data) {
    if (e.url === url) await stripe.webhookEndpoints.del(e.id);
  }
  const ep = await stripe.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: `osb-${cfg.envName} settlement escrow`,
  });
  if (!ep.secret) throw new Error('stripe returned no webhook signing secret');
  const merged = { ...json, webhook_secret: ep.secret };
  await secretsManager.send(
    new PutSecretValueCommand({
      SecretId: cfg.stripeSecretArn,
      SecretString: JSON.stringify(merged),
    }),
  );
  s.secretJson = merged;
  s.webhookSecret = ep.secret;
}

/**
 * Verify a webhook payload's signature and construct the event. This is THE
 * gate between the outside world and the escrow state machine: nothing
 * downstream ever sees an event that failed verification.
 */
export async function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string,
): Promise<Stripe.Event> {
  const stripe = await getStripe();
  const secret = await getWebhookSecret();
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

/** Minor units for a currency (Stripe charges in the smallest unit). */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function toMinorUnits(amount: number, ccy: string): number {
  const scaled = ZERO_DECIMAL.has(ccy.toUpperCase()) ? amount : amount * 100;
  const minor = Math.round(scaled);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error(`amount ${amount} ${ccy} does not convert to a positive minor-unit integer`);
  }
  return minor;
}

/**
 * Back the other way, for a figure going out on the wire beside `amount`,
 * which is in whole currency. Zero is a perfectly good answer here — one side
 * of an agreed split is often nothing — so this is not toMinorUnits' inverse
 * in its refusals, only in its arithmetic.
 */
export function fromMinorUnits(minor: number, ccy: string): number {
  if (!Number.isFinite(minor)) throw new Error(`bad minor amount ${minor}`);
  return ZERO_DECIMAL.has(ccy.toUpperCase()) ? minor : minor / 100;
}

/**
 * The percentage part of the fee, in minor units. Kept as a parameter and set
 * to 0 by default; the introductory fee is the flat one below.
 */
export function feeMinorUnits(amountMinor: number, feePercent: number): number {
  if (feePercent < 0 || feePercent > 100) throw new Error(`bad fee percent ${feePercent}`);
  return Math.round((amountMinor * feePercent) / 100);
}

/**
 * Our whole settlement fee in minor units: the flat introductory fee plus
 * whatever the percentage parameter adds (0 by default).
 *
 * The BUYER pays this, as a line of its own on the Checkout page. The seller
 * receives the agreed amount in full: the release transfer is the agreed
 * amount exactly, and our fee stays in the platform balance because the buyer
 * put it there.
 *
 * Throws when the fee would swallow the whole settlement; propose-time
 * validation refuses those amounts before a settlement row exists.
 */
export function settlementFeeMinor(
  amountMinor: number,
  cfg: { settlementFeeFlatMinor: number; settlementFeePercent: number },
): number {
  const flat = cfg.settlementFeeFlatMinor;
  if (!Number.isInteger(flat) || flat < 0) throw new Error(`bad flat fee ${flat}`);
  const fee = flat + feeMinorUnits(amountMinor, cfg.settlementFeePercent);
  if (fee >= amountMinor) {
    throw new Error(`settlement of ${amountMinor} is not larger than the ${fee} fee`);
  }
  return fee;
}

/**
 * The card-processing line, in minor units.
 *
 * Stripe's cut comes off the WHOLE charge, so recovering it is a gross-up
 * rather than an addition. With a rate r and a fixed f, charging
 *
 *   total = net + p     where     p = ceil((net * r + f) / (1 - r))
 *
 * leaves total - (total * r + f) >= net: the agreed amount plus our fee
 * arrives whole, and the rounding up of a fraction of a cent is the only
 * difference, in the buyer's favour by less than one minor unit of drift.
 *
 * The arithmetic is done in integers over a scaled rate so a rate like 1.7
 * cannot drift a cent either way through binary floating point.
 *
 * International and premium cards cost Stripe's standard rate PLUS a
 * surcharge, and this line does not chase it: that excess is absorbed by the
 * platform. The buyer is told one number, at Stripe's standard rate, whatever
 * plastic they end up using.
 */
const RATE_SCALE = 10_000;

export function processingRecoveryMinor(
  netMinor: number,
  cfg: { settlementProcessingPercent: number; settlementProcessingFixedMinor: number },
): number {
  const percent = cfg.settlementProcessingPercent;
  const fixed = cfg.settlementProcessingFixedMinor;
  if (!(percent >= 0) || percent >= 100) throw new Error(`bad processing percent ${percent}`);
  if (!Number.isInteger(fixed) || fixed < 0) throw new Error(`bad processing fixed ${fixed}`);
  if (!Number.isSafeInteger(netMinor) || netMinor <= 0) {
    throw new Error(`bad net amount ${netMinor}`);
  }
  const rate = Math.round((percent * RATE_SCALE) / 100); // r as rate/RATE_SCALE
  return Math.ceil((netMinor * rate + fixed * RATE_SCALE) / (RATE_SCALE - rate));
}

/** What the buyer's Checkout page itemises, and what the settlement row keeps. */
export interface SettlementBreakdown {
  /** The agreed amount, which the seller receives in full. */
  amountMinor: number;
  /** Our introductory fee. */
  feeMinor: number;
  /** Card processing, at Stripe's standard rate. */
  processingMinor: number;
  /** The three lines added up: what the buyer is charged. */
  buyerTotalMinor: number;
}

export function settlementBreakdown(
  amountMinor: number,
  cfg: {
    settlementFeeFlatMinor: number;
    settlementFeePercent: number;
    settlementProcessingPercent: number;
    settlementProcessingFixedMinor: number;
  },
): SettlementBreakdown {
  const feeMinor = settlementFeeMinor(amountMinor, cfg);
  const processingMinor = processingRecoveryMinor(amountMinor + feeMinor, cfg);
  return {
    amountMinor,
    feeMinor,
    processingMinor,
    buyerTotalMinor: amountMinor + feeMinor + processingMinor,
  };
}

/** The fee written out for a human, e.g. "$1.00" for 100 minor AUD units. */
export function formatMinor(minor: number, ccy: string): string {
  const zeroDecimal = ZERO_DECIMAL.has(ccy.toUpperCase());
  const value = zeroDecimal ? String(minor) : (minor / 100).toFixed(2);
  return `${value} ${ccy.toUpperCase()}`;
}
