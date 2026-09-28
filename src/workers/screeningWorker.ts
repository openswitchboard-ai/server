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
import { shadowCategoryTrial } from '../shadow/jevTrials.js';
import type { Config } from '../config.js';

/**
 * Tell the human their card came back rejected. BEST EFFORT, in both
 * directions: the verdict is already written when this runs, and a send that
 * throws is logged and swallowed so it can never undo or re-run the screening
 * decision. An account with no reachable address is simply not mailed — the
 * rejection is on their main page either way.
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
      categoryLabel: categoryLeafLabel(card.category, card.kind),
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
              } else if (
                typeof body.content_version === 'number' &&
                card.content_version !== undefined &&
                body.content_version !== card.content_version
              ) {
                // The words this message was sent for have been changed since
                // (migration 055). Not an error: the change sent a message of
                // its own, and that one screens the words as they stand now. A
                // message from before the version existed carries none and
                // screens whatever the row holds, as it always did.
                log('screening: a newer version is on its way', {
                  card_id: card.id,
                  message_version: body.content_version,
                  row_version: card.content_version,
                });
              } else {
                // The row as read is the row as screened: applyVerdict lands the
                // verdict only on this version and writes the snapshot from
                // these same values.
                const verdict = await screenCard(cfg, card);
                const { applied, screening } = await applyVerdict(cfg, card, verdict);
                log('screening verdict', {
                  card_id: card.id,
                  pass: verdict.pass,
                  reason_code: verdict.reason_code,
                  ...(applied ? {} : { applied: false }),
                });
                // The state change IS the rejection event: only the call that
                // actually flipped the row tells the human about it.
                if (applied && !verdict.pass) {
                  await notifyScreeningRejection(cfg, card, screening, log);
                }
                // A posting that got through is the moment trial A asks an
                // outside model where it would have filed this (dev only, off
                // by default, records an answer and changes nothing —
                // src/shadow/jevTrials.ts). Started, not awaited, and wrapped
                // as well: the verdict is already written and nothing about
                // this posting's journey may depend on a third party's API.
                if (verdict.pass && applied) {
                  try {
                    void shadowCategoryTrial(cfg, card, log);
                  } catch (e: any) {
                    log('screening: jev shadow could not be started', {
                      card_id: card.id,
                      error: e?.message,
                    });
                  }
                }
              }
            } else {
              // The shape, never the contents.
              log('screening: unknown message kind', { op: body?.op, fields: Object.keys(body ?? {}) });
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
