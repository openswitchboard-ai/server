import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { runMatchingForCard } from '../domain/matcher.js';
import type { Config } from '../config.js';

/**
 * Long-poll consumer of the matching queue (messages enqueued by the
 * screening pipeline when a card is published, and by the embedding
 * backfill). On any failure (Bedrock, DB) the message is NOT deleted: SQS
 * redelivers and eventually DLQs. Matching is idempotent (matches upsert on
 * the (card_want, card_have) unique key), so redelivery is safe.
 */
export function startMatchingWorker(cfg: Config, log: (msg: string, extra?: any) => void) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: cfg.matchingQueueUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 150,
          }),
        );
        for (const msg of r.Messages ?? []) {
          try {
            const body = JSON.parse(msg.Body ?? '{}');
            if (body.kind === 'card-published' && body.card_id) {
              const outcome = await runMatchingForCard(cfg, body.card_id, log);
              if (outcome) {
                log('matcher: card processed', {
                  card_id: body.card_id,
                  // How many cards passed the prefilter (counted to a cap),
                  // against how many of them the engine actually scored. A
                  // pool of 0 or 1 explains a run that found nothing; a pool
                  // pinned at the cap while evaluated stays at 50 is the
                  // starvation shape - the category is fuller than the limit.
                  candidate_pool: outcome.candidatePool,
                  candidate_pool_capped: outcome.candidatePoolCapped,
                  evaluated: outcome.evaluated,
                  matches: outcome.matchesCreated.length,
                  near_misses: outcome.nearMisses,
                });
                // 0.E: hand each fresh match to the ops queue for the human
                // summons. Queued (rather than sent inline) so a summons
                // failure retries on its own without re-running the matcher;
                // the send itself is idempotent (summons:{match}:{account}).
                for (const matchId of outcome.matchesCreated) {
                  await sqs.send(
                    new SendMessageCommand({
                      QueueUrl: cfg.opsQueueUrl,
                      MessageBody: JSON.stringify({ op: 'match-notify', match_id: matchId }),
                    }),
                  );
                }
              }
            } else {
              log('matcher: unknown message kind', { body: msg.Body?.slice(0, 200) });
            }
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: cfg.matchingQueueUrl,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
          } catch (e: any) {
            log('matcher: message failed (will redeliver)', { error: e?.message });
          }
        }
      } catch (e: any) {
        log('matcher: receive loop error', { error: e?.message });
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
