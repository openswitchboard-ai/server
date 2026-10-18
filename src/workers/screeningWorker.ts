import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { sqs } from "../aws.js";
import { getCard, type CardRow } from "../domain/cards.js";
import { categoryLeafLabel } from "../domain/matchRules.js";
import {
  applyVerdict,
  screeningReasonInPlainWords,
  screenCard,
  screenCardsTogether,
  type StoredScreening,
} from "../domain/screening.js";
import { getPool } from "../db.js";
import {
  LIST_CHUNK_SPACING_SECONDS,
  LIST_EMBED_CONCURRENCY,
  LIST_SCREEN_CHUNK_KIND,
  inBatches,
} from "../domain/lists.js";
import { shadowCategoryTrial } from "../shadow/jevTrials.js";
import { startVisibilityHeartbeat } from "./opsWorker.js";
import type { Config } from "../config.js";

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
    const { accountEmail } = await import("../domain/counterOps.js");
    const { sendScreeningRejectedEmail } = await import("../counter/email.js");
    const to = await accountEmail(
      card.account_id,
      "card-screening-rejected-notification",
    );
    if (!to) {
      log("screening: rejection notice skipped (no reachable address)", {
        card_id: card.id,
      });
      return;
    }
    const outcome = await sendScreeningRejectedEmail(cfg, to, card.account_id, {
      cardId: card.id,
      rejectedAt: screening.at,
      categoryLabel: categoryLeafLabel(card.category, card.kind),
      reason: screeningReasonInPlainWords(screening.reason_code),
    });
    log("screening: rejection notice", {
      card_id: card.id,
      status: outcome.status,
    });
  } catch (e: any) {
    log("screening: rejection notice failed; the verdict stands", {
      card_id: card.id,
      error: e?.message,
    });
  }
}

/**
 * A FAIR SHARE FOR SINGLE POSTINGS (migration 068, domain/lists.ts).
 *
 * One task runs this worker, and it reads five messages at a time and works
 * them one after another. A list of five hundred items arrives as fifty
 * messages of ten, already spaced out as they were sent; even so, a person who
 * posts one ordinary want while somebody's big list is going through should
 * not wait behind all of it.
 *
 * So each read is put in this order: every single posting first, then ONE
 * list message, and any other list messages in the same read go back on the
 * queue for LIST_CHUNK_SPACING_SECONDS. They go back as fresh copies (sent
 * again with a delay, the original deleted) rather than by changing their
 * visibility, because every receive counts towards the dead-letter limit and
 * a list message passed over five times would be lost there. A copy sent twice
 * is harmless: a verdict lands only on a pending row at the version it read.
 */
export function fairShare(messages: Message[]): { now: Message[]; later: Message[] } {
  const kindOf = (m: Message): string | undefined => {
    try {
      return JSON.parse(m.Body ?? "{}")?.kind;
    } catch {
      return undefined;
    }
  };
  const singles = messages.filter((m) => kindOf(m) !== LIST_SCREEN_CHUNK_KIND);
  const chunks = messages.filter((m) => kindOf(m) === LIST_SCREEN_CHUNK_KIND);
  return { now: [...singles, ...chunks.slice(0, 1)], later: chunks.slice(1) };
}

/**
 * One list message: up to ten of a list's items, screened together and then
 * applied one by one (domain/screening.ts screenCardsTogether). Items that are
 * no longer pending, or whose words have moved on since the message was sent,
 * are left to the message that carries their newer words, exactly as a single
 * posting is.
 *
 * Embeddings are one call per item: the embedding model this switchboard
 * stores vectors from takes one text per call, so they are run a few at a time
 * instead. Each published item's matching message waits a second more than
 * the one before it, so ten items clearing together reach the matcher spread
 * out rather than at once.
 *
 * No rejection email goes per item: a list of five hundred could otherwise
 * send a person dozens. What was turned away, and why, is on the list itself
 * (read_lists), in the same plain words.
 */
export async function screenListChunk(
  cfg: Config,
  body: { cards?: { card_id?: unknown; content_version?: unknown }[] },
  log: (msg: string, extra?: any) => void,
): Promise<void> {
  const wanted = (Array.isArray(body.cards) ? body.cards : [])
    .filter((c) => typeof c?.card_id === "string")
    .slice(0, 50);
  if (!wanted.length) return;
  const r = await getPool().query(`SELECT * FROM cards WHERE id = ANY($1::uuid[])`, [
    wanted.map((c) => c.card_id),
  ]);
  const byId = new Map<string, CardRow>((r.rows as CardRow[]).map((c) => [c.id, c]));
  const ready: CardRow[] = [];
  for (const w of wanted) {
    const card = byId.get(w.card_id as string);
    if (!card || card.lifecycle_state !== "PENDING_SCREENING") continue;
    if (
      typeof w.content_version === "number" &&
      card.content_version !== undefined &&
      w.content_version !== card.content_version
    ) {
      continue;
    }
    ready.push(card);
  }
  if (!ready.length) {
    log("screening: list items no longer pending", { asked: wanted.length });
    return;
  }
  const verdicts = await screenCardsTogether(cfg, ready);
  let passed = 0;
  let refused = 0;
  let position = 0;
  for (const batch of inBatches(ready, LIST_EMBED_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (card) => {
        const verdict = verdicts.get(card.id)!;
        const delay = verdict.pass ? position++ : 0;
        await applyVerdict(cfg, card, verdict, { matchDelaySeconds: delay });
        if (verdict.pass) passed++;
        else refused++;
      }),
    );
  }
  // Counts only: nothing about the items.
  log("screening: list items", { items: ready.length, passed, refused });
}

/**
 * Long-poll consumer of the screening queue. On any failure (e.g. Bedrock
 * unavailable) the message is NOT deleted: SQS redelivers, and after
 * maxReceiveCount it lands on the DLQ. The card stays PENDING_SCREENING —
 * never published unscreened.
 */
export function startScreeningWorker(
  cfg: Config,
  log: (msg: string, extra?: any) => void,
) {
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
        // Five messages are worked one after another, each with a model call,
        // so the later ones would outlive a fixed invisibility and be screened
        // twice. The ops worker's heartbeat keeps every unfinished one hidden.
        const pending = new Set(
          (r.Messages ?? [])
            .map((m) => m.ReceiptHandle)
            .filter((h): h is string => !!h),
        );
        const stopHeartbeat = startVisibilityHeartbeat(
          cfg.screeningQueueUrl,
          pending,
          log,
        );
        try {
          const { now, later } = fairShare(r.Messages ?? []);
          // The list messages passed over this time go back on the queue as
          // fresh copies, a little later (fairShare above).
          for (const msg of later) {
            try {
              await sqs.send(
                new SendMessageCommand({
                  QueueUrl: cfg.screeningQueueUrl,
                  MessageBody: msg.Body ?? "{}",
                  DelaySeconds: LIST_CHUNK_SPACING_SECONDS,
                }),
              );
              await sqs.send(
                new DeleteMessageCommand({
                  QueueUrl: cfg.screeningQueueUrl,
                  ReceiptHandle: msg.ReceiptHandle!,
                }),
              );
            } catch (e: any) {
              log("screening: list message could not be put back (will redeliver)", {
                error: e?.message,
              });
            } finally {
              if (msg.ReceiptHandle) pending.delete(msg.ReceiptHandle);
            }
          }
          for (const msg of now) {
            try {
              const body = JSON.parse(msg.Body ?? "{}");
              if (body.kind === LIST_SCREEN_CHUNK_KIND) {
                await screenListChunk(cfg, body, log);
              } else if (body.kind === "screen-card" && body.card_id) {
                const card = await getCard(body.card_id);
                if (!card) {
                  log("screening: card vanished", { card_id: body.card_id });
                } else if (card.lifecycle_state !== "PENDING_SCREENING") {
                  log("screening: card no longer pending", {
                    card_id: card.id,
                    state: card.lifecycle_state,
                  });
                } else if (
                  typeof body.content_version === "number" &&
                  card.content_version !== undefined &&
                  body.content_version !== card.content_version
                ) {
                  // The words this message was sent for have been changed since
                  // (migration 055). Not an error: the change sent a message of
                  // its own, and that one screens the words as they stand now. A
                  // message from before the version existed carries none and
                  // screens whatever the row holds, as it always did.
                  log("screening: a newer version is on its way", {
                    card_id: card.id,
                    message_version: body.content_version,
                    row_version: card.content_version,
                  });
                } else {
                  // The row as read is the row as screened: applyVerdict lands the
                  // verdict only on this version and writes the snapshot from
                  // these same values.
                  const verdict = await screenCard(cfg, card);
                  const { applied, screening } = await applyVerdict(
                    cfg,
                    card,
                    verdict,
                  );
                  log("screening verdict", {
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
                      log("screening: jev shadow could not be started", {
                        card_id: card.id,
                        error: e?.message,
                      });
                    }
                  }
                }
              } else {
                // The shape, never the contents.
                log("screening: unknown message kind", {
                  op: body?.op,
                  fields: Object.keys(body ?? {}),
                });
              }
              await sqs.send(
                new DeleteMessageCommand({
                  QueueUrl: cfg.screeningQueueUrl,
                  ReceiptHandle: msg.ReceiptHandle!,
                }),
              );
            } catch (e: any) {
              log("screening: message failed (will redeliver)", {
                error: e?.message,
              });
            } finally {
              if (msg.ReceiptHandle) pending.delete(msg.ReceiptHandle);
            }
          }
        } finally {
          stopHeartbeat();
        }
      } catch (e: any) {
        log("screening: receive loop error", { error: e?.message });
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
