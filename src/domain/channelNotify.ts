/**
 * The waiting-message nudge and its throttle.
 *
 * channel_send (domain/channel.ts) hands an encrypted message to the relay and
 * enqueues NOTHING for the recipient's human. That is the conversational
 * deadlock: if the recipient is a chatbot that checks only when its human asks,
 * or its human is passive, the message sits uncollected until the TTL sweep and
 * nobody is ever prompted — both sides wait on each other. This module closes
 * that gap the same way the matcher summons a human about a new match: a
 * best-effort email through the ops queue, "you have a message waiting; open
 * your assistant and it'll read it to you."
 *
 * It lives apart from channel.ts on purpose. The relay keeps no content and its
 * unit suite reads channel.ts source to prove it (one console call site, no
 * reach into other stores); the nudge's own logging and ops enqueue belong out
 * here, away from that surface. Nothing here touches a message body either —
 * only ids, a timestamp and a count cross this file.
 *
 * THROTTLE — a conversation, not a mailbox. Two gates, both must be open to
 * nudge (see migrations/019_channel_notify.sql for the row):
 *
 *   1. unread_notified: one nudge per "you have unread mail on this channel"
 *      state. After a nudge goes out the row carries unread_notified=true, and
 *      a further message in that state sends no second nudge. channel_receive
 *      re-arms it (unread_notified=false) once the recipient collects and their
 *      unread falls to zero, so the next arrival can nudge again.
 *   2. a floor of NUDGE_FLOOR_MINUTES on last_notified_at, held ACROSS re-arms.
 *      A turn-by-turn conversation where each side collects then replies would,
 *      on the unread gate alone, nudge the recipient on every line; the floor
 *      caps that at one nudge per recipient per channel per hour. Some messages
 *      inside the hour therefore raise no nudge of their own — that is the
 *      throttle working, and the recipient still sees them on their next check.
 *
 * The arm decision is a single atomic upsert (the same shape channel_send_rate
 * uses), so two concurrent sends can never both win a nudge.
 *
 * Best-effort throughout: every export swallows its own errors and never
 * throws, so a nudge that cannot be enqueued or sent leaves channel_send and
 * channel_receive untouched.
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import type { Config } from '../config.js';

/** At most one nudge per recipient per channel per this many minutes. */
export const NUDGE_FLOOR_MINUTES = 60;

/**
 * Decide whether this recipient should be nudged about a freshly delivered
 * message, and if so enqueue the nudge on the ops queue.
 *
 * The upsert returns a row only when BOTH gates are open — a brand-new
 * (channel, recipient) pair, or one that has been collected-to-zero since its
 * last nudge AND is past the floor. Anything else (still unread-notified, or
 * inside the floor) returns no row and sends nothing.
 */
export async function notifyChannelMessageWaiting(
  cfg: Config,
  args: { channelId: string; matchId: string; recipientAccount: string },
): Promise<void> {
  if (!cfg.opsQueueUrl) return; // no ops queue wired — nothing to nudge through
  try {
    const r = await getPool().query(
      `INSERT INTO channel_notify (channel_id, recipient_account, last_notified_at, unread_notified)
       VALUES ($1, $2, now(), true)
       ON CONFLICT (channel_id, recipient_account) DO UPDATE
         SET last_notified_at = now(), unread_notified = true
         WHERE channel_notify.unread_notified = false
           AND channel_notify.last_notified_at <= now() - make_interval(mins => $3)
       RETURNING last_notified_at`,
      [args.channelId, args.recipientAccount, NUDGE_FLOOR_MINUTES],
    );
    if (!r.rowCount) return; // a gate was closed — no nudge this time
    const notifiedAt = new Date(r.rows[0].last_notified_at).toISOString();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.opsQueueUrl,
        MessageBody: JSON.stringify({
          op: 'channel-nudge',
          match_id: args.matchId,
          channel_id: args.channelId,
          recipient_account: args.recipientAccount,
          // The nudge's own timestamp keys the email dedupe, so a redelivered
          // ops job coalesces while a later re-armed nudge sends afresh.
          notified_at: notifiedAt,
        }),
      }),
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(`channel-nudge: enqueue failed (send unaffected): ${e?.message ?? e}`);
  }
}

/**
 * Re-arm the nudge once a recipient has collected and their unread has fallen
 * to zero. The floor timestamp is left in place — the next arrival is eligible
 * for a nudge only when it is also past the floor.
 */
export async function rearmChannelNudge(
  channelId: string,
  recipientAccount: string,
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE channel_notify SET unread_notified = false
       WHERE channel_id = $1 AND recipient_account = $2`,
      [channelId, recipientAccount],
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(`channel-nudge: re-arm failed (receive unaffected): ${e?.message ?? e}`);
  }
}
