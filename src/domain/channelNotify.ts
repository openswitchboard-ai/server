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
 * WHO GETS ONE AT ALL. The nudge exists for people whose assistant only wakes
 * when it is spoken to: for them the email IS the delivery path, and a message
 * that raises no email reaches them the next time they happen to open a chat,
 * which may be never. A person whose agent runs between conversations
 * (accounts.hears_via = 'assistant') already has a messenger, so the nudge is
 * a second copy of news they have had; they get none at all. The account
 * column is the whole of that decision — see migrations/026_hears_via.sql.
 *
 * THROTTLE — a conversation, not a mailbox. Two gates, both must be open to
 * nudge (see migrations/019_channel_notify.sql for the row):
 *
 *   1. unread_notified: one nudge per "you have unread mail on this channel"
 *      state. After a nudge goes out the row carries unread_notified=true, and
 *      a further message in that state sends no second nudge. channel_receive
 *      re-arms it (unread_notified=false) once the recipient collects and their
 *      unread falls to zero, so the next arrival can nudge again.
 *   2. a coalescing window of NUDGE_COALESCE_MINUTES on last_notified_at, held
 *      ACROSS re-arms. It exists to fold a burst — three lines typed in one
 *      breath, a re-send, a collect-and-reply inside the same minute — into
 *      one email. It was an hour, which is far too long for the person this
 *      nudge is for: an hour of silence after they have read and answered is
 *      an hour in which the reply that came back reaches nobody. Three
 *      minutes coalesces the burst and stays out of the way of the
 *      conversation.
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
import { getHearsVia } from './accounts.js';
import type { Config } from '../config.js';

/** Messages landing within this many minutes of a nudge coalesce into it. */
export const NUDGE_COALESCE_MINUTES = 3;

/**
 * Decide whether this recipient should be nudged about a freshly delivered
 * message, and if so enqueue the nudge on the ops queue.
 *
 * A recipient whose agent brings them the news is out before the row is even
 * touched, so switching back to hearing by email leaves them eligible for the
 * next arrival rather than serving out a throttle they never used.
 *
 * The upsert returns a row only when BOTH gates are open — a brand-new
 * (channel, recipient) pair, or one that has been collected-to-zero since its
 * last nudge AND is past the coalescing window. Anything else (still
 * unread-notified, or inside the window) returns no row and sends nothing.
 */
export async function notifyChannelMessageWaiting(
  cfg: Config,
  args: { channelId: string; matchId: string; recipientAccount: string },
): Promise<void> {
  if (!cfg.opsQueueUrl) return; // no ops queue wired — nothing to nudge through
  try {
    // Their agent is the messenger; the switchboard stays out of it.
    if ((await getHearsVia(args.recipientAccount)) === 'assistant') return;
    const r = await getPool().query(
      `INSERT INTO channel_notify (channel_id, recipient_account, last_notified_at, unread_notified)
       VALUES ($1, $2, now(), true)
       ON CONFLICT (channel_id, recipient_account) DO UPDATE
         SET last_notified_at = now(), unread_notified = true
         WHERE channel_notify.unread_notified = false
           AND channel_notify.last_notified_at <= now() - make_interval(mins => $3)
       RETURNING last_notified_at`,
      [args.channelId, args.recipientAccount, NUDGE_COALESCE_MINUTES],
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
 * to zero. The timestamp is left in place — the next arrival is eligible for a
 * nudge only when it is also past the coalescing window.
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
