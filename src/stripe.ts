/**
 * Stripe wiring for the safe-hands escrow core (phase 1.A).
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

/** Webhook events the escrow state machine consumes. */
export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.canceled',
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
      const have = new Set(mine.enabled_events);
      if (!WEBHOOK_EVENTS.every((e) => have.has(e))) {
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
 * Platform fee in minor units. The fee parameter exists in config and is 0:
 * feePercent defaults to 0 and phase 1 charges no fee.
 */
export function feeMinorUnits(amountMinor: number, feePercent: number): number {
  if (feePercent < 0 || feePercent > 100) throw new Error(`bad fee percent ${feePercent}`);
  return Math.round((amountMinor * feePercent) / 100);
}
