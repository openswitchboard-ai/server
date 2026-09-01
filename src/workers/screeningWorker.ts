import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getCard, type CardRow } from '../domain/cards.js';
import { categoryLeafLabel } from '../domain/matchRules.js';
import {
  applyVerdict,
  screeningReasonInPlainWords,
  screenCard,
  type StoredScreening,
} from '../domain/screening.js';
import type { Config } from '../config.js';

/**
 * Tell the human their card came back rejected. BEST EFFORT, in both
 * directions: the verdict is already written when this runs, and a send that
 * throws is logged and swallowed so it can never undo or re-run the screening
 * decision. An account with no reachable address is simply not mailed — the
 * rejection is on their approval page either way.
 */
export async function notifyScreeningRejection(
  cfg: Config,
  card: CardRow,
  screening: StoredScreening,
  log: (msg: string, extra?: any) => void,
): Promise<void> {
  try {
    const { accountEmail } = await import('../domain/counterOps.js');
    const { sendScreeningRejectedEmail } = await import('../counter/email.js');
    const to = await accountEmail(card.account_id, 'card-screening-rejected-notification');
    if (!to) {
      log('screening: rejection notice skipped (no reachable address)', { card_id: card.id });
      return;
    }
    const outcome = await sendScreeningRejectedEmail(cfg, to, card.account_id, {
      cardId: card.id,
      rejectedAt: screening.at,
      categoryLabel: categoryLeafLabel(card.category),
      reason: screeningReasonInPlainWords(screening.reason_code),
    });
    log('screening: rejection notice', { card_id: card.id, status: outcome.status });
  } catch (e: any) {
    log('screening: rejection notice failed; the verdict stands', {
      card_id: card.id,
      error: e?.message,
    });
  }
}

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
                const { applied, screening } = await applyVerdict(cfg, card.id, verdict);
                log('screening verdict', {
                  card_id: card.id,
                  pass: verdict.pass,
                  reason_code: verdict.reason_code,
                });
                // The state change IS the rejection event: only the call that
                // actually flipped the row tells the human about it.
                if (applied && !verdict.pass) {
                  await notifyScreeningRejection(cfg, card, screening, log);
                }
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
