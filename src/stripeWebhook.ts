/**
 * /stripe/webhook — the ONLY inbound Stripe surface (MCP hostname). Every
 * request is signature-verified against the endpoint's signing secret before
 * anything reads it; only then is a webhook transition context minted. The
 * money-state transitions funded/released/refunded happen exclusively here.
 *
 * Registered only when the deployment has settlement handling configured;
 * otherwise the route does not exist.
 */
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { getPool } from './db.js';
import {
  getSettlement,
  getSettlementByPaymentIntent,
  markFunded,
  markRefunded,
  markReleased,
  webhookAction,
  type SettlementRow,
  type WebhookCtx,
} from './domain/settlements.js';
import { sendSettlementEmail } from './counter/email.js';
import { accountEmail } from './domain/counterOps.js';
import { verifyPaymentMatchesSettlement } from './domain/settlementStripe.js';
import { STRIPE_WEBHOOK_PATH, getStripe, verifyWebhookSignature } from './stripe.js';
import { OsbError } from './protocol.js';
import type { Config } from './config.js';

async function notifyBothParties(
  cfg: Config,
  s: SettlementRow,
  template: 'payment-held' | 'released' | 'refund',
): Promise<void> {
  for (const [accountId, role] of [
    [s.buyer_account, 'buyer'],
    [s.seller_account, 'seller'],
  ] as const) {
    const email = await accountEmail(accountId, `settlement-${template}-notification`);
    if (email) {
      await sendSettlementEmail(cfg, {
        to: email,
        accountId,
        template,
        settlementId: s.id,
        role,
      });
    }
  }
}

/** Extract our settlement id from an event's object metadata. */
function settlementIdOf(obj: { metadata?: Record<string, string> | null }): string | undefined {
  return obj.metadata?.osb_settlement_id || undefined;
}

/**
 * The funding path, shared by checkout.session.completed and
 * payment_intent.amount_capturable_updated: verify the payment matches the
 * settlement exactly (amount, currency, seller destination, manual capture,
 * fee), then approved -> funded. A payment that does not match funds
 * nothing; a duplicate hold is cancelled so the buyer's money is never held
 * twice.
 */
async function handleFunding(
  cfg: Config,
  ctx: WebhookCtx,
  sid: string,
  paymentIntent: string,
  checkoutSession: string | undefined,
  log: (m: string, x?: any) => void,
): Promise<void> {
  const current = await getSettlement(sid);
  if (!current) {
    log('stripe webhook: payment references an unknown settlement', { settlement_id: sid });
    return;
  }
  if (current.state !== 'approved') {
    if (current.stripe_payment_intent !== paymentIntent) {
      // A second hold slipped through after funding: release it.
      const stripe = await getStripe();
      await stripe.paymentIntents.cancel(paymentIntent).catch(() => {});
      log('stray settlement payment cancelled (settlement already funded)', {
        settlement_id: sid,
        payment_intent: paymentIntent,
      });
    }
    return;
  }
  const check = await verifyPaymentMatchesSettlement(cfg, current, paymentIntent);
  if (!check.ok) {
    log('stripe webhook: payment does not match its settlement; refusing to fund', {
      settlement_id: sid,
      payment_intent: paymentIntent,
      problem: check.problem,
    });
    return;
  }
  const row = await markFunded(ctx, sid, { checkoutSession, paymentIntent });
  log('settlement funded', { settlement_id: sid, payment_intent: paymentIntent });
  await notifyBothParties(cfg, row, 'payment-held');
}

async function handleEvent(cfg: Config, event: Stripe.Event, log: (m: string, x?: any) => void) {
  const ctx: WebhookCtx = webhookAction(event.id, event.type);
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const sid = settlementIdOf(session);
      if (!sid) return; // a payment unrelated to settlements
      if (session.metadata?.osb_env && session.metadata.osb_env !== cfg.envName) return;
      const pi = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
      if (!pi) throw new Error(`checkout session ${session.id} has no payment intent`);
      await handleFunding(cfg, ctx, sid, pi, session.id, log);
      return;
    }
    case 'payment_intent.amount_capturable_updated': {
      const pi = event.data.object;
      const sid = settlementIdOf(pi);
      if (!sid) return;
      if (pi.metadata?.osb_env && pi.metadata.osb_env !== cfg.envName) return;
      await handleFunding(cfg, ctx, sid, pi.id, undefined, log);
      return;
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const sid = settlementIdOf(pi) ?? (await getSettlementByPaymentIntent(pi.id))?.id;
      if (!sid) return;
      const row = await markReleased(ctx, sid);
      log('settlement released', { settlement_id: sid, payment_intent: pi.id });
      await notifyBothParties(cfg, row, 'released');
      return;
    }
    case 'payment_intent.canceled': {
      const pi = event.data.object;
      const sid = settlementIdOf(pi) ?? (await getSettlementByPaymentIntent(pi.id))?.id;
      if (!sid) return;
      const row = await markRefunded(ctx, sid);
      log('settlement refunded (authorisation released)', {
        settlement_id: sid,
        payment_intent: pi.id,
      });
      await notifyBothParties(cfg, row, 'refund');
      return;
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      const piId = typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id;
      if (!piId) return;
      const s = await getSettlementByPaymentIntent(piId);
      if (!s) return;
      const row = await markRefunded(ctx, s.id);
      log('settlement refunded (charge refunded)', { settlement_id: s.id, charge: charge.id });
      await notifyBothParties(cfg, row, 'refund');
      return;
    }
    default:
      return;
  }
}

export function registerStripeWebhook(app: FastifyInstance, cfg: Config): void {
  const counterHost = new URL(cfg.counterOrigin).host.toLowerCase();
  app.register(async (scope) => {
    // Raw body: signature verification runs over the exact bytes received.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    scope.post(STRIPE_WEBHOOK_PATH, async (req, reply) => {
      if ((req.headers.host ?? '').toLowerCase() === counterHost) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string') {
        return reply.code(400).send({ error: 'missing_signature' });
      }
      let event: Stripe.Event;
      try {
        event = await verifyWebhookSignature(req.body as Buffer, sig);
      } catch (e: any) {
        req.log.warn({ err: e?.message }, 'stripe webhook: signature verification failed');
        return reply.code(400).send({ error: 'invalid_signature' });
      }
      // Idempotency: the INSERT is the lock; a redelivered event never
      // re-runs a transition. Released on failure so Stripe's retry works.
      const claim = await getPool().query(
        `INSERT INTO stripe_events (event_id, event_type) VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.id, event.type],
      );
      if (!claim.rowCount) return reply.send({ received: true, duplicate: true });
      try {
        await handleEvent(cfg, event, (m, x) => req.log.info(x ?? {}, m));
      } catch (e: any) {
        if (e instanceof OsbError && e.payload.code === 'STAGE_LOCKED') {
          // The event does not apply to the settlement's current state (e.g.
          // a replayed capture on an already-released settlement). Truthful
          // no-op; keep the claim so Stripe stops retrying.
          req.log.warn({ event_id: event.id, type: event.type }, 'stripe webhook: event does not apply, ignored');
          return reply.send({ received: true, ignored: true });
        }
        await getPool().query('DELETE FROM stripe_events WHERE event_id = $1', [event.id]);
        req.log.error({ err: e?.message, event_id: event.id }, 'stripe webhook: processing failed');
        return reply.code(500).send({ error: 'processing_failed' });
      }
      return reply.send({ received: true });
    });
  });
}
