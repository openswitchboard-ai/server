/**
 * /stripe/webhook — the ONLY inbound Stripe surface (MCP hostname). Every
 * request is signature-verified against the endpoint's signing secret before
 * anything reads it; only then is a webhook transition context minted. The
 * money-state transitions funded/released/refunded happen exclusively here.
 *
 * WHY 'released' COMES FROM A WEBHOOK. Creating a Transfer is synchronous:
 * the API call returns a Transfer object, and we could write 'released' from
 * that response in the confirm route. We do not, for one structural reason —
 * money states are reachable only from a signature-verified webhook context,
 * and marking released off an API response inside a human route would put a
 * money state behind a human context instead. transfer.created arrives in
 * seconds and Stripe retries it, the transfer id is written to the row as
 * soon as the API returns, and a settlement stuck at 'confirmed' with a
 * transfer id recorded is a visible, recoverable state rather than a lost
 * one. The cost is that 'released' lags the actual movement of money by a
 * few seconds, which is the right trade for keeping the single writer honest.
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
  markSplitLeg,
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
  template: 'payment-held' | 'released' | 'refund' | 'split',
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
        // The release mail says which road it took, because "the window ran
        // out" and "you confirmed" are different pieces of news.
        auto: template === 'released' ? s.auto_released === true : undefined,
      });
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract our settlement id from an event's object metadata. The shape is
 * checked: a settlement id is a uuid, and anything else would be a value we
 * did not write, which must never reach a database lookup.
 */
function settlementIdOf(obj: { metadata?: Record<string, string> | null }): string | undefined {
  const id = obj.metadata?.osb_settlement_id;
  return id && UUID.test(id) ? id : undefined;
}

/**
 * The funding path, shared by checkout.session.completed and
 * checkout.session.async_payment_succeeded: verify the payment matches the
 * settlement exactly (the buyer total the row recorded, currency, the
 * settlement's own transfer_group, money actually taken into the platform
 * balance), then approved -> funded.
 * A payment that does not match funds nothing; a second payment that slipped
 * through is refunded, because with immediate capture the buyer really has
 * been charged twice.
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
      // A second payment landed after funding: give it straight back.
      const stripe = await getStripe();
      await stripe.refunds
        .create(
          { payment_intent: paymentIntent, metadata: { osb_settlement_id: sid } },
          { idempotencyKey: `osb-settlement-stray-${paymentIntent}` },
        )
        .catch(() => {});
      log('stray settlement payment refunded (settlement already funded)', {
        settlement_id: sid,
        payment_intent: paymentIntent,
      });
    }
    return;
  }
  const check = await verifyPaymentMatchesSettlement(current, paymentIntent);
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
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      const sid = settlementIdOf(session);
      if (!sid) return; // a payment unrelated to settlements
      if (session.metadata?.osb_env && session.metadata.osb_env !== cfg.envName) return;
      // A completed session whose payment has not actually landed (a delayed
      // method still processing) funds nothing; async_payment_succeeded is
      // the event that comes back for it.
      if (session.payment_status === 'unpaid') {
        log('stripe webhook: checkout completed but unpaid; waiting for the payment', {
          settlement_id: sid,
          session: session.id,
        });
        return;
      }
      const pi = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
      if (!pi) throw new Error(`checkout session ${session.id} has no payment intent`);
      await handleFunding(cfg, ctx, sid, pi, session.id, log);
      return;
    }
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object;
      const sid = settlementIdOf(session);
      if (!sid) return;
      // Nothing was taken, so nothing changes: the settlement stays approved
      // and the buyer can start a fresh payment from their own page.
      log('settlement payment failed; settlement still awaits payment', {
        settlement_id: sid,
        session: session.id,
      });
      return;
    }
    case 'transfer.created': {
      const transfer = event.data.object;
      // Our own releases are the only transfers this cares about: they carry
      // the settlement id in metadata AND as their transfer_group. A transfer
      // from anywhere else (Stripe writes its own transfer_group on some
      // charges) is left alone.
      const sid = settlementIdOf(transfer);
      if (!sid) return;
      if (transfer.metadata?.osb_env !== cfg.envName) return;
      if (transfer.transfer_group !== sid) {
        log('stripe webhook: transfer metadata and transfer_group disagree; ignored', {
          settlement_id: sid,
          transfer: transfer.id,
          transfer_group: transfer.transfer_group,
        });
        return;
      }
      const current = await getSettlement(sid);
      if (!current) return; // a transfer unrelated to settlements
      // A settlement in 'resolved' is an agreed split with both humans behind
      // it, and this transfer is one of its two legs rather than a release.
      // 'settled-split' lands once every leg that had money in it has landed.
      if (current.state === 'resolved') {
        const row = await markSplitLeg(ctx, sid, 'release');
        log('settlement split: the seller\'s part went out', {
          settlement_id: sid,
          transfer: transfer.id,
          state: row.state,
        });
        if (row.state === 'settled-split') await notifyBothParties(cfg, row, 'split');
        return;
      }
      const row = await markReleased(ctx, sid);
      log('settlement released', { settlement_id: sid, transfer: transfer.id });
      await notifyBothParties(cfg, row, 'released');
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
      // The same fork as the transfer above: inside an agreed split this is a
      // leg, and everywhere else it is the whole road ending. The refund is of
      // the agreed amount or part of it either way — the buyer's two fee lines
      // were never in it.
      if (s.state === 'resolved') {
        const row = await markSplitLeg(ctx, s.id, 'refund');
        log('settlement split: the buyer\'s part went back', {
          settlement_id: s.id,
          charge: charge.id,
          state: row.state,
        });
        if (row.state === 'settled-split') await notifyBothParties(cfg, row, 'split');
        return;
      }
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
        if (e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET') {
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
