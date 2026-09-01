import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { createAccount } from '../domain/accounts.js';
import { expireDueCards } from '../domain/cards.js';
import { backfillEmbeddings } from '../domain/embeddings.js';
import { backfillCardGeo } from '../geo/backfill.js';
import { gazetteerSource } from '../geo/gazetteer.js';
import { createMatch } from '../domain/matches.js';
import { acceptOfferByHuman } from '../domain/offers.js';
import { refreshPulseAggregates } from '../domain/pulse.js';
import {
  notifyMatchCreated,
  runDigestTick,
  runRenewalTick,
  runSummonsBatch,
} from '../email/digestEngine.js';
import type { Config } from '../config.js';

/**
 * INTERNAL ops interface — an IAM-gated SQS queue with NO public route.
 * In 0.C it carries:
 *  - ttl-expiry ticks from the EventBridge schedule;
 *  - dev/test bootstrap ops (create-account, create-match) used by the CLI
 *    bootstrap script and the integration suite (dev env only);
 *  - accept-offer-by-human: the ONLY path to the 'accepted-by-human' offer
 *    state. 0.D replaces this trigger with the counter's human-approval UI;
 *    the domain function itself (acceptOfferByHuman) is the stable interface.
 * Only principals with sqs:SendMessage on the ops queue (account operators /
 * the EventBridge schedule role) can reach any of this.
 */
export function startOpsWorker(cfg: Config, log: (msg: string, extra?: any) => void) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: cfg.opsQueueUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 60,
          }),
        );
        for (const msg of r.Messages ?? []) {
          try {
            const body = JSON.parse(msg.Body ?? '{}');
            switch (body.op) {
              case 'ttl-expiry': {
                const n = await expireDueCards();
                if (n > 0) log('ttl-expiry: expired cards', { count: n });
                break;
              }
              case 'create-account': {
                if (cfg.envName === 'prod') {
                  // Prod registration is CLOSED in 0.C — no bootstrap bypass.
                  log('ops: create-account refused in prod');
                  break;
                }
                const id = await createAccount({
                  email: body.email,
                  first_name: body.first_name,
                  locality: body.locality,
                  login_code_hash: body.login_code_hash,
                });
                log('ops: account bootstrapped', { account_id: id });
                break;
              }
              case 'create-match': {
                const id = await createMatch(body.card_want, body.card_have, body.score ?? 0.9);
                log('ops: match created', { match_id: id });
                // 0.E: the dev bootstrap path summons humans too (idempotent).
                await notifyMatchCreated(cfg, id);
                break;
              }
              case 'pulse-refresh': {
                // EventBridge 15-min tick: rebuild the k-anonymous demand-
                // pulse aggregates (see domain/pulse.ts for the k-floor).
                const rows = await refreshPulseAggregates();
                log('pulse-refresh: aggregates rebuilt', { rows });
                break;
              }
              case 'backfill-embeddings': {
                // One-shot, idempotent: embed published cards that predate
                // 0.F and hand each to the matching queue.
                const n = await backfillEmbeddings(cfg, async (cardId) => {
                  await sqs.send(
                    new SendMessageCommand({
                      QueueUrl: cfg.matchingQueueUrl,
                      MessageBody: JSON.stringify({ kind: 'card-published', card_id: cardId }),
                    }),
                  );
                });
                log('backfill-embeddings: cards embedded', { count: n });
                break;
              }
              case 'backfill-geo': {
                // One-shot, idempotent: place cards written before 0.3.0, then
                // hand each placed card back to the matching queue so pairs
                // that could not meet on unequal bucket strings get another go.
                log('backfill-geo: starting', gazetteerSource());
                const r = await backfillCardGeo(log);
                log('backfill-geo: done', r);
                if (body.rematch !== false) {
                  const placed = await getPool().query(
                    `SELECT id FROM cards WHERE geo_lat IS NOT NULL
                       AND lifecycle_state = 'PUBLISHED' AND expires_at > now()`,
                  );
                  for (const row of placed.rows) {
                    await sqs.send(
                      new SendMessageCommand({
                        QueueUrl: cfg.matchingQueueUrl,
                        MessageBody: JSON.stringify({
                          kind: 'card-published',
                          card_id: row.id,
                        }),
                      }),
                    );
                  }
                  log('backfill-geo: cards requeued for matching', {
                    count: placed.rowCount,
                  });
                }
                break;
              }
              case 'match-notify': {
                // 0.E: immediate match summons for both humans (enqueued by
                // the matcher / the dev create-match op). Idempotent via the
                // summons:{match}:{account} dedupe key.
                await notifyMatchCreated(cfg, body.match_id);
                break;
              }
              case 'email-digest-tick': {
                // EventBridge daily/weekly ticks. Batched summons first, then
                // the activity digest — each honours per-account frequency
                // and the quiet default (nothing happened -> no email).
                const cadence = body.cadence === 'weekly' ? 'weekly' : 'daily';
                const summons = await runSummonsBatch(cfg, cadence);
                const digests = await runDigestTick(cfg, cadence);
                log('email-digest-tick: done', { cadence, summons, digests });
                break;
              }
              case 'email-renewal-tick': {
                // Daily sweep; a renewal email lands once, 7 days before a
                // card batch expires (see digestEngine.runRenewalTick).
                const n = await runRenewalTick(cfg);
                if (n > 0) log('email-renewal-tick: renewal emails sent', { count: n });
                break;
              }
              case 'accept-offer-by-human': {
                const offer = await acceptOfferByHuman(
                  body.offer_id,
                  body.account_id,
                  body.recorded_via ?? 'internal-ops',
                );
                log('ops: offer accepted by human', { offer_id: offer.offer_id });
                break;
              }
              default:
                log('ops: unknown op', { body: msg.Body?.slice(0, 200) });
            }
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: cfg.opsQueueUrl,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
          } catch (e: any) {
            log('ops: message failed (will redeliver)', { error: e?.message });
          }
        }
      } catch (e: any) {
        log('ops: receive loop error', { error: e?.message });
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
