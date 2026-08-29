import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getCard } from '../domain/cards.js';
import { applyVerdict, screenCard } from '../domain/screening.js';
import type { Config } from '../config.js';

/**
 * Long-poll consumer of the screening queue. On any failure (e.g. Bedrock
 * unavailable) the message is NOT deleted: SQS redelivers, and after
 * maxReceiveCount it lands on the DLQ. The card stays PENDING_SCREENING —
 * never published unscreened.
 */
export function startScreeningWorker(cfg: Config, log: (msg: string, extra?: any) => void) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: cfg.screeningQueueUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 120,
          }),
        );
        for (const msg of r.Messages ?? []) {
          try {
            const body = JSON.parse(msg.Body ?? '{}');
            if (body.kind === 'screen-card' && body.card_id) {
              const card = await getCard(body.card_id);
              if (!card) {
                log('screening: card vanished', { card_id: body.card_id });
              } else if (card.lifecycle_state !== 'PENDING_SCREENING') {
                log('screening: card no longer pending', {
                  card_id: card.id,
                  state: card.lifecycle_state,
                });
              } else {
                const verdict = await screenCard(cfg, card);
                await applyVerdict(cfg, card.id, verdict);
                log('screening verdict', {
                  card_id: card.id,
                  pass: verdict.pass,
                  reason_code: verdict.reason_code,
                });
              }
            } else {
              log('screening: unknown message kind', { body: msg.Body?.slice(0, 200) });
            }
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: cfg.screeningQueueUrl,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
          } catch (e: any) {
            log('screening: message failed (will redeliver)', { error: e?.message });
          }
        }
      } catch (e: any) {
        log('screening: receive loop error', { error: e?.message });
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
