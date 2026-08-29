import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { createAccount } from '../domain/accounts.js';
import { expireDueCards } from '../domain/cards.js';
import { createMatch } from '../domain/matches.js';
import { acceptOfferByHuman } from '../domain/offers.js';
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
