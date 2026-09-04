/**
 * The patch-through transport: what travels on a stage-4 channel.
 *
 * The switchboard's job here is carrying. A message handed to it is encrypted
 * under a key belonging to that channel and held until the agent it is
 * addressed to collects it; collecting it is what deletes it, so once a batch
 * has been handed over the switchboard no longer holds it. Anything left
 * uncollected is deleted by the sweep 14 days after it was sent.
 *
 * What that rules out is as much of the design as what it allows. A message
 * body never reaches the WORM consent log, the service's own logs, screening,
 * or any aggregate. No model reads a patched-through conversation, because the
 * operator does not read one. The safety of the step comes from its structure
 * instead: only the two accounts of an open stage-4 match can reach a channel,
 * a message is capped at 4000 characters, each side gets 60 an hour, and every
 * message handed to an agent arrives labelled as the other side's words for
 * that agent to show its human rather than to act on.
 *
 * Delivery is therefore AT-MOST-ONCE, and that is stated plainly rather than
 * papered over. The rows are deleted in the same transaction that reads them,
 * so a failure while building the reply leaves them alone, but an agent that
 * dies between the switchboard's commit and its own handling of the reply has
 * lost that batch and there is nowhere to fetch it from again. TOOLS.md says
 * so, and the agent guidance tells an agent to relay a message the moment it
 * collects one.
 */
import { getPool } from '../db.js';
import { decryptForChannel, encryptForChannel, generateChannelKey } from '../crypto.js';
import { getCard } from './cards.js';
import { getMatch, sideOf, type MatchRow } from './matches.js';
import { notifyChannelMessageWaiting, rearmChannelNudge } from './channelNotify.js';
import { OsbError, SCHEMA_VERSION, assertOutbound } from '../protocol.js';
import type { Config } from '../config.js';

/** A message is capped at the length the protocol's channelBody allows. */
export const MAX_MESSAGE_CHARS = 4000;
/** Messages one side may hand over on one channel within a clock hour. */
export const MAX_MESSAGES_PER_HOUR = 60;
/** How long an uncollected message waits before the sweep deletes it. */
export const MESSAGE_TTL_DAYS = 14;
/** Most messages handed over in a single collection. */
export const RECEIVE_BATCH = 50;

/**
 * Counts and ids only. A message body, an excerpt of one, or even its length
 * never appears in a log line — the unit suite reads these call sites and
 * fails the build if one grows a content field.
 */
function relayLog(event: string, fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export interface OpenChannel {
  match: MatchRow;
  channelId: string;
  counterpartyAccount: string;
}

function channelLocked(human_action: string): OsbError {
  return new OsbError('NOT_UNLOCKED_YET', { human_action });
}

/**
 * Resolve the open channel a caller is a party to, or refuse.
 *
 * The gate is deliberately narrow: the match has to exist, the caller has to
 * be one of its two accounts, the match has to be open and at stage 4 with a
 * channel on it, and neither card may have been withdrawn. A withdrawn card is
 * someone saying they are done, and the channel stops carrying at that point.
 * A card that simply reached the end of its life is left alone: two people
 * already talking should not be cut off because the card that introduced them
 * aged out. Suspended agent tokens stop a send earlier still, at the door.
 */
export async function loadOpenChannel(
  matchId: string,
  accountId: string,
): Promise<OpenChannel> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  const side = sideOf(m, accountId); // throws notFound when the caller is not a party
  if (m.state !== 'open' || m.stage < 4 || !m.channel_id) {
    throw channelLocked(
      'This introduction has no open conversation yet. Both humans give the go-ahead first, and then open_conversation opens it.',
    );
  }
  for (const cardId of [m.card_want, m.card_have]) {
    const card = await getCard(cardId);
    if (!card || card.lifecycle_state === 'WITHDRAWN') {
      throw channelLocked(
        'This conversation has closed: one of the two listings behind it was withdrawn.',
      );
    }
  }
  return {
    match: m,
    channelId: m.channel_id,
    counterpartyAccount: side === 'want' ? m.account_have : m.account_want,
  };
}

/**
 * The channel's own data key, minted on first use if it is not there yet.
 *
 * openChannel mints one when it issues a channel id, so this normally reads a
 * key that already exists. The lazy path exists for channels opened before the
 * transport did. COALESCE settles a race between two first sends: both may
 * generate a candidate, and whichever lands first is the one both go on to
 * use.
 */
export async function ensureChannelKey(matchId: string, channelId: string): Promise<Buffer> {
  const r = await getPool().query('SELECT channel_key_enc FROM matches WHERE id = $1', [matchId]);
  const existing = r.rows[0]?.channel_key_enc as Buffer | null | undefined;
  if (existing) return existing;
  const candidate = await generateChannelKey(channelId);
  const w = await getPool().query(
    `UPDATE matches SET channel_key_enc = COALESCE(channel_key_enc, $2), updated_at = now()
     WHERE id = $1 RETURNING channel_key_enc`,
    [matchId, candidate],
  );
  return w.rows[0].channel_key_enc as Buffer;
}

/** Seconds left in the current clock hour. */
function secondsToNextHour(): number {
  const now = new Date();
  return Math.max(
    1,
    3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds()),
  );
}

/**
 * Hand a message to the switchboard for the other side to collect.
 *
 * The rate tally and the message row are written in one transaction, so a
 * refused write never spends an allowance and a spent allowance always has a
 * message behind it.
 */
export async function sendMessage(
  accountId: string,
  matchId: string,
  text: unknown,
  cfg?: Config,
): Promise<{ conversation_id: string; message_id: string; sent_at: string }> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw Object.assign(new Error('send_message requires text to carry'), { validation: ['text'] });
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    throw Object.assign(
      new Error(
        `a message can be up to ${MAX_MESSAGE_CHARS} characters; this one is ${text.length}. Send it in parts.`,
      ),
      { validation: ['text'] },
    );
  }
  const ch = await loadOpenChannel(matchId, accountId);
  const wrappedKey = await ensureChannelKey(matchId, ch.channelId);
  const bodyEnc = await encryptForChannel(ch.channelId, wrappedKey, text);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Fixed window per clock hour. The DO UPDATE only fires below the cap, so
    // no row comes back once the allowance is spent, and a refused attempt
    // never inflates the tally.
    const rate = await client.query(
      `INSERT INTO channel_send_rate (channel_id, sender_account, window_start, n)
       VALUES ($1, $2, date_trunc('hour', now()), 1)
       ON CONFLICT (channel_id, sender_account, window_start)
       DO UPDATE SET n = channel_send_rate.n + 1
       WHERE channel_send_rate.n < $3
       RETURNING n`,
      [ch.channelId, accountId, MAX_MESSAGES_PER_HOUR],
    );
    if (!rate.rowCount) {
      await client.query('ROLLBACK');
      throw new OsbError('QUOTA_EXCEEDED', { retry_after: secondsToNextHour() });
    }
    const r = await client.query(
      `INSERT INTO channel_messages
         (channel_id, match_id, sender_account, recipient_account, body_enc, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
       RETURNING id, created_at`,
      [
        ch.channelId,
        matchId,
        accountId,
        ch.counterpartyAccount,
        bodyEnc,
        String(MESSAGE_TTL_DAYS),
      ],
    );
    await client.query('COMMIT');
    relayLog('channel-message-relayed', {
      channel_id: ch.channelId,
      direction: 'accepted',
      count: 1,
    });
    // Best-effort: nudge the recipient's human that a message is waiting, once
    // per unread state and no more than the floor allows (domain/channelNotify.
    // ts). It runs only after the message is safely committed, and it can never
    // fail the send — the helper swallows its own errors.
    if (cfg) {
      await notifyChannelMessageWaiting(cfg, {
        channelId: ch.channelId,
        matchId,
        recipientAccount: ch.counterpartyAccount,
      });
    }
    return {
      conversation_id: ch.channelId,
      message_id: r.rows[0].id as string,
      sent_at: new Date(r.rows[0].created_at).toISOString(),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Collect what is waiting for the caller, and let it go.
 *
 * The read, the decrypt and the delete all happen inside one transaction: a
 * failure anywhere in there rolls back and the messages are still waiting. On
 * commit they are gone for good.
 */
export async function receiveMessages(
  accountId: string,
  matchId: string,
): Promise<{ messages: any[]; more_waiting: boolean }> {
  const ch = await loadOpenChannel(matchId, accountId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, created_at, body_enc FROM channel_messages
       WHERE recipient_account = $1 AND channel_id = $2
       ORDER BY created_at ASC, id ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [accountId, ch.channelId, RECEIVE_BATCH],
    );
    if (!r.rowCount) {
      await client.query('COMMIT');
      return { messages: [], more_waiting: false };
    }
    const wrappedKey = await ensureChannelKey(matchId, ch.channelId);
    const messages = [];
    for (const [i, row] of r.rows.entries()) {
      const text = await decryptForChannel(ch.channelId, wrappedKey, row.body_enc as Buffer);
      messages.push(
        assertOutbound('conversation.message', {
          schema_version: SCHEMA_VERSION,
          kind: 'conversation.message' as const,
          conversation_id: ch.channelId,
          message_id: row.id as string,
          seq: i + 1,
          sent_at: new Date(row.created_at).toISOString(),
          // Always the other side's words: this row was written by the
          // counterparty's agent, and the label says so to whoever reads it.
          body: { text, provenance: 'counterparty-untrusted' as const },
        }),
      );
    }
    await client.query('DELETE FROM channel_messages WHERE id = ANY($1::uuid[])', [
      r.rows.map((x: any) => x.id),
    ]);
    const rest = await client.query(
      `SELECT 1 FROM channel_messages
       WHERE recipient_account = $1 AND channel_id = $2 LIMIT 1`,
      [accountId, ch.channelId],
    );
    await client.query('COMMIT');
    const collected = messages.length;
    relayLog('channel-message-relayed', {
      channel_id: ch.channelId,
      direction: 'collected',
      count: collected,
    });
    // The recipient has caught up: re-arm the waiting-message nudge so the next
    // arrival to an empty inbox can prompt them again. Best-effort, and only
    // once unread has actually fallen to zero.
    if (!rest.rowCount) {
      await rearmChannelNudge(ch.channelId, accountId);
    }
    return { messages, more_waiting: !!rest.rowCount };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * How many messages are waiting for an account on each of the given channels.
 * One query for a whole check_in sweep, so a polling agent learns there
 * is something to collect without a second call.
 */
export async function pendingCounts(
  accountId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!channelIds.length) return out;
  const r = await getPool().query(
    `SELECT channel_id, count(*)::int AS n FROM channel_messages
     WHERE recipient_account = $1 AND channel_id = ANY($2::text[])
     GROUP BY channel_id`,
    [accountId, channelIds],
  );
  for (const row of r.rows) out.set(row.channel_id as string, row.n as number);
  return out;
}

/**
 * The sweep, run from the existing expiry tick. Uncollected messages are
 * deleted once they pass their expiry, and rate tallies are dropped as soon as
 * their window can no longer be the current one.
 */
export async function sweepExpiredChannelMessages(): Promise<{
  messages: number;
  rate_windows: number;
}> {
  const pool = getPool();
  const msgs = await pool.query('DELETE FROM channel_messages WHERE expires_at < now()');
  const windows = await pool.query(
    `DELETE FROM channel_send_rate WHERE window_start < now() - interval '2 hours'`,
  );
  return { messages: msgs.rowCount ?? 0, rate_windows: windows.rowCount ?? 0 };
}
